"""Development bodies in ``creature-body/1`` shape until morphology delivers real ones.

    python -m creature_gym.dev_bodies --body cheetah --out /tmp/bodies/cheetah
    python -m creature_gym.dev_bodies --body flower  --out /tmp/bodies/flower \
        [--generator-python /path/.venv/bin/python | --from-generated robots/flower/generated]

* cheetah: the Draft Cheetah export in ``play/public/draft/cheetah-*`` (quadruped.xml,
  torso_mesh.stl), nominal joints from the legacy controller manifest's
  ``defaultJointPosition`` and efforts from the XML's ``actuatorfrcrange``.
* flower: ``robots/flower/generate.py`` run with the generator venv (Draft installed)
  into a temporary directory; its ``flower.xml`` loses the 18 torque motors and the
  keyframe it adds, so the body is the raw Draft structure.

The derived numbers (nominal root height, leg length, dimensions) are measured with
forward kinematics in the training MuJoCo, so they match what the trainer simulates.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

import mujoco
import numpy as np

from . import BODY_SCHEMA
from .body import compute_asset_sha256, load_body, sha256_bytes, sha256_file

REPO = Path(__file__).resolve().parents[2]
CHEETAH_EXPORT = REPO / 'play/public/draft/cheetah-31f2a9bfec7b90a8'
CHEETAH_MANIFEST = REPO / 'play/public/controller/cheetah/manifest.json'
FLOWER_SOURCE = REPO / 'robots/flower'
DRAFT_REVISION = '3b03e144735098ef94b938e85756806f45628f83'
#: All feet of a nominal stance must lie within this height band (metres).
STANCE_FOOT_TOLERANCE = 0.005


def _role(joint_name: str) -> str:
    for role in ('hip_roll', 'hip_yaw', 'hip_pitch', 'knee', 'ankle'):
        if joint_name.endswith(role):
            return role
    return 'other'


def _velocity_limits(model: mujoco.MjModel) -> dict[str, float]:
    out = {}
    for i in range(model.nnumeric):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_NUMERIC, i) or ''
        if name.endswith('_velocity_limit'):
            out[name[:-len('_velocity_limit')]] = float(model.numeric_data[model.numeric_adr[i]])
    return out


def _strip(root: ET.Element, tags: tuple[str, ...]) -> None:
    for tag in tags:
        for element in list(root.findall(tag)):
            root.remove(element)


def _leg_length(model, data, joint_ids: list[int], foot_site: int) -> float:
    """Thigh + shank like Draft's measure: segments from the hip-pitch joint to the
    foot, each projected perpendicular to the joint axis it swings about (so a
    lateral hip offset does not count as leg length)."""
    chain = [j for j in joint_ids if _role(mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, j)) in ('hip_pitch', 'knee', 'ankle')]
    if not chain:
        chain = joint_ids[-2:]
    points = [data.xanchor[j].copy() for j in chain] + [data.site_xpos[foot_site].copy()]
    total = 0.0
    for k, joint in enumerate(chain):
        axis = data.xaxis[joint] / np.linalg.norm(data.xaxis[joint])
        v = points[k + 1] - points[k]
        total += float(np.linalg.norm(v - np.dot(v, axis) * axis))
    return total


def describe_body(directory: Path, *, body_id_prefix: str, name: str, body_plan: str,
                  xml_file: str, mesh_files: list[str], leg_names: list[str],
                  leg_joints: dict[str, list[str]], foot_geoms: dict[str, str],
                  foot_sites: dict[str, str], nominal: list[float], gait: dict,
                  root_body: str = 'torso_link', imu_site: str = 'imu',
                  extra: dict | None = None) -> dict:
    """Measure a body directory with MuJoCo FK and write its body.json."""
    assets = {m: (directory / m).read_bytes() for m in mesh_files}
    model = mujoco.MjModel.from_xml_string((directory / xml_file).read_text(), assets)
    data = mujoco.MjData(model)
    joint_names = [j for leg in leg_names for j in leg_joints[leg]]
    jid = {n: mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, n) for n in joint_names}
    if min(jid.values()) < 0:
        raise ValueError(f'unknown joints {[n for n, i in jid.items() if i < 0]}')
    if model.nq != 7 + len(joint_names):
        raise ValueError(f'body.xml must have a free root plus {len(joint_names)} joints (nq={model.nq})')
    root_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, root_body)
    qpos = np.zeros(model.nq)
    qpos[3] = 1.0
    for n, v in zip(joint_names, nominal):
        qpos[model.jnt_qposadr[jid[n]]] = v
    data.qpos[:] = qpos
    mujoco.mj_kinematics(model, data)
    foot_gids = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, foot_geoms[leg]) for leg in leg_names]
    radii = [float(model.geom_size[g, 0]) for g in foot_gids]
    bottoms = [float(data.geom_xpos[g, 2]) - r for g, r in zip(foot_gids, radii)]
    if max(bottoms) - min(bottoms) > STANCE_FOOT_TOLERANCE:
        raise ValueError(f'nominal stance does not put every foot on flat ground: {bottoms}')
    root_height = -min(bottoms)
    qpos[2] = root_height
    data.qpos[:] = qpos
    mujoco.mj_kinematics(model, data)
    mujoco.mj_comPos(model, data)

    velocity = _velocity_limits(model)
    joints = []
    for n in joint_names:
        j = jid[n]
        dof = model.jnt_dofadr[j]
        effort = float(model.jnt_actfrcrange[j, 1]) if model.jnt_actfrclimited[j] else 0.0
        if effort <= 0:
            raise ValueError(f'{n} has no actuatorfrcrange effort')
        joints.append({'name': n, 'range': [float(x) for x in model.jnt_range[j]], 'effort': effort,
                       'velocity': float(velocity.get(n, 20.0)), 'gear': None,
                       'armature': float(model.dof_armature[dof]), 'damping': float(model.dof_damping[dof]),
                       'frictionloss': float(model.dof_frictionloss[dof]), 'role': _role(n)})

    legs = []
    leg_lengths = []
    extent = max(1e-3, float(np.max(np.abs(data.xpos[1:, :2] - data.xpos[root_id, :2]))))
    for leg, gid, radius in zip(leg_names, foot_gids, radii):
        site = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, foot_sites[leg])
        if site < 0:
            raise ValueError(f'missing foot site {foot_sites[leg]}')
        # Leg bodies: from the torso's child down to the foot's body.
        chain, b = [], int(model.site_bodyid[site])
        while b not in (0, root_id):
            chain.append(mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, b))
            b = int(model.body_parentid[b])
        chain.reverse()
        first = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, chain[0])
        local = data.xmat[root_id].reshape(3, 3).T @ (data.xpos[first] - data.xpos[root_id])
        tol = 0.02 * extent
        side = 'left' if local[1] > tol else 'right' if local[1] < -tol else 'center'
        end = 'front' if local[0] > tol else 'rear' if local[0] < -tol else 'middle'
        legs.append({'name': leg, 'joints': leg_joints[leg], 'footGeom': foot_geoms[leg],
                     'footSite': foot_sites[leg], 'footRadius': radius,
                     'mountAngle': float(math.atan2(local[1], local[0])), 'side': side, 'end': end,
                     'bodies': chain})
        leg_lengths.append(_leg_length(model, data, [jid[n] for n in leg_joints[leg]], site))

    feet = [foot_geoms[leg] for leg in leg_names]
    roles = {'feet': list(feet), 'torso': [], 'limbs': [], 'motors': [], 'details': []}
    lo_corner, hi_corner = np.full(3, np.inf), np.full(3, -np.inf)
    for g in range(model.ngeom):
        gname = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, g) or ''
        if not gname:
            raise ValueError('every body geom needs a name so collision roles are explicit')
        if gname in feet:
            pass
        elif gname.endswith('_motor'):
            roles['motors'].append(gname)
        elif gname.endswith('_detail') or (model.geom_contype[g] == 0 and model.geom_conaffinity[g] == 0):
            roles['details'].append(gname)
        elif model.geom_bodyid[g] == root_id:
            roles['torso'].append(gname)
        else:
            roles['limbs'].append(gname)
        center, half = model.geom_aabb[g, :3], model.geom_aabb[g, 3:]
        rot = data.geom_xmat[g].reshape(3, 3)
        world_center = data.geom_xpos[g] + rot @ center
        world_half = np.abs(rot) @ half
        lo_corner = np.minimum(lo_corner, world_center - world_half)
        hi_corner = np.maximum(hi_corner, world_center + world_half)

    initial_qpos = [float(x) for x in qpos]
    asset_sha = compute_asset_sha256(directory, xml_file, mesh_files)
    digest = sha256_bytes(json.dumps({'assets': asset_sha, 'nominal': nominal}, sort_keys=True).encode())
    groups = [list(g) for g in gait['groups']]
    contract = {
        'schema': BODY_SCHEMA,
        'id': f'{body_id_prefix}-{digest[:16]}',
        'name': name,
        'bodyPlan': body_plan,
        'design': {'dev': True, 'note': 'Development body converted by creature_gym.dev_bodies; no DesignSpec.'},
        'xmlFile': xml_file,
        'meshFiles': list(mesh_files),
        'rootBody': root_body,
        'imuSite': imu_site,
        'forwardAxis': [1, 0, 0],
        'legs': legs,
        'jointNames': joint_names,
        'joints': joints,
        'nominalJointPositions': [float(v) for v in nominal],
        'nominalRootHeight': root_height,
        'nominalStanceTolerance': {'footHeightBandM': STANCE_FOOT_TOLERANCE, 'torsoTiltRad': 0.0},
        'initialQpos': initial_qpos,
        'massKg': float(model.body_mass.sum()),
        'dimensions': {'lengthM': float(hi_corner[0] - lo_corner[0]), 'widthM': float(hi_corner[1] - lo_corner[1]),
                       'heightM': float(hi_corner[2] - min(lo_corner[2], 0.0)),
                       'legLengthM': float(np.mean(leg_lengths))},
        'gaitHint': {'pattern': gait['pattern'], 'groups': groups},
        'geomRoles': roles,
        'bodyRoles': {'torso': root_body, 'head': None},
        # One entry per distinct motor envelope; dev bodies carry no catalogue data.
        'motors': [{'class': 'L', 'family': 'unknown', 'effortNm': e, 'velocityRadS': v, 'gear': None,
                    'massKg': None, 'catalogAnchor': None}
                   for e, v in sorted({(j['effort'], j['velocity']) for j in joints})],
        'feasibility': {'passed': True, 'warnings': [], 'overridden': []},
        'provenance': {'generator': 'Draft RobotGenerator strict=True (via creature_gym.dev_bodies)',
                       'draftRevision': DRAFT_REVISION, 'template': body_plan,
                       'sourcesSha256': {}, 'assetSha256': asset_sha},
    }
    if extra:
        for key, value in extra.items():
            if isinstance(value, dict) and isinstance(contract.get(key), dict):
                contract[key].update(value)
            else:
                contract[key] = value
    (directory / 'body.json').write_text(json.dumps(contract, indent=2) + '\n')
    load_body(directory)  # self-check against the contract rules
    return contract


def make_cheetah(out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    root = ET.parse(CHEETAH_EXPORT / 'quadruped.xml').getroot()
    _strip(root, ('actuator', 'keyframe'))
    ET.indent(root, space='  ')
    (out / 'body.xml').write_text(ET.tostring(root, encoding='unicode') + '\n')
    shutil.copyfile(CHEETAH_EXPORT / 'torso_mesh.stl', out / 'torso_mesh.stl')
    for name in ('feasibility_report.yaml', 'parameters_resolved.yaml'):
        shutil.copyfile(CHEETAH_EXPORT / name, out / name)
    manifest = json.loads(CHEETAH_MANIFEST.read_text())
    nominal = [float(v) for v in manifest['defaultJointPosition']]
    legs = ['fl', 'fr', 'rl', 'rr']
    export_manifest = json.loads((CHEETAH_EXPORT / 'manifest.json').read_text())
    return describe_body(
        out, body_id_prefix='quadruped', name='Cheetah (dev)', body_plan='quadruped',
        xml_file='body.xml', mesh_files=['torso_mesh.stl'], leg_names=legs,
        leg_joints={leg: [f'{leg}_hip_roll', f'{leg}_hip_pitch', f'{leg}_knee'] for leg in legs},
        foot_geoms={leg: f'{leg}_lower_leg_link_sphere' for leg in legs},
        foot_sites={leg: f'{leg}_foot' for leg in legs}, nominal=nominal,
        gait={'pattern': 'trot', 'groups': [[0, 3], [1, 2]]},
        extra={'feasibility': {'warnings': export_manifest.get('warnings', [])},
               'provenance': {'template': 'quadruped', 'sourcesSha256': {
                   'play/public/draft/cheetah-31f2a9bfec7b90a8/quadruped.xml': sha256_file(CHEETAH_EXPORT / 'quadruped.xml'),
                   'play/public/controller/cheetah/manifest.json': sha256_file(CHEETAH_MANIFEST)},
                   'preset': 'cheetah'}})


def _generate_flower(generator_python: str, workdir: Path) -> Path:
    env = dict(os.environ)
    env.setdefault('DRAFT_ROOT', str(REPO / '.deps/draft'))
    subprocess.run([generator_python, str(FLOWER_SOURCE / 'generate.py'), '--output', str(workdir)],
                   check=True, env=env, cwd=str(REPO), stdout=subprocess.DEVNULL)
    return workdir


def make_flower(out: Path, *, generator_python: str | None = None, from_generated: Path | None = None) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        if from_generated is not None:
            source = Path(from_generated)
        else:
            python = generator_python or os.environ.get('CREATURE_GENERATOR_PYTHON') or str(REPO / '.venv/bin/python')
            source = _generate_flower(python, Path(tmp))
        root = ET.parse(source / 'flower.xml').getroot()
        _strip(root, ('actuator', 'keyframe'))
        ET.indent(root, space='  ')
        (out / 'body.xml').write_text(ET.tostring(root, encoding='unicode') + '\n')
        shutil.copyfile(source / 'torso_mesh.stl', out / 'torso_mesh.stl')
        for name in ('feasibility_report.yaml', 'parameters_resolved.yaml'):
            if (source / name).is_file():
                shutil.copyfile(source / name, out / name)
        info_path = source / 'model-info.json'
        info = json.loads(info_path.read_text()) if info_path.is_file() else {}
    legs = [f'leg{i}' for i in range(6)]
    nominal = [float(v) for v in info.get('nominalJointPositions', [0.0, 0.15, 1.25] * 6)]
    sources = {name: sha256_file(FLOWER_SOURCE / name) for name in ('parameters.yaml', 'tree.yaml', 'mesh.yaml', 'generate.py')}
    return describe_body(
        out, body_id_prefix='multileg', name='Flower (dev)', body_plan='multileg',
        xml_file='body.xml', mesh_files=['torso_mesh.stl'], leg_names=legs,
        leg_joints={leg: [f'{leg}_hip_yaw', f'{leg}_hip_pitch', f'{leg}_knee'] for leg in legs},
        foot_geoms={leg: f'{leg}_lower_leg_link_sphere' for leg in legs},
        foot_sites={leg: f'{leg}_foot' for leg in legs}, nominal=nominal,
        gait={'pattern': 'tripod', 'groups': [[0, 2, 4], [1, 3, 5]]},
        extra={'provenance': {'template': 'flower', 'sourcesSha256': sources, 'preset': 'flower'}})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--body', choices=('cheetah', 'flower'), required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--generator-python', default=None, help='python with Draft installed (flower only)')
    parser.add_argument('--from-generated', type=Path, default=None,
                        help='existing generate.py output directory (flower only)')
    args = parser.parse_args(argv)
    if args.body == 'cheetah':
        contract = make_cheetah(args.out)
    else:
        contract = make_flower(args.out, generator_python=args.generator_python, from_generated=args.from_generated)
    print(json.dumps({'id': contract['id'], 'out': str(args.out.resolve()), 'massKg': round(contract['massKg'], 3),
                      'legLengthM': round(contract['dimensions']['legLengthM'], 4),
                      'nominalRootHeight': round(contract['nominalRootHeight'], 4)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
