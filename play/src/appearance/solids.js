import * as THREE from 'three';

// Closed-solid toolkit. Every builder returns an *indexed, welded* geometry
// (positions only) whose triangles are consistently wound outward and whose
// every edge is shared by exactly two triangles, so the same geometry renders
// in the creature view and exports as a watertight STL in the print kit.
// renderable() turns one into a non-indexed geometry with creased normals.

const TAU = Math.PI * 2;

class Builder {
  constructor() { this.positions = []; this.indices = []; }
  v(x, y, z) { this.positions.push(x, y, z); return this.positions.length / 3 - 1; }
  vv(p) { return this.v(p.x, p.y, p.z); }
  tri(a, b, c) { this.indices.push(a, b, c); }
  build({ orient = true } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setIndex(this.positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.indices, 1) : new THREE.Uint16BufferAttribute(this.indices, 1));
    // Builders wind each solid consistently; one global check makes the
    // normals point outward whatever the parameterisation's handedness.
    if (orient && signedVolume(g) < 0) flip(g);
    return g;
  }
}

/**
 * A topological sphere: start pole, rings (each the same length, ordered
 * counter-clockwise about +z when viewed from above), end pole. Walking from
 * the start pole to the end pole, the solid's material must lie on the left
 * of the profile when the ring runs CCW (that is how a lathe from the bottom
 * pole up the outside to the top pole behaves). Rings may be any shape.
 */
export function ringSolid(startPole, rings, endPole) {
  const b = new Builder(), n = rings[0].length;
  const s = b.vv(startPole);
  const ids = rings.map(ring => ring.map(p => b.vv(p)));
  const e = b.vv(endPole);
  for (let k = 0; k < n; k++) b.tri(s, ids[0][(k + 1) % n], ids[0][k]);
  for (let i = 0; i + 1 < ids.length; i++) {
    for (let k = 0; k < n; k++) {
      const a = ids[i][k], bb = ids[i][(k + 1) % n], c = ids[i + 1][(k + 1) % n], d = ids[i + 1][k];
      b.tri(a, bb, c); b.tri(a, c, d);
    }
  }
  const last = ids[ids.length - 1];
  for (let k = 0; k < n; k++) b.tri(last[k], last[(k + 1) % n], e);
  return b.build();
}

/** Surface of revolution about +z. profile: [[r, z], ...] from bottom pole (r=0) up the outside to top pole (r=0). */
export function latheSolid(profile, segments = 24) {
  const first = profile[0], last = profile[profile.length - 1];
  const rings = profile.slice(1, -1).map(([r, z]) => Array.from({ length: segments }, (_, k) => {
    const a = (k / segments) * TAU;
    return new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z);
  }));
  return ringSolid(new THREE.Vector3(0, 0, first[1]), rings, new THREE.Vector3(0, 0, last[1]));
}

export function sphereSolid(radius = 1, segments = 20, rings = 12) {
  const profile = [];
  for (let i = 0; i <= rings; i++) { const phi = Math.PI - (i / rings) * Math.PI; profile.push([radius * Math.sin(phi), radius * Math.cos(phi)]); }
  profile[0][0] = 0; profile[rings][0] = 0;
  return latheSolid(profile, segments);
}

/** Superellipsoid with half-extents (a,b,c); e1 vertical, e2 horizontal squareness (1 = ellipsoid, 0.2 = boxy). */
export function superellipsoidSolid(a, b, c, e1 = 1, e2 = 1, segments = 28, rings = 16) {
  const f = (w, m) => Math.sign(w) * Math.abs(w) ** m;
  const ringsOut = [];
  for (let i = 1; i < rings; i++) {
    const phi = -Math.PI / 2 + (i / rings) * Math.PI;
    const cp = f(Math.cos(phi), e1), sp = f(Math.sin(phi), e1);
    ringsOut.push(Array.from({ length: segments }, (_, k) => {
      const t = (k / segments) * TAU;
      return new THREE.Vector3(a * cp * f(Math.cos(t), e2), b * cp * f(Math.sin(t), e2), c * sp);
    }));
  }
  return ringSolid(new THREE.Vector3(0, 0, -c), ringsOut, new THREE.Vector3(0, 0, c));
}

/** Rounded cylinder ("puck") along +z: radius r, half-height h, edge fillet f. */
export function puckSolid(r, h, fillet = 0.25, segments = 28, r2 = r) {
  const f = Math.min(fillet * Math.min(r, h), r * 0.9, h * 0.9), profile = [[0, -h]];
  const steps = 4;
  for (let i = 0; i <= steps; i++) { const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2); profile.push([r - f + f * Math.cos(a), -h + f + f * Math.sin(a)]); }
  for (let i = 0; i <= steps; i++) { const a = (i / steps) * (Math.PI / 2); profile.push([r2 - f + f * Math.cos(a), h - f + f * Math.sin(a)]); }
  profile.push([0, h]);
  return latheSolid(dedupeProfile(profile), segments);
}

function dedupeProfile(profile) {
  const out = [];
  for (const p of profile) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) out.push(p); }
  return out;
}

export function boxSolid(sx, sy, sz) {
  const b = new Builder(), v = [];
  for (const z of [-sz, sz]) for (const y of [-sy, sy]) for (const x of [-sx, sx]) v.push(b.v(x, y, z));
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  for (const [a, c, d, e] of faces) { b.tri(v[a], v[c], v[d]); b.tri(v[a], v[d], v[e]); }
  return b.build();
}

/**
 * A ring band about +z with a rectangular section: radius R (mid-wall),
 * wall thickness t, top edge height h(theta) (crowns zig-zag, hat bands are
 * flat). Genus 1 and closed.
 */
export function bandSolid(R, t, height, segments = 48) {
  const b = new Builder(), sections = [];
  for (let k = 0; k < segments; k++) {
    const a = (k / segments) * TAU, c = Math.cos(a), s = Math.sin(a), h = typeof height === 'function' ? height(a) : height;
    const ri = R - t / 2, ro = R + t / 2;
    sections.push([b.v(ri * c, ri * s, 0), b.v(ro * c, ro * s, 0), b.v(ro * c, ro * s, h), b.v(ri * c, ri * s, h)]);
  }
  for (let k = 0; k < segments; k++) {
    const p = sections[k], q = sections[(k + 1) % segments];
    for (let e = 0; e < 4; e++) {
      const a = p[e], c = p[(e + 1) % 4], d = q[(e + 1) % 4], f = q[e];
      b.tri(a, c, d); b.tri(a, d, f);
    }
  }
  return b.build();
}

/** Torus about +z: major radius R, tube radius r. Genus 1, still closed. */
export function torusSolid(R, r, segments = 32, tube = 12) {
  const pts = Array.from({ length: segments }, (_, k) => { const a = (k / segments) * TAU; return new THREE.Vector3(R * Math.cos(a), R * Math.sin(a), 0); });
  return loopTubeSolid(pts, r, tube);
}

// Rotation-minimising frames along a polyline (closed or open).
function frames(points, closed) {
  const n = points.length, tangents = [], normals = [], binormals = [];
  for (let i = 0; i < n; i++) {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    tangents.push(next.clone().sub(prev).normalize());
  }
  const t0 = tangents[0], ref = Math.abs(t0.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  normals.push(ref.clone().sub(t0.clone().multiplyScalar(ref.dot(t0))).normalize());
  for (let i = 1; i < n; i++) {
    const axis = new THREE.Vector3().crossVectors(tangents[i - 1], tangents[i]), s = axis.length();
    const nrm = normals[i - 1].clone();
    if (s > 1e-9) nrm.applyAxisAngle(axis.normalize(), Math.atan2(s, tangents[i - 1].dot(tangents[i])));
    nrm.sub(tangents[i].clone().multiplyScalar(nrm.dot(tangents[i]))).normalize();
    normals.push(nrm);
  }
  for (let i = 0; i < n; i++) binormals.push(new THREE.Vector3().crossVectors(tangents[i], normals[i]));
  return { tangents, normals, binormals };
}

/** Closed tube along a closed loop of points (piping, rings, halos). */
export function loopTubeSolid(points, radius, tube = 10) {
  const { tangents, normals, binormals } = frames(points, true), n = points.length;
  const radii = typeof radius === 'function' ? points.map((_, i) => radius(i / n)) : points.map(() => radius);
  // Closed loops accumulate frame twist; transport the last frame back to the
  // start and spread the remaining angle evenly so the seam has no kink.
  const back = new THREE.Vector3().crossVectors(tangents[n - 1], tangents[0]);
  const end = normals[n - 1].clone();
  if (back.length() > 1e-9) end.applyAxisAngle(back.clone().normalize(), Math.atan2(back.length(), tangents[n - 1].dot(tangents[0])));
  const twist = Math.atan2(new THREE.Vector3().crossVectors(end, normals[0]).dot(tangents[0]), end.dot(normals[0]));
  const b = new Builder(), ids = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let k = 0; k < tube; k++) {
      const a = (k / tube) * TAU + (twist * i) / n;
      const offset = normals[i].clone().multiplyScalar(Math.cos(a) * radii[i]).add(binormals[i].clone().multiplyScalar(Math.sin(a) * radii[i]));
      row.push(b.vv(points[i].clone().add(offset)));
    }
    ids.push(row);
  }
  for (let i = 0; i < n; i++) {
    const r0 = ids[i], r1 = ids[(i + 1) % n];
    for (let k = 0; k < tube; k++) {
      const a = r0[k], c = r0[(k + 1) % tube], d = r1[(k + 1) % tube], e = r1[k];
      b.tri(a, e, d); b.tri(a, d, c);
    }
  }
  return b.build();
}

/**
 * Open tube along points with per-point radii, closed by caps:
 * 'flat' (disc), 'round' (hemisphere) or 'point' (cone tip, radius ignored).
 */
export function tubeSolid(points, radii, { radial = 12, start = 'round', end = 'round' } = {}) {
  const pts = points.map(p => p.clone());
  const r = typeof radii === 'number' ? pts.map(() => radii) : radii.slice();
  const { tangents, normals, binormals } = frames(pts, false);
  const ringAt = (center, nrm, bin, radius) => Array.from({ length: radial }, (_, k) => {
    const a = (k / radial) * TAU;
    return center.clone().add(nrm.clone().multiplyScalar(Math.cos(a) * radius)).add(bin.clone().multiplyScalar(Math.sin(a) * radius));
  });
  const rings = [];
  // Start cap: hemisphere rings growing from the pole.
  const capRings = (index, dir, kind) => {
    const out = [];
    if (kind !== 'round') return out;
    for (let i = 1; i < 4; i++) {
      const a = (i / 4) * (Math.PI / 2);
      const center = pts[index].clone().add(tangents[index].clone().multiplyScalar(dir * r[index] * Math.cos(a)));
      out.push(ringAt(center, normals[index], binormals[index], r[index] * Math.sin(a)));
    }
    return out;
  };
  const startRings = capRings(0, -1, start);
  rings.push(...startRings);
  for (let i = 0; i < pts.length; i++) {
    if ((i === 0 && start === 'point') || (i === pts.length - 1 && end === 'point')) continue;
    rings.push(ringAt(pts[i], normals[i], binormals[i], r[i]));
  }
  rings.push(...capRings(pts.length - 1, 1, end).reverse());
  const pole = (index, dir, kind) => {
    if (kind === 'point') return pts[index].clone();
    if (kind === 'round') return pts[index].clone().add(tangents[index].clone().multiplyScalar(dir * r[index]));
    return pts[index].clone();
  };
  return ringSolid(pole(0, -1, start), rings, pole(pts.length - 1, 1, end));
}

/** Convex polygon (2D points, CCW) extruded from z0 to z1 with an optional top chamfer. */
export function prismSolid(polygon, z0, z1, chamfer = 0) {
  const c = polygon.reduce((s, p) => [s[0] + p[0] / polygon.length, s[1] + p[1] / polygon.length], [0, 0]);
  const inset = p => [c[0] + (p[0] - c[0]) * (1 - chamfer), c[1] + (p[1] - c[1]) * (1 - chamfer)];
  const top = Math.max(z0, z1 - (chamfer > 0 ? (z1 - z0) * 0.35 : 0));
  const rings = [polygon.map(([x, y]) => new THREE.Vector3(x, y, z0))];
  rings.push(polygon.map(([x, y]) => new THREE.Vector3(x, y, top)));
  if (chamfer > 0) rings.push(polygon.map(p => { const [x, y] = inset(p); return new THREE.Vector3(x, y, z1); }));
  return ringSolid(new THREE.Vector3(c[0], c[1], z0), rings, new THREE.Vector3(c[0], c[1], z1));
}

/** Reverse winding (in place) and return the geometry. */
export function flip(geometry) {
  const idx = geometry.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  geometry.index.needsUpdate = true;
  return geometry;
}

/** Apply fn(Vector3) -> Vector3 to every vertex (in place). Injective maps keep the solid closed. */
export function deform(geometry, fn) {
  const pos = geometry.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const out = fn(v.clone()); pos.setXYZ(i, out.x, out.y, out.z); }
  pos.needsUpdate = true;
  if (signedVolume(geometry) < 0) flip(geometry);   // mirroring maps would invert it
  return geometry;
}

export function transform(geometry, matrix) {
  geometry.applyMatrix4(matrix);
  if (matrix.determinant() < 0) flip(geometry);
  return geometry;
}

export function place(geometry, position, quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1)) {
  return transform(geometry, new THREE.Matrix4().compose(position, quaternion, scale));
}

/** Concatenate solids (indexed, positions only) into one geometry. */
export function mergeSolids(list) {
  const b = new Builder();
  for (const g of list) {
    if (!g) continue;
    const base = b.positions.length / 3, pos = g.attributes.position.array;
    for (let i = 0; i < g.attributes.position.count * 3; i++) b.positions.push(pos[i]);
    const idx = g.index ? g.index.array : Array.from({ length: g.attributes.position.count }, (_, i) => i);
    for (let i = 0; i < idx.length; i++) b.indices.push(base + idx[i]);
  }
  return b.build();
}

/** Merge vertices that share a position (within tol); keeps the index buffer. */
export function weld(geometry, tol = 1e-7) {
  const pos = geometry.attributes.position, map = new Map(), remap = new Int32Array(pos.count), out = [];
  const q = x => Math.round(x / tol);
  for (let i = 0; i < pos.count; i++) {
    const key = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`;
    let id = map.get(key);
    if (id === undefined) { id = out.length / 3; map.set(key, id); out.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    remap[i] = id;
  }
  const idx = geometry.index ? geometry.index.array : Array.from({ length: pos.count }, (_, i) => i), indices = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]];
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setIndex(out.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
  return g;
}

export function signedVolume(geometry) {
  const pos = geometry.attributes.position, idx = geometry.index ? geometry.index.array : null;
  const n = idx ? idx.length : pos.count, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx[i] : i); b.fromBufferAttribute(pos, idx ? idx[i + 1] : i + 1); c.fromBufferAttribute(pos, idx ? idx[i + 2] : i + 2);
    v += a.dot(b.cross(c)) / 6;
  }
  return v;
}

/**
 * Keep the part of a closed solid where dot(normal, p) >= constant and cap
 * the cut, so the result is closed again. Works on welded geometry; the
 * same intersection vertex is reused by both triangles sharing an edge.
 */
export function cutSolid(geometry, normal, constant, { eps = null } = {}) {
  // Vertices within eps of the plane are moved onto it, so new vertices are
  // never closer than eps to old ones and caps stay planar (no slivers where
  // a later cut grazes an earlier one). Tolerances scale with the part:
  // 3e-5 of its size (18 um on a 0.6 m shell, also right in millimetres).
  const g = geometry.index ? geometry : weld(geometry);
  const pos = g.attributes.position, idx = g.index.array, n = normal.clone().normalize();
  if (!g.boundingBox) g.computeBoundingBox();
  const extent = g.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  eps = eps ?? extent * 3e-5;
  const positions = Array.from(pos.array), dist = [];
  for (let i = 0; i < pos.count; i++) {
    let d = n.x * pos.getX(i) + n.y * pos.getY(i) + n.z * pos.getZ(i) - constant;
    if (Math.abs(d) < eps) {
      positions[i * 3] -= d * n.x; positions[i * 3 + 1] -= d * n.y; positions[i * 3 + 2] -= d * n.z;
      d = 0;
    }
    dist.push(d);
  }
  const edgeCache = new Map();
  const cross = (i, j) => {
    const key = i < j ? `${i}_${j}` : `${j}_${i}`;
    let id = edgeCache.get(key);
    if (id !== undefined) return id;
    const t = dist[i] / (dist[i] - dist[j]);
    positions.push(...[0, 1, 2].map(k => positions[i * 3 + k] + (positions[j * 3 + k] - positions[i * 3 + k]) * t));
    id = positions.length / 3 - 1; dist.push(0); edgeCache.set(key, id);
    return id;
  };
  const out = [];
  for (let f = 0; f < idx.length; f += 3) {
    const tri = [idx[f], idx[f + 1], idx[f + 2]];
    if (tri.every(i => dist[i] >= 0)) {
      if (tri.every(i => dist[i] === 0)) continue;   // face lying on the cut: the cap replaces it
      out.push(...tri); continue;
    }
    if (tri.every(i => dist[i] <= 0)) continue;
    const poly = [];
    for (let k = 0; k < 3; k++) {
      const cur = tri[k], next = tri[(k + 1) % 3];
      if (dist[cur] >= 0) poly.push(cur);
      if ((dist[cur] > 0 && dist[next] < 0) || (dist[cur] < 0 && dist[next] > 0)) poly.push(cross(cur, next));
    }
    for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]);
  }
  // Boundary = directed edges without a reverse twin; chain them into loops.
  const edges = new Map();
  const ekey = (a, b) => `${a}_${b}`;
  for (let f = 0; f < out.length; f += 3) for (let k = 0; k < 3; k++) { const a = out[f + k], b = out[f + (k + 1) % 3]; edges.set(ekey(a, b), [a, b]); }
  const next = new Map();
  for (const [, [a, b]] of edges) if (!edges.has(ekey(b, a))) next.set(a, b);
  const loops = [];
  const seen = new Set();
  for (const startV of next.keys()) {
    if (seen.has(startV)) continue;
    const loop = []; let v = startV;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
    if (loop.length >= 3 && v === startV) loops.push(loop);
  }
  // Cap: triangulate in the plane. Mesh boundary loops run one way; the cap
  // must traverse them the other way, so outer loops and holes come out
  // right by orientation (holes run opposite to their outer loop).
  const u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
  const w = new THREE.Vector3().crossVectors(n, u);
  const to2 = i => new THREE.Vector2(positions[i * 3] * u.x + positions[i * 3 + 1] * u.y + positions[i * 3 + 2] * u.z,
    positions[i * 3] * w.x + positions[i * 3 + 1] * w.y + positions[i * 3 + 2] * w.z);
  const flat = loops.map(loop => ({ loop: loop.slice().reverse(), pts: loop.slice().reverse().map(to2) }));
  for (const item of flat) item.area = THREE.ShapeUtils.area(item.pts);
  // With the cap facing -n, a reversed boundary loop is CW in (u,w) for an
  // outer contour; holes are the opposite sign.
  const sign = Math.sign(flat.reduce((s, x) => (Math.abs(x.area) > Math.abs(s) ? x.area : s), 0)) || 1;
  const outers = flat.filter(x => Math.sign(x.area) === sign), holes = flat.filter(x => Math.sign(x.area) !== sign);
  const inside = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
  for (const outer of outers) {
    const myHoles = holes.filter(h => inside(h.pts[0], outer.pts));
    // Cutting a planar face across its diagonal leaves exactly collinear
    // outline points, on which earcut emits zero-area triangles. Triangulate
    // without them, then put each back by fanning the cap triangle that owns
    // its edge: every outline vertex is used and no triangle is degenerate.
    const rings = [outer, ...myHoles].map(r => simplifyRing(r.loop, r.pts));
    const tris = THREE.ShapeUtils.triangulateShape(rings[0].pts, rings.slice(1).map(r => r.pts));
    const all = rings.flatMap(r => r.ids);
    let capTris = tris.map(([a, b, c]) => [all[a], all[b], all[c]]);
    for (const ring of rings) {
      for (const [edge, inner] of ring.removed) {
        const [u, v] = edge;
        const t = capTris.findIndex(tri => tri.includes(u) && tri.includes(v));
        if (t < 0) continue;
        const tri = capTris[t], r = tri.find(x => x !== u && x !== v);
        // Keep the triangle's own winding: walk u->v if it appears that way.
        const forward = tri[(tri.indexOf(u) + 1) % 3] === v;
        const chain = forward ? [u, ...inner, v] : [v, ...inner.slice().reverse(), u];
        const fan = [];
        for (let i = 0; i + 1 < chain.length; i++) fan.push([chain[i], chain[i + 1], r]);
        capTris.splice(t, 1, ...fan);
      }
    }
    // Earcut winds all its triangles one way and the fans keep that winding,
    // so decide the cap's orientation once from the total signed area (a
    // single thin ear's own sign is float noise). u x w = n, so CCW in (u,w)
    // faces +n; the cap must face -n (towards the removed side).
    let total = 0;
    for (const [a, b, c] of capTris) {
      const pa = to2(a), pb = to2(b), pc = to2(c);
      total += (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
    }
    for (const [a, b, c] of capTris) { if (total > 0) out.push(a, c, b); else out.push(a, b, c); }
  }
  // Where two cut planes meet inside the solid, an earlier cap's vertices can
  // sit microns from the later plane and leave micro-edges on the corner
  // line. Collapse anything closer than 2 eps (real features are far larger),
  // then split whatever collinear slivers remain.
  clusterIndices(out, positions, eps * 2);
  removeSlivers(out, positions, 400);
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setIndex(positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(out, 1) : new THREE.Uint16BufferAttribute(out, 1));
  return compact(result);
}

/**
 * Proximity weld on an index list: vertices within tol (any cell boundary)
 * merge into one; triangles that collapse are dropped, and so are pairs of
 * opposite triangles on the same three vertices (flat pillows).
 */
export function clusterIndices(indices, positions, tol) {
  const count = positions.length / 3, parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const used = new Uint8Array(count);
  for (const i of indices) used[i] = 1;
  const cell = new Map(), key = (x, y, z) => `${x},${y},${z}`, tol2 = tol * tol;
  for (let i = 0; i < count; i++) {
    if (!used[i]) continue;
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const cx = Math.floor(x / tol), cy = Math.floor(y / tol), cz = Math.floor(z / tol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of cell.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        const ex = positions[j * 3] - x, ey = positions[j * 3 + 1] - y, ez = positions[j * 3 + 2] - z;
        if (ex * ex + ey * ey + ez * ez < tol2) { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
      }
    }
    const k = key(cx, cy, cz);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(i);
  }
  const kept = [], seen = new Map();
  for (let f = 0; f < indices.length; f += 3) {
    const a = find(indices[f]), b = find(indices[f + 1]), c = find(indices[f + 2]);
    if (a === b || b === c || a === c) continue;
    kept.push(a, b, c);
  }
  // Pillows: same vertex set, opposite winding -> both go.
  const canon = (a, b, c) => { const m = Math.min(a, b, c); return m === a ? [a, b, c] : m === b ? [b, c, a] : [c, a, b]; };
  const drop = new Set();
  for (let f = 0; f < kept.length; f += 3) {
    const [a, b, c] = canon(kept[f], kept[f + 1], kept[f + 2]);
    const twin = `${a},${c},${b}`;
    if (seen.has(twin) && !drop.has(seen.get(twin))) { drop.add(seen.get(twin)); drop.add(f); continue; }
    seen.set(`${a},${b},${c}`, f);
  }
  indices.length = 0;
  for (let f = 0; f < kept.length; f += 3) if (!drop.has(f)) indices.push(kept[f], kept[f + 1], kept[f + 2]);
}

/**
 * Earcut emits zero-area triangles where a cap outline has collinear runs
 * (a second cut crossing an earlier cap). For a sliver (a, m, b) with m on
 * a-b, split the neighbour (a, b, c) across a-b into (a, m, c) + (m, b, c):
 * the outline is unchanged, the sliver disappears, the mesh stays closed.
 */
export function removeSlivers(indices, positions, maxFixes = 20000) {
  const sliverEdge = f => {
    const i = indices[f], j = indices[f + 1], k = indices[f + 2];
    if (i < 0) return -1;
    const ax = positions[i * 3], ay = positions[i * 3 + 1], az = positions[i * 3 + 2];
    const ux = positions[j * 3] - ax, uy = positions[j * 3 + 1] - ay, uz = positions[j * 3 + 2] - az;
    const vx = positions[k * 3] - ax, vy = positions[k * 3 + 1] - ay, vz = positions[k * 3 + 2] - az;
    const wx = vx - ux, wy = vy - uy, wz = vz - uz;
    const l = [ux * ux + uy * uy + uz * uz, wx * wx + wy * wy + wz * wz, vx * vx + vy * vy + vz * vz];
    const longest = l[0] >= l[1] && l[0] >= l[2] ? 0 : l[1] >= l[2] ? 1 : 2, best = l[longest];
    if (best === 0) return -1;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return cx * cx + cy * cy + cz * cz <= best * best * 1e-20 ? longest : -1;   // truly flat only
  };
  const key = (u, v) => u * 1048576 + v;
  const owner = new Map();
  const setFace = f => { for (let k = 0; k < 3; k++) owner.set(key(indices[f + k], indices[f + (k + 1) % 3]), f); };
  const clearFace = f => { for (let k = 0; k < 3; k++) { const e = key(indices[f + k], indices[f + (k + 1) % 3]); if (owner.get(e) === f) owner.delete(e); } };
  const queue = [];
  for (let f = 0; f < indices.length; f += 3) { setFace(f); if (sliverEdge(f) >= 0) queue.push(f); }
  let removed = false;
  removeSlivers.lastStats = { initial: queue.length, fixes: 0 };
  for (let fixes = 0; queue.length && fixes < maxFixes; fixes++) {
    removeSlivers.lastStats.fixes = fixes + 1;
    const f = queue.pop(), longest = sliverEdge(f);
    if (longest < 0) continue;
    // The sliver owns b->a (its longest edge); m is its middle vertex.
    const b = indices[f + longest], a = indices[f + (longest + 1) % 3], m = indices[f + (longest + 2) % 3];
    const g = owner.get(key(a, b));
    if (g === undefined || g === f || indices[g] < 0) continue;
    const c = [indices[g], indices[g + 1], indices[g + 2]].find(v => v !== a && v !== b);
    if (c === undefined) continue;
    clearFace(f); clearFace(g);
    if (c === m) {
      // Two opposite faces on the same three points: a flat pillow, drop both.
      for (const x of [f, g]) indices[x] = indices[x + 1] = indices[x + 2] = -1;
      removed = true; continue;
    }
    indices[f] = a; indices[f + 1] = m; indices[f + 2] = c;
    indices[g] = m; indices[g + 1] = b; indices[g + 2] = c;
    setFace(f); setFace(g);
    if (sliverEdge(f) >= 0) queue.push(f);
    if (sliverEdge(g) >= 0) queue.push(g);
  }
  if (removed) {
    let w = 0;
    for (let r = 0; r < indices.length; r += 3) if (indices[r] >= 0) { indices[w++] = indices[r]; indices[w++] = indices[r + 1]; indices[w++] = indices[r + 2]; }
    indices.length = w;
  }
}

/**
 * Split a closed 2D outline into the corners earcut needs and the straight
 * pass-through points (returned per simplified edge, in order from u to v).
 */
function simplifyRing(ids, pts) {
  const n = ids.length, keep = new Array(n).fill(true);
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    const ax = c.x - p.x, ay = c.y - p.y, bx = q.x - c.x, by = q.y - c.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;
    // 1e-5 rad: float32 positions put "exactly" collinear points ~1e-6 off.
    if (Math.abs(ax * by - ay * bx) <= 1e-5 * la * lb && ax * bx + ay * by > 0) keep[i] = false;
  }
  if (keep.filter(Boolean).length < 3) return { ids: ids.slice(), pts: pts.slice(), removed: [] };
  const start = keep.indexOf(true), outIds = [], outPts = [], removed = [];
  let lastKept = ids[start], pending = [];
  for (let s = 1; s <= n; s++) {
    const i = (start + s) % n;
    if (!keep[i]) { pending.push(ids[i]); continue; }
    if (pending.length) removed.push([[lastKept, ids[i]], pending]);
    outIds.push(ids[i]); outPts.push(pts[i]); lastKept = ids[i]; pending = [];
  }
  return { ids: outIds, pts: outPts, removed };
}

/** Drop unreferenced vertices. */
export function compact(geometry) {
  const pos = geometry.attributes.position, idx = geometry.index.array, remap = new Map(), out = [], indices = [];
  for (let i = 0; i < idx.length; i++) {
    let id = remap.get(idx[i]);
    if (id === undefined) { id = out.length / 3; remap.set(idx[i], id); out.push(pos.getX(idx[i]), pos.getY(idx[i]), pos.getZ(idx[i])); }
    indices.push(id);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setIndex(out.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
  return g;
}

/** Keep the intersection of half-spaces [{normal, constant}] (each: dot(n,p) >= c). */
export function clipSolid(geometry, planes) {
  let g = geometry;
  for (const { normal, constant } of planes) {
    const next = cutSolid(g, normal, constant);
    if (g !== geometry) g.dispose();
    g = next;
  }
  return g;
}

/**
 * Non-indexed copy with normals averaged only across edges flatter than
 * creaseAngle (hard edges stay crisp, curved surfaces stay smooth).
 */
export function renderable(geometry, creaseAngle = (40 * Math.PI) / 180) {
  const g = geometry.index ? geometry : weld(geometry);
  const pos = g.attributes.position, idx = g.index.array, faces = idx.length / 3;
  const fn = new Float32Array(faces * 3), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const incident = Array.from({ length: pos.count }, () => []);
  for (let f = 0; f < faces; f++) {
    a.fromBufferAttribute(pos, idx[f * 3]); b.fromBufferAttribute(pos, idx[f * 3 + 1]); c.fromBufferAttribute(pos, idx[f * 3 + 2]);
    const nrm = b.clone().sub(a).cross(c.clone().sub(a));   // area weighted
    fn[f * 3] = nrm.x; fn[f * 3 + 1] = nrm.y; fn[f * 3 + 2] = nrm.z;
    for (let k = 0; k < 3; k++) incident[idx[f * 3 + k]].push(f);
  }
  const cos = Math.cos(creaseAngle), outPos = new Float32Array(faces * 9), outNrm = new Float32Array(faces * 9);
  const unit = f => { const l = Math.hypot(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]) || 1; return [fn[f * 3] / l, fn[f * 3 + 1] / l, fn[f * 3 + 2] / l]; };
  for (let f = 0; f < faces; f++) {
    const nf = unit(f);
    for (let k = 0; k < 3; k++) {
      const v = idx[f * 3 + k];
      let x = 0, y = 0, z = 0;
      for (const o of incident[v]) {
        const no = unit(o);
        if (no[0] * nf[0] + no[1] * nf[1] + no[2] * nf[2] >= cos) { x += fn[o * 3]; y += fn[o * 3 + 1]; z += fn[o * 3 + 2]; }
      }
      const l = Math.hypot(x, y, z) || 1;
      outPos.set([pos.getX(v), pos.getY(v), pos.getZ(v)], f * 9 + k * 3);
      outNrm.set([x / l, y / l, z / l], f * 9 + k * 3);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  out.computeBoundingSphere();
  return out;
}

/** Smooth-shaded indexed copy (for spheres and other fully smooth solids). */
export function smooth(geometry) {
  const g = geometry.clone();
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Watertightness report on a (possibly unwelded) triangle soup:
 * every undirected edge must be used by exactly two triangles in opposite
 * directions; no zero-area triangles; positive enclosed volume.
 */
export function meshReport(geometry, tol = 1e-7) {
  const g = weld(geometry, tol);
  const pos = g.attributes.position, idx = g.index.array, faces = idx.length / 3;
  const directed = new Map(), undirected = new Map();
  let degenerate = 0, area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let f = 0; f < faces; f++) {
    const t = [idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2]];
    a.fromBufferAttribute(pos, t[0]); b.fromBufferAttribute(pos, t[1]); c.fromBufferAttribute(pos, t[2]);
    const cross = b.clone().sub(a).cross(c.clone().sub(a)).length();
    area += cross / 2;
    if (cross < tol * tol) degenerate++;
    for (let k = 0; k < 3; k++) {
      const u = t[k], v = t[(k + 1) % 3];
      directed.set(`${u}_${v}`, (directed.get(`${u}_${v}`) ?? 0) + 1);
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      undirected.set(key, (undirected.get(key) ?? 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const [key, count] of undirected) {
    if (count === 1) boundary++;
    else if (count > 2) nonManifold++;
    else {
      const [u, v] = key.split('_');
      if ((directed.get(`${u}_${v}`) ?? 0) !== 1 || (directed.get(`${v}_${u}`) ?? 0) !== 1) inconsistent++;
    }
  }
  // Connected components (by shared vertices) and their signed volumes.
  const parent = Int32Array.from({ length: pos.count }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let f = 0; f < faces; f++) { const r = find(idx[f * 3]); parent[find(idx[f * 3 + 1])] = r; parent[find(idx[f * 3 + 2])] = find(idx[f * 3]); }
  const volumes = new Map();
  for (let f = 0; f < faces; f++) {
    a.fromBufferAttribute(pos, idx[f * 3]); b.fromBufferAttribute(pos, idx[f * 3 + 1]); c.fromBufferAttribute(pos, idx[f * 3 + 2]);
    const r = find(idx[f * 3]);
    volumes.set(r, (volumes.get(r) ?? 0) + a.dot(b.clone().cross(c)) / 6);
  }
  const componentVolumes = [...volumes.values()];
  g.computeBoundingBox();
  const box = g.boundingBox;
  const report = {
    triangles: faces, vertices: pos.count, boundaryEdges: boundary, nonManifoldEdges: nonManifold, inconsistentEdges: inconsistent,
    degenerateTriangles: degenerate, components: componentVolumes.length, negativeComponents: componentVolumes.filter(v => v <= 0).length,
    volume: componentVolumes.reduce((s, v) => s + v, 0), area,
    size: box ? [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z] : [0, 0, 0],
  };
  report.watertight = faces > 0 && boundary === 0 && nonManifold === 0 && inconsistent === 0 && degenerate === 0 && report.negativeComponents === 0;
  g.dispose();
  return report;
}
