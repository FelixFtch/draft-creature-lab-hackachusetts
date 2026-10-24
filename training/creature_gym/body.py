"""Load and validate a ``creature-body/1`` directory (see contracts/body-contract.md).

The trainer derives everything from ``body.xml`` + ``body.json``. This module
only parses and checks the contract; it never compiles MuJoCo models, so it is
cheap to import from services and tests.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
import re

from . import BODY_SCHEMA

MAX_BODY_JSON_BYTES = 4 * 1024 * 1024
SAFE_FILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
SAFE_NAME = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$')
GAIT_PATTERNS = ('trot', 'tripod', 'wave', 'ripple', 'pace', 'bound', 'walk')
JOINT_ROLES = ('hip_roll', 'hip_yaw', 'hip_pitch', 'knee', 'ankle', 'other')
NOMINAL_RANGE_TOLERANCE = 1e-6


class BodyError(ValueError):
    """The body directory does not satisfy the creature-body/1 contract."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def safe_file_name(name: object, what: str) -> str:
    if not isinstance(name, str) or not SAFE_FILE.match(name) or name in ('.', '..'):
        raise BodyError(f'{what} must be a plain file name, got {name!r}')
    return name


def _name(value: object, what: str) -> str:
    if not isinstance(value, str) or not SAFE_NAME.match(value):
        raise BodyError(f'{what} must be a MuJoCo element name, got {value!r}')
    return value


def _number(value: object, what: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise BodyError(f'{what} must be a finite number, got {value!r}')
    if positive and value <= 0:
        raise BodyError(f'{what} must be positive, got {value!r}')
    return float(value)


def _numbers(value: object, what: str, length: int | None = None) -> tuple[float, ...]:
    if not isinstance(value, list) or (length is not None and len(value) != length):
        raise BodyError(f'{what} must be a list' + (f' of {length} numbers' if length is not None else ''))
    return tuple(_number(v, f'{what}[{i}]') for i, v in enumerate(value))


@dataclass(frozen=True)
class JointSpec:
    name: str
    range: tuple[float, float]
    effort: float
    velocity: float
    role: str
    gear: float | None = None
    armature: float | None = None
    damping: float | None = None
    frictionloss: float | None = None


@dataclass(frozen=True)
class LegSpec:
    name: str
    joints: tuple[str, ...]
    foot_geom: str
    foot_site: str
    foot_radius: float
    mount_angle: float
    side: str
    end: str
    bodies: tuple[str, ...]


@dataclass(frozen=True)
class Body:
    directory: Path
    raw: dict = field(repr=False)
    id: str
    name: str
    body_plan: str
    xml_file: str
    mesh_files: tuple[str, ...]
    root_body: str
    imu_site: str
    forward_axis: tuple[float, float, float]
    legs: tuple[LegSpec, ...]
    joint_names: tuple[str, ...]
    joints: tuple[JointSpec, ...]
    nominal_joint_positions: tuple[float, ...]
    nominal_root_height: float
    initial_qpos: tuple[float, ...]
    mass_kg: float
    leg_length: float
    gait_pattern: str
    gait_groups: tuple[tuple[int, ...], ...]
    geom_roles: dict = field(repr=False)
    asset_sha256: dict = field(repr=False)

    @property
    def xml_path(self) -> Path:
        return self.directory / self.xml_file

    def mesh_assets(self) -> dict[str, bytes]:
        """Mesh bytes keyed by the file name body.xml references."""
        return {name: (self.directory / name).read_bytes() for name in self.mesh_files}

    def joint(self, name: str) -> JointSpec:
        for joint in self.joints:
            if joint.name == name:
                return joint
        raise KeyError(name)


def default_gait(n_legs: int, legs: list[LegSpec]) -> tuple[str, tuple[tuple[int, ...], ...]]:
    """A sensible gait when body.json has none: trot (4), tripod (6), else wave."""
    if n_legs == 4:
        # Diagonal pairs: sort by mount angle so the pairing is geometric, not by name.
        order = sorted(range(4), key=lambda i: legs[i].mount_angle % (2 * math.pi))
        return 'trot', ((order[0], order[2]), (order[1], order[3]))
    if n_legs >= 6 and n_legs % 2 == 0:
        order = sorted(range(n_legs), key=lambda i: legs[i].mount_angle % (2 * math.pi))
        return 'tripod', (tuple(order[0::2]), tuple(order[1::2]))
    order = sorted(range(n_legs), key=lambda i: legs[i].mount_angle % (2 * math.pi))
    return 'wave', tuple((i,) for i in order)


def compute_asset_sha256(directory: Path, xml_file: str, mesh_files: list[str] | tuple[str, ...]) -> dict[str, str]:
    return {name: sha256_file(directory / name) for name in [xml_file, *mesh_files]}


def load_body(path: str | Path, *, verify_hashes: bool = True) -> Body:
    """Parse ``<dir>/body.json`` and check the contract rules the trainer needs."""
    directory = Path(path)
    if directory.is_file():
        directory = directory.parent
    directory = directory.resolve()
    contract_path = directory / 'body.json'
    if not contract_path.is_file():
        raise BodyError(f'{contract_path} does not exist')
    if contract_path.stat().st_size > MAX_BODY_JSON_BYTES:
        raise BodyError('body.json is too large')
    try:
        raw = json.loads(contract_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise BodyError(f'body.json is not valid JSON: {error}') from error
    if not isinstance(raw, dict) or raw.get('schema') != BODY_SCHEMA:
        raise BodyError(f'body.json schema must be {BODY_SCHEMA!r}')

    body_id = raw.get('id')
    if not isinstance(body_id, str) or not re.match(r'^[a-z0-9][a-z0-9-]{0,95}$', body_id):
        raise BodyError(f'body id {body_id!r} must be lowercase letters, digits and dashes')
    xml_file = safe_file_name(raw.get('xmlFile', 'body.xml'), 'xmlFile')
    meshes = raw.get('meshFiles', [])
    if not isinstance(meshes, list):
        raise BodyError('meshFiles must be a list')
    mesh_files = tuple(safe_file_name(m, 'meshFiles entry') for m in meshes)
    if len(set(mesh_files)) != len(mesh_files) or xml_file in mesh_files:
        raise BodyError('meshFiles must be distinct and differ from xmlFile')
    for name in (xml_file, *mesh_files):
        if not (directory / name).is_file():
            raise BodyError(f'missing body file {name}')

    root_body = _name(raw.get('rootBody'), 'rootBody')
    imu_site = _name(raw.get('imuSite'), 'imuSite')
    forward = _numbers(raw.get('forwardAxis', [1, 0, 0]), 'forwardAxis', 3)

    legs_raw = raw.get('legs')
    if not isinstance(legs_raw, list) or not 1 <= len(legs_raw) <= 12:
        raise BodyError('legs must list 1-12 legs')
    legs: list[LegSpec] = []
    for index, leg in enumerate(legs_raw):
        if not isinstance(leg, dict):
            raise BodyError(f'legs[{index}] must be an object')
        joints = leg.get('joints')
        if not isinstance(joints, list) or not joints:
            raise BodyError(f'legs[{index}].joints must be a non-empty list')
        bodies = leg.get('bodies', [])
        if not isinstance(bodies, list):
            raise BodyError(f'legs[{index}].bodies must be a list')
        side = leg.get('side', 'center')
        end = leg.get('end', 'middle')
        if side not in ('left', 'right', 'center') or end not in ('front', 'middle', 'rear'):
            raise BodyError(f'legs[{index}] side/end are invalid')
        legs.append(LegSpec(
            name=_name(leg.get('name'), f'legs[{index}].name'),
            joints=tuple(_name(j, f'legs[{index}].joints') for j in joints),
            foot_geom=_name(leg.get('footGeom'), f'legs[{index}].footGeom'),
            foot_site=_name(leg.get('footSite'), f'legs[{index}].footSite'),
            foot_radius=_number(leg.get('footRadius'), f'legs[{index}].footRadius', positive=True),
            mount_angle=_number(leg.get('mountAngle', 0.0), f'legs[{index}].mountAngle'),
            side=side, end=end,
            bodies=tuple(_name(b, f'legs[{index}].bodies') for b in bodies),
        ))
    if len({leg.name for leg in legs}) != len(legs):
        raise BodyError('leg names must be distinct')

    joint_names = raw.get('jointNames')
    expected = [j for leg in legs for j in leg.joints]
    if joint_names != expected:
        raise BodyError('jointNames must equal the legs x joints order')
    if len(set(expected)) != len(expected):
        raise BodyError('joint names must be distinct')
    joints_raw = raw.get('joints')
    if not isinstance(joints_raw, list):
        raise BodyError('joints must be a list')
    by_name = {}
    for index, joint in enumerate(joints_raw):
        if not isinstance(joint, dict):
            raise BodyError(f'joints[{index}] must be an object')
        name = _name(joint.get('name'), f'joints[{index}].name')
        lo, hi = _numbers(joint.get('range'), f'{name}.range', 2)
        if not lo < hi:
            raise BodyError(f'{name}.range must be increasing')
        role = joint.get('role', 'other')
        if role not in JOINT_ROLES:
            raise BodyError(f'{name}.role {role!r} is not one of {JOINT_ROLES}')
        optional = {key: (_number(joint[key], f'{name}.{key}') if joint.get(key) is not None else None)
                    for key in ('gear', 'armature', 'damping', 'frictionloss')}
        by_name[name] = JointSpec(
            name=name, range=(lo, hi), role=role,
            effort=_number(joint.get('effort'), f'{name}.effort', positive=True),
            velocity=_number(joint.get('velocity'), f'{name}.velocity', positive=True),
            **optional)
    missing = [n for n in expected if n not in by_name]
    if missing:
        raise BodyError(f'joints is missing {missing}')
    joints = tuple(by_name[n] for n in expected)

    nominal = _numbers(raw.get('nominalJointPositions'), 'nominalJointPositions', len(expected))
    for joint, value in zip(joints, nominal):
        lo, hi = joint.range
        if not lo - NOMINAL_RANGE_TOLERANCE <= value <= hi + NOMINAL_RANGE_TOLERANCE:
            raise BodyError(f'nominal {joint.name}={value} is outside its range {joint.range}')
    root_height = _number(raw.get('nominalRootHeight'), 'nominalRootHeight', positive=True)
    initial_qpos = _numbers(raw.get('initialQpos'), 'initialQpos', 7 + len(expected))
    if abs(math.sqrt(sum(q * q for q in initial_qpos[3:7])) - 1) > 1e-6:
        raise BodyError('initialQpos root quaternion must be normalised')
    mass = _number(raw.get('massKg'), 'massKg', positive=True)
    dims = raw.get('dimensions') or {}
    if not isinstance(dims, dict):
        raise BodyError('dimensions must be an object')
    leg_length = _number(dims.get('legLengthM'), 'dimensions.legLengthM', positive=True)

    hint = raw.get('gaitHint') or {}
    pattern, groups = None, None
    if isinstance(hint, dict) and hint.get('groups') is not None:
        groups_raw = hint.get('groups')
        if not isinstance(groups_raw, list) or not groups_raw:
            raise BodyError('gaitHint.groups must be a non-empty list')
        groups = tuple(tuple(int(i) for i in g) for g in groups_raw if isinstance(g, list))
        flat = sorted(i for g in groups for i in g)
        if len(groups) != len(groups_raw) or flat != list(range(len(legs))):
            raise BodyError('gaitHint.groups must place every leg index in exactly one group')
        pattern = hint.get('pattern', 'trot')
        if pattern not in GAIT_PATTERNS:
            raise BodyError(f'gaitHint.pattern {pattern!r} is not one of {GAIT_PATTERNS}')
    if groups is None:
        pattern, groups = default_gait(len(legs), legs)

    roles = raw.get('geomRoles') or {}
    if not isinstance(roles, dict):
        raise BodyError('geomRoles must be an object')
    geom_roles = {}
    for role in ('feet', 'torso', 'limbs', 'motors', 'details'):
        values = roles.get(role, [])
        if not isinstance(values, list):
            raise BodyError(f'geomRoles.{role} must be a list')
        geom_roles[role] = [_name(v, f'geomRoles.{role}') for v in values]

    computed = compute_asset_sha256(directory, xml_file, mesh_files)
    declared = (raw.get('provenance') or {}).get('assetSha256')
    if verify_hashes:
        if not isinstance(declared, dict):
            raise BodyError('provenance.assetSha256 is required so policies can detect stale bodies')
        for name, digest in computed.items():
            if declared.get(name) != digest:
                raise BodyError(f'{name} does not match provenance.assetSha256 (body changed after export?)')

    return Body(
        directory=directory, raw=raw, id=body_id, name=str(raw.get('name') or body_id),
        body_plan=str(raw.get('bodyPlan') or 'multileg'), xml_file=xml_file, mesh_files=mesh_files,
        root_body=root_body, imu_site=imu_site, forward_axis=forward, legs=tuple(legs),
        joint_names=tuple(expected), joints=joints, nominal_joint_positions=nominal,
        nominal_root_height=root_height, initial_qpos=initial_qpos, mass_kg=mass,
        leg_length=leg_length, gait_pattern=pattern, gait_groups=groups,
        geom_roles=geom_roles, asset_sha256=dict(declared) if isinstance(declared, dict) else computed,
    )
