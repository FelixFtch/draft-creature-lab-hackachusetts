"""Training-only bumpy patches: smooth Gaussian mounds on a MuJoCo height field.

The height field sits ``depth`` below the floor plane, so the walking surface is
``max(floor, bumps)``: flat ground everywhere is the exact exported ``cg_floor``
plane and only mounds taller than ``depth`` protrude. Bump sizes scale with leg
length so every body sees "a few centimetres" relative to its own legs.

Patterns are deterministic in (spec, leg length, count, seed) and cached as .npy
under the run directory so chunked runs do not regenerate them.

MuJoCo hfield layout (verified with mj_ray): column c <-> x, row r <-> y,
``x = (2c/(ncol-1) - 1) * half_x``, ``y = (2r/(nrow-1) - 1) * half_y``.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from .sim_model import TerrainSpec

REF_LEG = 0.44


def terrain_spec_for(leg_length: float) -> TerrainSpec:
    """Patch size and bump ceiling for a body (protrusion <= 8% of leg length + depth)."""
    depth = 0.01
    max_protrusion = max(0.02, 0.08 * leg_length)
    return TerrainSpec(half_x=6.0, half_y=6.0, nrow=241, ncol=241,
                       elevation=round(max_protrusion + depth, 4), depth=depth)


def _patterns(spec: TerrainSpec, leg_length: float, count: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    s = leg_length / REF_LEG
    xs = np.linspace(-spec.half_x, spec.half_x, spec.ncol)
    ys = np.linspace(-spec.half_y, spec.half_y, spec.nrow)
    dx = xs[1] - xs[0]
    out = np.zeros((count, spec.nrow, spec.ncol), dtype=np.float32)
    top = spec.elevation  # metres for data value 1
    for p in range(count):
        field = np.zeros((spec.nrow, spec.ncol))
        n_patches = rng.integers(3, 6)
        for _ in range(n_patches):
            cx = rng.uniform(-0.75, 0.75) * spec.half_x
            cy = rng.uniform(-0.75, 0.75) * spec.half_y
            radius = rng.uniform(1.0, 2.0)
            for _ in range(int(rng.integers(12, 24))):
                r = radius * np.sqrt(rng.uniform())
                a = rng.uniform(0, 2 * np.pi)
                bx, by = cx + r * np.cos(a), cy + r * np.sin(a)
                sigma = rng.uniform(0.08, 0.25) * s
                height = rng.uniform(0.35, 1.0) * top
                # Evaluate only inside +-3 sigma: blobs are local, the grid is large.
                c0 = max(0, int((bx - 3 * sigma + spec.half_x) / dx))
                c1 = min(spec.ncol, int((bx + 3 * sigma + spec.half_x) / dx) + 2)
                r0 = max(0, int((by - 3 * sigma + spec.half_y) / dx))
                r1 = min(spec.nrow, int((by + 3 * sigma + spec.half_y) / dx) + 2)
                if c0 >= c1 or r0 >= r1:
                    continue
                gx = np.exp(-0.5 * ((xs[c0:c1] - bx) / sigma) ** 2)
                gy = np.exp(-0.5 * ((ys[r0:r1] - by) / sigma) ** 2)
                patch = height * np.outer(gy, gx)
                field[r0:r1, c0:c1] = np.maximum(field[r0:r1, c0:c1], patch)
        # Fade to zero near the border so the patch edge is not a cliff.
        edge = np.clip((spec.half_x - np.abs(xs)) / 0.5, 0, 1)[None, :] * \
            np.clip((spec.half_y - np.abs(ys)) / 0.5, 0, 1)[:, None]
        out[p] = np.clip(field * edge, 0.0, top)
    return out


class TerrainBank:
    """Bump patterns in metres above hfield zero; ``-1`` means flat (hfield off)."""

    def __init__(self, spec: TerrainSpec, leg_length: float, count: int, seed: int,
                 cache_dir: Path | None = None):
        self.spec = spec
        key = hashlib.sha256(json.dumps([spec.__dict__, round(leg_length, 6), count, seed],
                                        sort_keys=True).encode()).hexdigest()[:16]
        cached = Path(cache_dir) / f'terrain-{key}.npy' if cache_dir else None
        if cached is not None and cached.is_file():
            self.patterns = np.load(cached)
        else:
            self.patterns = _patterns(spec, leg_length, count, seed)
            if cached is not None:
                cached.parent.mkdir(parents=True, exist_ok=True)
                tmp = cached.with_suffix('.tmp.npy')
                np.save(tmp, self.patterns)
                tmp.replace(cached)
        self.count = count
        self._inv = np.array([(spec.ncol - 1) / (2 * spec.half_x), (spec.nrow - 1) / (2 * spec.half_y)])

    def hfield_data(self, pattern: int, scale: float) -> np.ndarray:
        """Normalised [0, 1] elevation for ``model.hfield_data`` (row-major, rows = y)."""
        if pattern < 0:
            return np.zeros(self.spec.nrow * self.spec.ncol, dtype=np.float32)
        return np.clip(self.patterns[pattern] * scale / self.spec.elevation, 0.0, 1.0).ravel()

    def height(self, pattern: np.ndarray, scale: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Walking-surface height (>= 0) at points; pattern/scale are per env, x/y (N, k)."""
        spec = self.spec
        h = np.zeros(x.shape)
        active = pattern >= 0
        if not np.any(active):
            return h
        u = (x + spec.half_x) * self._inv[0]
        v = (y + spec.half_y) * self._inv[1]
        inside = active[:, None] & (u >= 0) & (v >= 0) & (u <= spec.ncol - 1) & (v <= spec.nrow - 1)
        if not np.any(inside):
            return h
        env = np.broadcast_to(np.arange(x.shape[0])[:, None], x.shape)[inside]
        u, v = u[inside], v[inside]
        c0 = np.minimum(u.astype(np.int64), spec.ncol - 2)
        r0 = np.minimum(v.astype(np.int64), spec.nrow - 2)
        fu, fv = u - c0, v - r0
        p = pattern[env]
        grid = self.patterns
        z = ((1 - fu) * (1 - fv) * grid[p, r0, c0] + fu * (1 - fv) * grid[p, r0, c0 + 1]
             + (1 - fu) * fv * grid[p, r0 + 1, c0] + fu * fv * grid[p, r0 + 1, c0 + 1])
        h[inside] = np.maximum(0.0, z * scale[env] - spec.depth)
        return h
