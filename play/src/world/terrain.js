// One analytic description of the walkable world, shared by the MuJoCo
// injection (heightfield samples), the renderer (identical mesh), the camera
// (ground clamp), sparks (hover height) and the engine's terrain-relative
// fall check. Pure JS: no Three.js, no MuJoCo.
import { quatRotate } from './layout-park.js';

const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// Sample a heightfield description on its grid. Row r runs along local y from
// -halfSize[1] (r = 0) to +halfSize[1]; column c along local x. This matches
// MjModel.hfield_data. Heights are metres above the field's base.
export function hfieldGrid(hf) {
  const [sx, sy] = hf.halfSize;
  const ncol = Math.round(2 * sx / hf.spacing) + 1, nrow = Math.round(2 * sy / hf.spacing) + 1;
  const heights = new Float32Array(nrow * ncol);
  let max = 0;
  for (let r = 0; r < nrow; r++) {
    const y = -sy + 2 * sy * r / (nrow - 1);
    for (let c = 0; c < ncol; c++) {
      const x = -sx + 2 * sx * c / (ncol - 1);
      let h = 0;
      for (const b of hf.bumps) {
        const u = Math.hypot(x - b.x, y - b.y) / b.r;
        if (u < 1) h += b.h * (.5 + .5 * Math.cos(Math.PI * u));
      }
      // Fade to exactly zero at the border so the field meets the lawn flush.
      h *= smooth(0, hf.border, Math.min(sx - Math.abs(x), sy - Math.abs(y)));
      heights[r * ncol + c] = h;
      if (h > max) max = h;
    }
  }
  return { nrow, ncol, heights, max, halfSize: [sx, sy] };
}

function sampleGrid(grid, x, y) {
  const [sx, sy] = grid.halfSize;
  if (Math.abs(x) > sx || Math.abs(y) > sy) return null;
  const fc = (x + sx) / (2 * sx) * (grid.ncol - 1), fr = (y + sy) / (2 * sy) * (grid.nrow - 1);
  const c0 = Math.min(grid.ncol - 2, Math.floor(fc)), r0 = Math.min(grid.nrow - 2, Math.floor(fr));
  const tc = fc - c0, tr = fr - r0, h = grid.heights, n = grid.ncol;
  const a = h[r0 * n + c0], b = h[r0 * n + c0 + 1], c = h[(r0 + 1) * n + c0], d = h[(r0 + 1) * n + c0 + 1];
  return (a * (1 - tc) + b * tc) * (1 - tr) + (c * (1 - tc) + d * tc) * tr;
}

// Highest surface point of an oriented box along the vertical line through
// (x, y), via a slab test in the box frame. Null when the line misses.
function boxTop(s, x, y) {
  const top = 50, q = s.quat, inv = [q[0], -q[1], -q[2], -q[3]];
  const p = quatRotate(inv, [x - s.pos[0], y - s.pos[1], top - s.pos[2]]);
  const d = quatRotate(inv, [0, 0, -1]);
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const h = s.size[i];
    if (Math.abs(d[i]) < 1e-12) { if (Math.abs(p[i]) > h) return null; continue; }
    let a = (-h - p[i]) / d[i], b = (h - p[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return top - t0;
}

function staticTop(s, x, y) {
  if (s.type === 'box') return boxTop(s, x, y);
  const dx = x - s.pos[0], dy = y - s.pos[1], d2 = dx * dx + dy * dy;
  if (s.type === 'cylinder') return d2 <= s.size[0] ** 2 ? s.pos[2] + s.size[1] : null;
  if (s.type === 'sphere') return d2 <= s.size[0] ** 2 ? s.pos[2] + Math.sqrt(s.size[0] ** 2 - d2) : null;
  return null;
}

export function createTerrain(layout) {
  const fields = layout.hfields.map(hf => {
    const grid = hfieldGrid(hf), c = Math.cos(hf.yaw), s = Math.sin(hf.yaw);
    return { hf, grid, c, s };
  });
  const walkable = layout.statics.filter(s => s.walkable);
  const solid = layout.statics.filter(s => !s.walkable && s.type !== 'capsule');
  function fieldHeight(x, y) {
    let best = null;
    for (const f of fields) {
      const dx = x - f.hf.center[0], dy = y - f.hf.center[1];
      const h = sampleGrid(f.grid, dx * f.c + dy * f.s, -dx * f.s + dy * f.c);
      if (h !== null && (best === null || h > best)) best = h;
    }
    return best;
  }
  // Height of the walkable ground at (x, y): floor (0), heightfields, ramps,
  // plateau, steps and platforms. `solids` also counts walls and landmarks
  // (used to keep the camera out of them).
  function groundHeight(x, y, { solids = false } = {}) {
    let h = Math.max(0, fieldHeight(x, y) ?? 0);
    for (const s of walkable) { const t = staticTop(s, x, y); if (t !== null && t > h) h = t; }
    if (solids) for (const s of solid) { const t = staticTop(s, x, y); if (t !== null && t > h) h = t; }
    return h;
  }
  // Surface tag for footstep sounds/dust when the contact is the base floor.
  function surfaceAt(x, y) {
    const r = Math.hypot(x, y);
    if (layout.lab && r > layout.islandRadius - .6) {
      const [u, v] = layout.labLocal(x, y);
      if (u >= layout.lab.pier.u[0] && u <= layout.lab.pier.u[1] && Math.abs(v) <= layout.lab.pier.v[1]) return 'wood';
    }
    if (r < layout.hubRadius) return 'stone';
    if (r > layout.islandRadius - .55) return 'sand';
    const [u, v] = layout.toZoneLocal('court', x, y);
    if (u > layout.court.u0 && u < layout.court.u1 + layout.court.goalDepth && Math.abs(v) < layout.court.halfWidth) return 'court';
    for (const p of layout.paths) {
      const a = p.angle * Math.PI / 180, along = x * Math.cos(a) + y * Math.sin(a), across = -x * Math.sin(a) + y * Math.cos(a);
      if (along > p.r0 && along < p.r1 && Math.abs(across) < p.width / 2) return p.kind === 'trail' ? 'gravel' : 'sand';
    }
    return 'grass';
  }
  return { groundHeight, surfaceAt, fieldHeight, fields };
}
