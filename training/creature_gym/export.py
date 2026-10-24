"""Export a trained actor as a ``creature-policy/1`` bundle and validate it.

The ONNX graph is written with ``onnx.helper`` from the trained weights (no torch
exporter, so the result does not depend on torch's exporter version):

    obs[batch, N] -> Sub(mean) -> Div(std + eps) -> (Gemm -> Elu) x H -> Gemm -> action[batch, nu]

opset 17 and IR version 8 keep it loadable by onnxruntime 1.23+ and
onnxruntime-web 1.27. The normaliser constants are computed in float32 exactly
like the torch forward pass, and the export is checked against torch with
onnxruntime before anything is written.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil

import numpy as np

from . import MUJOCO_VERSION, POLICY_SCHEMA
from .body import Body, sha256_bytes, sha256_file
from .obs import MOVING_FRACTION

OPSET = 17
IR_VERSION = 8
SERVED = ('manifest.json', 'policy.onnx', 'scene.xml', 'eval.json', 'fixtures.json', 'progress.json')


def build_onnx(model, n_obs: int) -> bytes:
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    import torch

    norm = model.obs_norm
    mean = norm.mean.to(torch.float32).numpy()
    denom = (norm.var.sqrt().to(torch.float32) + torch.tensor(norm.eps, dtype=torch.float32)).numpy()
    linears = [layer for layer in model.actor if isinstance(layer, torch.nn.Linear)]
    inits = [numpy_helper.from_array(mean.astype(np.float32), 'obs_mean'),
             numpy_helper.from_array(denom.astype(np.float32), 'obs_denom')]
    nodes = [helper.make_node('Sub', ['obs', 'obs_mean'], ['x_centered']),
             helper.make_node('Div', ['x_centered', 'obs_denom'], ['x0'])]
    last = 'x0'
    for i, layer in enumerate(linears):
        w = layer.weight.detach().to(torch.float32).numpy()
        b = layer.bias.detach().to(torch.float32).numpy()
        inits += [numpy_helper.from_array(w, f'W{i}'), numpy_helper.from_array(b, f'b{i}')]
        out = 'action' if i == len(linears) - 1 else f'h{i}'
        nodes.append(helper.make_node('Gemm', [last, f'W{i}', f'b{i}'], [out], transB=1))
        if i < len(linears) - 1:
            nodes.append(helper.make_node('Elu', [out], [f'a{i}'], alpha=1.0))
            last = f'a{i}'
    n_act = linears[-1].weight.shape[0]
    graph = helper.make_graph(
        nodes, 'creature_policy',
        [helper.make_tensor_value_info('obs', TensorProto.FLOAT, ['batch', n_obs])],
        [helper.make_tensor_value_info('action', TensorProto.FLOAT, ['batch', n_act])], inits)
    proto = helper.make_model(graph, producer_name='creature_gym', opset_imports=[helper.make_opsetid('', OPSET)])
    proto.ir_version = IR_VERSION
    onnx.checker.check_model(proto)
    return proto.SerializeToString()


def verify_onnx(model, onnx_bytes: bytes, samples: np.ndarray, tolerance: float = 1e-4) -> float:
    import onnxruntime as ort
    import torch
    session = ort.InferenceSession(onnx_bytes, providers=['CPUExecutionProvider'])
    got = session.run(['action'], {'obs': samples.astype(np.float32)})[0]
    with torch.no_grad():
        want = model.policy_mean(torch.from_numpy(samples.astype(np.float32))).numpy()
    err = float(np.max(np.abs(got - want)))
    # Relative to the action magnitude (float32 rounding grows with it); actions are O(1).
    if not err <= tolerance * max(1.0, float(np.max(np.abs(want)))):
        raise RuntimeError(f'ONNX export differs from torch by {err}')
    return err


def honesty(skill: str, body: Body, terrain: bool) -> str:
    if skill == 'walk':
        return (f'PPO velocity-tracking policy trained on CPU for this exact body ({body.name}, {body.id}); '
                'simulated position servos (Draft PD rule, torque-limited, no DC-motor speed droop); flat ground '
                'plus small smooth bump patches' + (' during training' if terrain else '') +
                '. Not validated on hardware, stairs, steep ramps or slippery ice.')
    return (f'One-shot jump policy for this exact body ({body.name}, {body.id}), run for a fixed window and then '
            'handed back to its walk policy; trained and validated on flat ground only. Not validated on hardware.')


def write_bytes_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, path)


def manifest_for(body: Body, env, scene_xml: bytes, onnx_bytes: bytes, run: dict, state: dict,
                 machine: dict, n_obs: int) -> dict:
    import mujoco
    import torch
    task, sc, idx = env.task, env.scaling, env.idx
    skill = env.skill
    names = env.export_scene.sensor_names
    joints_names = list(body.joint_names)
    manifest = {
        'schema': POLICY_SCHEMA, 'skill': skill, 'kind': 'perpetual' if skill == 'walk' else 'episodic',
        'bodyId': body.id, 'bodyName': body.name, 'bodyAssetSha256': dict(body.asset_sha256),
        'sceneXml': 'scene.xml', 'sceneSha256': sha256_bytes(scene_xml),
        'assets': [{'name': n, 'sha256': sha256_file(body.directory / n)} for n in body.mesh_files],
        'policy': 'policy.onnx', 'policySha256': sha256_bytes(onnx_bytes), 'onnxInput': 'obs', 'onnxOutput': 'action',
        'onnxOpset': OPSET,
        'control': {'timestep': 0.005, 'decimation': 4, 'controlDt': 0.02},
        'rootBody': body.root_body,
        'rootJoint': mujoco.mj_id2name(env.model, mujoco.mjtObj.mjOBJ_JOINT, int(env.model.body_jntadr[idx.root_body])),
        'imuSite': body.imu_site, 'floorGeom': 'cg_floor',
        'legNames': [leg.name for leg in body.legs], 'footSites': [leg.foot_site for leg in body.legs],
        'footGeoms': [leg.foot_geom for leg in body.legs], 'footRadius': [leg.foot_radius for leg in body.legs],
        'jointNames': joints_names, 'actuatorNames': joints_names,
        'defaultJointPositions': [float(x) for x in env.default],
        'actionScale': [float(x) for x in task.action_scale], 'actionClip': float(task.action_clip),
        'observation': {'size': n_obs, 'terms': task.terms,
                        'notes': ('All terms from robot qpos/qvel and controller state (see training/creature_gym/obs.py): '
                                  'base_lin_vel = R^T qvel[0:3]; base_ang_vel = qvel[3:6]; projected_gravity = R^T (0,0,-1); '
                                  'joint_pos = q - default; joint_vel = qd; last_action = previous clipped action; '
                                  'gait_clock = per leg (sin, cos)(2 pi frac(phase + offset)), zero when not moving; '
                                  'jump_phase = (p, sin 2 pi p, cos 2 pi p). Values are multiplied by term scale. '
                                  'No noise at inference.')},
        'commandBounds': task.bounds(),
        'moving': {'fraction': MOVING_FRACTION, 'vmax': sc.vmax, 'wmax': sc.wmax},
        'clock': ({'frequencyHz': sc.freq, 'legPhaseOffsets': [float(x) for x in env.offsets],
                   'swingFraction': env.swing_frac, 'pattern': body.gait_pattern,
                   'groups': [list(g) for g in body.gait_groups]} if skill == 'walk' else None),
        'episode': ({'durationS': task.duration, 'steps': task.max_steps, 'handoff': 'walk'} if skill == 'jump' else None),
        'fallCriteria': {'tiltRad': 1.0, 'minHeightAboveFeetM': round((0.5 if skill == 'walk' else 0.35) * sc.h0, 4),
                         'torsoContactSensor': names['torsoContact']},
        'sensors': {'touch': names['touch'], 'footPos': names['footPos'], 'footVel': names['footVel'],
                    'torsoContact': names['torsoContact'], 'thighContact': names['thighContact'],
                    'gyro': names['gyro'], 'velocimeter': names['velocimeter'], 'accelerometer': names['accelerometer']},
        'contactThresholdN': round(float(env.contact_threshold), 4),
        'initialQpos': [float(x) for x in body.initial_qpos], 'nominalRootHeight': body.nominal_root_height,
        'scaling': {'legLengthM': sc.leg, 'froudeTopCommand': 0.25, 'referenceLegM': 0.44},
        'pd': {'kp': [float(x) for x in env.scene.kp], 'kv': [float(x) for x in env.scene.kv],
               'effort': [float(x) for x in env.scene.effort],
               'rule': 'MuJoCo position actuators: kp = 100/70 * effort, kv = 5/70 * effort (Draft), forcerange +-effort'},
        'training': {'algorithm': 'PPO', 'envSteps': int(state['env_steps']), 'iterations': int(state['iteration']),
                     'wallSeconds': round(float(state['wall']), 1), 'machine': machine, 'seed': run['seed'],
                     'envs': run['envs'], 'budget': run.get('budget'), 'mujocoVersion': mujoco.__version__,
                     'torchVersion': torch.__version__, 'ppo': run['ppo'],
                     'domainRandomization': {'footFriction': [0.4, 1.2], 'payloadFraction': [-0.1, 0.2],
                                             'torsoComM': 0.02 * sc.s, 'kpScale': [0.9, 1.1], 'kvScale': [0.8, 1.2],
                                             'effortScale': [0.85, 1.1], 'jointDampingFrictionScale': [0.5, 1.5],
                                             'pushes': skill == 'walk', 'observationNoise': True},
                     'terrain': 'flat + smooth bump patches (protrusion up to 8% of leg length)' if skill == 'walk' else 'flat'},
        'honesty': honesty(skill, body, skill == 'walk'),
    }
    if skill == 'jump':
        manifest['training']['jumpReference'] = task.reference.to_dict()
        manifest['training']['jumpReferenceNote'] = ('Training-only vertical target (crouch, push, ballistic flight, '
                                                     'absorb, stand); validation uses the absolute criteria in eval.json.')
    if MUJOCO_VERSION != mujoco.__version__:
        manifest['training']['warning'] = f'trained with mujoco {mujoco.__version__}, browser uses {MUJOCO_VERSION}'
    return manifest


def export_and_evaluate(*, body: Body, env, model, out: Path, work: Path, run: dict, state: dict,
                        machine: dict, walk_bundle: Path | None, progress) -> dict:
    from .evaluate import Bundle, evaluate_jump, evaluate_walk, record_fixtures
    out = Path(out)
    progress('exporting policy.onnx and scene.xml', 'exporting')
    scene_xml = env.export_scene.xml.encode('utf-8')
    n_obs = env.task.obs_size
    onnx_bytes = build_onnx(model, n_obs)
    # Verify on realistic inputs: the current env observations plus normaliser-shaped noise.
    import torch
    real = env.actor_obs()[:64]
    mean, scale = model.obs_norm.affine()
    synthetic = (np.random.default_rng(0).normal(size=(64, n_obs)) / scale.numpy() + mean.numpy()).astype(np.float32)
    max_err = verify_onnx(model, onnx_bytes, np.concatenate([real, synthetic]))
    # Fresh bundle files (stale eval/fixtures must never survive a re-export).
    for name in ('eval.json', 'fixtures.json', 'manifest.json'):
        (out / name).unlink(missing_ok=True)
    write_bytes_atomic(out / 'scene.xml', scene_xml)
    write_bytes_atomic(out / 'policy.onnx', onnx_bytes)
    for name in body.mesh_files:
        shutil.copyfile(body.directory / name, out / name)
    manifest = manifest_for(body, env, scene_xml, onnx_bytes, run, state, machine, n_obs)
    manifest['export'] = {'onnxMaxAbsErrorVsTorch': max_err, 'opset': OPSET, 'irVersion': IR_VERSION}
    write_bytes_atomic(out / 'manifest.json', (json.dumps(manifest, indent=2) + '\n').encode())

    progress('evaluating the exported policy (deterministic MuJoCo rollouts)', 'evaluating')
    bundle = Bundle(out)
    if env.skill == 'walk':
        report = evaluate_walk(bundle, body)
        fixtures = record_fixtures(bundle)
    else:
        walk_dir = Path(walk_bundle or out.parent / 'walk').resolve()
        try:
            walk = Bundle(walk_dir, require_eval=True)
        except Exception as error:  # noqa: BLE001 - reported in eval.json
            report = {'schema': 'creature-eval/1', 'skill': 'jump', 'bodyId': body.id,
                      'policySha256': manifest['policySha256'], 'sceneSha256': manifest['sceneSha256'],
                      'pass': False, 'rows': [], 'error': f'no ready walk bundle for the handoff: {error}'}
            fixtures = None
        else:
            if walk.manifest['sceneSha256'] != manifest['sceneSha256']:
                raise RuntimeError('walk and jump bundles must share the exact scene.xml')
            report = evaluate_jump(bundle, walk)
            fixtures = record_fixtures(walk, bundle)
            manifest['handoff'] = {'skill': 'walk', 'walkPolicySha256': walk.manifest['policySha256'],
                                   'walkManifestId': walk.manifest['bodyId']}
    eval_bytes = (json.dumps(report, indent=1, default=_json_default) + '\n').encode()
    write_bytes_atomic(out / 'eval.json', eval_bytes)
    manifest['evaluation'] = {'evalFile': 'eval.json', 'evalSha256': sha256_bytes(eval_bytes), 'pass': bool(report['pass'])}
    if fixtures is not None:
        fixture_bytes = (json.dumps(fixtures, default=_json_default) + '\n').encode()
        write_bytes_atomic(out / 'fixtures.json', fixture_bytes)
        manifest['fixtures'] = {'file': 'fixtures.json', 'sha256': sha256_bytes(fixture_bytes)}
    write_bytes_atomic(out / 'manifest.json', (json.dumps(manifest, indent=2) + '\n').encode())
    torch.save({'model': model.state_dict(), 'policySha256': manifest['policySha256']}, work / 'exported_model.pt')
    return report


def _json_default(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    raise TypeError(f'not JSON serialisable: {type(value)}')
