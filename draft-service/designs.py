#!/usr/bin/env python3
"""Design pipeline: a creature-design/1 DesignSpec becomes a real Draft robot body.

    validate   small strict JSON-schema subset against contracts/design.schema.json
    map        onto a Draft template: Draft's official quadruped (optionally on top of
               the cheetah/bear/giraffe experiment YAML) or robots/multileg
    generate   RobotGenerator(...).generate(..., strict=True): fitted actuator trends
               size every motor and the feasibility gate may refuse the design
    gate       extra checks Draft does not make: actuators bolted to one rigid body
               must not interpenetrate, and a level standing pose must exist
    analyse    nominal stance (MuJoCo forward kinematics), trainability heuristics
               (static loads, support polygon, a torque-limited PD hold test) and a
               spec sheet
    store      contracts/body-contract.md body directory; content-addressed id

bodyId hashes the exact Draft overrides, the template sources and the Draft revision.
Cosmetic design fields (name, concept, look, skills) never change a body; anything that
changes what Draft receives always does.

Honesty: a body is a generated mechanism with motor envelopes. Nothing here trains or
certifies a controller. Trainability flags are static and PD-hold heuristics, never a
gait test; the trainer's evaluation is the only evidence a body can walk or jump.

Wiring (draft-service/server.py, main agent): ROUTES / dispatch() / send_file_response();
body_dir() resolves a bodyId for the training job manager.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
import copy
import hashlib
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
import sys
import tempfile
import threading
from typing import NamedTuple

import mujoco
import numpy as np
import yaml

from draft.generation.generator import RobotGenerator
from draft.trends.feasibility import FeasibilityViolation, motor_fits
from draft.generation import packing as draft_packing

SERVICE = Path(__file__).resolve().parent
PROJECT = SERVICE.parent
CONTRACTS = PROJECT / 'contracts'
SCHEMA_FILE = CONTRACTS / 'design.schema.json'
DRAFT = Path(os.environ.get('DRAFT_ROOT', PROJECT / '.deps/draft')).resolve()
QUADRUPED_DIR = DRAFT / 'src/draft/robots/quadruped'
PRESET_DIR = DRAFT / 'experiments/quadruped_variants'
MULTILEG_DIR = PROJECT / 'robots/multileg'
FLOWER_DIR = PROJECT / 'robots/flower'
TEMPLATES_DIR = SERVICE / 'templates'
SHOWCASE_FILE = TEMPLATES_DIR / 'showcase.json'
# Committed showcase/legacy bodies, and the git-ignored runtime work directory.
SHOWCASE_DIR = PROJECT / 'creatures'
GENERATED_DIR = Path(os.environ.get('CREATURE_BODY_DIR', SERVICE / '.bodies')).resolve()

DESIGN_SCHEMA = 'creature-design/1'
BODY_SCHEMA = 'creature-body/1'
# Version of everything derived after Draft (stance, trainability, spec sheet, body.json
# layout). It is NOT part of bodyId: the mechanism does not change when it is bumped,
# so cached bodies just get a fresh body.json.
DESIGNS_VERSION = 1
MAX_GENERATED = 48
MAX_REQUEST_BYTES = 16384
GRAVITY = 9.81
LOCK = threading.RLock()
LOG = logging.getLogger('draft-service.designs')

BODY_ID_RE = re.compile(r'(quadruped|multileg)-[0-9a-f]{16}')
BODY_FILES = ('body.xml', 'body.json', 'feasibility_report.yaml', 'parameters_resolved.yaml')
POLICY_SKILLS = ('walk', 'jump')
POLICY_FILES = ('manifest.json', 'policy.onnx', 'scene.xml', 'eval.json', 'fixtures.json', 'progress.json')
MESH_NAME_RE = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}\.stl')

# ── Trainability thresholds (documented in draft-service/DESIGNS.md) ──────────
STAND_LOAD_WARN = 0.5        # fraction of peak torque needed to stand on all feet
STAND_LOAD_FAIL = 1.0
GAIT_LOAD_WARN = 0.9         # same, with only the stance group of the gait hint loaded
TIPPY_MARGIN_M = 0.02        # COM to support-polygon edge, all feet down
LOW_BELLY_M = 0.03
SLOW_JOINT_RAD_S = 6.0
JUMP_STRONG, JUMP_OK, JUMP_WEAK = 5.0, 3.0, 2.0   # sum of max vertical foot forces / weight
SETTLE_SECONDS = 2.0
SETTLE_SAG_WARN, SETTLE_SAG_FAIL, SETTLE_TILT_FAIL = 0.08, 0.25, 0.35
# PD hold test: kp = effort / this angle. Stiff enough that sag measures torque
# saturation rather than servo compliance, soft enough to stay stable at dt = 0.005.
HOLD_KP_SATURATION_RAD = 0.15
# Stance and clearance tolerances (stated in body.json and DESIGNS.md).
FOOT_HEIGHT_TOL_M = 1e-4
LEVEL_TOL_RAD = 1e-6
JOINT_MARGIN_FRACTION = 0.10
MIN_BELLY_CLEARANCE_M = 0.01
# Nominal stance candidates, most crouched (preferred) first. The solver keeps the
# first whose equal-share stand load is comfortable, else the least loaded, so strong
# bodies keep a springy crouch and weak or tall ones stand straighter.
# Quadruped: foot straight below the hip-pitch axis with this knee bend (rad); a fixed
# bend (not a fixed extension) keeps the knee clear of the ground for any thigh/shank
# ratio (equal segments at -1.1 stand at ~85% extension; legacy Cheetah policy: -1.0).
QUADRUPED_KNEES = (-1.1, -0.9, -0.7, -0.5)
QUADRUPED_KNEE = QUADRUPED_KNEES[0]
# Multileg (hip pitch, knee): the Flower stance first, then the thigh lowered with the
# shank kept ~80 deg below horizontal, which shortens the hip-pitch lever arm.
MULTILEG_STANCES = ((0.15, 1.25), (0.35, 1.05), (0.55, 0.85))
MULTILEG_STANCE = MULTILEG_STANCES[0]
STANCE_COMFORT_LOAD = 0.45

# Collision classes from docs/v2/PLAN.md, used by the PD hold test only.
CONTACT_BITS = {'feet': (2, 9), 'torso': (4, 9), 'limbs': (4, 9), 'motors': (4, 9), 'details': (0, 0)}


class DesignError(ValueError):
    """The request is not a valid DesignSpec (HTTP 400)."""

    def __init__(self, issues: list[dict]):
        self.issues = issues
        super().__init__('; '.join(f"{i['field']}: {i['message']}" for i in issues))


class DesignInfeasible(Exception):
    """A valid design that Draft's gate or a lab gate refuses (HTTP 422)."""

    def __init__(self, gate: str, message: str, hints: list[dict], violations: list[str] | None = None):
        self.gate, self.message, self.hints = gate, message, hints
        self.violations = violations or [message]
        super().__init__(message)

    def payload(self, design: dict | None = None) -> dict:
        out = {'error': 'infeasible-design', 'gate': self.gate, 'message': self.message,
               'hints': self.hints, 'violations': self.violations[:12]}
        if design is not None:
            out['design'] = design
        return out


def _hint(field: str, direction: str, reason: str, value=None) -> dict:
    """A revision hint; `value` (when known) is a schema-valid value that clears the gate."""
    out = {'field': field, 'direction': direction, 'reason': reason}
    if value is not None:
        out['value'] = value
    return out


# ── Schema and validation ──────────────────────────────────────────────────────

_JSON_CACHE: dict[Path, tuple] = {}


def _load_json(path: Path) -> dict:
    """Parse a contract file once per modification (ai-service may edit them live)."""
    stat = path.stat()
    key = (stat.st_mtime_ns, stat.st_size)
    cached = _JSON_CACHE.get(path)
    if cached and cached[0] == key:
        return cached[1]
    value = json.loads(path.read_text())
    _JSON_CACHE[path] = (key, value)
    return value


def design_schema() -> dict:
    return _load_json(SCHEMA_FILE)


def _is_number(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _type_ok(value, kind: str) -> bool:
    if kind == 'object':
        return isinstance(value, dict)
    if kind == 'array':
        return isinstance(value, list)
    if kind == 'string':
        return isinstance(value, str)
    if kind == 'boolean':
        return type(value) is bool
    if kind == 'number':
        return _is_number(value)
    if kind == 'integer':
        return _is_number(value) and float(value).is_integer()
    if kind == 'null':
        return value is None
    return True


def _same(a, b) -> bool:
    """JSON equality without Python's True == 1."""
    return type(a) is type(b) and a == b or (_is_number(a) and _is_number(b) and a == b)


def _resolve_ref(ref: str, root: dict) -> tuple[dict, dict]:
    if ref.startswith('#/'):
        node = root
        for part in ref[2:].split('/'):
            node = node[part]
        return node, root
    target = (SCHEMA_FILE.parent / ref).resolve()
    if target.parent != CONTRACTS.resolve() or not target.is_file():
        raise ValueError(f'unsupported schema reference {ref!r}')
    loaded = _load_json(target)
    return loaded, loaded


def _validate(value, schema: dict, root: dict, path: str, issues: list) -> None:
    """Subset of JSON Schema 2020-12 used by the contracts; unknown keywords are ignored."""
    def fail(message):
        issues.append({'field': path or '(root)', 'message': message})

    if '$ref' in schema:
        target, target_root = _resolve_ref(schema['$ref'], root)
        _validate(value, target, target_root, path, issues)
    kind = schema.get('type')
    if kind and not _type_ok(value, kind):
        fail(f'must be {"an" if kind[0] in "aeiou" else "a"} {kind}')
        return
    if 'const' in schema and not _same(value, schema['const']):
        fail(f'must be {json.dumps(schema["const"])}')
    if 'enum' in schema and not any(_same(value, option) for option in schema['enum']):
        fail('must be one of ' + ', '.join(json.dumps(o) for o in schema['enum']))
        return
    if _is_number(value) and type(value) is not bool:
        if 'minimum' in schema and value < schema['minimum']:
            fail(f'must be at least {schema["minimum"]}')
        if 'maximum' in schema and value > schema['maximum']:
            fail(f'must be at most {schema["maximum"]}')
        if 'exclusiveMinimum' in schema and value <= schema['exclusiveMinimum']:
            fail(f'must be greater than {schema["exclusiveMinimum"]}')
        if 'exclusiveMaximum' in schema and value >= schema['exclusiveMaximum']:
            fail(f'must be less than {schema["exclusiveMaximum"]}')
    if isinstance(value, str):
        if 'minLength' in schema and len(value) < schema['minLength']:
            fail(f'must have at least {schema["minLength"]} characters')
        if 'maxLength' in schema and len(value) > schema['maxLength']:
            fail(f'must have at most {schema["maxLength"]} characters')
        if 'pattern' in schema and not re.search(schema['pattern'], value):
            fail('has an invalid format')
    if isinstance(value, list):
        if 'minItems' in schema and len(value) < schema['minItems']:
            fail(f'needs at least {schema["minItems"]} items')
        if 'maxItems' in schema and len(value) > schema['maxItems']:
            fail(f'allows at most {schema["maxItems"]} items')
        if schema.get('uniqueItems'):
            seen = [json.dumps(v, sort_keys=True) for v in value]
            if len(seen) != len(set(seen)):
                fail('items must be unique')
        if isinstance(schema.get('items'), dict):
            for index, item in enumerate(value):
                _validate(item, schema['items'], root, f'{path}[{index}]', issues)
    if isinstance(value, dict):
        for key in schema.get('required', []):
            if key not in value:
                issues.append({'field': f'{path}.{key}' if path else key, 'message': 'is required'})
        properties = schema.get('properties', {})
        extra = schema.get('additionalProperties', True)
        for key, item in value.items():
            child = f'{path}.{key}' if path else str(key)
            if key in properties:
                _validate(item, properties[key], root, child, issues)
            elif extra is False:
                issues.append({'field': child, 'message': 'is not a known field'})
            elif isinstance(extra, dict):
                _validate(item, extra, root, child, issues)


# Rounding makes trivially different requests share one body (1 mm, 0.01 strength).
_ROUNDING = {'strength': 2, 'bodyAspect': 2}


def validate_design(payload) -> dict:
    """Return a normalised copy of a valid DesignSpec or raise DesignError."""
    if not isinstance(payload, dict):
        raise DesignError([{'field': '(root)', 'message': 'send a JSON object (creature-design/1)'}])
    if len(json.dumps(payload, ensure_ascii=False, default=str)) > MAX_REQUEST_BYTES:
        raise DesignError([{'field': '(root)', 'message': f'design JSON must be under {MAX_REQUEST_BYTES} bytes'}])
    schema = design_schema()
    issues: list[dict] = []
    _validate(payload, schema, schema, '', issues)
    if issues:
        raise DesignError(issues)
    design = copy.deepcopy(payload)
    design['name'] = design['name'].strip()
    if not design['name']:
        raise DesignError([{'field': 'name', 'message': 'must not be blank'}])
    plan = design['bodyPlan']
    other = 'multileg' if plan == 'quadruped' else 'quadruped'
    if other in design:
        issues.append({'field': other, 'message': f'only allowed when bodyPlan is {other}'})
    preset = design.get('basePreset')
    if preset is not None and (preset == 'flower') != (plan == 'multileg'):
        allowed = 'flower' if plan == 'multileg' else 'cheetah, bear or giraffe'
        issues.append({'field': 'basePreset', 'message': f'{preset} is not a {plan} preset; use {allowed}'})
    block = design.get(plan) or {}
    if plan == 'multileg':
        count = block.get('legCount')
        if count is not None:
            block['legCount'] = int(count)
        if block.get('arrangement') == 'bilateral' and block.get('legCount', 6) % 2:
            issues.append({'field': 'multileg.legCount', 'message': 'bilateral bodies need an even leg count (4, 6 or 8)'})
    if issues:
        raise DesignError(issues)
    for key, value in list(block.items()):
        if _is_number(value) and key != 'legCount':
            block[key] = round(float(value), _ROUNDING.get(key, 3))
    if plan in design:
        design[plan] = block
    if 'skills' in design:
        design['skills'] = sorted(design['skills'], key=lambda s: ('walk', 'jump').index(s))
    return design


# ── Actuator families and template mapping ─────────────────────────────────────

# Rated operating points restated from Draft's catalogue rows (datasets/actuators);
# friction/damping are asserted gearbox losses, as in Draft's experiment presets.
# allowHypothetical is False everywhere: a design beyond the catalogued frontier is
# refused (HTTP 422 with a hint), never silently promoted to an imaginary motor.
FAMILIES = {
    'quadruped': {
        'micro': {'label': 'Micro QDD (hobby class)', 'anchor': 'CyberGear MS01', 'category': 'QDD',
                  'effort': 12.0, 'velocity': 25.13, 'gear': 7.75, 'friction': 0.02, 'damping': 0.003,
                  'palette': 'micro', 'allowHypothetical': False},
        'qdd': {'label': 'Quasi-direct drive (MIT U12 class, Cheetah preset)', 'anchor': 'MIT U12', 'category': 'QDD',
                'effort': 72.0, 'velocity': 40.0, 'gear': 6.0, 'friction': 0.127, 'damping': 0.0127,
                'palette': 'qdd', 'allowHypothetical': False},
        'geared': {'label': 'Planetary geared (MyActuator RMD-X15, Bear preset)', 'anchor': 'RMD-X15-P20-450-E',
                   'category': 'MidGear', 'effort': 450.0, 'velocity': 11.31, 'gear': 20.25,
                   'friction': 0.300, 'damping': 0.0400, 'palette': 'geared', 'allowHypothetical': False},
        'harmonic': {'label': 'Harmonic strain-wave (ZeroErr eRob110H, Giraffe preset)', 'anchor': 'eRob110H-80',
                     'category': 'Harmonic', 'effort': 332.0, 'velocity': 3.93, 'gear': 80.0,
                     'friction': 0.294, 'damping': 0.0420, 'palette': 'harmonic', 'allowHypothetical': False},
    },
    'multileg': {
        'micro': {'label': 'Micro QDD (hobby class)', 'anchor': 'CyberGear MS01', 'category': 'QDD',
                  'effort': 12.0, 'velocity': 25.13, 'gear': 7.75, 'aspect': 0.6, 'friction': 0.02,
                  'damping': 0.003, 'palette': 'micro', 'allowHypothetical': False},
        'qdd': {'label': 'Quasi-direct drive (MIT Mini Cheetah U8 class)', 'anchor': 'MIT Mini Cheetah (U8)',
                'category': 'QDD', 'effort': 17.0, 'velocity': 40.0, 'gear': 6.0, 'aspect': 0.6,
                'friction': 0.03, 'damping': 0.003, 'palette': 'qdd', 'allowHypothetical': False},
        # Only reachable through basePreset=flower without an actuator: the Flower's own
        # trend-sized 12 Nm class (no catalogue anchor, ALL-category frontier).
        'flower': {'label': 'Flower crawler class (trend-sized, no catalogue anchor)', 'anchor': None,
                   'category': 'ALL', 'effort': 12.0, 'velocity': 20.0, 'gear': 12.0, 'aspect': 0.6,
                   'friction': 0.02, 'damping': 0.003, 'palette': 'flower', 'allowHypothetical': False},
    },
}
PRESET_FAMILY = {'cheetah': 'qdd', 'bear': 'geared', 'giraffe': 'harmonic', 'flower': 'flower'}
# Without basePreset a quadruped borrows the proportions of its family's archetype.
QUADRUPED_ARCHETYPE = {'qdd': 'cheetah', 'geared': 'bear', 'harmonic': 'giraffe', 'micro': None}
# The micro archetype ("pup"): Draft's quadruped template with these proportions.
MICRO_QUADRUPED = {'torso_lx': 0.30, 'torso_ly': 0.16, 'torso_lz': 0.10, 'shoulder_width': 0.10,
                   'hip_roll_link_length': 0.06, 'upper_leg_link_length': 0.15,
                   'lower_leg_link_length': 0.15, 'hip_roll_mot': 'L', 'hip_pitch_mot': 'L', 'knee_mot': 'L'}
PALETTES = {
    'qdd': ('0.424 0.547 0.746 1.000', '0.155 0.232 0.359 1.000', '0.095 0.143 0.221 1.000',
            '0.298 0.447 0.690 1.000', '0.302 0.302 0.302 1.000'),
    'geared': ('0.891 0.605 0.444 1.000', '0.451 0.269 0.167 1.000', '0.277 0.166 0.103 1.000',
               '0.867 0.518 0.322 1.000', '0.302 0.302 0.302 1.000'),
    'harmonic': ('0.453 0.720 0.514 1.000', '0.173 0.343 0.212 1.000', '0.107 0.211 0.131 1.000',
                 '0.333 0.659 0.408 1.000', '0.302 0.302 0.302 1.000'),
    'micro': ('0.600 0.500 0.760 1.000', '0.250 0.210 0.360 1.000', '0.150 0.120 0.220 1.000',
              '0.540 0.420 0.720 1.000', '0.302 0.302 0.302 1.000'),
    'flower': ('0.25 0.56 0.44 1', '0.22 0.29 0.29 1', '0.79 0.58 0.30 1', '0.84 0.40 0.48 1', '0.25 0.31 0.30 1'),
}
QUADRUPED_FIELDS = {'torsoLength': 'torso_lx', 'torsoWidth': 'torso_ly', 'torsoHeight': 'torso_lz',
                    'shoulderWidth': 'shoulder_width', 'hipOffset': 'hip_roll_link_length',
                    'upperLeg': 'upper_leg_link_length', 'lowerLeg': 'lower_leg_link_length'}
MULTILEG_FIELDS = {'bodyRadius': 'body_radius', 'bodyAspect': 'body_aspect', 'coxa': 'coxa_length',
                   'upperLeg': 'upper_leg_length', 'lowerLeg': 'lower_leg_length'}
# The Flower's proportions as multileg design values (robots/flower/parameters.yaml).
FLOWER_DESIGN = {'legCount': 6, 'arrangement': 'radial', 'bodyRadius': 0.145, 'bodyAspect': 1.0,
                 'coxa': 0.09, 'upperLeg': 0.18, 'lowerLeg': 0.22}
BILATERAL_SPREAD = math.pi / 4        # front pair at 45 deg, rear pair at 135 deg
YAW_RANGE_LIMITS = (0.30, 0.75)       # hip-yaw half range bounds (rad)
YAW_RANGE_SHARE = 0.6                 # of the angular gap to the nearest neighbouring leg

TEMPLATES = {
    'quadruped': {'kind': 'quadruped', 'dir': QUADRUPED_DIR, 'xml': 'quadruped.xml',
                  'files': ('parameters.yaml', 'tree.yaml', 'mesh.yaml')},
    'multileg': {'kind': 'multileg', 'dir': MULTILEG_DIR, 'xml': 'multileg.xml',
                 'files': ('parameters.yaml', 'tree.yaml', 'mesh.yaml')},
    'flower-legacy': {'kind': 'multileg', 'dir': FLOWER_DIR, 'xml': 'flower.xml',
                      'files': ('parameters.yaml', 'tree.yaml', 'mesh.yaml', 'generate.py')},
}


def _yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {}


def preset_overlay(preset: str) -> dict:
    """Draft's experiment YAML for a quadruped preset, exactly as /api/generate loads it."""
    return _yaml(PRESET_DIR / f'{preset}.yaml')


def _family_params(family: dict) -> dict:
    out = {'L_motor': family['anchor'], 'L_motor_effort': family['effort'],
           'L_motor_velocity': family['velocity'], 'L_motor_gear': family['gear'],
           'L_motor_friction': family['friction'], 'L_motor_damping': family['damping']}
    if family.get('aspect'):
        out['L_motor_aspect'] = family['aspect']
    link, motor, detail, torso, foot = PALETTES[family['palette']]
    out.update(link_color=link, motor_color=motor, mot_detail_color=detail, torso_color=torso, foot_color=foot)
    return out


def _apply_strength(overrides: dict, strength) -> None:
    """Scale peak torque; asserted gearbox losses scale with it (as across the presets)."""
    if strength is None or strength == 1:
        return
    for key in ('L_motor_effort', 'L_motor_friction', 'L_motor_damping'):
        overrides[key] = round(float(overrides[key]) * float(strength), 6)


def leg_layout(count: int, arrangement: str, aspect: float) -> list[dict]:
    """Leg directions and hub wall points (units of the hub half-width), CCW from +X.

    radial: legs evenly spaced in direction. bilateral: pairs whose directions spread
    from 45 deg (front) to 135 deg (rear) on each side. Each leg sits where the hub
    ellipse's outward normal points along the leg, so mounts face straight out.
    """
    if arrangement == 'radial':
        angles = [2 * math.pi * i / count for i in range(count)]
    else:
        pairs = count // 2
        left = [math.pi / 2 - BILATERAL_SPREAD + 2 * BILATERAL_SPREAD * i / (pairs - 1) for i in range(pairs)]
        angles = sorted(left + [2 * math.pi - a for a in left])
    a, b = float(aspect), 1.0
    legs = []
    for index, theta in enumerate(angles):
        t = math.atan2(b * math.sin(theta), a * math.cos(theta))
        yaw = math.atan2(math.sin(theta), math.cos(theta))
        legs.append({'index': index, 'name': f'leg{index}',
                     'ux': round(math.cos(t), 12) + 0.0, 'uy': round(math.sin(t), 12) + 0.0,
                     'nx': round(math.cos(theta), 12) + 0.0, 'ny': round(math.sin(theta), 12) + 0.0,
                     'yaw': round(yaw, 12) + 0.0})
    return legs


def yaw_half_range(legs: list[dict]) -> float:
    """Neighbouring legs may each sweep YAW_RANGE_SHARE of the gap between them."""
    angles = sorted(math.atan2(l['ny'], l['nx']) % (2 * math.pi) for l in legs)
    gaps = [(angles[(i + 1) % len(angles)] - angles[i]) % (2 * math.pi) for i in range(len(angles))]
    lo, hi = YAW_RANGE_LIMITS
    return round(min(hi, max(lo, YAW_RANGE_SHARE * min(gaps))), 4)


def _template_defaults(name: str) -> dict:
    return _yaml(TEMPLATES[name]['dir'] / 'parameters.yaml')


def plan_design(design: dict) -> dict:
    """Map a validated DesignSpec onto a Draft template and its exact overrides."""
    if design['bodyPlan'] == 'quadruped':
        return _plan_quadruped(design)
    return _plan_multileg(design)


def _plan_quadruped(design: dict) -> dict:
    block = design.get('quadruped') or {}
    preset = design.get('basePreset')
    family = block.get('actuator')
    if preset:
        base_name, base_family = preset, PRESET_FAMILY[preset]
        overrides = preset_overlay(preset)
    else:
        family = family or 'qdd'
        base_name = QUADRUPED_ARCHETYPE[family]
        base_family = family if base_name else None
        overrides = preset_overlay(base_name) if base_name else dict(MICRO_QUADRUPED)
    effective = family or base_family
    if effective != base_family:
        overrides.update(_family_params(FAMILIES['quadruped'][effective]))
    _apply_strength(overrides, block.get('strength'))
    for field, key in QUADRUPED_FIELDS.items():
        if field in block:
            overrides[key] = float(block[field])
    overrides['allow_hypothetical'] = FAMILIES['quadruped'][effective]['allowHypothetical']
    legacy = preset if preset and overrides == {**preset_overlay(preset), 'allow_hypothetical': False} else None
    defaults = _template_defaults('quadruped')
    resolved = {field: float(overrides.get(key, defaults.get(key))) for field, key in QUADRUPED_FIELDS.items()}
    resolved.update(actuator=effective, strength=float(block.get('strength', 1.0)))
    return {'template': 'quadruped', 'kind': 'quadruped', 'overrides': overrides, 'family': effective,
            'familyTable': FAMILIES['quadruped'][effective], 'basePreset': preset, 'archetype': base_name,
            'legacy': legacy, 'resolved': resolved, 'legNames': ['fl', 'fr', 'rl', 'rr']}


def _plan_multileg(design: dict) -> dict:
    block = design.get('multileg') or {}
    preset = design.get('basePreset')
    defaults = dict(FLOWER_DESIGN) if preset == 'flower' else {
        'legCount': 6, 'arrangement': 'radial', **{f: _template_defaults('multileg')[k] for f, k in MULTILEG_FIELDS.items()}}
    values = {**defaults, **{k: v for k, v in block.items() if k not in ('actuator', 'strength')}}
    family = block.get('actuator') or ('flower' if preset == 'flower' else 'micro')
    strength = block.get('strength')
    resolved = {**values, 'actuator': family, 'strength': float(strength if strength is not None else 1.0)}
    if (preset == 'flower' and family == 'flower' and resolved['strength'] == 1.0
            and all(float(values[k]) == float(FLOWER_DESIGN[k]) if k not in ('legCount', 'arrangement')
                    else values[k] == FLOWER_DESIGN[k] for k in FLOWER_DESIGN)):
        # The unmodified Flower is the legacy body (robots/flower/generate.py, byte-identical
        # to /api/generate) so its validated walking policy keeps matching.
        return {'template': 'flower-legacy', 'kind': 'multileg', 'overrides': {}, 'family': 'flower',
                'familyTable': FAMILIES['multileg']['flower'], 'basePreset': preset, 'archetype': 'flower',
                'legacy': 'flower', 'resolved': resolved,
                'legs': leg_layout(6, 'radial', 1.0), 'arrangement': 'radial'}
    legs = leg_layout(int(values['legCount']), values['arrangement'], float(values['bodyAspect']))
    overrides = _family_params(FAMILIES['multileg'][family])
    _apply_strength(overrides, strength)
    for field, key in MULTILEG_FIELDS.items():
        overrides[key] = float(values[field])
    half = yaw_half_range(legs)
    overrides.update(legs=legs, hip_yaw_range=[-half, half],
                     allow_hypothetical=FAMILIES['multileg'][family]['allowHypothetical'])
    return {'template': 'multileg', 'kind': 'multileg', 'overrides': overrides, 'family': family,
            'familyTable': FAMILIES['multileg'][family], 'basePreset': preset, 'archetype': preset,
            'legacy': None, 'resolved': resolved, 'legs': legs, 'arrangement': values['arrangement']}


# ── Identity ───────────────────────────────────────────────────────────────────

_FILE_DIGESTS: dict[Path, tuple] = {}


def _file_digest(path: Path) -> str:
    stat = path.stat()
    key = (stat.st_mtime_ns, stat.st_size)
    cached = _FILE_DIGESTS.get(path)
    if cached and cached[0] == key:
        return cached[1]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    _FILE_DIGESTS[path] = (key, digest)
    return digest


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def draft_revision() -> str:
    """Read the pinned Draft checkout's HEAD without running git."""
    git = DRAFT / '.git'
    try:
        head = (git / 'HEAD').read_text().strip()
        if not head.startswith('ref: '):
            return head
        ref = head[5:]
        if (git / ref).is_file():
            return (git / ref).read_text().strip()
        packed = git / 'packed-refs'
        if packed.is_file():
            for line in packed.read_text().splitlines():
                if line.endswith(' ' + ref):
                    return line.split()[0]
    except OSError:
        pass
    return 'unknown'


def _draft_sources() -> list[Path]:
    root = DRAFT / 'src/draft'
    return (sorted((root / 'generation').glob('*.py')) + sorted((root / 'trends').glob('*.py'))
            + sorted((root / 'trends/data').glob('*.json')))


def template_sources(plan: dict) -> dict:
    template = TEMPLATES[plan['template']]
    return {f'{plan["template"]}/{name}': _file_digest(template['dir'] / name) for name in template['files']}


def body_id(plan: dict) -> str:
    digest = hashlib.sha256()
    digest.update(json.dumps({'contract': BODY_SCHEMA, 'template': plan['template'],
                              'overrides': plan['overrides'], 'draftRevision': draft_revision()},
                             sort_keys=True, separators=(',', ':')).encode())
    for name, value in sorted(template_sources(plan).items()):
        digest.update(f'{name}={value}'.encode())
    for path in _draft_sources():
        digest.update(f'{path.name}={_file_digest(path)}'.encode())
    return f"{plan['kind']}-{digest.hexdigest()[:16]}"


# ── Generation and gates ───────────────────────────────────────────────────────

def _run_draft(plan: dict, output: Path) -> None:
    """Run the real generator; FeasibilityViolation becomes a structured DesignInfeasible."""
    log = io.StringIO()
    try:
        with redirect_stdout(log), redirect_stderr(log):
            if plan['template'] == 'flower-legacy':
                spec = importlib.util.spec_from_file_location('local_flower_generator', FLOWER_DIR / 'generate.py')
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                module.generate_model(output, 1.0, 1.0)
            else:
                RobotGenerator(TEMPLATES[plan['template']]['dir']).generate(
                    output, params_override=copy.deepcopy(plan['overrides']), strict=True)
    except FeasibilityViolation as error:
        raise _draft_infeasible(list(error.messages), plan) from None
    except DesignInfeasible:
        raise
    except Exception as error:  # Draft or MuJoCo refused the geometry itself
        LOG.warning('Draft generation error for %s: %s\n%s', plan['template'], error, log.getvalue()[-2000:])
        raise DesignInfeasible('draft-error', f'Draft could not build this geometry: {str(error)[:300]}',
                               _generic_hints(plan)) from None


def _generic_hints(plan: dict) -> list[dict]:
    block = plan['kind']
    if block == 'quadruped':
        return [_hint('quadruped.hipOffset', 'increase', 'gives the hip and knee actuators more room'),
                _hint('quadruped.strength', 'decrease', 'smaller torque means smaller actuators')]
    return [_hint('multileg.coxa', 'increase', 'gives the hip actuators more room'),
            _hint('multileg.strength', 'decrease', 'smaller torque means smaller actuators')]


def _limits(plan: dict, field: str) -> tuple:
    spec = design_schema()['properties'][plan['kind']]['properties'][field]
    return spec.get('minimum'), spec.get('maximum')


def _raise_to(plan: dict, field: str, needed: float):
    """Smallest value on a 5 mm grid that is >= needed and inside the schema, else None."""
    lo, hi = _limits(plan, field)
    value = round(math.ceil(round(needed / 0.005, 6)) * 0.005, 3)
    if lo is not None:
        value = max(value, lo)
    return value if hi is None or value <= hi + 1e-9 else None


def _max_strength(plan: dict):
    """Largest strength (0.05 steps) whose actuator class passes Draft's frontier check."""
    from draft.generation.generator import size_actuators
    from draft.trends.motor_catalog import resolve_catalog_motors
    params = {**_template_defaults(plan['template']), **plan['overrides']}
    current = float(plan['resolved'].get('strength', 1.0))
    base = {key: params[key] / current for key in ('L_motor_effort',)}

    def passes(strength: float) -> bool:
        trial = {k: v for k, v in params.items() if k.startswith(('L_motor', '_L_motor'))}
        trial.update(L_motor_effort=base['L_motor_effort'] * strength, allow_hypothetical=False)
        _, report = size_actuators(resolve_catalog_motors(trial), strict=False)
        return not report['errors']

    lo_limit, hi_limit = _limits(plan, 'strength')
    candidates = [round(s / 20, 2) for s in range(int(lo_limit * 20), int(round(current * 20)))]
    feasible = [s for s in candidates if s < current and passes(s)]
    return max(feasible) if feasible else None


_PACKING_FIELDS = {('quadruped', 'knee'): 'hipOffset', ('multileg', 'hip_yaw'): 'coxa',
                   ('multileg', 'knee'): 'upperLeg'}
_PACKING_REASONS = {'hipOffset': 'the hip-pitch and knee actuators share the lateral hip link and need its length',
                    'coxa': 'the coxa must hold the hip-yaw and hip-pitch actuators apart',
                    'upperLeg': 'the thigh must hold the hip-pitch and knee actuators apart'}


def _draft_infeasible(messages: list[str], plan: dict) -> DesignInfeasible:
    block = plan['kind']
    text = '\n'.join(messages)
    first = messages[0] if messages else 'Draft refused the design.'
    hints: list[dict] = []
    if 'beats the best catalogued' in text:
        gate = 'actuator-frontier'
        hints.append(_hint(f'{block}.strength', 'decrease',
                           'the requested torque would make this actuator denser than any catalogued part of its family',
                           _max_strength(plan)))
        if 'power density' in text and block == 'quadruped':
            hints.append(_hint('quadruped.actuator', 'change',
                               'power density binds: geared or harmonic families trade speed for torque'))
        elif block == 'multileg':
            hints.append(_hint('multileg.actuator', 'change', 'the micro family has more headroom on the frontier'))
    elif 'actuator packing' in text:
        gate = 'actuator-packing'
        needed: dict[str, float] = {}
        for _a, _b, role_a, role_b, depth in re.findall(
                r'actuator packing: (\S+) and (\S+) \((\w+) → (\w+)\) interpenetrate by ([\d.]+) mm', text):
            field = _PACKING_FIELDS.get((block, role_b)) or _PACKING_FIELDS.get((block, role_a))
            if field:
                needed[field] = max(needed.get(field, 0.0), float(depth) / 1000)
        for field, depth in needed.items():
            current = float(plan['resolved'][field])
            hints.append(_hint(f'{block}.{field}', 'increase', _PACKING_REASONS[field],
                               _raise_to(plan, field, current + depth + 0.003)))
        hints.append(_hint(f'{block}.strength', 'decrease', 'weaker actuators are physically smaller'))
    elif 'inside the root mesh' in text:
        gate = 'actuator-in-structure'
        if block == 'quadruped':
            hints += [_hint('quadruped.torsoWidth', 'decrease', 'a narrower trunk keeps the hip actuators outside it'),
                      _hint('quadruped.shoulderWidth', 'increase', 'moves the hip actuators outboard')]
        else:
            hints.append(_hint('multileg.bodyRadius', 'decrease', 'keeps the hub clear of the hip actuators'))
    elif 'link_rho' in text:
        gate = 'structure-density'
    else:
        gate = 'draft'
    if not hints:
        hints = _generic_hints(plan)
    return DesignInfeasible(gate, first, hints, messages)


def _motor_boxes(model, data, exempt: set[str]) -> list[dict]:
    """Every actuator cylinder (minus Draft's packing exemptions) as an oriented box."""
    out = []
    for g in range(model.ngeom):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, g) or ''
        if (not name.endswith('_motor') or name in exempt
                or model.geom_type[g] != mujoco.mjtGeom.mjGEOM_CYLINDER):
            continue
        r, half = float(model.geom_size[g][0]), float(model.geom_size[g][1])
        out.append({'name': name, 'body': int(model.geom_bodyid[g]), 'center': data.geom_xpos[g].copy(),
                    'R': data.geom_xmat[g].reshape(3, 3).copy(), 'half': np.array([r, r, half])})
    return out


def _rigid_root(model, body: int) -> int:
    """Nearest ancestor (or self) that has a joint: bodies sharing it move together."""
    while body > 0 and model.body_jntnum[body] == 0:
        body = int(model.body_parentid[body])
    return body


def rigid_packing_gate(model, resolved: dict) -> list[str]:
    """Actuators welded to one rigid body that interpenetrate: no joint can separate them.

    Draft's own packing gate treats actuators on different branches as a soft,
    neutral-pose warning; for housings bolted to the same body that is a real clash
    (e.g. neighbouring hip-yaw motors on a small multileg hub). Geoms Draft exempts
    from packing (the quadruped's weightless knee pulleys) are exempt here too.
    """
    data = mujoco.MjData(model)
    mujoco.mj_kinematics(model, data)
    boxes = _motor_boxes(model, data, set(resolved.get('packing_exempt_geoms') or ()))
    clashes = []
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            if a['body'] == b['body'] or _rigid_root(model, a['body']) != _rigid_root(model, b['body']):
                continue
            hit = draft_packing.overlap(a, b)
            if hit:
                clashes.append({'a': a['name'], 'b': b['name'], 'depthM': float(hit['depth_m']),
                                'message': f"actuators {a['name']} and {b['name']} are fixed to the same rigid body "
                                           f"and interpenetrate by {hit['depth_m'] * 1e3:.1f} mm"})
    return clashes


def _hub_radius_needed(plan: dict, resolved: dict):
    """Smallest bodyRadius (5 mm steps, within the schema) whose hip-yaw housings all clear."""
    r, length = float(resolved['L_motor_r']), float(resolved['L_motor_L'])
    offset = float(resolved['mount_gap']) + float(resolved['mount_link_length'])
    aspect = float(plan['resolved']['bodyAspect'])
    _, hi = _limits(plan, 'bodyRadius')
    radius = float(plan['resolved']['bodyRadius'])
    while radius <= hi + 1e-9:
        boxes = []
        for leg in plan['legs']:
            c, s = math.cos(leg['yaw']), math.sin(leg['yaw'])
            boxes.append({'name': leg['name'],
                          'center': np.array([radius * aspect * leg['ux'] + offset * leg['nx'],
                                              radius * leg['uy'] + offset * leg['ny'], 0.0]),
                          'R': np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]),
                          'half': np.array([r, r, length / 2])})
        if not any(draft_packing.overlap(a, b) for i, a in enumerate(boxes) for b in boxes[i + 1:]):
            return round(radius, 3)
        radius = round(radius + 0.005, 3)
    return None


def _rigid_infeasible(clashes: list[dict], plan: dict, resolved: dict) -> DesignInfeasible:
    messages = [c['message'] for c in clashes]
    if plan['kind'] == 'multileg':
        hints = [_hint('multileg.bodyRadius', 'increase', 'spreads the hip-yaw actuators around a larger hub',
                       _hub_radius_needed(plan, resolved)),
                 _hint('multileg.legCount', 'decrease', 'fewer legs leave more room per hip'),
                 _hint('multileg.strength', 'decrease', 'weaker actuators are physically smaller')]
        if plan['resolved']['arrangement'] == 'bilateral':
            hints.insert(1, _hint('multileg.bodyAspect', 'increase', 'a longer body spaces the side legs further apart'))
        elif plan['resolved']['bodyAspect'] > 1.0:
            hints.insert(1, _hint('multileg.bodyAspect', 'decrease', 'radial legs bunch up at the ends of a long hub'))
    else:
        lateral = max((c['depthM'] for c in clashes if c['a'][1] != c['b'][1]), default=0.0)   # fl vs fr
        axial = max((c['depthM'] for c in clashes if c['a'][0] != c['b'][0]), default=0.0)     # fl vs rl
        hints = []
        if lateral:
            hints.append(_hint('quadruped.shoulderWidth', 'increase', 'separates the left and right hip actuators',
                               _raise_to(plan, 'shoulderWidth', plan['resolved']['shoulderWidth'] + lateral + 0.003)))
        if axial:
            hints.append(_hint('quadruped.torsoLength', 'increase', 'separates the front and rear hip actuators',
                               _raise_to(plan, 'torsoLength', plan['resolved']['torsoLength'] + axial + 0.003)))
        hints.append(_hint('quadruped.strength', 'decrease', 'weaker actuators are physically smaller'))
    return DesignInfeasible('actuator-packing', messages[0], hints, messages)


# ── Body description (legs, joints, roles) ─────────────────────────────────────

def _name(model, kind, index) -> str:
    return mujoco.mj_id2name(model, kind, index) or ''


def _id(model, kind, name: str) -> int:
    index = mujoco.mj_name2id(model, kind, name)
    if index < 0:
        raise RuntimeError(f'generated body has no {kind.name[5:].lower()} named {name!r}')
    return index


def _numeric(model, name: str):
    index = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_NUMERIC, name)
    if index < 0:
        return None
    return float(model.numeric_data[model.numeric_adr[index]])


def describe_legs(model, plan: dict) -> list[dict]:
    legs = []
    if plan['kind'] == 'quadruped':
        for name in plan['legNames']:
            mount = _id(model, mujoco.mjtObj.mjOBJ_BODY, f'{name}_roll_motor_link')
            x, y = (float(v) for v in model.body_pos[mount][:2])
            legs.append({'name': name, 'joints': [f'{name}_hip_roll', f'{name}_hip_pitch', f'{name}_knee'],
                         'roles': ['hip_roll', 'hip_pitch', 'knee'],
                         'footGeom': f'{name}_lower_leg_link_sphere', 'footSite': f'{name}_foot',
                         'mountAngle': round(math.atan2(y, x), 6),
                         'side': 'left' if name[1] == 'l' else 'right',
                         'end': 'front' if name[0] == 'f' else 'rear',
                         'bodies': [f'{name}_roll_motor_link', f'{name}_roll_link', f'{name}_pitch_link',
                                    f'{name}_upper_leg_link', f'{name}_lower_leg_link']})
    else:
        for leg in plan['legs']:
            name, theta = leg['name'], math.atan2(leg['ny'], leg['nx'])
            side = 'left' if math.sin(theta) > 0.2588 else 'right' if math.sin(theta) < -0.2588 else 'center'
            end = 'front' if math.cos(theta) > 0.2588 else 'rear' if math.cos(theta) < -0.2588 else 'middle'
            legs.append({'name': name, 'joints': [f'{name}_hip_yaw', f'{name}_hip_pitch', f'{name}_knee'],
                         'roles': ['hip_yaw', 'hip_pitch', 'knee'],
                         'footGeom': f'{name}_lower_leg_link_sphere', 'footSite': f'{name}_foot',
                         'mountAngle': round(theta, 6), 'side': side, 'end': end,
                         'bodies': [f'{name}_mount', f'{name}_yaw_link', f'{name}_upper_leg_link',
                                    f'{name}_lower_leg_link']})
    for leg in legs:
        geom = _id(model, mujoco.mjtObj.mjOBJ_GEOM, leg['footGeom'])
        _id(model, mujoco.mjtObj.mjOBJ_SITE, leg['footSite'])
        for body in leg['bodies']:
            _id(model, mujoco.mjtObj.mjOBJ_BODY, body)
        leg['footRadius'] = round(float(model.geom_size[geom][0]), 6)
    return legs


def geom_roles(model, legs: list[dict]) -> dict:
    feet = {leg['footGeom'] for leg in legs}
    roles = {'feet': [], 'torso': [], 'limbs': [], 'motors': [], 'details': []}
    for g in range(model.ngeom):
        name = _name(model, mujoco.mjtObj.mjOBJ_GEOM, g)
        if name in feet:
            roles['feet'].append(name)
        elif name.endswith('_mesh') and model.geom_bodyid[g] == 1:
            roles['torso'].append(name)
        elif name.endswith('_motor'):
            roles['motors'].append(name)
        elif name.endswith('_detail'):
            roles['details'].append(name)
        elif name.endswith('_link'):
            roles['limbs'].append(name)
        else:
            raise RuntimeError(f'generated geom {name!r} has no body-contract role')
    roles['feet'] = [leg['footGeom'] for leg in legs]
    return roles


def joint_table(model, legs: list[dict], resolved: dict) -> list[dict]:
    rows = []
    for leg in legs:
        for name, role in zip(leg['joints'], leg['roles']):
            j = _id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
            dof = int(model.jnt_dofadr[j])
            cls = str(resolved.get(f'{role}_mot', 'L'))
            gear = resolved.get(f'{cls}_motor_gear')
            rows.append({'name': name, 'role': role, 'leg': leg['name'],
                         'range': [round(float(v), 6) for v in model.jnt_range[j]],
                         'effort': round(float(model.jnt_actfrcrange[j][1]), 6),
                         'velocity': _numeric(model, f'{name}_velocity_limit'),
                         'gear': round(float(gear), 6) if gear is not None else None,
                         'armature': round(float(model.dof_armature[dof]), 9),
                         'damping': round(float(model.dof_damping[dof]), 9),
                         'frictionloss': round(float(model.dof_frictionloss[dof]), 9),
                         'motorClass': cls, 'qposAdr': int(model.jnt_qposadr[j]), 'dofAdr': dof})
    return rows


def gait_hint(plan: dict, count: int) -> dict:
    """Phase groups for a clock prior; legs index into body.json legs."""
    if plan['kind'] == 'quadruped':
        pattern, groups = 'trot', [[0, 3], [1, 2]]
    elif count == 6:
        pattern, groups = 'tripod', [[0, 2, 4], [1, 3, 5]]
    elif count == 4:
        pattern, groups = 'trot', [[0, 2], [1, 3]]
    elif count == 8:
        pattern, groups = 'ripple', [[0, 4], [2, 6], [1, 5], [3, 7]]
    else:
        pattern = 'wave'
        groups = [[i] for i in range(0, count, 2)] + [[i] for i in range(1, count, 2)]
    phases = [0.0] * count
    for k, group in enumerate(groups):
        for leg in group:
            phases[leg] = round(k / len(groups), 4)
    duty = 0.5 if len(groups) == 2 else round(1 - 1 / len(groups), 4)
    return {'pattern': pattern, 'groups': groups, 'phaseOffsets': phases, 'dutyFactor': duty}


# ── Nominal stance ─────────────────────────────────────────────────────────────

def _quadruped_angles(upper: float, lower: float, knee: float = QUADRUPED_KNEE) -> tuple[float, float]:
    """Hip pitch putting the foot straight below the hip-pitch axis for a given knee bend.

    Draft's quadruped legs hang along -z; positive pitch swings the thigh back
    (direction (-sin q, -cos q) in x/z) and the negative knee swings the shank forward.
    """
    hip = math.atan2(-lower * math.sin(knee), upper + lower * math.cos(knee))
    return hip, knee


def _stance_candidates(plan: dict, legs: list[dict], resolved_params: dict) -> list[tuple[str, list[float]]]:
    """(label, joint angles) in order of preference; legacy bodies keep their policy's stance."""
    count = len(legs)
    if plan.get('legacy') == 'cheetah':
        return [('legacy Cheetah policy default stance', [0.0, 0.5, -1.0] * count)]
    if plan.get('legacy') == 'flower':
        return [('legacy Flower policy default stance', [0.0, *MULTILEG_STANCE] * count)]
    if plan['kind'] == 'quadruped':
        upper = float(resolved_params['upper_leg_link_length'])
        lower = float(resolved_params['lower_leg_link_length'])
        return [(f'foot below the hip-pitch axis, knee bent {-knee:.1f} rad',
                 [0.0, _quadruped_angles(upper, lower, knee)[0], knee] * count) for knee in QUADRUPED_KNEES]
    return [(f'hip pitch {pitch:.2f} rad, knee {knee:.2f} rad (shank ~80 deg below horizontal)',
             [0.0, pitch, knee] * count) for pitch, knee in MULTILEG_STANCES]


def _static_loads(model, data, legs: list[dict], joints: list[dict]) -> dict:
    """Equal-share standing load and per-leg vertical force limits at the posed state."""
    weight = float(model.body_mass.sum()) * GRAVITY
    jacp, jacr = np.zeros((3, model.nv)), np.zeros((3, model.nv))
    forces, takeoff, stand = [], [], 0.0
    for leg in legs:
        mujoco.mj_jacSite(model, data, jacp, jacr, _id(model, mujoco.mjtObj.mjOBJ_SITE, leg['footSite']))
        rows = [row for row in joints if row['leg'] == leg['name']]
        lever = [abs(float(jacp[2, row['dofAdr']])) for row in rows]
        limits = [row['effort'] / l for row, l in zip(rows, lever) if l > 1e-6]
        forces.append(min(limits) if limits else math.inf)
        stand = max(stand, max(l * weight / len(legs) / row['effort'] for row, l in zip(rows, lever)))
        takeoff.append(sum(0.5 * (row['velocity'] or 0.0) * l for row, l in zip(rows, lever)))
    return {'weight': weight, 'perLegForce': forces, 'standLoad': stand, 'takeoff': takeoff}


def _set_pose(model, data, joints: list[dict], angles, root_z: float) -> None:
    data.qpos[:] = model.qpos0
    data.qpos[0:7] = [0.0, 0.0, root_z, 1.0, 0.0, 0.0, 0.0]
    for row, angle in zip(joints, angles):
        data.qpos[row['qposAdr']] = angle
    data.qvel[:] = 0
    mujoco.mj_forward(model, data)


def _refine_leg(model, data, leg_joints: list[dict], site: int, target: np.ndarray, root_z: float,
                angles: list[float], joints: list[dict]) -> None:
    """Newton on the two sagittal joints (hip pitch, knee) to put a foot site on target."""
    jacp = np.zeros((3, model.nv))
    jacr = np.zeros((3, model.nv))
    pitch, knee = leg_joints[1], leg_joints[2]
    index = {row['name']: i for i, row in enumerate(joints)}
    for _ in range(30):
        _set_pose(model, data, joints, angles, root_z)
        error = target - data.site_xpos[site]
        if float(np.linalg.norm(error)) < 1e-10:
            return
        mujoco.mj_jacSite(model, data, jacp, jacr, site)
        J = jacp[:, [pitch['dofAdr'], knee['dofAdr']]]
        step, *_ = np.linalg.lstsq(J, error, rcond=None)
        angles[index[pitch['name']]] += float(step[0])
        angles[index[knee['name']]] += float(step[1])


def _geom_bottom(model, data, g: int) -> float:
    center, half = model.geom_aabb[g][:3], model.geom_aabb[g][3:]
    R = data.geom_xmat[g].reshape(3, 3)
    corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) * half + center
    return float((corners @ R.T + data.geom_xpos[g])[:, 2].min())


def solve_stance(model, legs: list[dict], joints: list[dict], plan: dict, resolved_params: dict,
                 roles: dict) -> dict:
    """Most crouched comfortable level stance; every candidate is checked by forward kinematics."""
    tried, best, first_bad = [], None, None
    for label, angles in _stance_candidates(plan, legs, resolved_params):
        stance = _try_stance(model, legs, joints, list(angles), roles)
        stance['source'] = label
        if stance['problems']:
            tried.append({'source': label, 'problems': stance['problems']})
            first_bad = first_bad or stance
            continue
        data = mujoco.MjData(model)
        _set_pose(model, data, joints, stance['angles'], stance['rootZ'])
        stance['standLoad'] = _static_loads(model, data, legs, joints)['standLoad']
        tried.append({'source': label, 'standLoad': round(stance['standLoad'], 4)})
        if best is None or stance['standLoad'] < best['standLoad'] - 1e-9:
            best = stance
        if stance['standLoad'] <= STANCE_COMFORT_LOAD:
            best = stance
            break
    result = best or first_bad
    result['candidates'] = tried
    return result


def _try_stance(model, legs: list[dict], joints: list[dict], angles: list[float], roles: dict) -> dict:
    """Level-torso pose for one candidate with every foot on z = 0, plus its checks."""
    data = mujoco.MjData(model)
    _set_pose(model, data, joints, angles, 1.0)
    sites = [_id(model, mujoco.mjtObj.mjOBJ_SITE, leg['footSite']) for leg in legs]
    radii = [leg['footRadius'] for leg in legs]
    bottoms = [float(data.site_xpos[s][2]) - r for s, r in zip(sites, radii)]
    root_z = 1.0 - min(bottoms)
    _set_pose(model, data, joints, angles, root_z)
    # Per-leg refinement: same horizontal foot position, foot sphere resting on z = 0.
    for leg, site, radius in zip(legs, sites, radii):
        target = data.site_xpos[site].copy()
        target[2] = radius
        rows = [row for row in joints if row['leg'] == leg['name']]
        _refine_leg(model, data, rows, site, target, root_z, angles, joints)
    _set_pose(model, data, joints, angles, root_z)
    foot_z = [float(data.site_xpos[s][2]) - r for s, r in zip(sites, radii)]
    R = data.xmat[1].reshape(3, 3)
    roll = math.atan2(R[2, 1], R[2, 2])
    pitch = math.asin(max(-1.0, min(1.0, -R[2, 0])))
    problems = []
    if max(abs(z) for z in foot_z) > FOOT_HEIGHT_TOL_M:
        problems.append(f'feet could not all reach the ground (worst {max(abs(z) for z in foot_z) * 1e3:.2f} mm)')
    margins = []
    for row, angle in zip(joints, angles):
        lo, hi = row['range']
        margin = JOINT_MARGIN_FRACTION * (hi - lo)
        margins.append(min(angle - lo, hi - angle) / (hi - lo))
        if not lo + margin - 1e-9 <= angle <= hi - margin + 1e-9:
            problems.append(f"{row['name']} = {angle:.3f} rad is within {JOINT_MARGIN_FRACTION:.0%} of its limit")
    excluded = set(roles['feet']) | set(roles['details'])
    for leg in legs:   # the shank (foot-bearing body) naturally reaches the ground
        b = _id(model, mujoco.mjtObj.mjOBJ_BODY, leg['bodies'][-1])
        excluded |= {_name(model, mujoco.mjtObj.mjOBJ_GEOM, g) for g in range(model.ngeom) if model.geom_bodyid[g] == b}
    clearance = min(_geom_bottom(model, data, g) for g in range(model.ngeom)
                    if _name(model, mujoco.mjtObj.mjOBJ_GEOM, g) not in excluded)
    if clearance < MIN_BELLY_CLEARANCE_M:
        problems.append(f'the body would rest on the ground (clearance {clearance * 1e3:.0f} mm)')
    return {'angles': angles, 'rootZ': root_z, 'footZ': foot_z, 'roll': roll, 'pitch': pitch,
            'clearance': clearance, 'problems': problems, 'minJointMarginFraction': min(margins),
            'qpos': data.qpos.copy()}


def _stance_infeasible(stance: dict, plan: dict) -> DesignInfeasible:
    if plan['kind'] == 'quadruped':
        hints = [_hint('quadruped.lowerLeg', 'increase', 'longer legs lift the trunk clear of the ground'),
                 _hint('quadruped.torsoHeight', 'decrease', 'a flatter trunk needs less ground clearance')]
    else:
        hints = [_hint('multileg.lowerLeg', 'increase', 'longer shanks lift the hub clear of the ground'),
                 _hint('multileg.bodyRadius', 'decrease', 'a smaller hub needs less clearance')]
    return DesignInfeasible('stance', 'No level standing pose: ' + stance['problems'][0], hints, stance['problems'])


# ── Trainability heuristics ────────────────────────────────────────────────────

def _hull(points: list[tuple]) -> list[tuple]:
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _segment_distance(p, a, b) -> float:
    ax, ay, bx, by = a[0], a[1], b[0], b[1]
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / length))
    return math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy)


def support_margin(com_xy, feet_xy: list[tuple]) -> float:
    """Signed distance from the COM projection to the support polygon (positive inside)."""
    hull = _hull([(round(x, 9), round(y, 9)) for x, y in feet_xy])
    if not hull:
        return -math.inf
    if len(hull) < 3:
        return -min(_segment_distance(com_xy, hull[i], hull[(i + 1) % len(hull)]) for i in range(len(hull)))
    edges = [(hull[i], hull[(i + 1) % len(hull)]) for i in range(len(hull))]
    distance = min(_segment_distance(com_xy, a, b) for a, b in edges)
    inside = all((b[0] - a[0]) * (com_xy[1] - a[1]) - (b[1] - a[1]) * (com_xy[0] - a[0]) >= 0 for a, b in edges)
    return distance if inside else -distance


def _hold_test(body_xml: Path, joints: list[dict], roles: dict, qpos: np.ndarray, angles: list[float],
               legs: list[dict]) -> dict:
    """Torque-limited PD hold of the nominal pose on a flat floor (no policy, no gait).

    Uses the plan's timestep/integrator and collision classes; actuator force is capped
    by the joint's Draft effort (actuatorfrcrange), so a body too heavy for its motors sags.
    """
    spec = mujoco.MjSpec.from_file(str(body_xml))
    spec.option.timestep = 0.005
    spec.option.integrator = mujoco.mjtIntegrator.mjINT_IMPLICITFAST
    for key in list(spec.keys):
        spec.delete(key)
    for actuator in list(spec.actuators):
        spec.delete(actuator)
    for role, names in roles.items():
        contype, conaffinity = CONTACT_BITS[role]
        for name in names:
            geom = spec.geom(name)
            geom.contype, geom.conaffinity = contype, conaffinity
    floor = spec.worldbody.add_geom()
    floor.name, floor.type = 'hold_test_floor', mujoco.mjtGeom.mjGEOM_PLANE
    floor.size = [10, 10, 0.1]
    floor.contype, floor.conaffinity = 1, 15
    floor.friction = [1.0, 0.005, 0.0001]
    for row in joints:
        actuator = spec.add_actuator()
        actuator.name, actuator.target = f'hold_{row["name"]}', row['name']
        actuator.trntype = mujoco.mjtTrn.mjTRN_JOINT
        actuator.set_to_position(kp=row['effort'] / HOLD_KP_SATURATION_RAD, dampratio=1.0)
    model = spec.compile()
    data = mujoco.MjData(model)
    data.qpos[:] = qpos
    data.qpos[2] += 0.002
    data.ctrl[:] = angles
    mujoco.mj_forward(model, data)
    floor_id = _id(model, mujoco.mjtObj.mjOBJ_GEOM, 'hold_test_floor')
    feet = {_id(model, mujoco.mjtObj.mjOBJ_GEOM, name) for name in roles['feet']}
    steps = int(round(SETTLE_SECONDS / model.opt.timestep))
    tail = int(round(0.5 / model.opt.timestep))
    load, body_contacts, finite = 0.0, 0, True
    effort = np.array([row['effort'] for row in joints])
    dofs = np.array([row['dofAdr'] for row in joints])
    for step in range(steps):
        mujoco.mj_step(model, data)
        if not (np.isfinite(data.qpos).all() and np.isfinite(data.qvel).all()):
            finite = False
            break
        if step >= steps - tail:
            load = max(load, float(np.max(np.abs(data.qfrc_actuator[dofs]) / effort)))
            for c in data.contact[:data.ncon]:
                pair = {int(c.geom1), int(c.geom2)}
                if floor_id in pair and not (pair - {floor_id}) <= feet:
                    body_contacts += 1
    if not finite:
        return {'passed': False, 'finite': False, 'note': 'simulation diverged'}
    R = data.xmat[1].reshape(3, 3)
    tilt = math.acos(max(-1.0, min(1.0, float(R[2, 2]))))
    sag = (float(qpos[2]) - float(data.qpos[2])) / float(qpos[2])
    passed = sag < SETTLE_SAG_FAIL and tilt < SETTLE_TILT_FAIL and body_contacts == 0
    return {'passed': bool(passed), 'finite': True, 'seconds': SETTLE_SECONDS, 'sagFraction': round(sag, 4),
            'tiltRad': round(tilt, 4), 'peakTorqueFraction': round(load, 4),
            'bodyGroundContacts': int(body_contacts),
            'method': f'PD hold of the nominal pose, kp = effort/{HOLD_KP_SATURATION_RAD} rad, damping ratio 1, '
                      'torque capped at the Draft effort, timestep 0.005 implicitfast, plan collision classes'}


def trainability(model, body_xml: Path, legs: list[dict], joints: list[dict], stance: dict, roles: dict,
                 plan: dict, design: dict, gait: dict, leg_length: float, body_length: float) -> dict:
    data = mujoco.MjData(model)
    _set_pose(model, data, joints, stance['angles'], stance['rootZ'])
    mass = float(model.body_mass.sum())
    com = data.subtree_com[1].copy()
    sites = [_id(model, mujoco.mjtObj.mjOBJ_SITE, leg['footSite']) for leg in legs]
    feet_xy = [(float(data.site_xpos[s][0]), float(data.site_xpos[s][1])) for s in sites]
    count = len(legs)
    loads = _static_loads(model, data, legs, joints)
    weight, stand_load, takeoff = loads['weight'], loads['standLoad'], loads['takeoff']
    vertical_ratio = sum(loads['perLegForce']) / weight
    stance_legs = count - max(len(group) for group in gait['groups'])
    gait_load = stand_load * count / max(stance_legs, 1)
    margin_all = support_margin((float(com[0]), float(com[1])), feet_xy)
    gait_margins, dynamic = [], False
    for group in gait['groups']:
        rest = [xy for i, xy in enumerate(feet_xy) if i not in group]
        gait_margins.append(support_margin((float(com[0]), float(com[1])), rest))
        # Fewer than three feet down is a line or point support: balance is dynamic.
        dynamic = dynamic or len(rest) < 3 or gait_margins[-1] <= 0
    min_velocity = min(row['velocity'] or 0.0 for row in joints)
    stroke = 0.4 * leg_length
    v_takeoff = min(takeoff)
    hop = max(0.0, min(v_takeoff * v_takeoff / (2 * GRAVITY), (vertical_ratio - 1) * stroke))
    hold = _hold_test(body_xml, joints, roles, stance['qpos'], stance['angles'], legs)
    flags = []

    def flag(code, severity, message):
        flags.append({'code': code, 'severity': severity, 'message': message})

    if stand_load > STAND_LOAD_FAIL:
        flag('cannot-stand', 'error', f'Cannot stand: holding even its most comfortable stance needs '
                                      f'{stand_load:.0%} of peak torque. Lighter body, shorter legs or stronger '
                                      'actuators.')
    elif not hold['passed']:
        parts = []
        if not hold.get('finite', True):
            parts.append('the simulation diverged')
        if hold.get('tiltRad', 0) >= SETTLE_TILT_FAIL:
            parts.append(f"it tipped over ({hold['tiltRad']:.2f} rad)")
        if hold.get('sagFraction', 0) >= SETTLE_SAG_FAIL:
            parts.append(f"it sagged {hold['sagFraction']:.0%}")
        if hold.get('bodyGroundContacts'):
            parts.append('its body hit the ground')
        flag('unstable-stance', 'error',
             'Falls over when its joints simply hold the stance (' + ', '.join(parts or ['it failed']) +
             ' within 2 s): a learned policy would have to balance from the first step. Widen the stance, '
             'shorten the legs, lighten the body or use stronger actuators.')
    elif stand_load > STAND_LOAD_WARN or hold.get('sagFraction', 0) > SETTLE_SAG_WARN:
        detail = (f'standing on all feet already needs {stand_load:.0%} of peak torque' if stand_load > STAND_LOAD_WARN
                  else f"it sags {hold['sagFraction']:.0%} while its joints hold the stance")
        flag('may-struggle-to-stand', 'warning', f'May struggle to stand: {detail}.')
    if gait_load > GAIT_LOAD_WARN and stand_load <= STAND_LOAD_FAIL:
        flag('may-struggle-to-walk', 'warning',
             f'May struggle to walk: with {stance_legs} feet down the stance legs need {min(gait_load, 9.99):.0%} '
             'of peak torque.')
    if margin_all < TIPPY_MARGIN_M:
        flag('tippy', 'warning', f'Tippy: the centre of mass is only {margin_all * 100:.1f} cm inside the feet.')
    if dynamic:
        flag('dynamic-gait', 'info', f'The {gait["pattern"]} gait is not statically stable; the policy must '
                                     'balance dynamically (normal for trotting).')
    if stance['clearance'] < LOW_BELLY_M:
        flag('low-belly', 'warning', f"Low belly: {stance['clearance'] * 100:.1f} cm of ground clearance.")
    if min_velocity < SLOW_JOINT_RAD_S:
        flag('slow-joints', 'info', f'Slow joints ({min_velocity:.1f} rad/s no-load): expect a slow, careful gait.')
    ratio = leg_length / body_length if body_length > 0 else 0
    if ratio < 0.45:
        flag('short-legs', 'info', 'Short legs for the body: small steps and little ground clearance.')
    elif ratio > 2.2:
        flag('long-legs', 'info', 'Very long legs for the body: tall and harder to balance.')
    if vertical_ratio >= JUMP_STRONG and hop >= 0.15:
        jump = 'strong'
    elif vertical_ratio >= JUMP_OK and hop >= 0.08:
        jump = 'capable'
    elif vertical_ratio >= JUMP_WEAK:
        jump = 'weak'
    else:
        jump = 'unlikely'
    if 'jump' in (design.get('skills') or []) and jump in ('weak', 'unlikely'):
        flag('jump-unlikely', 'warning', f'Jumping looks {jump}: the legs can push only {vertical_ratio:.1f}x '
                                         'the body weight.')
    errors = any(f['severity'] == 'error' for f in flags)
    walk_warn = any(f['code'] in ('may-struggle-to-walk', 'may-struggle-to-stand', 'tippy') for f in flags)
    verdict = {'stand': 'fails' if errors else 'marginal' if any(f['code'] == 'may-struggle-to-stand' for f in flags)
               else 'ok',
               'walk': 'unlikely' if errors else 'hard' if walk_warn else 'plausible',
               'jump': 'unlikely' if errors else jump}
    return {
        'verdict': verdict, 'flags': flags,
        'metrics': {
            'massKg': round(mass, 4), 'weightN': round(weight, 3),
            'standLoad': round(stand_load, 4), 'gaitLoad': round(gait_load, 4), 'gaitStanceLegs': stance_legs,
            'verticalForceRatio': round(vertical_ratio, 3),
            'specificTorqueNmPerKg': round(max(row['effort'] for row in joints) / mass, 3),
            'staticMarginM': round(margin_all, 4),
            'gaitMarginM': round(min(gait_margins), 4) if all(math.isfinite(m) for m in gait_margins) else None,
            'comHeightM': round(float(com[2]), 4), 'bellyClearanceM': round(stance['clearance'], 4),
            'legLengthM': round(leg_length, 4), 'bodyLengthM': round(body_length, 4),
            'legToBodyRatio': round(ratio, 3), 'minJointVelocityRadS': round(min_velocity, 3),
            'maxFootSpeedMS': round(min_velocity * leg_length, 3),
            'jumpEstimate': {'takeoffSpeedMS': round(v_takeoff, 3), 'strokeM': round(stroke, 3),
                             'hopHeightM': round(hop, 3),
                             'note': 'Rough upper bound from joint torque/speed limits at the nominal pose; '
                                     'not a simulated or trained jump.'},
        },
        'holdTest': hold,
        'notes': 'Static and PD-hold heuristics for coaching; only a trained policy\'s evaluation shows walking '
                 'or jumping.',
    }


# ── Spec sheet ─────────────────────────────────────────────────────────────────

def _motor_rows(report: dict, resolved: dict, joints: list[dict], plan: dict) -> list[dict]:
    counts: dict[str, int] = {}
    for row in joints:
        counts[row['motorClass']] = counts.get(row['motorClass'], 0) + 1
    rows = []
    for cls, count in counts.items():
        c = report['actuator_checks']['classes'][cls]
        family = plan['family'] if cls == 'L' else None
        rows.append({'class': cls, 'family': family, 'familyLabel': plan['familyTable']['label'] if family else None,
                     'catalogAnchor': c.get('anchor'), 'category': c.get('category') or 'ALL', 'count': count,
                     'effortNm': round(float(c['effort_Nm']), 3), 'velocityRadS': round(float(c['velocity_rad_s']), 3),
                     'gear': round(float(c['gear_ratio']), 3), 'massKg': round(float(c['mass_kg']), 4),
                     'diameterMm': round(2000 * float(c['radius_m']), 1), 'lengthMm': round(1000 * float(c['length_m']), 1),
                     'armatureKgm2': float(c['armature_kgm2']), 'peakPowerW': round(float(c['peak_power_W']), 1),
                     'torqueDensityNmPerKg': float(c['torque_density_Nm_per_kg']),
                     'powerDensityWPerKg': float(c['power_density_W_per_kg']),
                     'frontierTorqueMaxNm': float(c['frontier_tau_max_Nm'])})
    return rows


def _relevant_warnings(report: dict, used: set[str]) -> list[str]:
    """Draft warnings, minus those about declared-but-unused motor classes."""
    out = []
    for message in report.get('warnings') or []:
        m = re.match(r'(?:allow_\w+: )?\[(\w+)\]', message)
        if m and m.group(1) not in used:
            continue
        out.append(message)
    return out


def spec_sheet(body: dict) -> dict:
    motors = body['motors']
    fam = motors[0] if motors else {}
    plan_label = 'Quadruped' if body['bodyPlan'] == 'quadruped' else \
        f"{len(body['legs'])}-leg {body['resolvedDesign'].get('arrangement', 'radial')} crawler"
    return {
        'title': body['name'], 'bodyId': body['id'],
        'subtitle': f"{plan_label} · {fam.get('familyLabel') or 'Draft actuators'}",
        'template': body['provenance']['template'], 'massKg': body['massKg'], 'dimensions': body['dimensions'],
        'legCount': len(body['legs']), 'jointCount': len(body['jointNames']), 'actuatorCount': len(body['jointNames']),
        'motors': motors,
        'feasibility': {'status': 'passed', 'gate': 'Draft strict feasibility gate + lab packing/stance gates',
                        'warnings': body['feasibility']['warnings'],
                        'warningCount': len(body['feasibility']['warnings'])},
        'trainability': {'verdict': body['trainability']['verdict'], 'flags': body['trainability']['flags'],
                         'metrics': body['trainability']['metrics']},
        'gait': body['gaitHint']['pattern'],
        'provenance': {'generator': body['provenance']['generator'], 'draftRevision': body['provenance']['draftRevision'],
                       'template': body['provenance']['template'], 'assetSha256': body['provenance']['assetSha256']},
        'honesty': 'Generated mechanism only: no controller exists until a policy is trained and validated for '
                   'this exact body.',
    }


# ── Assembling a body directory ────────────────────────────────────────────────

def _strip(value):
    """JSON-safe floats (numpy scalars, rounding)."""
    if isinstance(value, dict):
        return {k: _strip(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_strip(v) for v in value]
    if isinstance(value, (np.floating, float)):
        return float(value) + 0.0          # also turns -0.0 into 0.0
    if isinstance(value, (np.integer,)):
        return int(value)
    return value


def analyse(directory: Path, plan: dict, design: dict, identifier: str) -> dict:
    """Build body.json for a directory that holds body.xml, meshes and Draft's reports."""
    body_xml = directory / 'body.xml'
    model = mujoco.MjModel.from_xml_path(str(body_xml))
    report = _yaml(directory / 'feasibility_report.yaml')
    resolved = _yaml(directory / 'parameters_resolved.yaml')
    legs = describe_legs(model, plan)
    roles = geom_roles(model, legs)
    joints = joint_table(model, legs, resolved)
    hinges = int(np.count_nonzero(model.jnt_type == mujoco.mjtJoint.mjJNT_HINGE))
    if hinges != 3 * len(legs) or len(joints) != hinges or model.nq != 7 + hinges:
        raise RuntimeError('generated body does not have three hinges per leg plus one free joint')
    clashes = rigid_packing_gate(model, resolved)
    if clashes:
        raise _rigid_infeasible(clashes, plan, resolved)
    stance = solve_stance(model, legs, joints, plan, resolved, roles)
    if stance['problems']:
        raise _stance_infeasible(stance, plan)
    gait = gait_hint(plan, len(legs))
    if plan['kind'] == 'quadruped':
        leg_length = float(resolved['upper_leg_link_length']) + float(resolved['lower_leg_link_length'])
        body_length = float(resolved['torso_lx'])
    else:
        leg_length = float(resolved['upper_leg_length']) + float(resolved['lower_leg_length'])
        body_length = 2 * float(resolved['body_radius']) * float(resolved.get('body_aspect', 1.0))
    train = trainability(model, body_xml, legs, joints, stance, roles, plan, design, gait, leg_length, body_length)
    data = mujoco.MjData(model)
    _set_pose(model, data, joints, stance['angles'], stance['rootZ'])
    solid = [g for g in range(model.ngeom) if _name(model, mujoco.mjtObj.mjOBJ_GEOM, g) not in roles['details']]
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for g in solid:
        center, half = model.geom_aabb[g][:3], model.geom_aabb[g][3:]
        R = data.geom_xmat[g].reshape(3, 3)
        corners = (np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) * half + center) @ R.T
        corners += data.geom_xpos[g]
        lo, hi = np.minimum(lo, corners.min(0)), np.maximum(hi, corners.max(0))
    used = {row['motorClass'] for row in joints}
    meshes = sorted(p.name for p in directory.glob('*.stl'))
    template = TEMPLATES[plan['template']]
    template_dir = (f"draft:{template['dir'].relative_to(DRAFT)}" if template['dir'].is_relative_to(DRAFT)
                    else f"repo:{template['dir'].relative_to(PROJECT)}")
    body = {
        'schema': BODY_SCHEMA, 'id': identifier, 'name': design['name'], 'bodyPlan': plan['kind'],
        'design': design, 'resolvedDesign': plan['resolved'],
        'xmlFile': 'body.xml', 'meshFiles': meshes, 'rootBody': 'torso_link', 'imuSite': 'imu',
        'forwardAxis': [1, 0, 0],
        'legs': legs, 'jointNames': [row['name'] for row in joints],
        'joints': [{k: row[k] for k in ('name', 'role', 'leg', 'range', 'effort', 'velocity', 'gear', 'armature',
                                        'damping', 'frictionloss', 'motorClass')} for row in joints],
        'nominalJointPositions': [round(a, 6) for a in stance['angles']],
        'nominalRootHeight': round(stance['rootZ'], 6),
        'initialQpos': [round(float(v), 6) for v in stance['qpos']],
        'stanceCheck': {'footHeightsM': [round(z, 7) for z in stance['footZ']],
                        'maxFootHeightErrorM': round(max(abs(z) for z in stance['footZ']), 9),
                        'rollRad': round(stance['roll'], 9), 'pitchRad': round(stance['pitch'], 9),
                        'bellyClearanceM': round(stance['clearance'], 4),
                        'minJointMarginFraction': round(stance['minJointMarginFraction'], 4),
                        'tolerances': {'footHeightM': FOOT_HEIGHT_TOL_M, 'levelRad': LEVEL_TOL_RAD,
                                       'jointMarginFraction': JOINT_MARGIN_FRACTION,
                                       'minBellyClearanceM': MIN_BELLY_CLEARANCE_M},
                        'source': stance['source'], 'candidates': stance['candidates'],
                        'comfortLoad': STANCE_COMFORT_LOAD,
                        'method': 'Candidate stances from most crouched to straightest; the first whose '
                                  'equal-share stand load is comfortable (else the least loaded) is kept. Each is '
                                  'posed with MuJoCo forward kinematics: root lowered until the lowest foot sphere '
                                  'touches z = 0, then per-leg Newton on hip pitch and knee.'},
        'massKg': round(float(model.body_mass.sum()), 4),
        'dimensions': {'lengthM': round(float(hi[0] - lo[0]), 4), 'widthM': round(float(hi[1] - lo[1]), 4),
                       'heightM': round(float(hi[2]), 4), 'legLengthM': round(leg_length, 4)},
        'gaitHint': gait, 'geomRoles': roles,
        'bodyRoles': {'torso': 'torso_link', 'head': None},
        # Workshop pose experiments only (never physics or training): per-role joint
        # deltas, indexed like each leg's joints, matching play/src/draft-lab.js.
        'poseHints': ({'crouchDelta': [0.0, 0.475, -0.95], 'waveLeg': 'fl', 'waveDelta': [0.0, -1.25, -0.3]}
                      if plan['kind'] == 'quadruped' else
                      {'crouchDelta': [0.0, -0.30, 0.45], 'waveLeg': 'leg0', 'waveDelta': [0.0, -0.35, 0.35]}),
        'xmlContents': {'actuators': int(model.nu), 'sensors': int(model.nsensor),
                        'sensorNames': [_name(model, mujoco.mjtObj.mjOBJ_SENSOR, s) for s in range(model.nsensor)],
                        'keyframes': [_name(model, mujoco.mjtObj.mjOBJ_KEY, k) for k in range(model.nkey)],
                        'note': 'Generated bodies carry no actuators; the legacy Flower body keeps its '
                                '18 direct torque motors and nominal keyframe so its bytes match the legacy policy.'},
        'motors': _motor_rows(report, resolved, joints, plan),
        'feasibility': {'passed': True, 'strict': True,
                        'allowHypothetical': bool(resolved.get('allow_hypothetical', False)),
                        'warnings': _relevant_warnings(report, used),
                        'overridden': sorted({o['param'] for c in report['actuator_checks']['classes'].values()
                                              for o in c.get('overridden_by_law', [])}),
                        'extraGates': ['rigid actuator overlap', 'level stance with body clearance']},
        'trainability': train,
        'legacy': ({'preset': plan['legacy'],
                    'controller': f"/controller/{plan['legacy']}/manifest.json"
                    if plan['legacy'] in ('cheetah', 'flower') else None,
                    'note': 'Byte-identical to the legacy /api/generate model at original size.'}
                   if plan.get('legacy') else None),
        'provenance': {
            'generator': 'Draft RobotGenerator strict=True', 'repository': 'https://github.com/davidhnguyen2000/draft',
            'draftRevision': draft_revision(), 'draftPackageVersion': importlib.metadata.version('draft-robots'),
            'mujocoVersion': mujoco.__version__, 'template': plan['template'], 'templateDir': template_dir,
            'family': plan['family'], 'basePreset': plan['basePreset'], 'archetype': plan['archetype'],
            'sourcesSha256': template_sources(plan), 'draftOverrides': plan['overrides'],
            'assetSha256': {name: sha256(directory / name) for name in ['body.xml', *meshes]},
            'designsVersion': DESIGNS_VERSION,
            'massModel': ('Actuators and structure from Draft trends (quadruped population)'
                          if plan['kind'] == 'quadruped' else
                          'Actuators from Draft trends; structure stated (no multileg population), as the Flower'),
        },
    }
    body['specSheet'] = spec_sheet(body)
    return _strip(body)


def _assemble(plan: dict, design: dict, identifier: str, workdir: Path) -> Path:
    """Generate into a fresh directory holding only contract files; return it."""
    raw = workdir / 'draft'
    _run_draft(plan, raw)
    out = workdir / identifier
    out.mkdir()
    shutil.copyfile(raw / TEMPLATES[plan['template']]['xml'], out / 'body.xml')
    for path in raw.glob('*.stl'):
        shutil.copyfile(path, out / path.name)
    for name in ('feasibility_report.yaml', 'parameters_resolved.yaml'):
        shutil.copyfile(raw / name, out / name)
    shutil.rmtree(raw)
    body = analyse(out, plan, design, identifier)
    (out / 'body.json').write_text(json.dumps(body, ensure_ascii=False, indent=1, allow_nan=False) + '\n')
    return out


def evaluate(design_payload, keep_dir: Path | None = None) -> dict:
    """Validate, generate and analyse without touching the body stores (probes, tests)."""
    design = validate_design(design_payload)
    plan = plan_design(design)
    identifier = body_id(plan)
    base = keep_dir or GENERATED_DIR
    base.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.eval-', dir=base) as temporary:
        out = _assemble(plan, design, identifier, Path(temporary))
        body = json.loads((out / 'body.json').read_text())
        if keep_dir:
            target = keep_dir / identifier
            if not target.exists():
                out.rename(target)
        return body


# ── Body stores ────────────────────────────────────────────────────────────────

def _store_dir(root: Path, identifier: str) -> Path | None:
    if not BODY_ID_RE.fullmatch(identifier or ''):
        return None
    directory = root / identifier
    try:
        if root.is_symlink() or directory.is_symlink() or not directory.is_dir():
            return None
        if not directory.resolve().is_relative_to(root.resolve()):
            return None
        if not (directory / 'body.json').is_file() or (directory / 'body.json').is_symlink():
            return None
    except OSError:
        return None
    return directory


def body_dir(body_id_value: str) -> Path | None:
    """Resolve a bodyId to its directory (committed showcase first, then generated).

    For the training job manager: returns None for malformed ids, symlinks or anything
    outside the two stores. Generated directories are writable by the same user.
    """
    return _store_dir(SHOWCASE_DIR, body_id_value) or _store_dir(GENERATED_DIR, body_id_value)


def load_body(body_id_value: str) -> dict | None:
    directory = body_dir(body_id_value)
    if directory is None:
        return None
    try:
        return json.loads((directory / 'body.json').read_text())
    except (OSError, ValueError):
        return None


def _assets_intact(directory: Path, body: dict) -> bool:
    expected = (body.get('provenance') or {}).get('assetSha256') or {}
    return bool(expected) and all((directory / name).is_file() and sha256(directory / name) == digest
                                  for name, digest in expected.items())


def _refresh(directory: Path, plan: dict, design: dict, identifier: str) -> dict:
    """Re-derive body.json for intact assets produced by an older DESIGNS_VERSION."""
    body = analyse(directory, plan, json.loads((directory / 'body.json').read_text()).get('design', design),
                   identifier)
    temporary = directory / '.body.json.tmp'
    temporary.write_text(json.dumps(body, ensure_ascii=False, indent=1, allow_nan=False) + '\n')
    temporary.replace(directory / 'body.json')
    return body


def evict_generated(keep: int = MAX_GENERATED) -> None:
    """Drop least-recently-used generated bodies; never one that holds policies."""
    if not GENERATED_DIR.is_dir():
        return
    entries = []
    for directory in GENERATED_DIR.iterdir():
        if directory.is_symlink() or not directory.is_dir() or not BODY_ID_RE.fullmatch(directory.name):
            continue
        if (directory / 'policies').exists():
            continue
        try:
            entries.append((directory.joinpath('body.json').stat().st_mtime, directory))
        except OSError:
            continue
    entries.sort()
    while len(entries) >= keep:
        shutil.rmtree(entries.pop(0)[1], ignore_errors=True)


def build_body(design_payload, root: Path | None = None) -> tuple[dict, bool]:
    """Validate, map, generate (or reuse) and store a body; returns (body.json, cached)."""
    design = validate_design(design_payload)
    plan = plan_design(design)
    identifier = body_id(plan)
    with LOCK:
        existing = (_store_dir(root, identifier) if root else body_dir(identifier))
        if existing is not None:
            body = json.loads((existing / 'body.json').read_text())
            if not _assets_intact(existing, body):
                raise RuntimeError(f'Body {identifier} failed its checksum check; remove the directory and retry.')
            if body.get('provenance', {}).get('designsVersion') != DESIGNS_VERSION:
                body = _refresh(existing, plan, design, identifier)
            os.utime(existing / 'body.json')
            return body, True
        target_root = root or GENERATED_DIR
        target_root.mkdir(parents=True, exist_ok=True)
        if target_root.is_symlink():
            raise RuntimeError('The body store cannot be a symlink.')
        with tempfile.TemporaryDirectory(prefix='.build-', dir=target_root) as temporary:
            out = _assemble(plan, design, identifier, Path(temporary))
            if root is None:
                evict_generated()
            out.rename(target_root / identifier)
        return json.loads((target_root / identifier / 'body.json').read_text()), False


def _policy_summary(directory: Path) -> list[str]:
    skills = []
    for skill in POLICY_SKILLS:
        folder = directory / 'policies' / skill
        if (folder / 'manifest.json').is_file() and (folder / 'policy.onnx').is_file():
            skills.append(skill)
    return skills


def _recency(directory: Path) -> float:
    try:
        return -(directory / 'body.json').stat().st_mtime
    except OSError:
        return 0.0


def list_bodies() -> list[dict]:
    """Legacy then showcase bodies (by name), then generated ones, most recently used first."""
    rows = []
    for origin, root in (('showcase', SHOWCASE_DIR), ('generated', GENERATED_DIR)):
        if not root.is_dir() or root.is_symlink():
            continue
        entries = sorted(root.iterdir(), key=(lambda d: d.name) if origin == 'showcase' else _recency)
        first = len(rows)
        for directory in entries:
            if _store_dir(root, directory.name) is None:
                continue
            try:
                body = json.loads((directory / 'body.json').read_text())
            except (OSError, ValueError):
                continue
            if origin == 'generated' and _store_dir(SHOWCASE_DIR, directory.name):
                continue
            rows.append({'id': body['id'], 'name': body['name'], 'bodyPlan': body['bodyPlan'],
                         'template': body['provenance']['template'], 'legCount': len(body['legs']),
                         'massKg': body['massKg'], 'origin': 'legacy' if body.get('legacy') else origin,
                         'legacyPreset': (body.get('legacy') or {}).get('preset'),
                         'verdict': body['trainability']['verdict'], 'policies': _policy_summary(directory),
                         'urls': body_urls(body)})
        if origin == 'showcase':
            rows[first:] = sorted(rows[first:], key=lambda row: (row['origin'] != 'legacy', row['name']))
    return rows


def body_urls(body: dict) -> dict:
    base = f"/creatures/{body['id']}/"
    return {'base': base, 'bodyJson': base + 'body.json', 'bodyXml': base + 'body.xml',
            'meshes': {name: base + name for name in body['meshFiles']},
            'feasibilityReport': base + 'feasibility_report.yaml',
            'parametersResolved': base + 'parameters_resolved.yaml'}


# ── HTTP routes (wired into server.py by the main agent) ───────────────────────

class FileResponse(NamedTuple):
    path: Path
    content_type: str
    cache_control: str


CONTENT_TYPES = {'.xml': 'application/xml', '.json': 'application/json', '.stl': 'model/stl',
                 '.yaml': 'text/yaml; charset=utf-8', '.onnx': 'application/octet-stream'}


def route_design(match, payload):
    try:
        body, cached = build_body(payload)
    except DesignError as error:
        return 400, {'error': 'invalid-design', 'message': str(error)[:600], 'issues': error.issues[:24]}
    except DesignInfeasible as error:
        return 422, error.payload(validate_design(payload))
    except Exception as error:   # generator bug or broken store: never a silent success
        LOG.exception('Design generation failed')
        return 500, {'error': 'design-failed', 'message': 'Draft could not prepare this body.',
                     'detail': str(error)[:400]}
    request = validate_design(payload)
    # The body is shared by every design that compiles to it; echo this request's
    # cosmetic fields (name, concept, look, skills) without rewriting the stored file.
    view = {**body, 'name': request['name'], 'design': request}
    sheet = {**body['specSheet'], 'title': request['name']}
    view['specSheet'] = sheet
    return 200, {'body': view, 'urls': body_urls(body), 'specSheet': sheet, 'cached': cached}


def route_bodies(match, payload):
    return 200, {'bodies': list_bodies()}


def route_schema(match, payload):
    return 200, design_schema()


def resolve_creature_file(identifier: str, relative: str) -> Path | None:
    """Allowlisted, traversal- and symlink-safe file inside a body directory."""
    directory = body_dir(identifier)
    if directory is None or not isinstance(relative, str):
        return None
    parts = relative.split('/')
    try:
        meshes = set(json.loads((directory / 'body.json').read_text()).get('meshFiles', []))
    except (OSError, ValueError):
        return None
    if len(parts) == 1:
        if parts[0] not in BODY_FILES and not (parts[0] in meshes and MESH_NAME_RE.fullmatch(parts[0])):
            return None
    elif len(parts) == 3 and parts[0] == 'policies' and parts[1] in POLICY_SKILLS:
        if parts[2] not in POLICY_FILES and not (parts[2] in meshes and MESH_NAME_RE.fullmatch(parts[2])):
            return None
    else:
        return None
    target = directory.joinpath(*parts)
    try:
        node = directory
        for part in parts:
            node = node / part
            if node.is_symlink():
                return None
        if not target.is_file() or not target.resolve().is_relative_to(directory.resolve()):
            return None
    except OSError:
        return None
    return target


def route_creature_file(match, payload):
    target = resolve_creature_file(match['body'], match['file'])
    if target is None:
        return 404, {'error': 'Creature file not found.'}
    policy = '/policies/' in f"/{match['file']}"
    immutable = not policy and target.suffix in ('.xml', '.stl')
    return 200, FileResponse(target, CONTENT_TYPES.get(target.suffix, 'application/octet-stream'),
                             'public, max-age=86400, immutable' if immutable else 'no-store')


ROUTES = [
    ('POST', re.compile(r'/api/design'), route_design),
    ('GET', re.compile(r'/api/bodies'), route_bodies),
    ('GET', re.compile(r'/api/design/schema'), route_schema),
    ('GET', re.compile(r'/creatures/(?P<body>[a-z]+-[0-9a-f]{16})/(?P<file>[A-Za-z0-9_][A-Za-z0-9_./-]{0,160})'),
     route_creature_file),
]


def dispatch(method: str, path: str, payload=None):
    """Return (status, dict | FileResponse) for a matching route, else None."""
    for route_method, pattern, handler in ROUTES:
        if route_method == method:
            match = pattern.fullmatch(path)
            if match:
                return handler(match, payload)
    return None


def send_file_response(handler, response: FileResponse) -> None:
    """Write a FileResponse through a BaseHTTPRequestHandler (server.py helper)."""
    data = response.path.read_bytes()
    handler.send_response(200)
    handler.send_header('Content-Type', response.content_type)
    handler.send_header('Content-Length', str(len(data)))
    handler.send_header('Cache-Control', response.cache_control)
    handler.send_header('X-Content-Type-Options', 'nosniff')
    if hasattr(handler, 'origin_headers'):
        handler.origin_headers()
    handler.end_headers()
    handler.wfile.write(data)


# ── Showcase builder and CLI ───────────────────────────────────────────────────

def showcase_designs() -> list[dict]:
    return json.loads(SHOWCASE_FILE.read_text())['designs']


def build_showcase(only: set[str] | None = None) -> list[dict]:
    """(Re)generate the committed bodies under creatures/ from templates/showcase.json."""
    out = []
    for entry in showcase_designs():
        if only and entry['name'] not in only:
            continue
        body, cached = build_body(entry, root=SHOWCASE_DIR)
        out.append({'name': body['name'], 'id': body['id'], 'cached': cached, 'massKg': body['massKg'],
                    'verdict': body['trainability']['verdict'],
                    'flags': [f['code'] for f in body['trainability']['flags']],
                    'warnings': len(body['feasibility']['warnings'])})
    return out


def _outcome(design: dict) -> dict:
    """One probe row: generate without storing; gate/flags only."""
    try:
        body = evaluate(design)
    except DesignInfeasible as error:
        return {'ok': False, 'gate': error.gate, 'message': error.message[:160]}
    except DesignError as error:
        return {'ok': False, 'gate': 'invalid', 'message': str(error)[:160]}
    train = body['trainability']
    return {'ok': True, 'massKg': body['massKg'], 'verdict': train['verdict'],
            'flags': [f['code'] for f in train['flags'] if f['severity'] != 'info'],
            'standLoad': train['metrics']['standLoad'], 'vfr': train['metrics']['verticalForceRatio']}


def probe_bounds() -> dict:
    """Scans and rule-following grid corners per plan/family (draft-service/DESIGNS.md).

    Scans locate where Draft's gate or the lab gates refuse a design; corners take every
    extreme of the remaining fields while following contracts/design.schema.json
    x-designRules (family minimums, hub rules), so hard-gate failures there would mean
    the documented rules are wrong.
    """
    import itertools
    base = {'schema': DESIGN_SCHEMA, 'name': 'probe'}
    schema = design_schema()
    q_props, m_props = (schema['properties'][k]['properties'] for k in ('quadruped', 'multileg'))
    documented = schema['x-actuatorFamilies']
    lim = lambda props, key: (props[key]['minimum'], props[key]['maximum'])
    report = {'quadruped': {}, 'multileg': {}}
    for family in FAMILIES['quadruped']:
        rows = report['quadruped'][family] = {'strength': {}, 'hipOffset': {}, 'shoulderWidth': {}, 'corners': []}
        minimums = documented['quadruped'][family]['minimums']
        top = documented['quadruped'][family]['strengthMax']
        for strength in sorted({0.5, 1.0, 1.25, top, 1.5}):
            rows['strength'][strength] = _outcome({**base, 'bodyPlan': 'quadruped',
                                                   'quadruped': {'actuator': family, 'strength': strength,
                                                                 **minimums}})
        for strength in (1.0, top):
            for offset in (0.06, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25):
                rows['hipOffset'][f'{strength}@{offset}'] = _outcome(
                    {**base, 'bodyPlan': 'quadruped', 'quadruped': {
                        'actuator': family, 'strength': strength, 'hipOffset': offset,
                        'shoulderWidth': max(minimums['shoulderWidth'], 0.25)}})
            for width in (0.10, 0.12, 0.14, 0.16, 0.19, 0.22):
                rows['shoulderWidth'][f'{strength}@{width}'] = _outcome(
                    {**base, 'bodyPlan': 'quadruped', 'quadruped': {
                        'actuator': family, 'strength': strength, 'shoulderWidth': width, 'hipOffset': 0.25}})
        keys = ('torsoLength', 'torsoWidth', 'torsoHeight', 'upperLeg', 'lowerLeg')
        for corner in itertools.product(*[lim(q_props, k) for k in keys]):
            block = dict(zip(keys, corner), actuator=family, **minimums)
            rows['corners'].append({'design': block, **_outcome({**base, 'bodyPlan': 'quadruped', 'quadruped': block})})
    layouts = {'radial3': ('radial', 3, (0.08, 0.25), (1.0, 2.2)), 'radial6': ('radial', 6, (0.08, 0.25), (1.0, 2.2)),
               'radial8': ('radial', 8, (0.11, 0.25), (1.0, 1.2)), 'bilateral4': ('bilateral', 4, (0.08, 0.25), (1.0, 2.2)),
               'bilateral6': ('bilateral', 6, (0.11, 0.25), (1.0, 2.2)),
               'bilateral8': ('bilateral', 8, (0.11, 0.25), (1.6, 2.2))}
    for family in ('micro', 'qdd'):
        rows = report['multileg'][family] = {'strength': {}, 'coxa': {}, 'corners': []}
        coxa_min = documented['multileg'][family]['minimums']['coxa']
        for strength in (0.5, 1.0, 1.2, 1.5):
            rows['strength'][strength] = _outcome({**base, 'bodyPlan': 'multileg', 'multileg': {
                'actuator': family, 'strength': strength, 'coxa': coxa_min if strength <= 1.2 else 0.1}})
            for coxa in (0.08, 0.085, 0.09, 0.095, 0.10, 0.12, 0.14):
                rows['coxa'][f'{strength}@{coxa}'] = _outcome(
                    {**base, 'bodyPlan': 'multileg', 'multileg': {'actuator': family, 'strength': strength,
                                                                  'coxa': coxa}})
        for name, (arrangement, count, radii, aspects) in layouts.items():
            for radius, aspect, upper, lower in itertools.product(radii, aspects, lim(m_props, 'upperLeg'),
                                                                  lim(m_props, 'lowerLeg')):
                block = {'bodyRadius': radius, 'bodyAspect': aspect, 'upperLeg': upper, 'lowerLeg': lower,
                         'actuator': family, 'coxa': coxa_min, 'legCount': count, 'arrangement': arrangement}
                rows['corners'].append({'layout': name, 'design': block,
                                        **_outcome({**base, 'bodyPlan': 'multileg', 'multileg': block})})
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Draft Creature Lab design pipeline')
    sub = parser.add_subparsers(dest='command', required=True)
    showcase = sub.add_parser('build-showcase', help='regenerate committed bodies under creatures/')
    showcase.add_argument('--only', nargs='*')
    single = sub.add_parser('evaluate', help='validate and generate one design JSON file (not stored)')
    single.add_argument('design', type=Path)
    probe = sub.add_parser('probe-bounds', help='sweep grid corners per plan/family (slow, CPU only)')
    probe.add_argument('--out', type=Path, required=True)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    if args.command == 'build-showcase':
        print(json.dumps(build_showcase(set(args.only) if args.only else None), indent=2))
        return 0
    if args.command == 'probe-bounds':
        args.out.write_text(json.dumps(probe_bounds(), indent=1) + '\n')
        print('wrote', args.out)
        return 0
    try:
        body = evaluate(json.loads(args.design.read_text()))
    except DesignError as error:
        print(json.dumps({'error': 'invalid-design', 'issues': error.issues}, indent=2))
        return 2
    except DesignInfeasible as error:
        print(json.dumps(error.payload(), indent=2))
        return 3
    print(json.dumps(body['specSheet'], indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
