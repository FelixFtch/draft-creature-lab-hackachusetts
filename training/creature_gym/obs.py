"""Observation terms shared by training, evaluation, export and the browser.

Every term is computed from ``qpos``/``qvel`` of the robot (plus controller
state: command, last action, clocks), never from ``sensordata``. MuJoCo fills
``sensordata`` at the start of ``mj_step`` (before integration), so sensor
readings after a step lag the state by one substep; state-derived terms are
identical in batched training rollouts, Python evaluation and the browser.

Frames: MuJoCo free joint ``qpos[3:7]`` is the root quaternion (w, x, y, z),
``qvel[0:3]`` the root-origin linear velocity in the world frame and
``qvel[3:6]`` the angular velocity in the root body frame. So
``base_lin_vel = R^T qvel[0:3]`` (equals a velocimeter at the root origin) and
``base_ang_vel = qvel[3:6]`` (equals a gyro aligned with the root body).

play/src/creature-controller.js implements the same formulas; keep them in sync
(qa/creature-controller-validation.mjs checks parity on recorded fixtures).
"""
from __future__ import annotations

import numpy as np

JOINT_VEL_SCALE = 0.05
ANG_VEL_SCALE = 0.25
#: A command is "moving" (gait clock on) when either component exceeds this
#: fraction of its trained maximum; otherwise the policy is asked to stand.
MOVING_FRACTION = 0.05


def walk_terms(nu: int, n_legs: int) -> list[dict]:
    return _layout([
        ('base_lin_vel', 3, 1.0), ('base_ang_vel', 3, ANG_VEL_SCALE), ('projected_gravity', 3, 1.0),
        ('command', 3, 1.0), ('joint_pos', nu, 1.0), ('joint_vel', nu, JOINT_VEL_SCALE),
        ('last_action', nu, 1.0), ('gait_clock', 2 * n_legs, 1.0)])


def jump_terms(nu: int) -> list[dict]:
    return _layout([
        ('base_lin_vel', 3, 1.0), ('base_ang_vel', 3, ANG_VEL_SCALE), ('projected_gravity', 3, 1.0),
        ('joint_pos', nu, 1.0), ('joint_vel', nu, JOINT_VEL_SCALE), ('last_action', nu, 1.0),
        ('jump_phase', 3, 1.0)])


def _layout(spec: list[tuple[str, int, float]]) -> list[dict]:
    terms, start = [], 0
    for name, length, scale in spec:
        terms.append({'name': name, 'start': start, 'length': int(length), 'scale': float(scale)})
        start += length
    return terms


def obs_size(terms: list[dict]) -> int:
    return terms[-1]['start'] + terms[-1]['length']


def quat_rotate_inverse(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """R(q)^T v for unit quaternions q = (w, x, y, z); batched over leading dims."""
    w, x, y, z = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    vx, vy, vz = v[..., 0], v[..., 1], v[..., 2]
    r00, r01, r02 = 1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)
    r10, r11, r12 = 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)
    r20, r21, r22 = 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
    return np.stack([r00 * vx + r10 * vy + r20 * vz,
                     r01 * vx + r11 * vy + r21 * vz,
                     r02 * vx + r12 * vy + r22 * vz], axis=-1)


def normalized_quat(qpos_root: np.ndarray) -> np.ndarray:
    q = qpos_root[..., 3:7]
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def projected_gravity(q: np.ndarray) -> np.ndarray:
    """Gravity direction (0, 0, -1) in the root frame."""
    w, x, y, z = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    return -np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], axis=-1)


def heading(q: np.ndarray) -> np.ndarray:
    """Yaw of the root x axis in the world frame."""
    w, x, y, z = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    return np.arctan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z))


def is_moving(command: np.ndarray, vmax: float, wmax: float) -> np.ndarray:
    return (np.abs(command[..., 0]) > MOVING_FRACTION * vmax) | \
        (np.abs(command[..., 1]) > MOVING_FRACTION * vmax) | \
        (np.abs(command[..., 2]) > MOVING_FRACTION * wmax)


def leg_phases(phase: np.ndarray, offsets: np.ndarray) -> np.ndarray:
    p = phase[..., None] + offsets
    return p - np.floor(p)


def gait_clock(phase: np.ndarray, offsets: np.ndarray, moving: np.ndarray) -> np.ndarray:
    """Per-leg (sin, cos) of 2*pi*leg_phase, interleaved; zeros when standing."""
    angle = 2 * np.pi * leg_phases(phase, offsets)
    clock = np.stack([np.sin(angle), np.cos(angle)], axis=-1).reshape(*phase.shape, -1)
    return clock * moving[..., None]


def jump_phase_features(phase: np.ndarray) -> np.ndarray:
    angle = 2 * np.pi * phase
    return np.stack([phase, np.sin(angle), np.cos(angle)], axis=-1)


def build(terms: list[dict], values: dict[str, np.ndarray]) -> np.ndarray:
    """Concatenate raw term values (batched) in manifest order, applying scales."""
    parts = []
    for term in terms:
        value = values[term['name']]
        if value.shape[-1] != term['length']:
            raise ValueError(f"{term['name']} has length {value.shape[-1]}, expected {term['length']}")
        parts.append(value * term['scale'] if term['scale'] != 1.0 else value)
    return np.concatenate(parts, axis=-1).astype(np.float32)


def proprio_values(qpos: np.ndarray, qvel: np.ndarray, root_qpos: int, root_dof: int,
                   joint_qpos: np.ndarray, joint_dof: np.ndarray, default: np.ndarray) -> dict:
    """Raw (unscaled) robot terms from batched qpos/qvel (N, nq)/(N, nv)."""
    q = normalized_quat(qpos[..., root_qpos:root_qpos + 7])
    return {
        'base_lin_vel': quat_rotate_inverse(q, qvel[..., root_dof:root_dof + 3]),
        'base_ang_vel': qvel[..., root_dof + 3:root_dof + 6],
        'projected_gravity': projected_gravity(q),
        'joint_pos': qpos[..., joint_qpos] - default,
        'joint_vel': qvel[..., joint_dof],
    }
