#!/usr/bin/env python3
"""Generate the original flower crawler with Draft; no upstream modifications.

The raw Draft output is retained as flower-generated.xml. flower.xml adds only
18 direct torque motors and a measured nominal-stance keyframe. Structural
masses and controller gains are explicit engineering assumptions, not a fit to
humanoid/quadruped body populations or a hardware-validated design.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import mujoco
import numpy as np
import yaml
from draft.generation.generator import RobotGenerator

HERE = Path(__file__).resolve().parent
LEG_NAMES = [f'leg{i}' for i in range(6)]
JOINT_NAMES = [f'{leg}_{role}' for leg in LEG_NAMES for role in ('hip_yaw', 'hip_pitch', 'knee')]
STANCE = [0.0, 0.15, 1.25] * 6


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate_model(output_dir: Path, length_scale: float = 1.0, leg_scale: float = 1.0) -> dict:
    """Return a JSON-serializable model contract; scales are bounded 0.8..1.2."""
    for name, value in [('length_scale', length_scale), ('leg_scale', leg_scale)]:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.8 <= value <= 1.2:
            raise ValueError(f'{name} must be a finite number from 0.8 to 1.2')
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    base = yaml.safe_load((HERE / 'parameters.yaml').read_text())
    overrides = {k: base[k] * length_scale for k in ('body_radius', 'hub_mount_radius', 'mount_link_length')}
    overrides.update({k: base[k] * leg_scale for k in ('coxa_length', 'upper_leg_length', 'lower_leg_length')})
    RobotGenerator(HERE).generate(output_dir, params_override=overrides, strict=True)
    xml_path = output_dir / 'flower.xml'
    raw_path = output_dir / 'flower-generated.xml'
    raw_path.write_bytes(xml_path.read_bytes())
    doc = ET.parse(xml_path)
    root = doc.getroot()
    actuator = root.find('actuator')
    if actuator is not None:
        root.remove(actuator)
    actuator = ET.SubElement(root, 'actuator')
    for name in JOINT_NAMES:
        ET.SubElement(actuator, 'motor', name=name, joint=name, gear='1', ctrllimited='true', ctrlrange='-12 12', forcelimited='true', forcerange='-12 12')
    ET.indent(doc, space='  ')
    doc.write(xml_path, encoding='utf-8', xml_declaration=True)
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    data = mujoco.MjData(model)
    qpos = np.array(model.qpos0, copy=True)
    qpos[:7] = [0, 0, 0, 1, 0, 0, 0]
    for name, angle in zip(JOINT_NAMES, STANCE):
        jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
        qpos[model.jnt_qposadr[jid]] = angle
    data.qpos[:] = qpos
    mujoco.mj_forward(model, data)
    foot_geoms = [f'{leg}_lower_leg_link_sphere' for leg in LEG_NAMES]
    foot_sites = [f'{leg}_foot' for leg in LEG_NAMES]
    foot_ids = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, name) for name in foot_geoms]
    qpos[2] = -min(float(data.geom_xpos[i, 2] - model.geom_size[i, 0]) for i in foot_ids) + 0.005
    data.qpos[:] = qpos
    mujoco.mj_forward(model, data)
    keyframe = root.find('keyframe')
    if keyframe is None:
        keyframe = ET.SubElement(root, 'keyframe')
    ET.SubElement(keyframe, 'key', name='nominal', qpos=' '.join(f'{v:.12g}' for v in qpos), qvel=' '.join(['0'] * model.nv), ctrl=' '.join(['0'] * model.nu))
    ET.indent(doc, space='  ')
    doc.write(xml_path, encoding='utf-8', xml_declaration=True)
    # Reload the serialized file used by all consumers, not the pre-save model.
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)
    params = yaml.safe_load((output_dir / 'parameters_resolved.yaml').read_text())
    spec_sources = {name: sha256(HERE / name) for name in ('parameters.yaml', 'tree.yaml', 'mesh.yaml', 'generate.py')}
    joints = []
    motors = []
    for i, name in enumerate(JOINT_NAMES):
        jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
        joints.append({'name': name, 'id': int(jid), 'qposAdr': int(model.jnt_qposadr[jid]), 'dofAdr': int(model.jnt_dofadr[jid]),
                       'axis': model.jnt_axis[jid].tolist(), 'range': model.jnt_range[jid].tolist(), 'nominalPosition': STANCE[i]})
        motors.append({'jointName': name, 'actuatorName': name, 'kp': 60.0, 'kd': 1.5, 'effortLimit': 12.0,
                       'saturationEffort': 12.0, 'velocityLimit': 20.0, 'armature': float(model.dof_armature[model.jnt_dofadr[jid]])})
    contract = {
        'schemaVersion': 1, 'id': 'flower', 'name': {'en': 'Flower crawler', 'zh': '六足花朵机器人'},
        'xmlFile': 'flower.xml', 'rawDraftXmlFile': 'flower-generated.xml', 'meshFile': 'torso_mesh.stl',
        'parameters': {'preset': 'flower', 'lengthScale': float(length_scale), 'legScale': float(leg_scale)},
        'scaleMeaning': {'lengthScale': 'Central housing radius and fixed radial mounts', 'legScale': 'Coxa, upper and lower segment lengths; actuator sizes unchanged'},
        'bodyName': 'torso_link', 'torsoBodyName': 'torso_link', 'imuSiteName': 'imu',
        'sensorNames': {'linearVelocity': 'imu_lin_vel', 'angularVelocity': 'imu_ang_vel'},
        'legNames': LEG_NAMES, 'jointNames': JOINT_NAMES, 'actuatorNames': JOINT_NAMES,
        'joints': joints, 'motors': motors, 'footGeomNames': foot_geoms, 'footSiteNames': foot_sites,
        'footRadius': 0.025, 'nominalJointPositions': STANCE, 'defaultJointPosition': STANCE,
        'defaultJointVelocity': [0.0] * 18, 'initialQpos': data.qpos.tolist(), 'initialQvel': [0.0] * model.nv,
        'nominalRootHeight': float(data.qpos[2]), 'footPositions': [data.geom_xpos[i].tolist() for i in foot_ids],
        'poseRoles': {'hipYawSuffix': '_hip_yaw', 'hipPitchSuffix': '_hip_pitch', 'kneeSuffix': '_knee',
                      'crouchDelta': [0, 0.18, 0.2], 'waveLeg': 'leg0', 'waveDelta': [0, -0.35, 0.35]},
        'massKg': float(model.body_mass.sum()), 'nq': int(model.nq), 'nv': int(model.nv), 'nu': int(model.nu),
        'bodies': [{'name': mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, i), 'parentId': int(model.body_parentid[i]),
                    'massKg': float(model.body_mass[i]), 'inertia': model.body_inertia[i].tolist()} for i in range(model.nbody)],
        'motorEngineeringAssumptions': {'peakTorqueNm': 12, 'noLoadSpeedRadS': 20, 'gearRatio': 12, 'estimatedMotorMassKg': params['L_motor_mass'],
                                        'nominalKp': 60, 'nominalKd': 1.5, 'note': 'Operating point and controller gains selected for this prototype; motor envelope/mass/armature derived by Draft, not a purchased actuator claim.'},
        'provenance': {'generator': 'Installed Draft RobotGenerator, strict=True', 'upstreamRepository': 'https://github.com/davidhnguyen2000/draft',
                       'sourceFilesSha256': spec_sources, 'xmlSha256': sha256(xml_path), 'rawXmlSha256': sha256(raw_path),
                       'meshSha256': sha256(output_dir / 'torso_mesh.stl'),
                       'adaptation': 'Six radial branches authored in YAML; generated MJCF augmented with direct torque motors and a forward-kinematics stance keyframe.',
                       'massValidation': 'No mass_composition_reference: structural densities and dimensions are stated assumptions, not validated against a flower population.',
                       'locomotionPolicy': 'None supplied by the generator; training and gait validation are separate.'},
    }
    (output_dir / 'model-info.json').write_text(json.dumps(contract, indent=2) + '\n')
    return contract


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=HERE / 'generated')
    parser.add_argument('--length-scale', type=float, default=1.0)
    parser.add_argument('--leg-scale', type=float, default=1.0)
    args = parser.parse_args()
    result = generate_model(args.output, args.length_scale, args.leg_scale)
    print(json.dumps({k: result[k] for k in ('xmlFile', 'massKg', 'nq', 'nv', 'nu', 'nominalRootHeight')}, indent=2))
