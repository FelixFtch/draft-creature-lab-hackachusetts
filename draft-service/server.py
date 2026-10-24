#!/usr/bin/env python3
"""Local bounded adapter for the installed upstream Draft generator.

GET /api/training-status is read-only: allowlisted training progress and optional
evaluation summary, never local paths, PIDs, raw config, or a launch capability.
GET /training-media/cheetah-forward-native.mp4 serves only the fixed evaluation
video after verified-media.json declares verified:true and its SHA-256 matches.
Missing/corrupt status is a normal available:false response; no job is started.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import importlib.util
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
from urllib.parse import unquote, urlsplit

import mujoco
import numpy as np
import yaml

from draft.generation.generator import RobotGenerator

SERVICE = Path(__file__).resolve().parent
PROJECT = SERVICE.parent
TRAINING = PROJECT / 'training'
DRAFT = Path(os.environ.get('DRAFT_ROOT', PROJECT / '.deps/draft')).resolve()
ROBOT = DRAFT / 'src/draft/robots/quadruped'
FLOWER = PROJECT / 'robots/flower'
PUBLIC = PROJECT / 'play/public'
ASSETS = PUBLIC / 'draft'
WORK = SERVICE / '.work'
MAX_MODELS = 64
MAX_BODY = 2048
SCHEMA_VERSION = 1
PRESETS = {
    'cheetah': {'name': {'en': 'Cheetah', 'zh': '猎豹'}, 'description': {'en': 'Light, short-legged QDD quadruped', 'zh': '轻型短腿 QDD 四足机器人'}},
    'bear': {'name': {'en': 'Bear', 'zh': '熊'}, 'description': {'en': 'Heavy quadruped with mid-ratio geared actuators', 'zh': '使用中减速比执行器的重型四足机器人'}},
    'giraffe': {'name': {'en': 'Giraffe', 'zh': '长颈鹿'}, 'description': {'en': 'Long-legged quadruped with harmonic actuators', 'zh': '使用谐波执行器的长腿四足机器人'}},
    'flower': {'name': {'en': 'Flower crawler', 'zh': '花朵六足'}, 'description': {'en': 'Custom six-legged radial design', 'zh': '自定义六足放射状身体'}},
}
LOCK = threading.RLock()
LOG = logging.getLogger('draft-service')
MEDIA_LOCK = threading.Lock()
MEDIA_CACHE = {}
TRAINING_VIDEO_URL = '/training-media/cheetah-forward-native.mp4'


class RequestError(ValueError):
    pass


def source_revision() -> str:
    """Read repository metadata without invoking a shell or git process."""
    git = DRAFT / '.git'
    head = (git / 'HEAD').read_text().strip()
    if not head.startswith('ref: '):
        return head
    ref = head[5:]
    target = git / ref
    if target.is_file():
        return target.read_text().strip()
    packed = git / 'packed-refs'
    if packed.is_file():
        for line in packed.read_text().splitlines():
            if line.endswith(' ' + ref):
                return line.split()[0]
    return 'unknown'


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def provenance() -> dict:
    return {
        'generator': 'Draft RobotGenerator',
        'repository': 'https://github.com/davidhnguyen2000/draft',
        'revision': source_revision(),
        'packageVersion': importlib.metadata.version('draft-robots'),
        'robot': 'quadruped',
        'strict': True,
        'allowHypothetical': False,
        'generation': 'Official experiment YAML plus bounded dimension overrides; regenerated MJCF and torso mesh',
        'controller': 'No learned controller is created or certified by this endpoint',
    }


def normalized(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise RequestError('Send a JSON object with preset, lengthScale and legScale.')
    extra = set(payload) - {'preset', 'lengthScale', 'legScale'}
    if extra:
        raise RequestError('Unknown parameter: ' + ', '.join(sorted(str(k) for k in extra)))
    preset = payload.get('preset', 'cheetah')
    if not isinstance(preset, str) or preset not in PRESETS:
        raise RequestError('Choose preset cheetah, bear, giraffe or flower.')
    result = {'preset': preset}
    for key in ('lengthScale', 'legScale'):
        value = payload.get(key, 1)
        if type(value) not in (int, float) or not 0.8 <= value <= 1.2 or not math.isfinite(value):
            raise RequestError(f'{key} must be a finite number from 0.8 to 1.2.')
        result[key] = round(float(value), 4)
    return result


def source_overlay(preset: str) -> tuple[Path, dict]:
    source = DRAFT / 'experiments/quadruped_variants' / f'{preset}.yaml'
    return source, yaml.safe_load(source.read_text())


def identity(parameters: dict) -> str:
    if parameters['preset'] == 'flower':
        digest = hashlib.sha256(json.dumps(parameters, sort_keys=True).encode())
        digest.update(source_revision().encode())
        for name in ('parameters.yaml', 'tree.yaml', 'mesh.yaml', 'generate.py'):
            digest.update((FLOWER / name).read_bytes())
        return 'flower-' + digest.hexdigest()[:16]
    source, _ = source_overlay(parameters['preset'])
    # Include generator source and design inputs so edits cannot reuse stale geometry.
    digest = hashlib.sha256()
    digest.update(json.dumps({'schema': SCHEMA_VERSION, 'revision': source_revision(), **parameters}, sort_keys=True).encode())
    paths = [source, *sorted(ROBOT.glob('*.yaml'))]
    paths += sorted((DRAFT / 'src/draft/generation').glob('*.py'))
    for path in paths:
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return parameters['preset'] + '-' + digest.hexdigest()[:16]


def ensure_assets() -> None:
    if not PUBLIC.is_dir() or PUBLIC.is_symlink():
        raise RuntimeError('The play/public directory must be a real directory before Draft assets are generated.')
    if ASSETS.is_symlink():
        raise RuntimeError('The Draft asset directory cannot be a symlink.')
    ASSETS.mkdir(exist_ok=True)
    WORK.mkdir(exist_ok=True)


def evict_cache() -> None:
    entries = []
    protected = {identity(normalized({'preset': preset})) for preset in PRESETS}
    for directory in ASSETS.iterdir():
        if not directory.is_dir() or directory.is_symlink() or not re.fullmatch(r'(cheetah|bear|giraffe|flower)-[a-f0-9]{16}', directory.name):
            continue
        manifest = directory / 'manifest.json'
        try:
            item = json.loads(manifest.read_text())
            default = directory.name in protected
            entries.append((directory, manifest.stat().st_mtime, default))
        except (OSError, ValueError, KeyError):
            continue
    # Leave room for the new model; preserve the three current defaults.
    removable = sorted((row for row in entries if not row[2]), key=lambda row: row[1])
    while len(entries) >= MAX_MODELS and removable:
        row = removable.pop(0)
        shutil.rmtree(row[0])
        entries.remove(row)


def cpu_check(directory: Path, steps: int = 250) -> dict:
    model = mujoco.MjModel.from_xml_path(str(directory / 'quadruped.xml'))
    mass = float(model.body_mass.sum())
    hinges = int(np.count_nonzero(model.jnt_type == mujoco.mjtJoint.mjJNT_HINGE))
    if not math.isfinite(mass) or mass <= 0 or hinges != 12:
        raise RuntimeError('Generated robot has invalid mass or hinge-joint count.')
    scene = mujoco.MjModel.from_xml_path(str(directory / 'scene.xml'))
    data = mujoco.MjData(scene)
    mujoco.mj_forward(scene, data)
    for _ in range(steps):
        mujoco.mj_step(scene, data)
        if not np.isfinite(data.qpos).all() or not np.isfinite(data.qvel).all():
            raise RuntimeError('Generated model produced a non-finite state in the CPU smoke check.')
    warnings = [int(w.number) for w in data.warning]
    if any(warnings):
        raise RuntimeError('MuJoCo reported a simulation warning during the CPU smoke check.')
    return {
        'massKg': mass, 'nq': int(model.nq), 'nv': int(model.nv), 'actuators': int(model.nu), 'hingeJoints': hinges,
        'bodies': int(model.nbody), 'mujocoVersion': mujoco.__version__,
        'finiteSteps': steps, 'simulationSeconds': float(data.time),
        'validationScope': 'CPU compile and finite unactuated scene steps; not a locomotion or hardware validation',
    }


def generate(payload: object) -> dict:
    parameters = normalized(payload)
    if parameters['preset'] == 'flower':
        return generate_flower(parameters)
    model_id = identity(parameters)
    with LOCK:
        ensure_assets()
        destination = ASSETS / model_id
        manifest_path = destination / 'manifest.json'
        if manifest_path.is_file():
            existing = json.loads(manifest_path.read_text())
            if all((destination / name).is_file() and sha256(destination / name) == digest
                   for name, digest in existing.get('assetSha256', {}).items()) and existing.get('assetSha256'):
                manifest_path.touch()
                return existing
            raise RuntimeError('Cached Draft assets failed their checksum check; remove the affected model directory and retry.')
        source, overlay = source_overlay(parameters['preset'])
        overlay['torso_lx'] = float(overlay['torso_lx']) * parameters['lengthScale']
        for key in ('upper_leg_link_length', 'lower_leg_link_length'):
            overlay[key] = float(overlay[key]) * parameters['legScale']
        overlay['allow_hypothetical'] = False
        output_log = io.StringIO()
        try:
            with tempfile.TemporaryDirectory(prefix='generate-', dir=WORK) as temporary:
                generated = Path(temporary) / 'model'
                with redirect_stdout(output_log), redirect_stderr(output_log):
                    RobotGenerator(ROBOT).generate(generated, params_override=overlay, strict=True)
                checks = cpu_check(generated)
                resolved = yaml.safe_load((generated / 'parameters_resolved.yaml').read_text())
                feasibility = yaml.safe_load((generated / 'feasibility_report.yaml').read_text())
                names = ['quadruped.xml', 'torso_mesh.stl', 'scene.xml', 'parameters_resolved.yaml', 'feasibility_report.yaml']
                item = {
                    'id': model_id, 'preset': parameters['preset'], 'parameters': parameters,
                    'xmlUrl': f'/draft/{model_id}/quadruped.xml',
                    'meshUrl': f'/draft/{model_id}/torso_mesh.stl',
                    'manifestUrl': f'/draft/{model_id}/manifest.json',
                    'massKg': checks['massKg'],
                    'resolvedParameters': {key: resolved.get(key) for key in (
                        'torso_lx', 'torso_ly', 'torso_lz', 'upper_leg_link_length', 'lower_leg_link_length',
                        'hip_roll_link_length', 'shoulder_width', 'L_motor_effort', 'L_motor_velocity')},
                    'provenance': {**provenance(), 'presetFile': str(source.relative_to(DRAFT)),
                                   'presetSha256': sha256(source)},
                    'validation': checks,
                    'warnings': feasibility.get('warnings', []),
                    'assetSha256': {name: sha256(generated / name) for name in names},
                }
                (generated / 'manifest.json').write_text(json.dumps(item, ensure_ascii=False, indent=2) + '\n')
                # Publish only six known files; generation intermediates never become public.
                for path in list(generated.iterdir()):
                    if path.name not in names + ['manifest.json']:
                        if path.is_dir():
                            shutil.rmtree(path)
                        else:
                            path.unlink()
                evict_cache()
                generated.rename(destination)
                return item
        except Exception:
            LOG.error('Draft generation failed for %s\n%s', parameters, output_log.getvalue())
            raise


def generate_flower(parameters: dict) -> dict:
    """A locally authored topology, generated by Draft; never an official preset."""
    model_id = identity(parameters)
    with LOCK:
        ensure_assets()
        destination = ASSETS / model_id
        manifest_path = destination / 'manifest.json'
        if manifest_path.is_file():
            item = json.loads(manifest_path.read_text())
            if item.get('assetSha256') and all((destination / n).is_file() and sha256(destination / n) == h for n, h in item['assetSha256'].items()):
                manifest_path.touch()
                return item
            raise RuntimeError('Flower cache checksum failed.')
        spec = importlib.util.spec_from_file_location('local_flower_generator', FLOWER / 'generate.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='flower-', dir=WORK) as temporary:
            generated = Path(temporary) / 'model'
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                info = module.generate_model(generated, parameters['lengthScale'], parameters['legScale'])
            model = mujoco.MjModel.from_xml_path(str(generated / info['xmlFile']))
            if model.nq != 25 or model.nv != 24 or model.nu != 18 or len(info['footGeomNames']) != 6:
                raise RuntimeError('Flower model must have six legs and eighteen independent motors.')
            if not math.isfinite(info['massKg']) or info['massKg'] <= 0:
                raise RuntimeError('Flower mass is invalid.')
            names = [info['xmlFile'], info['meshFile'], 'scene.xml', 'model-info.json', 'parameters_resolved.yaml', 'feasibility_report.yaml']
            item = {'id': model_id, 'preset': 'flower', 'parameters': parameters,
                'xmlUrl': f'/draft/{model_id}/{info["xmlFile"]}', 'meshUrl': f'/draft/{model_id}/{info["meshFile"]}',
                'manifestUrl': f'/draft/{model_id}/manifest.json', 'massKg': info['massKg'],
                'bodyPlan': {k: info[k] for k in ('jointNames','footGeomNames','footSiteNames','nominalJointPositions','poseRoles','nominalRootHeight')},
                'resolvedParameters': info['scaleMeaning'],
                'provenance': {**provenance(), 'robot': 'flower', 'generation': 'Local six-legged specification compiled with Draft; direct torque motors and nominal stance added locally',
                    'officialPreset': False, 'specificationSha256': info['provenance']['sourceFilesSha256'], 'massValidation': info['provenance']['massValidation']},
                'validation': {'scope': 'MuJoCo model compile; gait validation is separate', 'nq': 25, 'nv': 24, 'actuators': 18, 'hingeJoints': 18, 'feet': 6},
                'warnings': ['Custom morphology; structural masses and controller gains are engineering assumptions.'],
                'assetSha256': {name: sha256(generated / name) for name in names}}
            (generated / 'manifest.json').write_text(json.dumps(item, ensure_ascii=False, indent=2) + '\n')
            for path in list(generated.iterdir()):
                if path.name not in names + ['manifest.json']:
                    if path.is_dir(): shutil.rmtree(path)
                    else: path.unlink()
            evict_cache()
            generated.rename(destination)
            return item


def catalog() -> dict:
    entries = []
    for preset, text in PRESETS.items():
        if preset == 'flower':
            entries.append({'id': preset, **text, 'baseParameters': {'lengthScale': 1, 'legScale': 1}, 'default': generate({'preset': preset})})
            continue
        _, base = source_overlay(preset)
        entries.append({'id': preset, **text,
                        'baseParameters': {key: base[key] for key in ('torso_lx', 'upper_leg_link_length', 'lower_leg_link_length')},
                        'default': generate({'preset': preset, 'lengthScale': 1, 'legScale': 1})})
    shared_provenance = {**provenance(), 'robot': 'mixed catalog',
                         'generation': 'Three official quadruped presets and one locally authored six-legged Flower; see each model provenance'}
    return {'presets': entries, 'bounds': {'lengthScale': [0.8, 1.2], 'legScale': [0.8, 1.2]},
            'provenance': shared_provenance, 'cacheLimit': MAX_MODELS}


def allowed_origin(value: str | None) -> bool:
    if value is None:
        return True
    try:
        parsed = urlsplit(value)
        return parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1') and not parsed.username and not parsed.password and parsed.path in ('', '/')
    except ValueError:
        return False


def read_training_json(path: Path, maximum: int = 2 * 1024 * 1024) -> dict | None:
    """Read only fixed local report files; malformed/unavailable is not HTTP 500."""
    try:
        if not path.is_file() or path.is_symlink() or path.stat().st_size > maximum:
            return None
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, UnicodeError, RecursionError):
        return None


def report_number(value, *, nonnegative: bool = True):
    if type(value) not in (int, float) or not math.isfinite(value):
        return None
    return value if not nonnegative or value >= 0 else None


def verified_training_video() -> Path | None:
    """No caller-selected paths. Rehash on stat/marker change; cache valid bytes."""
    directory = TRAINING / 'evaluation' / 'full'
    video = directory / 'cheetah-forward-native.mp4'
    marker_path = directory / 'verified-media.json'
    try:
        if any(path.is_symlink() for path in (TRAINING, directory.parent, directory)):
            return None
        marker = read_training_json(marker_path, maximum=16384)
        if not marker or marker.get('verified') is not True:
            return None
        expected = marker.get('videoSha256')
        if not isinstance(expected, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', expected):
            return None
        if not video.is_file() or video.is_symlink():
            return None
        stat = video.stat()
        signature = (str(video), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, expected.lower())
        with MEDIA_LOCK:
            if MEDIA_CACHE.get('signature') == signature:
                return video if MEDIA_CACHE.get('matches') else None
            digest = hashlib.sha256()
            with video.open('rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(block)
            after = video.stat()
            if (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns):
                return None
            matches = stat.st_size > 0 and digest.hexdigest() == expected.lower()
            MEDIA_CACHE.update(signature=signature, matches=matches)
            return video if matches else None
    except OSError:
        return None


def survivor_displacement(row: dict) -> dict:
    """Complete finite measurements only, with no recorded non-timeout failure.

    Use one population for lateral displacement and yaw so the exposed survivor
    count describes both means. Missing arrays are not evidence of survival.
    """
    arrays = [row.get(key) for key in ('per_env_measured_seconds', 'first_failure_seconds',
                                      'per_env_net_xy_m', 'per_env_yaw_rotation_rad')]
    lateral, yaw = [], []
    if all(isinstance(values, list) for values in arrays):
        for measured, failure, xy, rotation in zip(*arrays):
            seconds = report_number(measured)
            if seconds is None or seconds <= 0 or failure is not None:
                continue
            if not isinstance(xy, list) or len(xy) != 2:
                continue
            x = report_number(xy[0], nonnegative=False)
            y = report_number(xy[1], nonnegative=False)
            angle = report_number(rotation, nonnegative=False)
            if x is None or y is None or angle is None:
                continue
            lateral.append(abs(y))
            yaw.append(abs(angle))
    count = len(lateral)
    return {'meanAbsLateralDisplacementM': sum(lateral) / count if count else None,
            'maxAbsLateralDisplacementM': max(lateral) if count else None,
            'meanAbsYawRotationRad': sum(yaw) / count if count else None,
            'nSurvivorsForDisplacement': count}


def training_evaluation(status_source: dict) -> dict | None:
    # Never attach an older checkpoint's evaluation to a new or incomplete run.
    if status_source.get('mode') != 'full' or status_source.get('status') != 'completed':
        return None
    source = read_training_json(TRAINING / 'evaluation' / 'full' / 'evaluation.json')
    if not source or not isinstance(source.get('results'), list):
        return None
    checkpoint = source.get('checkpoint')
    latest = status_source.get('latest_checkpoint')
    if not isinstance(checkpoint, str) or not isinstance(latest, str):
        return None
    try:
        if Path(checkpoint).resolve(strict=True) != Path(latest).resolve(strict=True):
            return None
    except (OSError, ValueError):
        return None
    classification = source.get('classification')
    if not isinstance(classification, str):
        return None
    results = []
    for row in source['results'][:64]:
        if not isinstance(row, dict) or not isinstance(row.get('scenario'), str):
            continue
        velocity = row.get('mean_actual_vx_vy_wz')
        if not isinstance(velocity, list) or len(velocity) != 3:
            velocity = None
        else:
            velocity = [report_number(value, nonnegative=False) for value in velocity]
            if any(value is None for value in velocity):
                velocity = None
        results.append({'scenario': row['scenario'][:80],
                        'fallFraction': report_number(row.get('fall_fraction')),
                        'meanActualVxVyWz': velocity,
                        'completed': row.get('completed') if type(row.get('completed')) is bool else None,
                        'physicsFinite': row.get('physics_finite') if type(row.get('physics_finite')) is bool else None,
                        **survivor_displacement(row)})
    return {'classification': classification[:300], 'results': results,
            'videoUrl': TRAINING_VIDEO_URL if verified_training_video() else None}


def training_status() -> dict:
    """Original, unscaled Cheetah only. A stale running report is not liveness."""
    result = {'available': False, 'status': 'unavailable', 'mode': None,
              'body': 'cheetah', 'iterationsObserved': None, 'iterationsRequested': None,
              'elapsedSeconds': None, 'peakOwnedGpuMiB': None, 'peakOwnedRamMiB': None,
              'minGpuFreeMiB': None, 'updatedAt': None, 'ageSeconds': None, 'stale': False,
              'evaluation': None}
    source = read_training_json(TRAINING / 'current-status.json')
    if not source or source.get('mode') not in ('capacity', 'full') or source.get('status') not in (
            'starting', 'running', 'stopping', 'stopped', 'completed', 'failed', 'refused'):
        return result
    try:
        updated = source['updated_at']
        if not isinstance(updated, str):
            return result
        timestamp = datetime.fromisoformat(updated.replace('Z', '+00:00'))
        if timestamp.tzinfo is None:
            return result
        age = max(0, (datetime.now(timezone.utc) - timestamp).total_seconds())
    except (KeyError, ValueError, OverflowError):
        return result
    result.update(available=True, status=source['status'], mode=source['mode'],
                  updatedAt=timestamp.isoformat(), ageSeconds=round(age, 1),
                  stale=source['status'] in ('starting', 'running', 'stopping') and age > 30)
    fields = {'iterationsObserved':'iterations_observed', 'iterationsRequested':'iterations_requested',
              'elapsedSeconds':'elapsed_s', 'peakOwnedGpuMiB':'peak_owned_gpu_mib_sampled',
              'peakOwnedRamMiB':'peak_owned_rss_mib_sampled', 'minGpuFreeMiB':'min_gpu_free_mib_sampled'}
    result.update({public: report_number(source.get(private)) for public, private in fields.items()})
    result['evaluation'] = training_evaluation(source)
    return result


def flower_status() -> dict:
    source = read_training_json(TRAINING / 'flower/current-status.json')
    result = {'available': bool(source), 'status': 'preparing', 'stale': False, 'browserReady': False}
    if source:
        result['status'] = source.get('status') if source.get('status') in ('starting','running','completed','failed','stopped') else 'preparing'
        result['phase'] = source.get('phase') if source.get('phase') in ('smoke','capacity','full') else 'preparing'
        fields = {'iterationsObserved':'iterations_observed','iterationsRequested':'iterations_requested','elapsedSeconds':'elapsed_s','peakOwnedGpuMiB':'peak_owned_gpu_mib','peakOwnedRamMiB':'peak_owned_rss_mib'}
        result.update({public: report_number(source.get(private)) for public,private in fields.items()})
        cumulative=report_number(source.get('cumulative_supervised_training_elapsed_s'))
        if cumulative is not None:
            result['elapsedSeconds']=cumulative
        try:
            if not isinstance(source.get('updated_at'), str):
                raise ValueError('Missing timestamp')
            stamp = datetime.fromisoformat(source['updated_at'].replace('Z','+00:00'))
            age = (datetime.now(timezone.utc)-stamp).total_seconds()
            result['stale'] = result['status'] in ('starting','running') and age>30
        except (KeyError,ValueError,TypeError):
            result['stale'] = result['status'] in ('starting','running')
    # Read-only release gate. Training completion alone never unlocks driving.
    # The actual controller/ONNX/WASM report must pass and match these assets.
    report = read_training_json(PROJECT / 'qa/flower-controller-validation.json')
    controller_dir = PUBLIC / 'controller/flower'
    controller_manifest = read_training_json(controller_dir / 'manifest.json')
    checked = {
        'policySha256': controller_dir / 'policy.onnx',
        'xmlSha256': controller_dir / 'scene.xml',
        'controllerSha256': PROJECT / 'play/src/flower-controller.js',
        'rawBodyXmlSha256': FLOWER / 'generated/flower.xml',
    }
    if report and report.get('pass') is True and controller_manifest:
        try:
            matches = all(isinstance(report.get(key), str) and path.is_file() and sha256(path) == report[key] for key,path in checked.items())
            matches = matches and all(report.get(key) == controller_manifest.get(key) for key in ('policySha256','xmlSha256'))
            asset_rows=report.get('assetHashes')
            mesh_row=next((row for row in asset_rows if isinstance(row,dict) and row.get('name')=='torso_mesh.stl'),None) if isinstance(asset_rows,list) else None
            matches = matches and bool(mesh_row) and mesh_row.get('sha256') == controller_manifest.get('sourceMeshSha256')
            if matches:
                matches=sha256(controller_dir/'assets/torso_mesh.stl') == mesh_row['sha256'] == sha256(FLOWER/'generated/torso_mesh.stl')
            if matches:
                result.update(browserReady=True, status='verified', stale=False)
                rows=[]
                for row in report.get('episodes',[]) if isinstance(report.get('episodes'),list) else []:
                    if not isinstance(row,dict) or row.get('name') not in ('stationary','forward','turn_left'):
                        continue
                    command=row.get('command');actual=row.get('meanActualVelocity')
                    if not all(isinstance(v,list) and len(v)==3 and all(type(n) in (int,float) and math.isfinite(n) for n in v) for v in (command,actual)):
                        continue
                    rows.append({'name':row['name'],'command':command,'meanActualVelocity':actual,'pass':row.get('pass') is True})
                result['evaluation']={'scope':'One nominal-body WASM rollout per command; 2 seconds settling plus 10 seconds measured','rows':rows}
        except OSError:
            pass
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = 'LocalDraft/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def origin_headers(self):
        origin = self.headers.get('Origin')
        if origin and allowed_origin(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def reply(self, status: int, body: dict):
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.origin_headers()
        self.end_headers()
        self.wfile.write(encoded)

    def permitted(self) -> bool:
        # Loopback bind plus host/origin checks prevents unintended remote browser use.
        host = self.headers.get('Host', '').split(':', 1)[0]
        if host not in ('127.0.0.1', 'localhost') or not allowed_origin(self.headers.get('Origin')):
            self.reply(403, {'error': 'This generator accepts requests from the local playground only.'})
            return False
        return True

    def do_OPTIONS(self):
        if not self.permitted():
            return
        self.send_response(204)
        self.origin_headers()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self.permitted():
            return
        path = urlsplit(self.path).path
        try:
            if path == '/api/catalog':
                self.reply(200, catalog())
            elif path == '/api/training-status':
                self.reply(200, training_status())
            elif path == '/api/flower-status':
                self.reply(200, flower_status())
            elif path == TRAINING_VIDEO_URL:
                target = verified_training_video()
                if target is None:
                    self.reply(404, {'error': 'Verified training video is not available.'})
                    return
                data = target.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.origin_headers()
                self.end_headers()
                self.wfile.write(data)
            elif path == '/api/health':
                self.reply(200, {'status': 'ok', 'service': 'draft-generator', 'revision': source_revision()})
            elif path.startswith('/draft/'):
                match = re.fullmatch(r'/draft/((?:cheetah|bear|giraffe|flower)-[a-f0-9]{16})/(quadruped\.xml|flower\.xml|torso_mesh\.stl|scene\.xml|manifest\.json|model-info\.json|parameters_resolved\.yaml|feasibility_report\.yaml)', unquote(path))
                if not match:
                    self.reply(404, {'error': 'Model asset not found.'})
                    return
                target = ASSETS / match[1] / match[2]
                if not target.is_file() or target.is_symlink() or target.parent.is_symlink() or not target.resolve().is_relative_to(ASSETS.resolve()):
                    self.reply(404, {'error': 'Model asset not found; generate this configuration again.'})
                    return
                data = target.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', {'xml': 'application/xml', 'json': 'application/json', 'stl': 'model/stl'}.get(target.suffix[1:], 'text/yaml'))
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'public, max-age=86400, immutable')
                self.origin_headers()
                self.end_headers()
                self.wfile.write(data)
            else:
                self.reply(404, {'error': 'Unknown endpoint.'})
        except Exception as error:
            LOG.exception('GET failed')
            self.reply(500, {'error': 'Draft could not prepare the model catalog.', 'detail': str(error)[:500]})

    def do_POST(self):
        if not self.permitted():
            return
        if urlsplit(self.path).path != '/api/generate':
            self.reply(404, {'error': 'Unknown endpoint.'})
            return
        try:
            if self.headers.get('Transfer-Encoding'):
                raise RequestError('Use a JSON request with Content-Length.')
            if self.headers.get_content_type() != 'application/json':
                raise RequestError('Content-Type must be application/json.')
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                raise RequestError('Invalid Content-Length.')
            if not 0 < size <= MAX_BODY:
                raise RequestError('The JSON request must contain 1 to 2048 bytes.')
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise RequestError('Incomplete JSON request.')
            def reject_constant(value):
                raise RequestError('JSON numbers must be finite.')
            payload = json.loads(raw, parse_constant=reject_constant)
            self.reply(200, generate(payload))
        except (RequestError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self.reply(400, {'error': str(error)})
        except Exception as error:
            LOG.exception('Generation failed')
            self.reply(422, {'error': 'Draft could not generate a feasible model for those settings.', 'detail': str(error)[:500]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18382)
    parser.add_argument('--prepare', action='store_true', help='Generate/validate defaults, print catalog, then exit.')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    prepared = catalog()
    (SERVICE / 'catalog.json').write_text(json.dumps(prepared, ensure_ascii=False, indent=2) + '\n')
    if args.prepare:
        print(json.dumps(prepared, ensure_ascii=False, indent=2))
        return
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    LOG.info('Draft service ready at http://127.0.0.1:%s; %s', args.port, ASSETS)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
