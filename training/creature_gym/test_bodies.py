"""Small hand-written test bodies for the wheeled and humanoid code paths.

    python -m creature_gym.test_bodies --body wheelie --out .scratch/bodies/wheelie
    python -m creature_gym.test_bodies --body biped   --out .scratch/bodies/biped

These are *not* Draft bodies. They exist so the trainer's wheel (``drive``) and
humanoid (flat feet, 12 leg joints) paths can be built and unit-tested before the
morphology service delivers the real roster bodies (Rollo, Bipo). They follow the
body contract extensions of docs/v2/ROSTER-AND-TERRAIN.md exactly:

* wheelie (``bodyPlan: wheeled``): two wheel-legs, each ``hip_pitch`` + ``knee`` +
  a driven wheel (``role: wheel``, ``continuous: true``, ``legs[i].wheel`` with
  ``joint/geom/radiusM/axis``); a 4.8 kg segway-like wheel biped (Ollie/Diablo style).
* biped (``bodyPlan: humanoid``): ``hip_yaw, hip_roll, hip_pitch, knee,
  ankle_pitch, ankle_roll`` per leg, box sole plates as ``footGeom`` and the four
  sole corners as ``footContactSites``; 6.4 kg, 0.40 m legs.

Root height, mass, dimensions and the asset hashes are measured with MuJoCo FK,
like creature_gym.dev_bodies does for the Draft dev bodies.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

import mujoco
import numpy as np

from . import BODY_SCHEMA
from .body import compute_asset_sha256, load_body, sha256_bytes
from .sim_model import geom_lowest_z


def _f(x: float) -> str:
    return f'{float(x):.6g}'


def wheelie_xml(*, thigh=0.16, shank=0.16, wheel_r=0.06, hip_y=0.13, wheel_y=0.045) -> str:
    def leg(side: str, sign: int) -> str:
        return f'''
      <body name="{side}_thigh_link" pos="0 {_f(sign * hip_y)} 0">
        <joint name="{side}_hip_pitch" type="hinge" axis="0 1 0" range="-2.0 1.0" actuatorfrcrange="-10 10" damping="0.05" armature="0.005"/>
        <geom name="{side}_thigh_geom" type="capsule" fromto="0 0 0 0 0 {_f(-thigh)}" size="0.018" mass="0.35"/>
        <body name="{side}_shank_link" pos="0 0 {_f(-thigh)}">
          <joint name="{side}_knee" type="hinge" axis="0 1 0" range="0.0 2.4" actuatorfrcrange="-10 10" damping="0.05" armature="0.005"/>
          <geom name="{side}_shank_geom" type="capsule" fromto="0 0 0 0 0 {_f(-shank)}" size="0.015" mass="0.30"/>
          <body name="{side}_wheel_link" pos="0 {_f(sign * wheel_y)} {_f(-shank)}">
            <joint name="{side}_wheel" type="hinge" axis="0 1 0" actuatorfrcrange="-2.5 2.5" damping="0.002" armature="0.001"/>
            <geom name="{side}_wheel_geom" type="cylinder" size="{_f(wheel_r)} 0.015" quat="0.70710678 0.70710678 0 0" mass="0.25" friction="1.0 0.01 0.001"/>
            <site name="{side}_foot" pos="0 0 0" size="0.01"/>
          </body>
        </body>
      </body>'''
    return f'''<mujoco model="wheelie_test">
  <compiler angle="radian" autolimits="true"/>
  <worldbody>
    <body name="torso_link" pos="0 0 0.4">
      <freejoint name="root"/>
      <geom name="torso_box" type="box" size="0.08 0.11 0.05" mass="3.0"/>
      <site name="imu" pos="0 0 0" size="0.01"/>{leg('left', 1)}{leg('right', -1)}
    </body>
  </worldbody>
</mujoco>
'''


def biped_xml(*, thigh=0.18, shank=0.18, hip_y=0.07) -> str:
    sole = (0.07, 0.035, 0.008)   # half sizes
    ankle_drop = 0.03

    def leg(side: str, sign: int) -> str:
        corners = '\n'.join(
            f'              <site name="{side}_sole_{tag}" pos="{_f(0.02 + dx * sole[0])} {_f(dy * sole[1])} {_f(-ankle_drop - sole[2])}" size="0.004"/>'
            for tag, dx, dy in (('fl', 1, 1), ('fr', 1, -1), ('rl', -1, 1), ('rr', -1, -1)))
        return f'''
      <body name="{side}_hip_yaw_link" pos="0 {_f(sign * hip_y)} -0.05">
        <joint name="{side}_hip_yaw" type="hinge" axis="0 0 1" range="-0.6 0.6" actuatorfrcrange="-8 8" damping="0.05" armature="0.005"/>
        <geom name="{side}_hip_yaw_geom" type="sphere" size="0.02" mass="0.2"/>
        <body name="{side}_hip_roll_link" pos="0 0 0">
          <joint name="{side}_hip_roll" type="hinge" axis="1 0 0" range="-0.5 0.5" actuatorfrcrange="-15 15" damping="0.05" armature="0.005"/>
          <geom name="{side}_hip_roll_geom" type="sphere" size="0.02" mass="0.2"/>
          <body name="{side}_thigh_link" pos="0 0 0">
            <joint name="{side}_hip_pitch" type="hinge" axis="0 1 0" range="-1.6 0.8" actuatorfrcrange="-15 15" damping="0.05" armature="0.005"/>
            <geom name="{side}_thigh_geom" type="capsule" fromto="0 0 -0.02 0 0 {_f(-thigh)}" size="0.02" mass="0.6"/>
            <body name="{side}_shank_link" pos="0 0 {_f(-thigh)}">
              <joint name="{side}_knee" type="hinge" axis="0 1 0" range="0.0 2.2" actuatorfrcrange="-20 20" damping="0.05" armature="0.005"/>
              <geom name="{side}_shank_geom" type="capsule" fromto="0 0 -0.02 0 0 {_f(-shank + 0.02)}" size="0.018" mass="0.4"/>
              <body name="{side}_ankle_link" pos="0 0 {_f(-shank)}">
                <joint name="{side}_ankle_pitch" type="hinge" axis="0 1 0" range="-1.0 1.0" actuatorfrcrange="-10 10" damping="0.05" armature="0.005"/>
                <geom name="{side}_ankle_geom" type="sphere" size="0.015" mass="0.1"/>
                <body name="{side}_foot_link" pos="0 0 0">
                  <joint name="{side}_ankle_roll" type="hinge" axis="1 0 0" range="-0.5 0.5" actuatorfrcrange="-8 8" damping="0.05" armature="0.005"/>
                  <geom name="{side}_sole_geom" type="box" size="{' '.join(_f(s) for s in sole)}" pos="0.02 0 {_f(-ankle_drop)}" mass="0.2" friction="1.0 0.01 0.001"/>
                  <site name="{side}_foot" pos="0.02 0 {_f(-ankle_drop - sole[2])}" size="0.006"/>
{corners}
                </body>
              </body>
            </body>
          </body>
        </body>
      </body>'''
    return f'''<mujoco model="biped_test">
  <compiler angle="radian" autolimits="true"/>
  <worldbody>
    <body name="torso_link" pos="0 0 0.5">
      <freejoint name="root"/>
      <geom name="torso_box" type="box" size="0.06 0.1 0.08" pos="0 0 0.04" mass="3.0"/>
      <site name="imu" pos="0 0 0" size="0.01"/>{leg('left', 1)}{leg('right', -1)}
    </body>
  </worldbody>
</mujoco>
'''


def write_body(directory: Path, xml: str, *, prefix: str, name: str, plan: str, legs: list[dict],
               joints: list[dict], nominal: list[float], leg_length: float, gait: dict) -> dict:
    """Write body.xml, measure it with FK at the nominal pose and write body.json."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'body.xml').write_text(xml)
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    names = [j['name'] for j in joints]
    qpos = np.zeros(model.nq)
    qpos[3] = 1.0
    for joint, value in zip(names, nominal):
        qpos[model.jnt_qposadr[mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, joint)]] = value
    data.qpos[:] = qpos
    mujoco.mj_kinematics(model, data)
    feet = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, leg['footGeom']) for leg in legs]
    bottoms = [geom_lowest_z(model, data, g) for g in feet]
    if max(bottoms) - min(bottoms) > 0.002:
        raise ValueError(f'nominal stance does not put every foot on flat ground: {bottoms}')
    qpos[2] = -min(bottoms)
    data.qpos[:] = qpos
    mujoco.mj_kinematics(model, data)
    root = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, 'torso_link')
    for leg in legs:
        first = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, leg['bodies'][0])
        local = data.xpos[first] - data.xpos[root]
        leg['mountAngle'] = float(math.atan2(local[1], local[0]))
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for g in range(model.ngeom):
        center, half = model.geom_aabb[g, :3], model.geom_aabb[g, 3:]
        rot = data.geom_xmat[g].reshape(3, 3)
        c = data.geom_xpos[g] + rot @ center
        h = np.abs(rot) @ half
        lo, hi = np.minimum(lo, c - h), np.maximum(hi, c + h)
    foot_names = {leg['footGeom'] for leg in legs}
    roles = {'feet': sorted(foot_names), 'torso': ['torso_box'],
             'limbs': [mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, g) for g in range(model.ngeom)
                       if mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, g) not in foot_names | {'torso_box'}],
             'motors': [], 'details': []}
    assets = compute_asset_sha256(directory, 'body.xml', [])
    digest = sha256_bytes(json.dumps({'assets': assets, 'nominal': nominal}, sort_keys=True).encode())
    contract = {
        'schema': BODY_SCHEMA, 'id': f'{prefix}-{digest[:16]}', 'name': name, 'bodyPlan': plan,
        'design': {'dev': True, 'note': 'Hand-written trainer test body (creature_gym.test_bodies); not a Draft body.'},
        'xmlFile': 'body.xml', 'meshFiles': [], 'rootBody': 'torso_link', 'imuSite': 'imu',
        'forwardAxis': [1, 0, 0], 'legs': legs, 'jointNames': names, 'joints': joints,
        'nominalJointPositions': [float(v) for v in nominal], 'nominalRootHeight': float(qpos[2]),
        'initialQpos': [float(v) for v in qpos], 'massKg': float(model.body_mass.sum()),
        'dimensions': {'lengthM': float(hi[0] - lo[0]), 'widthM': float(hi[1] - lo[1]),
                       'heightM': float(hi[2] - min(lo[2], 0.0)), 'legLengthM': float(leg_length)},
        'gaitHint': gait, 'geomRoles': roles, 'bodyRoles': {'torso': 'torso_link', 'head': None},
        'feasibility': {'passed': True, 'warnings': ['hand-written test body, not generated by Draft'],
                        'overridden': []},
        'provenance': {'generator': 'creature_gym.test_bodies', 'template': plan, 'assetSha256': assets},
    }
    (directory / 'body.json').write_text(json.dumps(contract, indent=2) + '\n')
    load_body(directory)   # self-check against the contract rules
    return contract


def _joint(name: str, xml_range, effort: float, velocity: float, role: str, **extra) -> dict:
    joint = {'name': name, 'effort': effort, 'velocity': velocity, 'role': role, 'gear': None,
             'armature': 0.005, 'damping': 0.05, 'frictionloss': 0.0}
    if xml_range is not None:
        joint['range'] = list(xml_range)
    joint.update(extra)
    return joint


def make_wheelie(out: Path) -> dict:
    thigh = shank = 0.16
    wheel_r = 0.06
    legs, joints, nominal = [], [], []
    for side in ('left', 'right'):
        legs.append({'name': side, 'joints': [f'{side}_hip_pitch', f'{side}_knee', f'{side}_wheel'],
                     'footGeom': f'{side}_wheel_geom', 'footSite': f'{side}_foot',
                     'side': side, 'end': 'middle',
                     'bodies': [f'{side}_thigh_link', f'{side}_shank_link', f'{side}_wheel_link'],
                     'wheel': {'joint': f'{side}_wheel', 'geom': f'{side}_wheel_geom', 'radiusM': wheel_r,
                               'axis': [0, 1, 0]}})
        joints += [_joint(f'{side}_hip_pitch', (-2.0, 1.0), 10.0, 20.0, 'hip_pitch'),
                   _joint(f'{side}_knee', (0.0, 2.4), 10.0, 20.0, 'knee'),
                   _joint(f'{side}_wheel', None, 2.5, 40.0, 'wheel', continuous=True, armature=0.001, damping=0.002)]
        nominal += [-0.6, 1.2, 0.0]
    return write_body(out, wheelie_xml(thigh=thigh, shank=shank, wheel_r=wheel_r), prefix='wheeled',
                      name='Wheelie (trainer test body)', plan='wheeled', legs=legs, joints=joints,
                      nominal=nominal, leg_length=thigh + shank, gait={})


def make_biped(out: Path) -> dict:
    legs, joints, nominal = [], [], []
    spec = (('hip_yaw', (-0.6, 0.6), 8.0, 0.0), ('hip_roll', (-0.5, 0.5), 15.0, 0.0),
            ('hip_pitch', (-1.6, 0.8), 15.0, -0.3), ('knee', (0.0, 2.2), 20.0, 0.6),
            ('ankle_pitch', (-1.0, 1.0), 10.0, -0.3), ('ankle_roll', (-0.5, 0.5), 8.0, 0.0))
    for side in ('left', 'right'):
        legs.append({'name': side, 'joints': [f'{side}_{role}' for role, *_ in spec],
                     'footGeom': f'{side}_sole_geom', 'footSite': f'{side}_foot',
                     'footContactSites': [f'{side}_sole_{c}' for c in ('fl', 'fr', 'rl', 'rr')],
                     'side': side, 'end': 'middle',
                     'bodies': [f'{side}_hip_yaw_link', f'{side}_hip_roll_link', f'{side}_thigh_link',
                                f'{side}_shank_link', f'{side}_ankle_link', f'{side}_foot_link']})
        for role, rng, effort, value in spec:
            joints.append(_joint(f'{side}_{role}', rng, effort, 15.0, role))
            nominal.append(value)
    return write_body(out, biped_xml(), prefix='humanoid', name='Biped (trainer test body)', plan='humanoid',
                      legs=legs, joints=joints, nominal=nominal, leg_length=0.18 + 0.18 + 0.038,
                      gait={'pattern': 'alternate', 'groups': [[0], [1]]})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--body', choices=('wheelie', 'biped'), required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args(argv)
    contract = (make_wheelie if args.body == 'wheelie' else make_biped)(args.out)
    print(json.dumps({'id': contract['id'], 'out': str(args.out.resolve()), 'massKg': round(contract['massKg'], 3),
                      'legLengthM': round(contract['dimensions']['legLengthM'], 4),
                      'nominalRootHeight': round(contract['nominalRootHeight'], 4)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
