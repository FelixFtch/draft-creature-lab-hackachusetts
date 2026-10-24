"""Build the simulation scene for a body: the exact MJCF trained on and exported.

``build_scene(body)`` returns the ``scene.xml`` text every policy bundle ships and
the browser simulates: the Draft body plus

* one MuJoCo ``<position>`` actuator per joint with Draft's PD scaling
  ``kp = 100/70 * effort`` and ``kv = 5/70 * effort`` (``kv`` is the position
  actuator's velocity gain, ``biasprm[2] = -kv``), ``forcerange = +-effort`` and
  ``ctrlrange = joint range``. The PD therefore runs inside MuJoCo every 5 ms
  substep (implicit in ``kv`` with ``implicitfast``). Honest limits: a torque-
  limited position servo; DC-motor speed droop (torque falling with joint speed)
  and gearbox backlash are *not* modelled;
* sensors named ``cg_*`` (IMU gyro/velocimeter/accelerometer, per-foot touch on
  a sphere site slightly larger than the foot, per-foot world position and
  velocity, torso and thigh contact flags, actuator forces);
* collision bits from docs/v2/PLAN.md section 3 (feet 2/9, torso and structural
  limbs 4/9, motors and details 0/0, floor 1/15; no self-collision);
* ``cg_floor`` (plane at z = 0) and fixed options: dt 0.005, implicitfast,
  pyramidal cone, Newton 10/20 iterations, tolerance 1e-8, gravity -9.81.

``build_scene(body, terrain=TerrainSpec(...))`` adds a training-only height
field patch on top of the same floor (bumps rise above z = 0); the robot part of
the model is byte-for-byte the same XML.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import xml.etree.ElementTree as ET

import numpy as np

from .body import Body, BodyError, sha256_bytes

KP_PER_NM = 100.0 / 70.0
KD_PER_NM = 5.0 / 70.0
TIMESTEP = 0.005
DECIMATION = 4
CONTROL_DT = TIMESTEP * DECIMATION
GRAVITY = 9.81
TOUCH_SITE_SCALE = 1.15     # touch sphere radius / foot radius
TOUCH_SITE_MARGIN = 0.002   # metres added to the touch sphere radius
FLOOR = 'cg_floor'
TERRAIN = 'cg_terrain'
OPTION = {'timestep': '0.005', 'integrator': 'implicitfast', 'cone': 'pyramidal', 'solver': 'Newton',
          'iterations': '10', 'ls_iterations': '20', 'tolerance': '1e-8', 'impratio': '1',
          'gravity': '0 0 -9.81'}
COLLISION = {'feet': (2, 9), 'torso': (4, 9), 'limbs': (4, 9), 'motors': (0, 0), 'details': (0, 0)}
FILE_ATTRS = (('mesh', 'file'), ('hfield', 'file'), ('texture', 'file'), ('skin', 'file'))


def fmt(x: float) -> str:
    """Stable number formatting so scene.xml (and its hash) is reproducible."""
    return f'{float(x):.10g}'


@dataclass(frozen=True)
class TerrainSpec:
    """Training-only heightfield patch (MuJoCo hfield size semantics)."""
    half_x: float = 6.0
    half_y: float = 6.0
    nrow: int = 241
    ncol: int = 241
    elevation: float = 0.08     # metres between data 0 and data 1
    depth: float = 0.01         # data 0 lies this far below the floor plane

    def surface(self, data01: np.ndarray) -> np.ndarray:
        return data01 * self.elevation - self.depth


@dataclass
class Scene:
    xml: str
    assets: dict[str, bytes]
    body: Body
    terrain: TerrainSpec | None
    actuator_names: list[str]
    sensor_names: dict = field(default_factory=dict)
    kp: np.ndarray | None = None
    kv: np.ndarray | None = None
    effort: np.ndarray | None = None

    @property
    def sha256(self) -> str:
        return sha256_bytes(self.xml.encode())

    def compile(self):
        import mujoco
        return mujoco.MjModel.from_xml_string(self.xml, dict(self.assets))


def sensor_names(body: Body) -> dict:
    legs = [leg.name for leg in body.legs]
    return {
        'gyro': 'cg_imu_gyro', 'velocimeter': 'cg_imu_vel', 'accelerometer': 'cg_imu_acc',
        'touch': [f'cg_touch_{leg}' for leg in legs],
        'footPos': [f'cg_foot_pos_{leg}' for leg in legs],
        'footVel': [f'cg_foot_vel_{leg}' for leg in legs],
        'torsoContact': 'cg_torso_contact',
        'thighContact': [f'cg_thigh_contact_{leg}' for leg in legs],
        'actuatorForce': [f'cg_frc_{name}' for name in body.joint_names],
    }


def touch_site_name(leg: str) -> str:
    return f'cg_touch_site_{leg}'


def build_scene(body: Body, *, terrain: TerrainSpec | None = None) -> Scene:
    try:
        root = ET.fromstring(body.xml_path.read_text())
    except ET.ParseError as error:
        raise BodyError(f'{body.xml_file} is not valid XML: {error}') from error
    if root.tag != 'mujoco':
        raise BodyError('body.xml root element must be <mujoco>')
    for tag in ('actuator', 'sensor', 'keyframe', 'option', 'equality', 'tendon'):
        for element in list(root.findall(tag)):
            if tag in ('equality', 'tendon') and len(element):
                raise BodyError(f'body.xml <{tag}> is not supported by creature_gym')
            root.remove(element)
    compiler = root.find('compiler')
    # MuJoCo defaults to degrees; body.json ranges (and our ctrlrange) are radians.
    if compiler is None or compiler.get('angle') != 'radian':
        raise BodyError('body.xml must declare <compiler angle="radian"> (Draft does)')
    for attr in ('meshdir', 'assetdir', 'texturedir'):
        compiler.attrib.pop(attr, None)
    for tag, attr in FILE_ATTRS:
        for element in root.iter(tag):
            name = element.get(attr)
            if name is not None and name not in body.mesh_files:
                raise BodyError(f'<{tag} {attr}="{name}"> is not listed in meshFiles')
    root.set('model', f'creature-{body.id}')

    worldbody = root.find('worldbody')
    if worldbody is None:
        raise BodyError('body.xml has no <worldbody>')
    bodies = {b.get('name'): b for b in worldbody.iter('body')}
    if body.root_body not in bodies:
        raise BodyError(f'root body {body.root_body} not found')
    top = [b for b in worldbody.findall('body')]
    if len(top) != 1 or top[0].get('name') != body.root_body:
        raise BodyError('body.xml must contain exactly one top-level body: the root body')
    for element in worldbody.findall('geom'):
        raise BodyError('body.xml must not contain world geoms (the trainer adds the floor)')
    joints = {j.get('name'): j for j in worldbody.iter('joint')}
    free = [j for j in worldbody.iter('joint') if j.get('type') == 'free'] + list(worldbody.iter('freejoint'))
    if len(free) != 1:
        raise BodyError('body.xml must have exactly one free joint (on the root body)')
    for name in body.joint_names:
        if name not in joints:
            raise BodyError(f'joint {name} not found in body.xml')

    role_of = {}
    for role, names in body.geom_roles.items():
        for name in names:
            role_of[name] = role
    for leg in body.legs:
        role_of[leg.foot_geom] = 'feet'
    for geom in worldbody.iter('geom'):
        name = geom.get('name')
        if not name:
            raise BodyError('every body geom needs a name so collision roles are explicit')
        role = role_of.get(name)
        if role is None:
            # Unlisted geoms keep their visual status; anything else is structure.
            visual = geom.get('class') == 'visual' or (geom.get('contype') == '0' and geom.get('conaffinity') == '0')
            role = 'details' if visual else 'limbs'
        contype, conaffinity = COLLISION[role]
        geom.set('contype', str(contype))
        geom.set('conaffinity', str(conaffinity))
        if role == 'feet':
            # condim 3 + priority 1: the foot's (randomised) friction governs foot-ground contacts.
            geom.set('condim', '3')
            geom.set('priority', '1')

    parent = {child: element for element in root.iter() for child in element}
    for leg in body.legs:
        site = next((s for s in worldbody.iter('site') if s.get('name') == leg.foot_site), None)
        if site is None:
            raise BodyError(f'foot site {leg.foot_site} not found')
        holder = parent[site]
        touch = ET.Element('site', {'name': touch_site_name(leg.name), 'type': 'sphere',
                                    'size': fmt(leg.foot_radius * TOUCH_SITE_SCALE + TOUCH_SITE_MARGIN),
                                    'pos': site.get('pos', '0 0 0'), 'group': '5', 'rgba': '1 0.5 0 0.3'})
        holder.insert(list(holder).index(site) + 1, touch)

    option = ET.Element('option', dict(OPTION))
    root.insert(list(root).index(compiler) + 1, option)

    floor = ET.Element('geom', {'name': FLOOR, 'type': 'plane', 'size': '0 0 0.05', 'contype': '1',
                                'conaffinity': '15', 'condim': '3', 'friction': '1 0.005 0.0001',
                                'rgba': '0.55 0.6 0.55 1'})
    worldbody.insert(0, floor)
    if terrain is not None:
        asset = root.find('asset')
        if asset is None:
            asset = ET.SubElement(root, 'asset')
        ET.SubElement(asset, 'hfield', {'name': TERRAIN, 'nrow': str(terrain.nrow), 'ncol': str(terrain.ncol),
                                        'size': ' '.join(fmt(v) for v in (terrain.half_x, terrain.half_y,
                                                                           terrain.elevation, 0.05))})
        worldbody.insert(1, ET.Element('geom', {'name': TERRAIN, 'type': 'hfield', 'hfield': TERRAIN,
                                                'pos': f'0 0 {fmt(-terrain.depth)}', 'contype': '1',
                                                'conaffinity': '15', 'condim': '3',
                                                'friction': '1 0.005 0.0001', 'rgba': '0.5 0.55 0.5 1'}))

    names = sensor_names(body)
    kp = np.array([KP_PER_NM * j.effort for j in body.joints])
    kv = np.array([KD_PER_NM * j.effort for j in body.joints])
    effort = np.array([j.effort for j in body.joints])
    actuator = ET.SubElement(root, 'actuator')
    for joint, p, v in zip(body.joints, kp, kv):
        lo, hi = joint.range
        ET.SubElement(actuator, 'position', {
            'name': joint.name, 'joint': joint.name, 'kp': fmt(p), 'kv': fmt(v),
            'ctrllimited': 'true', 'ctrlrange': f'{fmt(lo)} {fmt(hi)}',
            'forcelimited': 'true', 'forcerange': f'{fmt(-joint.effort)} {fmt(joint.effort)}'})

    sensor = ET.SubElement(root, 'sensor')
    ET.SubElement(sensor, 'gyro', {'name': names['gyro'], 'site': body.imu_site})
    ET.SubElement(sensor, 'velocimeter', {'name': names['velocimeter'], 'site': body.imu_site})
    ET.SubElement(sensor, 'accelerometer', {'name': names['accelerometer'], 'site': body.imu_site})
    for leg, touch, pos, vel in zip(body.legs, names['touch'], names['footPos'], names['footVel']):
        ET.SubElement(sensor, 'touch', {'name': touch, 'site': touch_site_name(leg.name)})
        ET.SubElement(sensor, 'framepos', {'name': pos, 'objtype': 'site', 'objname': leg.foot_site})
        ET.SubElement(sensor, 'framelinvel', {'name': vel, 'objtype': 'site', 'objname': leg.foot_site})
    ET.SubElement(sensor, 'contact', {'name': names['torsoContact'], 'body1': body.root_body,
                                      'data': 'found', 'reduce': 'netforce'})
    for leg, name in zip(body.legs, names['thighContact']):
        # The thigh is the second-to-last leg body (the last one carries the foot).
        thigh = leg.bodies[-2] if len(leg.bodies) >= 2 else leg.bodies[-1] if leg.bodies else body.root_body
        ET.SubElement(sensor, 'contact', {'name': name, 'body1': thigh, 'data': 'found', 'reduce': 'netforce'})
    for joint, name in zip(body.joint_names, names['actuatorForce']):
        ET.SubElement(sensor, 'actuatorfrc', {'name': name, 'actuator': joint})

    ET.indent(root, space='  ')
    xml = ET.tostring(root, encoding='unicode') + '\n'
    return Scene(xml=xml, assets=body.mesh_assets(), body=body, terrain=terrain,
                 actuator_names=list(body.joint_names), sensor_names=names, kp=kp, kv=kv, effort=effort)


@dataclass
class SceneIndex:
    """Addresses into a compiled scene (by name, so extra world bodies are fine)."""
    nq: int
    nv: int
    nu: int
    nsensordata: int
    nstate: int
    root_body: int
    root_qpos: int
    root_dof: int
    joint_qpos: np.ndarray
    joint_dof: np.ndarray
    actuators: np.ndarray
    ctrl_lo: np.ndarray
    ctrl_hi: np.ndarray
    gyro: int
    velocimeter: int
    accelerometer: int
    touch: np.ndarray
    foot_pos: np.ndarray
    foot_vel: np.ndarray
    torso_contact: int
    thigh_contact: np.ndarray
    actuator_force: np.ndarray
    foot_sites: np.ndarray
    foot_geoms: np.ndarray
    floor_geom: int
    terrain_geom: int
    terrain_hfield: int

    @classmethod
    def build(cls, model, body: Body, names: dict) -> 'SceneIndex':
        import mujoco
        obj = mujoco.mjtObj

        def ident(kind, name):
            i = mujoco.mj_name2id(model, kind, name)
            if i < 0:
                raise BodyError(f'compiled scene is missing {name}')
            return i

        def sensor(name, dim):
            i = ident(obj.mjOBJ_SENSOR, name)
            if model.sensor_dim[i] != dim:
                raise BodyError(f'sensor {name} has dim {model.sensor_dim[i]}, expected {dim}')
            return int(model.sensor_adr[i])

        root = ident(obj.mjOBJ_BODY, body.root_body)
        jnt = int(model.body_jntadr[root])
        if jnt < 0 or model.jnt_type[jnt] != mujoco.mjtJoint.mjJNT_FREE:
            raise BodyError('root body must carry the free joint first')
        joints = [ident(obj.mjOBJ_JOINT, n) for n in body.joint_names]
        acts = [ident(obj.mjOBJ_ACTUATOR, n) for n in body.joint_names]
        for a, j in zip(acts, joints):
            if model.actuator_trnid[a, 0] != j:
                raise BodyError('actuator/joint mapping mismatch')
        terrain_geom = mujoco.mj_name2id(model, obj.mjOBJ_GEOM, TERRAIN)
        return cls(
            nq=model.nq, nv=model.nv, nu=model.nu, nsensordata=model.nsensordata,
            nstate=mujoco.mj_stateSize(model, mujoco.mjtState.mjSTATE_FULLPHYSICS),
            root_body=root, root_qpos=int(model.jnt_qposadr[jnt]), root_dof=int(model.jnt_dofadr[jnt]),
            joint_qpos=np.array([model.jnt_qposadr[j] for j in joints]),
            joint_dof=np.array([model.jnt_dofadr[j] for j in joints]),
            actuators=np.array(acts),
            ctrl_lo=np.array([model.actuator_ctrlrange[a, 0] for a in acts]),
            ctrl_hi=np.array([model.actuator_ctrlrange[a, 1] for a in acts]),
            gyro=sensor(names['gyro'], 3), velocimeter=sensor(names['velocimeter'], 3),
            accelerometer=sensor(names['accelerometer'], 3),
            touch=np.array([sensor(n, 1) for n in names['touch']]),
            foot_pos=np.array([sensor(n, 3) for n in names['footPos']]),
            foot_vel=np.array([sensor(n, 3) for n in names['footVel']]),
            torso_contact=sensor(names['torsoContact'], 1),
            thigh_contact=np.array([sensor(n, 1) for n in names['thighContact']]),
            actuator_force=np.array([sensor(n, 1) for n in names['actuatorForce']]),
            foot_sites=np.array([ident(obj.mjOBJ_SITE, leg.foot_site) for leg in body.legs]),
            foot_geoms=np.array([ident(obj.mjOBJ_GEOM, leg.foot_geom) for leg in body.legs]),
            floor_geom=ident(obj.mjOBJ_GEOM, FLOOR),
            terrain_geom=terrain_geom,
            terrain_hfield=mujoco.mj_name2id(model, obj.mjOBJ_HFIELD, TERRAIN),
        )
