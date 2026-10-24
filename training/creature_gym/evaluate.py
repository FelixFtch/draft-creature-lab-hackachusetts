"""Deterministic validation of exported bundles in Python MuJoCo (same version as the browser).

``ReferenceController`` is the Python twin of play/src/creature-controller.js: same
observation terms, command clamping, gait clock, action clipping, position targets,
4 substeps per 50 Hz control step and the Microduck-style walk -> jump -> walk
handoff. Evaluation, fixtures and the jump trainer's slow-walk start states all
use it, and the JS parity QA replays its fixtures.

    python -m creature_gym.evaluate --bundle <bodyDir>/policies/walk [--jump <bodyDir>/policies/jump]

Every scenario row records its command schedule, pushes, measured mean velocities,
fall flag, thresholds and a pass flag; ``pass`` is true only if every required row
passes. Thresholds are engineering acceptance for a game character on this exact
body, not a robotics benchmark.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

import mujoco
import numpy as np

from . import EVAL_SCHEMA, FIXTURES_SCHEMA, MUJOCO_VERSION, POLICY_SCHEMA
from . import obs as O
from .body import Body, sha256_bytes, sha256_file

CONTROL_DT = 0.02
SUBSTEPS = 4
#: Spawn height above the nominal stance (same constant as creature-controller.js reset()).
SPAWN_CLEARANCE = 0.005


class BundleError(RuntimeError):
    pass


class Bundle:
    """A policy bundle directory with verified hashes (eval optional)."""

    def __init__(self, directory: str | Path, *, require_eval: bool = False):
        self.dir = Path(directory).resolve()
        mpath = self.dir / 'manifest.json'
        if not mpath.is_file():
            raise BundleError(f'{mpath} not found')
        self.manifest = m = json.loads(mpath.read_text())
        if m.get('schema') != POLICY_SCHEMA:
            raise BundleError('manifest schema mismatch')
        self.reasons: list[str] = []
        self.scene_xml = (self.dir / m['sceneXml']).read_bytes()
        if sha256_bytes(self.scene_xml) != m['sceneSha256']:
            raise BundleError('scene.xml hash mismatch')
        self.assets = {}
        for asset in m['assets']:
            data = (self.dir / asset['name']).read_bytes()
            if sha256_bytes(data) != asset['sha256']:
                raise BundleError(f"{asset['name']} hash mismatch")
            self.assets[asset['name']] = data
        self.policy_path = self.dir / m['policy']
        if sha256_file(self.policy_path) != m['policySha256']:
            raise BundleError('policy.onnx hash mismatch')
        self.eval = None
        epath = self.dir / 'eval.json'
        ev = m.get('evaluation') or {}
        if epath.is_file() and ev.get('evalSha256'):
            if sha256_file(epath) != ev['evalSha256']:
                raise BundleError('eval.json hash mismatch')
            self.eval = json.loads(epath.read_text())
        self.ready = bool(self.eval and self.eval.get('pass') is True
                          and self.eval.get('policySha256') == m['policySha256']
                          and self.eval.get('sceneSha256') == m['sceneSha256'])
        if require_eval and not self.ready:
            raise BundleError('bundle has no passing evaluation')

    def compile(self) -> mujoco.MjModel:
        return mujoco.MjModel.from_xml_string(self.scene_xml.decode('utf-8'), dict(self.assets))

    def session(self):
        return make_session(self.policy_path)


def make_session(path: Path):
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])


class SkillRuntime:
    """Manifest-derived constants for one skill."""

    def __init__(self, manifest: dict, session, model: mujoco.MjModel):
        self.m = manifest
        self.session = session
        self.input = manifest['onnxInput']
        self.output = manifest['onnxOutput']
        self.terms = manifest['observation']['terms']
        self.size = manifest['observation']['size']
        self.default = np.array(manifest['defaultJointPositions'])
        self.scale = np.array(manifest['actionScale'])
        self.clip = float(manifest['actionClip'])
        clock = manifest.get('clock')
        self.freq = clock['frequencyHz'] if clock else 0.0
        self.offsets = np.array(clock['legPhaseOffsets']) if clock else None
        ep = manifest.get('episode')
        self.duration = ep['durationS'] if ep else None
        b = manifest['commandBounds']
        self.bounds = np.array([b['vx'], b['vy'], b['wz']], dtype=float)
        mv = manifest.get('moving') or {}
        self.vmax, self.wmax = mv.get('vmax', 1.0), mv.get('wmax', 1.0)

    def infer(self, obs: np.ndarray) -> np.ndarray:
        out = self.session.run([self.output], {self.input: obs[None, :].astype(np.float32)})[0]
        return np.asarray(out[0], dtype=np.float32)


class ReferenceController:
    """Python twin of the browser controller. Robot entries resolve by name."""

    def __init__(self, model: mujoco.MjModel, data: mujoco.MjData, walk: SkillRuntime,
                 jump: SkillRuntime | None = None):
        self.model, self.data, self.walk, self.jump = model, data, walk, jump
        m = walk.m
        name2id = lambda kind, name: mujoco.mj_name2id(model, kind, name)  # noqa: E731
        obj = mujoco.mjtObj
        root_joint = name2id(obj.mjOBJ_JOINT, m['rootJoint'])
        self.root_body = name2id(obj.mjOBJ_BODY, m['rootBody'])
        self.root_qpos = int(model.jnt_qposadr[root_joint])
        self.root_dof = int(model.jnt_dofadr[root_joint])
        joints = [name2id(obj.mjOBJ_JOINT, n) for n in m['jointNames']]
        self.joint_qpos = np.array([model.jnt_qposadr[j] for j in joints])
        self.joint_dof = np.array([model.jnt_dofadr[j] for j in joints])
        self.actuators = np.array([name2id(obj.mjOBJ_ACTUATOR, n) for n in m['actuatorNames']])
        self.lo = model.actuator_ctrlrange[self.actuators, 0].copy()
        self.hi = model.actuator_ctrlrange[self.actuators, 1].copy()
        self.foot_sites = np.array([name2id(obj.mjOBJ_SITE, n) for n in m['footSites']])
        sensors = m['sensors']
        self.touch = np.array([model.sensor_adr[name2id(obj.mjOBJ_SENSOR, n)] for n in sensors['touch']])
        self.torso_contact = int(model.sensor_adr[name2id(obj.mjOBJ_SENSOR, sensors['torsoContact'])])
        self.fall = m['fallCriteria']
        self.nq_robot = 7 + len(joints)
        self.foot_radius = np.array(m['footRadius'])
        self.contact_threshold = m['contactThresholdN']
        self.reset()

    # -- state -------------------------------------------------------------------
    def reset(self, qpos: np.ndarray | None = None, qvel: np.ndarray | None = None) -> None:
        d, m = self.data, self.walk.m
        q = np.array(m['initialQpos'] if qpos is None else qpos, dtype=float)
        d.qpos[self.root_qpos:self.root_qpos + 7] = q[:7]
        d.qpos[self.root_qpos + 2] += SPAWN_CLEARANCE
        d.qpos[self.joint_qpos] = q[7:]
        d.qvel[self.root_dof:self.root_dof + 6] = 0 if qvel is None else qvel[:6]
        d.qvel[self.joint_dof] = 0 if qvel is None else qvel[6:]
        d.ctrl[self.actuators] = self.walk.default
        mujoco.mj_forward(self.model, d)
        self.phase = 0.0
        self.jump_phase = 0.0
        self.mode = 'walk'
        self.last_action = np.zeros(len(self.actuators), dtype=np.float32)
        self.command = np.zeros(3)
        self.jumps = 0

    def controller_state(self) -> dict:
        return {'mode': self.mode, 'phase': self.phase, 'jumpPhase': self.jump_phase,
                'lastAction': self.last_action.astype(float).tolist()}

    def set_controller_state(self, s: dict) -> None:
        self.mode, self.phase, self.jump_phase = s['mode'], s['phase'], s['jumpPhase']
        self.last_action = np.array(s['lastAction'], dtype=np.float32)

    # -- observation ---------------------------------------------------------------
    def clamp_command(self, command) -> np.ndarray:
        c = np.array(command, dtype=float)
        return np.clip(c, self.walk.bounds[:, 0], self.walk.bounds[:, 1])

    def observe(self, command: np.ndarray) -> np.ndarray:
        d = self.data
        skill = self.jump if self.mode == 'jump' else self.walk
        values = O.proprio_values(d.qpos[None], d.qvel[None], self.root_qpos, self.root_dof,
                                  self.joint_qpos, self.joint_dof, skill.default)
        values = {k: v[0] for k, v in values.items()}
        values['last_action'] = self.last_action.astype(float)
        if self.mode == 'walk':
            moving = O.is_moving(command, self.walk.vmax, self.walk.wmax)
            values['command'] = command
            values['gait_clock'] = O.gait_clock(np.array(self.phase), self.walk.offsets, np.array(moving))
        else:
            values['jump_phase'] = O.jump_phase_features(np.array(self.jump_phase))
        return O.build(skill.terms, values)

    # -- control step ----------------------------------------------------------------
    def step(self, command=(0.0, 0.0, 0.0), *, jump: bool = False) -> dict:
        d, model = self.data, self.model
        cmd = self.clamp_command(command)
        if jump and self.mode == 'walk' and self.jump is not None:
            self.mode, self.jump_phase = 'jump', 0.0
            self.last_action = np.clip(self.last_action * self.walk.scale / self.jump.scale,
                                       -self.jump.clip, self.jump.clip).astype(np.float32)
            self.jumps += 1
        skill = self.jump if self.mode == 'jump' else self.walk
        obs = self.observe(cmd)
        raw = skill.infer(obs)
        action = np.clip(raw, -skill.clip, skill.clip).astype(np.float32)
        ctrl = np.clip(skill.default + skill.scale * action.astype(float), self.lo, self.hi)
        d.ctrl[self.actuators] = ctrl
        warnings_before = [int(w.number) for w in d.warning]
        t0 = d.time
        for _ in range(SUBSTEPS):
            mujoco.mj_step(model, d)
        warned = any(int(w.number) > b for w, b in zip(d.warning, warnings_before))
        mujoco.mj_forward(model, d)
        self.last_action = action
        mode_used = self.mode
        self.phase += self.walk.freq * CONTROL_DT
        if self.phase >= 1.0:
            self.phase -= 1.0
        if self.mode == 'jump':
            self.jump_phase += CONTROL_DT / self.jump.duration
            if self.jump_phase >= 1.0 - 1e-9:
                self.mode = 'walk'
                self.last_action = np.clip(self.last_action * self.jump.scale / self.walk.scale,
                                           -self.walk.clip, self.walk.clip).astype(np.float32)
        finite = bool(np.all(np.isfinite(d.qpos)) and np.all(np.isfinite(d.qvel)))
        return {'obs': obs, 'action': raw, 'ctrl': ctrl, 'mode': mode_used, 'command': cmd,
                'valid': finite and not warned and d.time > t0}

    # -- measurements --------------------------------------------------------------------
    def measure(self) -> dict:
        d = self.data
        q = O.normalized_quat(d.qpos[self.root_qpos:self.root_qpos + 7])
        v = O.quat_rotate_inverse(q, d.qvel[self.root_dof:self.root_dof + 3])
        w = d.qvel[self.root_dof + 3:self.root_dof + 6]
        g = O.projected_gravity(q)
        feet = d.site_xpos[self.foot_sites]
        tilt = float(math.acos(float(np.clip(-g[2], -1, 1))))
        height_feet = float(d.qpos[self.root_qpos + 2] - feet[:, 2].mean())
        touch = d.sensordata[self.touch]
        torso = bool(d.sensordata[self.torso_contact] > 0)
        fall = tilt > self.fall['tiltRad'] or height_feet < self.fall['minHeightAboveFeetM'] or torso
        return {'pos': d.qpos[self.root_qpos:self.root_qpos + 3].copy(), 'vel': np.array([v[0], v[1], w[2]]),
                'yaw': float(O.heading(q)), 'tilt': tilt, 'heightAboveFeet': height_feet,
                'feetZ': feet[:, 2] - self.foot_radius, 'touch': touch.copy(),
                'airborne': bool(np.all(touch <= self.contact_threshold) and np.all(feet[:, 2] - self.foot_radius > 0.005)),
                'torsoContact': torso, 'fall': bool(fall)}


def runtime_for(bundle: Bundle, model: mujoco.MjModel) -> SkillRuntime:
    return SkillRuntime(bundle.manifest, bundle.session(), model)


# ---------------------------------------------------------------------------- scenarios
def schedule_command(schedule: list, t: float) -> list:
    cmd = schedule[0][1:]
    for row in schedule:
        if t + 1e-9 >= row[0]:
            cmd = row[1:]
    return cmd


def run_scenario(ctrl: ReferenceController, sc: dict, *, record: bool = False) -> dict:
    """Run one scenario dict: schedule [[t, vx, vy, wz]], pushes [[t, dvx, dvy]], jumps [t]."""
    ctrl.reset(sc.get('initialQpos'))
    if sc.get('initialVelocity') is not None:
        ctrl.data.qvel[ctrl.root_dof:ctrl.root_dof + 3] = sc['initialVelocity']
        mujoco.mj_forward(ctrl.model, ctrl.data)
    steps = int(round(sc['durationS'] / CONTROL_DT))
    pushes = {int(round(p[0] / CONTROL_DT)): p[1:] for p in sc.get('pushes', [])}
    jumps = {int(round(t / CONTROL_DT)) for t in sc.get('jumps', [])}
    samples, error = [], None
    start = ctrl.measure()
    for k in range(steps):
        t = k * CONTROL_DT
        if k in pushes:
            dvx, dvy = pushes[k]
            ctrl.data.qvel[ctrl.root_dof] += dvx
            ctrl.data.qvel[ctrl.root_dof + 1] += dvy
            mujoco.mj_forward(ctrl.model, ctrl.data)
        info = ctrl.step(schedule_command(sc['schedule'], t), jump=k in jumps)
        meas = ctrl.measure()
        samples.append({'t': round(t + CONTROL_DT, 4), 'mode': info['mode'], 'cmd': info['command'].tolist(), **meas})
        if not info['valid']:
            error = 'MuJoCo warning or non-finite state'
            break
        if meas['fall']:
            break
    return {'samples': samples, 'error': error, 'start': start}


def _wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


def summarize(samples: list, start: dict, measure_from: float) -> dict:
    win = [s for s in samples if s['t'] > measure_from + 1e-9] or samples[-1:]
    vel = np.mean([s['vel'] for s in win], axis=0)
    yaw = np.array([s['yaw'] for s in samples])
    heading_change = float(np.sum(_wrap(np.diff(np.concatenate([[start['yaw']], yaw])))))
    p0 = win[0]['pos'] if win else start['pos']
    return {
        'meanVelocity': [round(float(x), 4) for x in vel],
        'planarSpeed': round(float(np.mean([np.hypot(s['vel'][0], s['vel'][1]) for s in win])), 4),
        'displacement': [round(float(x), 4) for x in (samples[-1]['pos'] - start['pos'])],
        'windowDisplacement': [round(float(x), 4) for x in (samples[-1]['pos'] - p0)],
        'headingChange': round(heading_change, 4),
        'maxTilt': round(max(s['tilt'] for s in samples), 4),
        'minHeightAboveFeet': round(min(s['heightAboveFeet'] for s in samples), 4),
    }


def gait_stats(samples: list, measure_from: float, threshold: float) -> dict:
    """Per-foot duty factor, touchdown rate and swing clearance in the measurement window."""
    win = [s for s in samples if s['t'] > measure_from + 1e-9]
    if len(win) < 10:
        return {}
    contact = np.array([s['touch'] > threshold for s in win])           # (T, legs)
    feet = np.array([s['feetZ'] for s in win])
    touchdowns = np.sum(contact[1:] & ~contact[:-1], axis=0)
    seconds = len(win) * CONTROL_DT
    return {'dutyFactor': [round(float(x), 3) for x in contact.mean(axis=0)],
            'touchdownsPerS': [round(float(x), 3) for x in touchdowns / seconds],
            'peakFootClearanceM': [round(float(x), 4) for x in feet.max(axis=0)]}


def walk_scenarios(m: dict) -> list[dict]:
    vmax, wmax = m['moving']['vmax'], m['moving']['wmax']
    vmin = m['commandBounds']['vx'][0]
    sqrt_s = math.sqrt(m['scaling']['legLengthM'] / 0.44)
    leg = m['scaling']['legLengthM']
    h0 = m['nominalRootHeight']
    r = lambda x: round(float(x), 4)  # noqa: E731
    push = r(0.5 * sqrt_s)
    drop = list(m['initialQpos'])
    drop[2] = r(drop[2] + 0.15 * leg)
    tilt = 0.2
    drop[3:7] = [r(math.cos(tilt / 2)), r(math.sin(tilt / 2)), 0.0, 0.0]
    rows = [
        {'name': 'stand', 'durationS': 10, 'measureFromS': 2, 'schedule': [[0, 0, 0, 0]],
         'criteria': {'maxPlanarDriftM': r(max(0.2, 0.5 * leg)), 'maxPlanarSpeed': r(0.1 * vmax), 'maxAbsHeadingChange': 0.5}},
        # Straight rows also bound the yaw rate (a visibly curving "forward" fails) and
        # turn-in-place rows bound the planar speed (no running off while turning).
        {'name': 'forward', 'durationS': 10, 'measureFromS': 2, 'schedule': [[0, r(0.6 * vmax), 0, 0]],
         'criteria': {'minVxFraction': 0.5, 'maxAbsWz': r(0.2 * wmax)}},
        {'name': 'forward_max', 'durationS': 10, 'measureFromS': 3, 'schedule': [[0, r(vmax), 0, 0]],
         'criteria': {'minVxFraction': 0.4, 'maxAbsWz': r(0.2 * wmax)}},
        {'name': 'backward', 'durationS': 10, 'measureFromS': 2, 'schedule': [[0, r(vmin), 0, 0]],
         'criteria': {'minVxFraction': 0.4, 'maxAbsWz': r(0.2 * wmax)}},
        {'name': 'turn_left', 'durationS': 10, 'measureFromS': 2, 'schedule': [[0, 0, 0, r(0.6 * wmax)]],
         'criteria': {'minWzFraction': 0.5, 'maxPlanarSpeed': r(0.25 * vmax)}},
        {'name': 'turn_right', 'durationS': 10, 'measureFromS': 2, 'schedule': [[0, 0, 0, r(-0.6 * wmax)]],
         'criteria': {'minWzFraction': 0.5, 'maxPlanarSpeed': r(0.25 * vmax)}},
        {'name': 'arc', 'durationS': 10, 'measureFromS': 2, 'schedule': [[0, r(0.5 * vmax), 0, r(0.5 * wmax)]],
         'criteria': {'minVxFraction': 0.4, 'minWzFraction': 0.4}},
        {'name': 'start_stop', 'durationS': 12, 'measureFromS': 11,
         'schedule': [[0, 0, 0, 0], [2, r(0.6 * vmax), 0, 0], [5, 0, 0, 0], [8, 0, 0, r(0.6 * wmax)], [10, 0, 0, 0]],
         'criteria': {'maxPlanarSpeed': r(0.15 * vmax)}},
        {'name': 'push_recovery', 'durationS': 12, 'measureFromS': 2, 'schedule': [[0, r(0.3 * vmax), 0, 0]],
         'pushes': [[3, 0, push], [6, 0, -push], [9, push, 0]], 'criteria': {}},
        {'name': 'drop_recovery', 'durationS': 4, 'measureFromS': 3, 'schedule': [[0, 0, 0, 0]],
         'initialQpos': drop, 'initialVelocity': [0, 0, r(-0.5 * sqrt_s)], 'criteria': {}},
        {'name': 'bumpy', 'durationS': 10, 'measureFromS': 2, 'schedule': [[0, r(0.5 * vmax), 0, 0]],
         'terrain': {'pattern': 0, 'scale': 0.8}, 'criteria': {'minVxFraction': 0.3}},
    ]
    del h0
    return rows


def jump_scenarios(walk_m: dict, jump_m: dict) -> list[dict]:
    vmax = walk_m['moving']['vmax']
    window = jump_m['episode']['durationS']
    r = lambda x: round(float(x), 4)  # noqa: E731
    return [
        {'name': 'jump_from_stand', 'durationS': 1.5 + window + 3, 'schedule': [[0, 0, 0, 0]], 'jumps': [1.5]},
        {'name': 'jump_from_walk', 'durationS': 2 + window + 3, 'schedule': [[0, r(0.3 * vmax), 0, 0]], 'jumps': [2.0]},
        {'name': 'jump_repeat', 'durationS': 3 * (1.5 + window) + 2, 'schedule': [[0, r(0.2 * vmax), 0, 0]],
         'jumps': [r(1.5 + i * (1.5 + window)) for i in range(3)]},
    ]


def evaluate_walk(bundle: Bundle, body: Body | None = None) -> dict:
    m = bundle.manifest
    rows = []
    for sc in walk_scenarios(m):
        if sc.get('terrain'):
            if body is None:
                rows.append({**sc, 'pass': None, 'skipped': 'needs the body to build the terrain scene'})
                continue
            model = terrain_model(bundle, body, sc['terrain'])
        else:
            model = bundle.compile()
        data = mujoco.MjData(model)
        ctrl = ReferenceController(model, data, runtime_for(bundle, model))
        res = run_scenario(ctrl, sc)
        rows.append(score_walk_row(sc, res, m))
    return finish_report(bundle, rows, 'walk')


def terrain_model(bundle: Bundle, body: Body, terrain: dict) -> mujoco.MjModel:
    from .sim_model import build_scene
    from .terrain import TerrainBank, terrain_spec_for
    spec = terrain_spec_for(body.leg_length)
    scene = build_scene(body, terrain=spec)
    plain = build_scene(body)
    if plain.xml.encode() != bundle.scene_xml:
        raise BundleError('bundle scene.xml differs from this body (stale bundle?)')
    model = scene.compile()
    bank = TerrainBank(spec, body.leg_length, count=8, seed=1234)
    hid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_HFIELD, 'cg_terrain')
    adr, size = model.hfield_adr[hid], model.hfield_nrow[hid] * model.hfield_ncol[hid]
    model.hfield_data[adr:adr + size] = bank.hfield_data(terrain['pattern'], terrain['scale'])
    return model


def score_walk_row(sc: dict, res: dict, m: dict) -> dict:
    samples = res['samples']
    steps = int(round(sc['durationS'] / CONTROL_DT))
    fell = bool(samples and samples[-1]['fall'])
    complete = len(samples) == steps and res['error'] is None and not fell
    summary = summarize(samples, res['start'], sc['measureFromS']) if samples else {}
    crit = sc.get('criteria', {})
    cmd = schedule_command(sc['schedule'], sc['durationS'] - CONTROL_DT)
    outcomes = []
    v = summary.get('meanVelocity', [0, 0, 0])
    if 'minVxFraction' in crit:
        ok = math.copysign(1, cmd[0]) * v[0] >= crit['minVxFraction'] * abs(cmd[0])
        outcomes.append({'criterion': 'minVxFraction', 'value': round(v[0] / cmd[0], 3) if cmd[0] else None, 'pass': bool(ok)})
    if 'minWzFraction' in crit:
        ok = math.copysign(1, cmd[2]) * v[2] >= crit['minWzFraction'] * abs(cmd[2])
        outcomes.append({'criterion': 'minWzFraction', 'value': round(v[2] / cmd[2], 3) if cmd[2] else None, 'pass': bool(ok)})
    if 'maxAbsWz' in crit:
        outcomes.append({'criterion': 'maxAbsWz', 'value': round(abs(v[2]), 4), 'pass': bool(abs(v[2]) <= crit['maxAbsWz'])})
    if 'maxPlanarSpeed' in crit:
        outcomes.append({'criterion': 'maxPlanarSpeed', 'value': summary.get('planarSpeed'),
                         'pass': bool(summary.get('planarSpeed', 1e9) <= crit['maxPlanarSpeed'])})
    if 'maxPlanarDriftM' in crit:
        drift = float(np.hypot(*summary.get('displacement', [1e9, 1e9])[:2]))
        outcomes.append({'criterion': 'maxPlanarDriftM', 'value': round(drift, 4), 'pass': drift <= crit['maxPlanarDriftM']})
    if 'maxAbsHeadingChange' in crit:
        hc = abs(summary.get('headingChange', 1e9))
        outcomes.append({'criterion': 'maxAbsHeadingChange', 'value': round(hc, 4), 'pass': hc <= crit['maxAbsHeadingChange']})
    row = {k: sc[k] for k in sc if k not in ('criteria',)}
    row.update(criteria=crit, required=True, command=cmd, executedSteps=len(samples), requestedSteps=steps,
               fall=fell, error=res['error'], complete=complete, outcomes=outcomes,
               pass_=complete and all(o['pass'] for o in outcomes), **summary,
               gait=gait_stats(samples, sc['measureFromS'], m['contactThresholdN']))
    row['pass'] = row.pop('pass_')
    return row


def evaluate_jump(jump: Bundle, walk: Bundle) -> dict:
    m = jump.manifest
    leg = m['scaling']['legLengthM']
    crit = {'minApexGainM': round(0.10 * leg, 4), 'minAirborneS': 0.1, 'maxTiltRad': 0.6}
    rows = []
    for sc in jump_scenarios(walk.manifest, m):
        model = walk.compile()
        data = mujoco.MjData(model)
        ctrl = ReferenceController(model, data, runtime_for(walk, model), runtime_for(jump, model))
        res = run_scenario(ctrl, sc)
        samples = res['samples']
        steps = int(round(sc['durationS'] / CONTROL_DT))
        fell = bool(samples and samples[-1]['fall'])
        complete = len(samples) == steps and res['error'] is None and not fell
        jumps = []
        for t_jump in sc['jumps']:
            k0 = int(round(t_jump / CONTROL_DT))
            before = samples[k0 - 1] if 0 < k0 <= len(samples) else res['start']
            window = []  # the contiguous run of steps driven by the jump policy from this trigger
            for s in samples[k0:]:
                if s['mode'] != 'jump':
                    break
                window.append(s)
            after = samples[k0 + len(window):k0 + len(window) + 50]
            if not window:
                jumps.append({'t': t_jump, 'executed': False})
                continue
            apex = max(s['pos'][2] for s in window) - before['pos'][2]
            air = sum(s['airborne'] for s in window) * CONTROL_DT
            tilt = max(s['tilt'] for s in window + after)
            jumps.append({'t': t_jump, 'executed': True, 'apexGainM': round(float(apex), 4),
                          'airborneS': round(float(air), 3), 'maxTiltRad': round(float(tilt), 4),
                          'handoffSteps': len(after),
                          'pass': bool(apex >= crit['minApexGainM'] and air >= crit['minAirborneS']
                                       and tilt <= crit['maxTiltRad'])})
        ok = complete and len(jumps) == len(sc['jumps']) and all(j.get('pass') for j in jumps)
        summary = summarize(samples, res['start'], 0.0) if samples else {}
        rows.append({**sc, 'criteria': crit, 'required': True, 'executedSteps': len(samples), 'requestedSteps': steps,
                     'fall': fell, 'error': res['error'], 'complete': complete, 'jumpsMeasured': jumps,
                     'pass': bool(ok), **summary})
    report = finish_report(jump, rows, 'jump')
    report['handoff'] = {'walkPolicySha256': walk.manifest['policySha256'], 'walkSceneSha256': walk.manifest['sceneSha256']}
    return report


def finish_report(bundle: Bundle, rows: list, skill: str) -> dict:
    import onnxruntime
    required = [r for r in rows if r.get('required', True) and r.get('pass') is not None]
    return {
        'schema': EVAL_SCHEMA, 'skill': skill, 'bodyId': bundle.manifest['bodyId'],
        'policySha256': bundle.manifest['policySha256'], 'sceneSha256': bundle.manifest['sceneSha256'],
        'pass': bool(required) and all(r['pass'] for r in required),
        'rows': rows,
        'engine': {'mujoco': mujoco.__version__, 'onnxruntime': onnxruntime.__version__,
                   'controlDt': CONTROL_DT, 'substeps': SUBSTEPS},
        'scope': ('Deterministic Python MuJoCo rollouts of the exported ONNX policy on the exported scene '
                  '(flat cg_floor; the bumpy row adds the training bump patch). Engineering acceptance for '
                  'this exact body as a game character, not a robustness study or hardware claim.'),
    }


# --------------------------------------------------------------------------- fixtures
def record_fixtures(walk: Bundle, jump: Bundle | None = None) -> dict:
    """Deterministic closed-loop rollout; each kept step restores independently in JS."""
    model = walk.compile()
    data = mujoco.MjData(model)
    ctrl = ReferenceController(model, data, runtime_for(walk, model), runtime_for(jump, model) if jump else None)
    m = walk.manifest
    vmax, wmax = m['moving']['vmax'], m['moving']['wmax']
    plan = [(0, 0, 0, False)] * 6 + [(0.6 * vmax, 0, 0, False)] * 18 + [(0, 0, 0.6 * wmax, False)] * 8
    if jump is not None:
        k = int(round(jump.manifest['episode']['durationS'] / CONTROL_DT))
        plan = [(0, 0, 0, False)] * 4 + [(0, 0, 0, True)] + [(0, 0, 0, False)] * (k + 8)
    steps = []
    for i, (vx, vy, wz, jump_now) in enumerate(plan):
        before = {'qpos': data.qpos.tolist(), 'qvel': data.qvel.tolist(), 'qaccWarmstart': data.qacc_warmstart.tolist(),
                  'time': data.time, **ctrl.controller_state()}
        info = ctrl.step((vx, vy, wz), jump=jump_now)
        steps.append({'k': i, 'command': [vx, vy, wz], 'jump': jump_now, 'before': before,
                      'modeUsed': info['mode'], 'obs': info['obs'].astype(float).tolist(),
                      'action': info['action'].astype(float).tolist(), 'ctrl': info['ctrl'].tolist(),
                      'after': {'qpos': data.qpos.tolist(), 'qvel': data.qvel.tolist(), **ctrl.controller_state()}})
    if jump is not None:
        k = int(round(jump.manifest['episode']['durationS'] / CONTROL_DT))
        keep = set(range(0, 10)) | set(range(4 + k - 4, 4 + k + 4))
        steps = [s for s in steps if s['k'] in keep]
    import onnxruntime
    return {'schema': FIXTURES_SCHEMA, 'skill': 'jump' if jump else 'walk',
            'source': {'mujoco': mujoco.__version__, 'onnxruntime': onnxruntime.__version__,
                       'sceneSha256': m['sceneSha256'], 'policySha256': m['policySha256'],
                       'jumpPolicySha256': jump.manifest['policySha256'] if jump else None},
            'tolerances': {'obs': 1e-5, 'action': 5e-5, 'ctrl': 1e-5, 'qposAfter': 1e-6, 'qvelAfter': 1e-4},
            'note': ('Each step stores the full state before the step (qpos, qvel, qacc_warmstart, time) and the '
                     'controller state; restore it, rebuild the observation, run the ONNX, set targets and step 4 '
                     'substeps, then compare obs/action/ctrl and the state after.'),
            'steps': steps}


# --------------------------------------------------------------------------- jump support
def walk_state_bank(body: Body, walk_dir: Path, cache_dir: Path, *, seed: int = 0, count: int = 2048) -> dict | None:
    """Slow-walk start states for jump training, recorded with the ready walk bundle.

    Cached per walk policy hash, so retraining walk never feeds jump stale states."""
    try:
        walk = Bundle(walk_dir, require_eval=True)
    except (BundleError, OSError, KeyError):
        return None
    if walk.manifest['bodyId'] != body.id:
        return None
    cache = Path(cache_dir) / f"walk_state_bank-{walk.manifest['policySha256'][:16]}.npz"
    if cache.is_file():
        data = np.load(cache)
        return {k: data[k] for k in data.files}
    model = walk.compile()
    data = mujoco.MjData(model)
    ctrl = ReferenceController(model, data, runtime_for(walk, model))
    rng = np.random.default_rng(seed)
    vmax, wmax = walk.manifest['moving']['vmax'], walk.manifest['moving']['wmax']
    qpos, qvel, last = [], [], []
    while len(qpos) < count:
        ctrl.reset()
        cmd = [0.0, 0.0, 0.0] if rng.random() < 0.3 else [rng.uniform(0, 0.4) * vmax, 0.0, rng.uniform(-0.3, 0.3) * wmax]
        for k in range(300):
            ctrl.step(cmd)
            if ctrl.measure()['fall']:
                break
            if k >= 100 and k % 10 == 0:
                qpos.append(np.concatenate([data.qpos[ctrl.root_qpos:ctrl.root_qpos + 7], data.qpos[ctrl.joint_qpos]]))
                qvel.append(np.concatenate([data.qvel[ctrl.root_dof:ctrl.root_dof + 6], data.qvel[ctrl.joint_dof]]))
                last.append(ctrl.last_action.astype(float))
    bank = {'qpos': np.array(qpos[:count]), 'qvel': np.array(qvel[:count]), 'last_action': np.array(last[:count])}
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez(cache, **bank)
    return bank


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bundle', type=Path, required=True, help='walk bundle directory')
    parser.add_argument('--jump', type=Path, default=None, help='jump bundle directory (evaluates the handoff)')
    parser.add_argument('--body', type=Path, default=None, help='body directory (enables the bumpy row)')
    args = parser.parse_args(argv)
    from .body import load_body
    body = load_body(args.body) if args.body else None
    walk = Bundle(args.bundle)
    report = evaluate_jump(Bundle(args.jump), walk) if args.jump else evaluate_walk(walk, body)
    for row in report['rows']:
        print(json.dumps({k: row.get(k) for k in ('name', 'pass', 'fall', 'meanVelocity', 'command', 'outcomes', 'jumpsMeasured')}))
    print(json.dumps({'pass': report['pass']}))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
