"""Vectorised CPU environment: many MuJoCo envs stepped by ``mujoco.rollout``.

One control step (50 Hz) = one ``Rollout.rollout`` call with ``nstep = 4``
substeps and the position targets held constant; the PD lives in the scene's
native position actuators, so torques are recomputed every 5 ms substep inside
MuJoCo's C threads. Env state between calls is just the FULLPHYSICS state
vector (time, qpos, qvel) per env, so envs are cheap (no MjData per env) and the
whole env state can be checkpointed exactly. Observations, rewards, resets,
pushes and curricula are vectorised numpy on the returned state/sensordata.

Domain randomisation uses a pool of model variants (foot friction, payload and
torso COM, servo strength/gains, joint damping/friction, bump patch or flat);
each env runs on one variant drawn at reset, the pool is re-drawn periodically.
Note: ``rollout`` starts every call from a zero solver warm-start, which equals
a fresh ``mj_step`` from the restored state (verified bit-identical); the
browser keeps its warm-start between steps, a difference far below the
contact solver tolerance.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass

import mujoco
import numpy as np
from mujoco import rollout

from . import obs as O
from .body import Body
from .sim_model import CONTROL_DT, DECIMATION, GRAVITY, SceneIndex, build_scene
from .terrain import TerrainBank, terrain_spec_for

REF_LEG = 0.44
CTRL_SPEC = mujoco.mjtState.mjSTATE_CTRL.value


@dataclass
class Scaling:
    """Body-size scaling (Froude-style, reference leg 0.44 m like Draft)."""
    leg: float
    s: float
    sqrt_s: float
    vmax: float
    wmax: float
    freq: float
    h0: float

    @classmethod
    def for_body(cls, body: Body) -> 'Scaling':
        leg = body.leg_length
        s = leg / REF_LEG
        # Froude number v^2/(g L) = 0.25 at the top command: a brisk walk/trot.
        vmax = 0.5 * math.sqrt(GRAVITY * leg)
        # Draft-style actuator ceiling: knee no-load speed x shank (~half the leg).
        knee = [j.velocity for j in body.joints if j.role == 'knee'] or [j.velocity for j in body.joints]
        vmax = min(vmax, 0.5 * 0.74 * min(knee) * 0.5 * leg)
        wmax = float(np.clip(1.0 / math.sqrt(s), 0.6, 1.5))
        freq = float(np.clip(2.0 * math.sqrt(REF_LEG / leg), 1.2, 3.0))
        return cls(leg=leg, s=s, sqrt_s=math.sqrt(s), vmax=round(vmax, 4), wmax=round(wmax, 4),
                   freq=round(freq, 4), h0=body.nominal_root_height)


def gait_offsets(body: Body) -> tuple[np.ndarray, float]:
    """Leg phase offsets from gaitHint groups and the swing fraction of the cycle."""
    groups = body.gait_groups
    offsets = np.zeros(len(body.legs))
    for k, group in enumerate(groups):
        for leg in group:
            offsets[leg] = k / len(groups)
    swing = 0.9 * min(0.5, 1.0 / len(groups))
    return offsets, swing


def ramp(x: float, start: float, end: float, lo: float = 0.0, hi: float = 1.0) -> float:
    if end <= start:
        return hi if x >= end else lo
    return lo + (hi - lo) * float(np.clip((x - start) / (end - start), 0.0, 1.0))


class ModelPool:
    """Domain-randomised copies of the training model (same size signature)."""

    PARAMS = ('friction', 'payload', 'com_x', 'com_y', 'com_z', 'kp', 'kv', 'effort', 'damping',
              'frictionloss', 'pattern', 'bump_scale')

    def __init__(self, model: mujoco.MjModel, index: SceneIndex, body: Body, scaling: Scaling,
                 terrain: TerrainBank, count: int):
        self.base = model
        self.index = index
        self.terrain = terrain
        self.scaling = scaling
        self.count = count
        self.models = [copy.copy(model) for _ in range(count)]
        self.scratch = mujoco.MjData(model)
        self.params = {k: np.zeros(count) for k in self.PARAMS}
        self.params['pattern'][:] = -1
        root = index.root_body
        self.defaults = {
            'foot_friction': model.geom_friction[index.foot_geoms].copy(),
            'mass': float(model.body_mass[root]), 'inertia': model.body_inertia[root].copy(),
            'ipos': model.body_ipos[root].copy(),
            'gain': model.actuator_gainprm[index.actuators, 0].copy(),
            'bias': model.actuator_biasprm[index.actuators, :3].copy(),
            'forcerange': model.actuator_forcerange[index.actuators].copy(),
            'actfrc': model.jnt_actfrcrange.copy(),
            'damping': model.dof_damping.copy(), 'frictionloss': model.dof_frictionloss.copy(),
        }
        self.joint_ids = np.array([model.actuator_trnid[a, 0] for a in index.actuators])

    def randomize(self, rng: np.random.Generator, dr: float, bump_fraction: float, bump_scale: float) -> None:
        n = self.count
        p = self.params
        p['friction'][:] = rng.uniform(0.4, 1.2, n)
        p['payload'][:] = rng.uniform(-0.1, 0.2, n) * dr
        com = 0.02 * self.scaling.s * dr
        p['com_x'][:] = rng.uniform(-com, com, n)
        p['com_y'][:] = rng.uniform(-com, com, n)
        p['com_z'][:] = rng.uniform(-com / 2, com / 2, n)
        p['kp'][:] = 1 + rng.uniform(-0.1, 0.1, n) * dr
        p['kv'][:] = 1 + rng.uniform(-0.2, 0.2, n) * dr
        p['effort'][:] = 1 + rng.uniform(-0.15, 0.1, n) * dr
        p['damping'][:] = 1 + rng.uniform(-0.5, 0.5, n) * dr
        p['frictionloss'][:] = 1 + rng.uniform(-0.5, 0.5, n) * dr
        bumpy = rng.random(n) < bump_fraction
        p['pattern'][:] = np.where(bumpy, rng.integers(0, self.terrain.count, n), -1)
        p['bump_scale'][:] = np.where(bumpy, bump_scale, 0.0)
        for i in range(n):
            self.apply(i)

    def apply(self, i: int) -> None:
        m, d, idx, p = self.models[i], self.defaults, self.index, {k: v[i] for k, v in self.params.items()}
        root = idx.root_body
        m.geom_friction[idx.foot_geoms] = d['foot_friction']
        m.geom_friction[idx.foot_geoms, 0] = p['friction']
        ratio = 1 + p['payload']
        m.body_mass[root] = d['mass'] * ratio
        m.body_inertia[root] = d['inertia'] * ratio
        m.body_ipos[root] = d['ipos'] + np.array([p['com_x'], p['com_y'], p['com_z']])
        m.actuator_gainprm[idx.actuators, 0] = d['gain'] * p['kp']
        m.actuator_biasprm[idx.actuators, 0] = d['bias'][:, 0]
        m.actuator_biasprm[idx.actuators, 1] = d['bias'][:, 1] * p['kp']
        m.actuator_biasprm[idx.actuators, 2] = d['bias'][:, 2] * p['kv']
        m.actuator_forcerange[idx.actuators] = d['forcerange'] * p['effort']
        m.jnt_actfrcrange[:] = d['actfrc']
        m.jnt_actfrcrange[self.joint_ids] = d['actfrc'][self.joint_ids] * p['effort']
        m.dof_damping[:] = d['damping'] * p['damping']
        m.dof_frictionloss[:] = d['frictionloss'] * p['frictionloss']
        if idx.terrain_geom >= 0:
            pattern = int(p['pattern'])
            on = pattern >= 0
            m.geom_contype[idx.terrain_geom] = 1 if on else 0
            m.geom_conaffinity[idx.terrain_geom] = 15 if on else 0
            if on:
                adr = m.hfield_adr[idx.terrain_hfield]
                size = m.hfield_nrow[idx.terrain_hfield] * m.hfield_ncol[idx.terrain_hfield]
                m.hfield_data[adr:adr + size] = self.terrain.hfield_data(pattern, float(p['bump_scale']))
        # Derived constants (subtree mass, invweight, acc0) follow the edited inertia.
        mujoco.mj_setConst(m, self.scratch)


class CreatureEnv:
    """Batched env for one body and one skill (``walk`` or ``jump``)."""

    def __init__(self, body: Body, skill: str, *, n_envs: int = 256, threads: int = 2, seed: int = 0,
                 n_variants: int = 32, cache_dir=None, state_bank: dict | None = None):
        if skill not in ('walk', 'jump'):
            raise ValueError(f'unknown skill {skill}')
        self.body, self.skill, self.n, self.threads = body, skill, n_envs, threads
        self.scaling = sc = Scaling.for_body(body)
        self.offsets, self.swing_frac = gait_offsets(body)
        self.rng = np.random.default_rng(seed)
        spec = terrain_spec_for(body.leg_length)
        self.scene = build_scene(body, terrain=spec)
        self.model = self.scene.compile()
        self.export_scene = build_scene(body)
        self.idx = idx = SceneIndex.build(self.model, body, self.scene.sensor_names)
        if idx.root_qpos != 0:
            raise RuntimeError('training scene must start with the robot free joint')
        self.terrain = TerrainBank(spec, body.leg_length, count=8, seed=1234, cache_dir=cache_dir)
        self.pool = ModelPool(self.model, idx, body, sc, self.terrain, n_variants)
        self.nu, self.n_legs = idx.nu, len(body.legs)
        self.default = np.array(body.nominal_joint_positions)
        self.lo, self.hi = idx.ctrl_lo, idx.ctrl_hi
        mid, half = (self.lo + self.hi) / 2, (self.hi - self.lo) / 2
        self.soft_lo, self.soft_hi = mid - 0.95 * half, mid + 0.95 * half
        self.effort = self.scene.effort
        self.omega = np.array([j.velocity for j in body.joints])
        self.weight = body.mass_kg * GRAVITY
        self.contact_threshold = 0.05 * self.weight / self.n_legs
        self.foot_radius = np.array([leg.foot_radius for leg in body.legs])

        self.executor = rollout.Rollout(nthread=threads)
        self.datas = [mujoco.MjData(self.model) for _ in range(max(1, threads))]
        self.fk = mujoco.MjData(self.model)
        n, ns = n_envs, idx.nstate
        self.state = np.zeros((n, ns))
        self.out_state = np.zeros((n, DECIMATION, ns))
        self.out_sensor = np.zeros((n, DECIMATION, idx.nsensordata))
        self.ctrl = np.zeros((n, DECIMATION, self.nu))
        self.variant = np.zeros(n, dtype=np.int64)
        self.models = [self.pool.models[0]] * n
        self.last_action = np.zeros((n, self.nu))
        self.prev_action = np.zeros((n, self.nu))
        self.prev_joint_vel = np.zeros((n, self.nu))
        self.ep_step = np.zeros(n, dtype=np.int64)
        self.ep_return = np.zeros(n)
        self.push_timer = np.zeros(n, dtype=np.int64)
        self.progress = 0.0
        self.iteration = 0
        self.task = WalkTask(self) if skill == 'walk' else JumpTask(self, state_bank)
        self.curriculum = {}
        self.set_progress(0.0, force_pool=True)
        self.reset(np.arange(n))
        self.obs_noise = True

    # ------------------------------------------------------------------ curriculum
    def set_progress(self, fraction: float, *, force_pool: bool = False) -> None:
        f = float(np.clip(fraction, 0.0, 1.0))
        self.progress = f
        cur = {
            'command_scale': ramp(f, 0.0, 0.3, 0.5, 1.0),
            'push_scale': ramp(f, 0.15, 0.5),
            'bump_fraction': 0.4,
            'bump_scale': ramp(f, 0.05, 0.6, 0.3, 1.0),
            'dr': ramp(f, 0.0, 0.4, 0.3, 1.0),
        }
        if self.skill == 'jump':
            cur.update(push_scale=0.0, bump_fraction=0.0, command_scale=1.0)
        changed = force_pool or any(abs(cur[k] - self.curriculum.get(k, -1)) > 0.05 for k in ('bump_scale', 'dr'))
        self.curriculum = cur
        if changed:
            self.redraw_pool()

    def redraw_pool(self) -> None:
        c = self.curriculum
        self.pool.randomize(self.rng, c['dr'], c['bump_fraction'], c['bump_scale'])

    # ------------------------------------------------------------------ helpers
    def qpos(self, state=None):
        s = self.state if state is None else state
        return s[..., 1:1 + self.idx.nq]

    def qvel(self, state=None):
        s = self.state if state is None else state
        return s[..., 1 + self.idx.nq:1 + self.idx.nq + self.idx.nv]

    def ground(self, ids, x, y):
        v = self.variant[ids]
        return self.terrain.height(self.pool.params['pattern'][v].astype(np.int64),
                                   self.pool.params['bump_scale'][v], x, y)

    def place(self, ids: np.ndarray, qpos: np.ndarray, clearance: np.ndarray) -> None:
        """Lift each root so its lowest foot sits ``clearance`` above the ground below it."""
        idx = self.idx
        for k, env in enumerate(ids):
            self.fk.qpos[:] = qpos[k]
            mujoco.mj_kinematics(self.model, self.fk)
            feet = self.fk.site_xpos[idx.foot_sites]
            g = self.ground(np.array([env]), feet[None, :, 0], feet[None, :, 1])[0]
            lowest = np.min(feet[:, 2] - self.foot_radius - g)
            qpos[k, 2] += clearance[k] - lowest

    def sample_states(self, ids: np.ndarray, *, landing_fraction: float, joint_noise: float) -> None:
        n, rng, sc = len(ids), self.rng, self.scaling
        qpos = np.tile(np.array(self.body.initial_qpos), (n, 1))
        qvel = np.zeros((n, self.idx.nv))
        qpos[:, 0] = rng.uniform(-2.5, 2.5, n)
        qpos[:, 1] = rng.uniform(-2.5, 2.5, n)
        landing = rng.random(n) < landing_fraction
        tilt = np.where(landing, 0.25, 0.1)
        roll, pitch = rng.uniform(-1, 1, n) * tilt, rng.uniform(-1, 1, n) * tilt
        yaw = rng.uniform(-np.pi, np.pi, n)
        cr, sr, cp, sp, cy, sy = (np.cos(roll / 2), np.sin(roll / 2), np.cos(pitch / 2),
                                  np.sin(pitch / 2), np.cos(yaw / 2), np.sin(yaw / 2))
        qpos[:, 3] = cr * cp * cy + sr * sp * sy
        qpos[:, 4] = sr * cp * cy - cr * sp * sy
        qpos[:, 5] = cr * sp * cy + sr * cp * sy
        qpos[:, 6] = cr * cp * sy - sr * sp * cy
        noise = np.where(landing[:, None], 3 * joint_noise, joint_noise)
        joints = self.default + rng.uniform(-1, 1, (n, self.nu)) * noise
        qpos[:, self.idx.joint_qpos] = np.clip(joints, self.soft_lo, self.soft_hi)
        qvel[:, 0:2] = rng.uniform(-0.3, 0.3, (n, 2)) * sc.sqrt_s
        qvel[:, 3:6] = rng.uniform(-0.3, 0.3, (n, 3))
        qvel[:, self.idx.joint_dof] = rng.uniform(-0.5, 0.5, (n, self.nu))
        clearance = np.where(landing, rng.uniform(0.05, 0.3, n) * sc.leg, rng.uniform(0.002, 0.01, n))
        qvel[:, 2] = np.where(landing, -rng.uniform(0, 1.0, n) * sc.sqrt_s, 0.0)
        self.place(ids, qpos, clearance)
        self.state[ids, 0] = 0.0
        self.state[ids, 1:1 + self.idx.nq] = qpos
        self.state[ids, 1 + self.idx.nq:1 + self.idx.nq + self.idx.nv] = qvel

    def reset(self, ids: np.ndarray) -> None:
        if len(ids) == 0:
            return
        self.variant[ids] = self.rng.integers(0, self.pool.count, len(ids))
        for env in ids:
            self.models[env] = self.pool.models[self.variant[env]]
        self.last_action[ids] = 0
        self.prev_action[ids] = 0
        self.ep_step[ids] = 0
        self.ep_return[ids] = 0
        sc = self.scaling
        self.push_timer[ids] = (self.rng.uniform(2, 5, len(ids)) * sc.sqrt_s / CONTROL_DT).astype(np.int64)
        self.task.reset(ids)
        self.prev_joint_vel[ids] = self.qvel()[ids][:, self.idx.joint_dof]

    # ------------------------------------------------------------------ stepping
    def physics(self, ctrl: np.ndarray) -> None:
        self.ctrl[:] = ctrl[:, None, :]
        self.executor.rollout(self.models, self.datas, self.state, self.ctrl, control_spec=CTRL_SPEC,
                              skip_checks=True, nstep=DECIMATION, initial_warmstart=None,
                              state=self.out_state, sensordata=self.out_sensor, chunk_size=None)

    def step(self, actions: np.ndarray):
        task, idx = self.task, self.idx
        a = np.clip(np.asarray(actions, dtype=np.float64), -task.action_clip, task.action_clip)
        self.prev_action[:] = self.last_action
        self.last_action[:] = a
        ctrl = np.clip(self.default + task.action_scale * a, self.lo, self.hi)
        t_before = self.state[:, 0].copy()
        self.physics(ctrl)
        self.state[:] = self.out_state[:, -1]
        finite = np.all(np.isfinite(self.state), axis=1)
        # MuJoCo resets MjData (time -> 0) on divergence; treat that as a failed episode.
        valid = finite & (self.state[:, 0] > t_before + 0.5 * DECIMATION * 0.005) & \
            (np.max(np.abs(self.qvel()), axis=1, initial=0.0) < 1e3)
        if not np.all(valid):
            self.state[~valid] = 0.0
            self.state[~valid, 4] = 1.0  # unit quaternion so observation math stays finite
            self.out_sensor[~valid] = 0.0
        self.ep_step += 1
        self.push(valid)
        rewards, terminated, info = task.evaluate(valid)
        truncated = (self.ep_step >= task.max_steps) & ~terminated
        done = terminated | truncated
        self.ep_return += rewards
        # Clocks advance before the terminal observation so a time-out bootstraps
        # from exactly the observation the policy would have seen next.
        task.advance()
        info['terminal_critic_obs'] = None
        if np.any(truncated):
            info['truncated_ids'] = np.nonzero(truncated)[0]
            info['terminal_critic_obs'] = self.critic_obs()[truncated]
        finished = np.nonzero(done)[0]
        info['episode_returns'] = self.ep_return[finished].copy()
        info['episode_lengths'] = self.ep_step[finished].copy()
        info['invalid'] = int(np.sum(~valid))
        self.reset(finished)
        self.prev_joint_vel[:] = self.qvel()[:, idx.joint_dof]
        return self.actor_obs(), self.critic_obs(), rewards.astype(np.float32), terminated, truncated, info

    def push(self, valid: np.ndarray) -> None:
        scale = self.curriculum['push_scale']
        self.push_timer -= 1
        due = (self.push_timer <= 0) & valid
        if not np.any(due):
            return
        ids = np.nonzero(due)[0]
        sc = self.scaling
        self.push_timer[ids] = (self.rng.uniform(2, 5, len(ids)) * sc.sqrt_s / CONTROL_DT).astype(np.int64)
        if scale <= 0:
            return
        base = 1 + self.idx.nq + self.idx.root_dof
        self.state[ids, base:base + 2] += self.rng.uniform(-0.5, 0.5, (len(ids), 2)) * sc.sqrt_s * scale
        self.state[ids, base + 3:base + 6] += self.rng.uniform(-0.3, 0.3, (len(ids), 3)) * scale

    # ------------------------------------------------------------------ observations
    def proprio(self) -> dict:
        idx = self.idx
        return O.proprio_values(self.qpos(), self.qvel(), idx.root_qpos, idx.root_dof,
                                idx.joint_qpos, idx.joint_dof, self.default)

    def actor_obs(self) -> np.ndarray:
        values = self.proprio()
        if self.obs_noise:
            rng, n = self.rng, self.n
            values['base_lin_vel'] = values['base_lin_vel'] + rng.uniform(-0.05, 0.05, (n, 3)) * self.scaling.sqrt_s
            values['base_ang_vel'] = values['base_ang_vel'] + rng.uniform(-0.1, 0.1, (n, 3))
            values['projected_gravity'] = values['projected_gravity'] + rng.uniform(-0.03, 0.03, (n, 3))
            values['joint_pos'] = values['joint_pos'] + rng.uniform(-0.01, 0.01, (n, self.nu))
            values['joint_vel'] = values['joint_vel'] + rng.uniform(-1, 1, (n, self.nu)) * 0.0104 * self.omega
        return self.task.actor_obs(values)

    def critic_obs(self) -> np.ndarray:
        values = self.proprio()
        actor = self.task.actor_obs(values)
        return np.concatenate([actor, self.task.privileged()], axis=1).astype(np.float32)

    # ------------------------------------------------------------------ sensors
    def sensors(self) -> dict:
        idx, sd = self.idx, self.out_sensor
        touch = sd[:, :, idx.touch]
        feet = sd[:, -1, :][:, idx.foot_pos[:, None] + np.arange(3)]
        feet_vel = sd[:, -1, :][:, idx.foot_vel[:, None] + np.arange(3)]
        return {
            'contact': np.mean(touch > self.contact_threshold, axis=1),
            'touch': touch[:, -1],
            'feet': feet, 'feet_vel': feet_vel,
            'torso_contact': np.any(sd[:, :, idx.torso_contact] > 0, axis=1),
            'thigh_contact': np.any(sd[:, :, idx.thigh_contact] > 0, axis=1),
            'force': np.sqrt(np.mean(sd[:, :, idx.actuator_force] ** 2, axis=1)),
        }

    # ------------------------------------------------------------------ checkpoint state
    def state_dict(self) -> dict:
        return {
            'state': self.state.copy(), 'variant': self.variant.copy(),
            'last_action': self.last_action.copy(), 'prev_action': self.prev_action.copy(),
            'ep_step': self.ep_step.copy(), 'ep_return': self.ep_return.copy(),
            'push_timer': self.push_timer.copy(),
            'pool_params': {k: v.copy() for k, v in self.pool.params.items()},
            'task': self.task.state_dict(), 'curriculum': dict(self.curriculum), 'progress': self.progress,
            'rng': self.rng.bit_generator.state,
        }

    def load_state_dict(self, sd: dict) -> bool:
        """Restore env state; returns False (and keeps a fresh reset) if shapes differ."""
        if sd.get('state') is None or sd['state'].shape != self.state.shape:
            return False
        self.rng.bit_generator.state = sd['rng']
        for k, v in sd['pool_params'].items():
            self.pool.params[k][:] = v
        for i in range(self.pool.count):
            self.pool.apply(i)
        self.curriculum = dict(sd['curriculum'])
        self.progress = float(sd['progress'])
        for key in ('state', 'variant', 'last_action', 'prev_action', 'ep_step', 'ep_return', 'push_timer'):
            getattr(self, key)[:] = sd[key]
        self.models = [self.pool.models[v] for v in self.variant]
        self.task.load_state_dict(sd['task'])
        self.prev_joint_vel[:] = self.qvel()[:, self.idx.joint_dof]
        return True

    def close(self) -> None:
        if self.executor is not None:
            self.executor.close()
            self.executor = None


class WalkTask:
    """Perpetual velocity tracking with a gait clock (swing/stance shaping per leg)."""

    action_clip = 4.0

    def __init__(self, env: CreatureEnv):
        self.env = env
        sc = env.scaling
        self.action_scale = 0.175 * np.ones(env.nu)   # Draft: 0.25 / KP_PER_NM rad per unit action
        self.max_steps = int(round(20.0 / CONTROL_DT))
        self.terms = O.walk_terms(env.nu, env.n_legs)
        self.command = np.zeros((env.n, 3))
        self.cmd_timer = np.zeros(env.n, dtype=np.int64)
        self.phase = np.zeros(env.n)
        self.h_peak = 0.15 * sc.leg
        self.sigma_v = 0.3 * sc.sqrt_s
        self.sigma_w = 0.4
        self.privileged_size = 3 + 2 * env.n_legs
        self.log_terms = {}

    @property
    def obs_size(self) -> int:
        return O.obs_size(self.terms)

    def bounds(self) -> dict:
        sc = self.env.scaling
        return {'vx': [round(-0.5 * sc.vmax, 4), sc.vmax], 'vy': [0.0, 0.0], 'wz': [-sc.wmax, sc.wmax]}

    def sample_commands(self, ids: np.ndarray) -> None:
        env, n = self.env, len(ids)
        rng, sc = env.rng, env.scaling
        scale = env.curriculum['command_scale']
        vx = rng.uniform(-0.5 * sc.vmax, sc.vmax, n) * scale
        wz = rng.uniform(-sc.wmax, sc.wmax, n) * scale
        mode = rng.random(n)
        wz = np.where(mode < 0.25, 0.0, wz)                     # straight lines
        vx = np.where((mode >= 0.25) & (mode < 0.4), 0.0, vx)   # turn in place
        weak = (np.abs(vx) < 0.15 * sc.vmax) & (np.abs(wz) < 0.15 * sc.wmax)
        vx = np.where(weak, np.sign(vx + 1e-9) * 0.2 * sc.vmax, vx)
        stand = rng.random(n) < 0.15
        self.command[ids, 0] = np.where(stand, 0.0, vx)
        self.command[ids, 1] = 0.0
        self.command[ids, 2] = np.where(stand, 0.0, wz)
        self.cmd_timer[ids] = (rng.uniform(3, 8, n) / CONTROL_DT).astype(np.int64)

    def reset(self, ids: np.ndarray) -> None:
        env = self.env
        env.sample_states(ids, landing_fraction=0.2, joint_noise=0.1)
        self.phase[ids] = env.rng.uniform(0, 1, len(ids))
        self.sample_commands(ids)

    def moving(self) -> np.ndarray:
        sc = self.env.scaling
        return O.is_moving(self.command, sc.vmax, sc.wmax)

    def actor_obs(self, values: dict) -> np.ndarray:
        env = self.env
        values = dict(values, command=self.command, last_action=env.last_action,
                      gait_clock=O.gait_clock(self.phase, env.offsets, self.moving()))
        return O.build(self.terms, values)

    def privileged(self) -> np.ndarray:
        env = self.env
        qpos = env.qpos()
        ids = np.arange(env.n)
        g = env.ground(ids, qpos[:, 0:1], qpos[:, 1:2])[:, 0]
        feet = getattr(self, '_feet', None)
        contact = getattr(self, '_contact', None)
        if feet is None:
            feet = np.zeros((env.n, env.n_legs))
            contact = np.zeros((env.n, env.n_legs))
        friction = env.pool.params['friction'][env.variant]
        payload = env.pool.params['payload'][env.variant]
        return np.concatenate([(qpos[:, 2] - g)[:, None] / env.scaling.h0, friction[:, None], payload[:, None],
                               contact, feet / env.scaling.leg], axis=1)

    def advance(self) -> None:
        env = self.env
        self.phase += env.scaling.freq * CONTROL_DT
        self.phase[self.phase >= 1.0] -= 1.0
        self.cmd_timer -= 1
        due = np.nonzero(self.cmd_timer <= 0)[0]
        if len(due):
            self.sample_commands(due)

    def evaluate(self, valid: np.ndarray):
        env, sc = self.env, self.env.scaling
        values = env.proprio()
        s = env.sensors()
        qpos, qvel = env.qpos(), env.qvel()
        ids = np.arange(env.n)
        v, w, g = values['base_lin_vel'], values['base_ang_vel'], values['projected_gravity']
        cmd = self.command
        moving = self.moving()
        # Phase of the state just reached (the clock advances after this step).
        phase_next = self.phase + sc.freq * CONTROL_DT
        phase_next = phase_next - np.floor(phase_next)
        leg_phase = O.leg_phases(phase_next, env.offsets)
        swing = (leg_phase < self.swing_frac_value()) & moving[:, None]
        stance = ~swing
        contact = s['contact']
        feet = s['feet']
        ground_feet = env.ground(ids, feet[:, :, 0], feet[:, :, 1])
        foot_h = feet[:, :, 2] - env.foot_radius - ground_feet
        ground_root = env.ground(ids, qpos[:, 0:1], qpos[:, 1:2])[:, 0]
        height = qpos[:, 2] - ground_root
        self._feet, self._contact = foot_h, contact

        err_v = (cmd[:, 0] - v[:, 0]) ** 2 + (cmd[:, 1] - v[:, 1]) ** 2
        err_w = (cmd[:, 2] - w[:, 2]) ** 2
        swing_progress = np.clip(leg_phase / self.swing_frac_value(), 0, 1)
        target_h = self.h_peak * np.sin(np.pi * swing_progress)
        joint_err = qpos[:, env.idx.joint_qpos] - env.default
        joint_vel = qvel[:, env.idx.joint_dof]
        q = qpos[:, env.idx.joint_qpos]
        limit = np.maximum(q - env.soft_hi, 0) + np.maximum(env.soft_lo - q, 0)
        slip = np.sum(s['feet_vel'][:, :, :2] ** 2, axis=2)
        r = {
            'track_lin_vel': 1.5 * np.exp(-err_v / self.sigma_v ** 2),
            'track_ang_vel': 0.8 * np.exp(-err_w / self.sigma_w ** 2),
            'upright': 0.5 * np.exp(-(g[:, 0] ** 2 + g[:, 1] ** 2) / 0.05),
            'height': 0.4 * np.exp(-((height - 0.96 * sc.h0) / (0.15 * sc.h0)) ** 2),
            'gait_contact': 1.0 * np.mean(np.where(swing, 1 - contact, contact), axis=1),
            'swing_height': -1.0 * np.mean(swing * ((foot_h - target_h) / self.h_peak) ** 2, axis=1),
            'stance_slip': -0.5 * np.mean(stance * contact * slip, axis=1) / sc.s,
            'lin_vel_z': -1.0 * v[:, 2] ** 2 / sc.s,
            'ang_vel_xy': -0.05 * (w[:, 0] ** 2 + w[:, 1] ** 2),
            'action_rate': -0.6 * np.mean((env.last_action - env.prev_action) ** 2, axis=1),
            'torque': -0.2 * np.mean((s['force'] / env.effort) ** 2, axis=1),
            'joint_acc': -1e-4 * np.mean(((joint_vel - env.prev_joint_vel) / CONTROL_DT / env.omega) ** 2, axis=1),
            'joint_limits': -2.0 * np.mean(limit, axis=1),
            'thigh_contact': -1.0 * np.mean(s['thigh_contact'], axis=1),
            'stand_pose': -1.0 * np.mean(joint_err ** 2, axis=1) * ~moving,
            'stand_still': -0.05 * np.mean((joint_vel / env.omega * 10) ** 2, axis=1) * ~moving,
        }
        total = sum(r.values()) * CONTROL_DT
        tilt_bad = g[:, 2] > -math.cos(1.0)
        low = (qpos[:, 2] - np.mean(feet[:, :, 2], axis=1)) < 0.5 * sc.h0
        terminated = ~valid | tilt_bad | low | s['torso_contact']
        total = np.where(terminated, total - 2.0, total)
        total = np.where(valid, total, -2.0)
        info = {'terms': {k: float(np.mean(val)) for k, val in r.items()},
                'tracking': {'vx_abs_err': float(np.mean(np.abs(cmd[:, 0] - v[:, 0])[moving])) if np.any(moving) else 0.0,
                             'wz_abs_err': float(np.mean(np.abs(cmd[:, 2] - w[:, 2])[moving])) if np.any(moving) else 0.0},
                'falls': int(np.sum(terminated))}
        return total, terminated, info

    def swing_frac_value(self) -> float:
        return self.env.swing_frac

    def state_dict(self) -> dict:
        return {'command': self.command.copy(), 'cmd_timer': self.cmd_timer.copy(), 'phase': self.phase.copy()}

    def load_state_dict(self, sd: dict) -> None:
        self.command[:] = sd['command']
        self.cmd_timer[:] = sd['cmd_timer']
        self.phase[:] = sd['phase']


@dataclass
class JumpReference:
    """Body-scaled vertical profile the jump policy is rewarded to follow (training only).

    crouch (cosine) -> constant-acceleration push to take-off -> ballistic flight
    with apex ``flight_rise`` above the take-off height -> landing absorb -> stand.
    Everything scales with the nominal root height, leg length and gravity, so any
    body gets a physically consistent target without motion capture.
    """
    duration: float
    h_stand: float
    crouch: float
    extend: float
    flight_rise: float
    t_crouch: float
    t_push: float
    t_takeoff: float
    t_land: float
    t_absorb: float
    v_takeoff: float

    @classmethod
    def for_scaling(cls, sc: Scaling, duration: float) -> 'JumpReference':
        h_stand = 0.96 * sc.h0
        crouch = 0.15 * sc.h0
        extend = 0.04 * sc.leg
        rise = 0.15 * sc.leg
        v_to = math.sqrt(2 * GRAVITY * rise)
        t_push = 2 * (crouch + extend) / v_to          # from rest with constant acceleration
        t_crouch = 0.08 * duration
        t_takeoff = t_crouch + 0.22 + t_push
        t_land = t_takeoff + 2 * v_to / GRAVITY
        t_absorb = t_land + 0.25
        if t_absorb > duration - 0.15:
            raise ValueError('jump window too short for this body')
        return cls(duration, h_stand, crouch, extend, rise, t_crouch, t_push, t_takeoff, t_land, t_absorb, v_to)

    def __call__(self, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        h = np.full(t.shape, self.h_stand)
        vz = np.zeros(t.shape)
        h_c = self.h_stand - self.crouch
        h_to = self.h_stand + self.extend
        c0, c1 = self.t_crouch, self.t_crouch + 0.22
        m = (t >= c0) & (t < c1)
        u = (t[m] - c0) / (c1 - c0)
        h[m] = self.h_stand - self.crouch * (1 - np.cos(np.pi * u)) / 2
        vz[m] = -self.crouch * np.pi / (2 * (c1 - c0)) * np.sin(np.pi * u)
        m = (t >= c1) & (t < self.t_takeoff)
        tau = t[m] - c1
        a = self.v_takeoff / self.t_push
        h[m] = h_c + 0.5 * a * tau ** 2
        vz[m] = a * tau
        m = (t >= self.t_takeoff) & (t < self.t_land)
        tau = t[m] - self.t_takeoff
        h[m] = h_to + self.v_takeoff * tau - 0.5 * GRAVITY * tau ** 2
        vz[m] = self.v_takeoff - GRAVITY * tau
        m = (t >= self.t_land) & (t < self.t_absorb)
        u = (t[m] - self.t_land) / (self.t_absorb - self.t_land)
        low = self.h_stand - 0.5 * self.crouch
        # Two half-cosines: give way from take-off height to `low`, then rise to standing.
        first = u < 0.5
        h_m = np.where(first, h_to + (low - h_to) * (1 - np.cos(np.pi * 2 * u)) / 2,
                       low + (self.h_stand - low) * (1 - np.cos(np.pi * (2 * u - 1))) / 2)
        h[m] = h_m
        span = self.t_absorb - self.t_land
        vz[m] = np.where(first, (low - h_to) * np.pi / span * np.sin(np.pi * 2 * u),
                         (self.h_stand - low) * np.pi / span * np.sin(np.pi * (2 * u - 1)))
        return h, vz

    def to_dict(self) -> dict:
        return {k: round(float(v), 5) for k, v in self.__dict__.items()}


class JumpTask:
    """Episodic one-shot jump: crouch -> takeoff -> flight -> landing -> settle."""

    action_clip = 4.0

    def __init__(self, env: CreatureEnv, state_bank: dict | None):
        self.env = env
        sc = env.scaling
        self.action_scale = 0.3 * np.ones(env.nu)
        # A whole number of control steps, so phase reaches exactly 1 on the last
        # step here and in the controller (both stop at phase >= 1 - 1e-9).
        self.max_steps = int(round(float(np.clip(1.4 * sc.sqrt_s, 1.2, 1.6)) / CONTROL_DT))
        self.duration = round(self.max_steps * CONTROL_DT, 6)
        self.reference = JumpReference.for_scaling(sc, self.duration)
        self.terms = O.jump_terms(env.nu)
        self.phase = np.zeros(env.n)
        self.max_height = np.zeros(env.n)
        self.air_steps = np.zeros(env.n, dtype=np.int64)
        self.bank = state_bank
        self.privileged_size = 4 + 2 * env.n_legs
        self.walk_scale = 0.175

    @property
    def obs_size(self) -> int:
        return O.obs_size(self.terms)

    def bounds(self) -> dict:
        return {'vx': [0.0, 0.0], 'vy': [0.0, 0.0], 'wz': [0.0, 0.0]}

    def reset(self, ids: np.ndarray) -> None:
        env = self.env
        env.sample_states(ids, landing_fraction=0.0, joint_noise=0.05)
        bank = self.bank
        if bank is not None and len(bank['qpos']):
            # Half the jumps start from slow-walk states recorded with the walk policy.
            from_walk = ids[env.rng.random(len(ids)) < 0.5]
            if len(from_walk):
                pick = env.rng.integers(0, len(bank['qpos']), len(from_walk))
                qpos = bank['qpos'][pick].copy()
                qpos[:, 0] = env.rng.uniform(-2.5, 2.5, len(pick))
                qpos[:, 1] = env.rng.uniform(-2.5, 2.5, len(pick))
                env.state[from_walk, 1:1 + env.idx.nq] = qpos
                env.state[from_walk, 1 + env.idx.nq:1 + env.idx.nq + env.idx.nv] = bank['qvel'][pick]
                # The walk policy's last targets, re-expressed in jump action units.
                env.last_action[from_walk] = np.clip(bank['last_action'][pick] * self.walk_scale / self.action_scale,
                                                     -self.action_clip, self.action_clip)
        else:
            env.state[ids, 1 + env.idx.nq:1 + env.idx.nq + env.idx.nv] *= 0.3
        self.phase[ids] = 0.0
        self.max_height[ids] = env.qpos()[ids, 2]
        self.air_steps[ids] = 0

    def actor_obs(self, values: dict) -> np.ndarray:
        values = dict(values, last_action=self.env.last_action, jump_phase=O.jump_phase_features(self.phase))
        return O.build(self.terms, values)

    def privileged(self) -> np.ndarray:
        env = self.env
        qpos = env.qpos()
        feet = getattr(self, '_feet', np.zeros((env.n, env.n_legs)))
        contact = getattr(self, '_contact', np.zeros((env.n, env.n_legs)))
        return np.concatenate([(qpos[:, 2:3]) / env.scaling.h0, (self.max_height[:, None] - env.scaling.h0) / env.scaling.leg,
                               self.air_steps[:, None] * CONTROL_DT, env.pool.params['friction'][env.variant][:, None],
                               contact, feet / env.scaling.leg], axis=1)

    def advance(self) -> None:
        self.phase += CONTROL_DT / self.duration

    def evaluate(self, valid: np.ndarray):
        env, sc = self.env, self.env.scaling
        values = env.proprio()
        s = env.sensors()
        qpos, qvel = env.qpos(), env.qvel()
        v, w, g = values['base_lin_vel'], values['base_ang_vel'], values['projected_gravity']
        phase = self.phase + CONTROL_DT / self.duration   # phase of the state just reached
        height = qpos[:, 2]
        feet_z = s['feet'][:, :, 2] - env.foot_radius
        airborne = np.all(s['contact'] == 0, axis=1) & np.all(feet_z > 0.005, axis=1)
        self._feet, self._contact = feet_z, s['contact']
        self.max_height = np.maximum(self.max_height, height)
        self.air_steps += airborne
        ref = self.reference
        t = phase * self.duration
        h_ref, vz_ref = ref(t)
        err_h, err_v = height - h_ref, qvel[:, 2] - vz_ref
        rise, v_to = ref.flight_rise, ref.v_takeoff
        flight = (t > ref.t_takeoff + 0.02) & (t < ref.t_land - 0.02)
        stance = (t < ref.t_takeoff - 0.02) | (t > ref.t_land + 0.06)
        settle = t > ref.t_absorb
        joint_err = qpos[:, env.idx.joint_qpos] - env.default
        q = qpos[:, env.idx.joint_qpos]
        limit = np.maximum(q - env.soft_hi, 0) + np.maximum(env.soft_lo - q, 0)
        upright = np.exp(-(g[:, 0] ** 2 + g[:, 1] ** 2) / 0.1)
        r = {
            # Broad + tight kernels: gradient from the first iteration, precision later.
            'track_height': 2.0 * np.exp(-(err_h / rise) ** 2) + 1.0 * np.exp(-(err_h / (0.3 * rise)) ** 2),
            'track_vz': 1.0 * np.exp(-(err_v / v_to) ** 2) + 0.5 * np.exp(-(err_v / (0.3 * v_to)) ** 2),
            'airborne': 3.0 * flight * airborne * upright,
            'stance_contact': 0.5 * stance * np.mean(s['contact'], axis=1),
            'upright': 1.0 * upright,
            'settle_pose': 1.0 * settle * np.exp(-np.mean(joint_err ** 2, axis=1) / 0.05),
            'settle_still': 1.0 * settle * np.exp(-(v[:, 0] ** 2 + v[:, 1] ** 2 + v[:, 2] ** 2) / (0.1 * sc.s)),
            'ang_vel_xy': -0.05 * (w[:, 0] ** 2 + w[:, 1] ** 2),
            'yaw_rate': -0.05 * w[:, 2] ** 2,
            'action_rate': -0.1 * np.mean((env.last_action - env.prev_action) ** 2, axis=1),
            'torque': -0.05 * np.mean((s['force'] / env.effort) ** 2, axis=1),
            'joint_limits': -2.0 * np.mean(limit, axis=1),
            'thigh_contact': -1.0 * np.mean(s['thigh_contact'], axis=1),
        }
        total = sum(r.values()) * CONTROL_DT
        tilt_bad = g[:, 2] > -math.cos(1.0)
        low = (height - np.mean(s['feet'][:, :, 2], axis=1)) < 0.35 * sc.h0
        terminated = ~valid | tilt_bad | low | s['torso_contact']
        total = np.where(terminated, total - 3.0, total)
        total = np.where(valid, total, -3.0)
        # The window ending is the true end of this skill (no bootstrap): the walk
        # policy takes over from whatever state the settle phase reached.
        finished = phase >= 1.0 - 1e-9
        info = {'terms': {k: float(np.mean(val)) for k, val in r.items()},
                'tracking': {'apex_gain_m': float(np.mean(self.max_height - sc.h0)),
                             'air_time_s': float(np.mean(self.air_steps) * CONTROL_DT)},
                'falls': int(np.sum(terminated))}
        return total, terminated | finished, info

    def state_dict(self) -> dict:
        return {'phase': self.phase.copy(), 'max_height': self.max_height.copy(), 'air_steps': self.air_steps.copy()}

    def load_state_dict(self, sd: dict) -> None:
        self.phase[:] = sd['phase']
        self.max_height[:] = sd['max_height']
        self.air_steps[:] = sd['air_steps']
