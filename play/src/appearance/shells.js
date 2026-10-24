import * as THREE from 'three';
import { ringSolid, clipSolid, sphereSolid, prismSolid, loopTubeSolid, deform, place, superellipsoidSolid, latheSolid, mergeSolids, puckSolid } from './solids.js';

// Decorative printed shells, fitted to the real torso.
//
// Every shell starts from a "cap": a superelliptic dome with wall thickness
// and a short vertical skirt (the mounting lip). fitCap() sizes it from the
// torso's actual vertices so the inner surface clears the body by a fixed
// gap, and raises the rim locally wherever leg machinery (swept over its
// first two joints' ranges) would hit the skirt, which gives the shell arches
// over the hip motors. The cap is closed, so it renders and prints as is;
// beetle wings, armour bands and pie plates are plane cuts of it.

const TAU = Math.PI * 2;
export const SHELL_THICKNESS = 0.0024;   // 2.4 mm walls: 3 perimeters at 0.4 mm + margin
export const SHELL_CLEARANCE = 0.0015;   // gap to the torso (assembly clearance)

const seDir = (theta, n) => { const c = Math.cos(theta), s = Math.sin(theta); return [Math.sign(c) * Math.abs(c) ** (2 / n), Math.sign(s) * Math.abs(s) ** (2 / n)]; };
const profileG = (rho, p) => (rho >= 1 ? 0 : (1 - rho ** p) ** (1 / p));

function seInverse(x, y, a, b, n) {
  const rho = ((Math.abs(x) / a) ** n + (Math.abs(y) / b) ** n) ** (1 / n);
  if (rho < 1e-9) return { theta: 0, rho: 0 };
  const ux = x / (a * rho), uy = y / (b * rho);
  return { theta: Math.atan2(Math.sign(uy) * Math.abs(uy) ** (n / 2), Math.sign(ux) * Math.abs(ux) ** (n / 2)), rho };
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function rimAt(cap, theta) {
  const N = cap.rim.length, f = ((((theta / TAU) % 1) + 1) % 1) * N, i = Math.floor(f) % N, t = f - Math.floor(f);
  return cap.rim[i] * (1 - t) + cap.rim[(i + 1) % N] * t;
}

/** Outer (or inner) surface height of a cap at body-frame (x, y), or null outside. */
export function capZ(cap, x, y, inner = false) {
  const a = inner ? cap.a - cap.t : cap.a, b = inner ? cap.b - cap.t : cap.b, top = inner ? cap.top - cap.t : cap.top;
  const { theta, rho } = seInverse(x - cap.cx, y - cap.cy, a, b, cap.n);
  if (rho > 1) return null;
  const rim = rimAt(cap, theta);
  return rim + (top - rim) * profileG(rho, cap.p);
}

export function capPoint(cap, theta, rho, inner = false) {
  const a = inner ? cap.a - cap.t : cap.a, b = inner ? cap.b - cap.t : cap.b, top = inner ? cap.top - cap.t : cap.top;
  const [dx, dy] = seDir(theta, cap.n), rim = rimAt(cap, theta);
  return new THREE.Vector3(cap.cx + a * rho * dx, cap.cy + b * rho * dy, rim + (top - rim) * profileG(rho, cap.p));
}

/** Numerical outward normal of the outer cap surface at (x, y). */
export function capNormal(cap, x, y) {
  const h = Math.max(1e-4, Math.min(cap.a, cap.b) * 0.01);
  const z = capZ(cap, x, y) ?? cap.rimMax, zx = capZ(cap, x + h, y) ?? z, zy = capZ(cap, x, y + h) ?? z;
  return new THREE.Vector3(-(zx - z) / h, -(zy - z) / h, 1).normalize();
}

function dilate(values, radius) {
  const N = values.length;
  return values.map((_, i) => { let m = -Infinity; for (let k = -radius; k <= radius; k++) m = Math.max(m, values[(i + k + N) % N]); return m; });
}
function blur(values, radius, passes = 2) {
  let v = values.slice(); const N = v.length;
  for (let p = 0; p < passes; p++) v = v.map((_, i) => { let s = 0; for (let k = -radius; k <= radius; k++) s += v[(i + k + N) % N]; return s / (2 * radius + 1); });
  return v;
}

/**
 * Fit a cap to the creature.
 * opts: coverage (0..1 of torso height the shell reaches down), profile (dome
 * exponent: 2 = elliptic, 3+ = flatter top), rise (dome height as a fraction
 * of the smaller half-width), size (look.shell.size), thickness.
 */
export function fitCap(info, { coverage = 0.55, profile = 2.2, rise = 0.42, size = 1, thickness = SHELL_THICKNESS, clearance = SHELL_CLEARANCE, squareness = null, N = 96 } = {}) {
  const { box, center, half, points } = info.torso;
  const cx = center.x, cy = center.y;
  let boxiness = 0;
  for (const v of points) boxiness = Math.max(boxiness, Math.min(Math.abs(v.x - cx) / half.x, Math.abs(v.y - cy) / half.y));
  const n = squareness ?? (boxiness > 0.86 ? 4 : 2.2);
  const H = box.max.z - box.min.z, t = thickness, c = clearance;
  const lip = Math.min(0.009, Math.max(0.004, 0.07 * H));
  const zBase = box.max.z - coverage * H;
  const grow = 1 + Math.max(0, size - 1) * 0.35;
  let a = (half.x + t + c) * grow, b = (half.y + t + c) * grow;
  let rim = new Array(N).fill(zBase);
  const interior = [];
  for (let pass = 0; pass < 3; pass++) {
    const req = new Array(N).fill(zBase);
    interior.length = 0;
    for (const o of info.obstacles) {
      // Only machinery inside the footprint (plus a hair of clearance) can
      // touch the shell; anything further out passes beside the skirt.
      const { theta, rho } = seInverse(o.x - cx, o.y - cy, a, b, n);
      if (rho >= 0.72 && rho <= 1.04) {
        const k = Math.round((((theta / TAU) % 1) + 1) % 1 * N) % N;
        req[k] = Math.max(req[k], o.z + lip + c);
      } else if (rho < 0.72) interior.push(o);
    }
    const smooth = blur(dilate(req, Math.max(2, Math.round(N / 40))), Math.max(2, Math.round(N / 32)));
    rim = smooth.map((v, i) => Math.max(v, req[i]));
    // Torso points the shell covers must sit inside the inner footprint.
    const ai = a - t - c, bi = b - t - c;
    let worst = 0;
    for (const v of points) {
      const { theta, rho } = seInverse(v.x - cx, v.y - cy, ai, bi, n);
      const r = rim[Math.round((((theta / TAU) % 1) + 1) % 1 * N) % N];
      if (v.z >= r - lip - c) worst = Math.max(worst, rho);
    }
    if (worst > 1) { a = (ai * worst * 1.002) + t + c; b = (bi * worst * 1.002) + t + c; }
  }
  const rimMax = Math.max(...rim), rimMin = Math.min(...rim);
  // Dome height: the inner surface must clear every covered point by c.
  const cap = { a, b, n, p: profile, t, lip, rim, cx, cy, top: rimMax + 0.01 };
  let topInner = rimMax + t;
  for (const v of points.concat(interior)) {
    const { theta, rho } = seInverse(v.x - cx, v.y - cy, a - t, b - t, n);
    if (rho >= 0.985) continue;
    const r = rimAt(cap, theta), need = v.z + c;
    if (need <= r) continue;
    topInner = Math.max(topInner, r + (need - r) / Math.max(0.05, profileG(rho, profile)));
  }
  const aesthetic = rimMax + rise * Math.min(a, b) * (0.75 + 0.25 * size) + t;
  cap.top = Math.max(topInner + t, aesthetic, box.max.z + t + c + 0.004);
  cap.rimMax = rimMax; cap.rimMin = rimMin; cap.zBottom = rimMin - lip;
  return cap;
}

/** The closed cap solid (outer dome, skirt, inner dome). */
export function capSolid(cap, { segU = 72, segV = 14 } = {}) {
  const thetas = Array.from({ length: segU }, (_, k) => (k / segU) * TAU);
  const rhos = Array.from({ length: segV }, (_, j) => Math.sin(((j + 1) / segV) * (Math.PI / 2)));   // dense near the rim
  const ring = (rho, inner, dz = 0) => thetas.map(th => {
    const p = capPoint(cap, th, rho, inner);
    if (dz) p.z = rimAt(cap, th) - dz;
    return p;
  });
  const rings = [];
  for (const rho of rhos) rings.push(ring(rho, true));               // inner: apex -> rim
  rings.push(ring(1, true, cap.lip));                                 // inner skirt bottom
  rings.push(ring(1, false, cap.lip));                                // outer skirt bottom
  for (const rho of rhos.slice().reverse()) rings.push(ring(rho, false));   // outer: rim -> apex
  return ringSolid(new THREE.Vector3(cap.cx, cap.cy, cap.top - cap.t), rings, new THREE.Vector3(cap.cx, cap.cy, cap.top));
}

/**
 * One pie plate of the cap between angles th0..th1 and radial fraction
 * rho0..1 (skirt included), built directly from the parameterisation: the
 * cross-section loop is swept across the angle range and both ends are
 * triangulated, so the plate is closed by construction (no plane cuts).
 */
export function capPatchSolid(cap, th0, th1, rho0, { nu = 16, nv = 10 } = {}) {
  const rhos = Array.from({ length: nv + 1 }, (_, j) => rho0 + (1 - rho0) * Math.sin((j / nv) * (Math.PI / 2)));
  const loop = th => {
    const outer = rhos.map(r => capPoint(cap, th, r, false));
    const inner = rhos.map(r => capPoint(cap, th, r, true)).reverse();
    const rim = rimAt(cap, th);
    const ob = capPoint(cap, th, 1, false); ob.z = rim - cap.lip;
    const ib = capPoint(cap, th, 1, true); ib.z = rim - cap.lip;
    return [...outer, ob, ib, ...inner];   // closes back from inner(rho0) to outer(rho0)
  };
  const loops = Array.from({ length: nu + 1 }, (_, i) => loop(th0 + ((th1 - th0) * i) / nu));
  const positions = [], indices = [], ids = loops.map(l => l.map(p => { positions.push(p.x, p.y, p.z); return positions.length / 3 - 1; }));
  const M = loops[0].length;
  for (let i = 0; i < nu; i++) for (let k = 0; k < M; k++) {
    const a = ids[i][k], b = ids[i][(k + 1) % M], c = ids[i + 1][(k + 1) % M], d = ids[i + 1][k];
    indices.push(a, b, c, a, c, d);
  }
  const endCap = (l, idList, forward) => {
    const pts = l.map(p => new THREE.Vector2(Math.hypot(p.x - cap.cx, p.y - cap.cy), p.z));
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    const area = THREE.ShapeUtils.area(pts);
    let sum = 0;
    for (const [a, b, c] of tris) sum += (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x);
    const same = Math.sign(sum) === Math.sign(area);   // earcut triangles run the loop's way?
    for (const [a, b, c] of tris) {
      if (same === forward) indices.push(idList[a], idList[b], idList[c]); else indices.push(idList[a], idList[c], idList[b]);
    }
  };
  // Sides own L0[k]->L0[k+1]; the first end must run the loop backwards,
  // the last end forwards.
  endCap(loops[0], ids[0], false);
  endCap(loops[nu], ids[nu], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  const v = signedVolumeOf(positions, indices);
  if (v < 0) for (let f = 0; f < indices.length; f += 3) { const t = indices[f + 1]; indices[f + 1] = indices[f + 2]; indices[f + 2] = t; }
  g.setIndex(indices);
  return g;
}

/** The central part of a cap (rho <= rhoB) closed by a vertical wall. */
export function capBossSolid(cap, rhoB, { segU = 48, segV = 8 } = {}) {
  const thetas = Array.from({ length: segU }, (_, k) => (k / segU) * TAU);
  const rhos = Array.from({ length: segV }, (_, j) => rhoB * ((j + 1) / segV));
  const ring = (rho, inner) => thetas.map(th => capPoint(cap, th, rho, inner));
  const rings = [...rhos.map(r => ring(r, true)), ...rhos.slice().reverse().map(r => ring(r, false))];
  return ringSolid(new THREE.Vector3(cap.cx, cap.cy, cap.top - cap.t), rings, new THREE.Vector3(cap.cx, cap.cy, cap.top));
}

function signedVolumeOf(positions, indices) {
  let v = 0;
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f] * 3, b = indices[f + 1] * 3, c = indices[f + 2] * 3;
    v += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  return v;
}

function rimPiping(cap, radius, segU = 96) {
  const pts = Array.from({ length: segU }, (_, k) => {
    const th = (k / segU) * TAU, [dx, dy] = seDir(th, cap.n);
    const out = new THREE.Vector2(dx / cap.a, dy / cap.b).normalize();   // approximate outward direction
    return new THREE.Vector3(cap.cx + cap.a * dx + out.x * radius * 0.35, cap.cy + cap.b * dy + out.y * radius * 0.35, rimAt(cap, th) - cap.lip + radius * 0.9);
  });
  return loopTubeSolid(pts, radius, 8);
}

/** Orientation that maps +z onto a surface normal, with a heading around it. */
function alignTo(normal, heading = 0) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
  return q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), heading));
}

// A petal / leaf / feather blank: ellipsoid along +x from 0 to len, tapered,
// curled upward along its length and cupped across it.
export function petalSolid(len, width, thick, { curl = 0.5, cup = 0.25, taper = 0.45, segments = 14, rings = 10 } = {}) {
  const g = sphereSolid(1, segments, rings);
  return deform(g, p => {
    // Sphere poles are on z; lay the long axis on x first.
    const u = (p.z + 1) / 2, sideways = p.x, thickness = p.y;
    const w = width * (1 - taper * u) * 0.5, x = u * len;
    let y = sideways * w, z = thickness * thick * 0.5 * (1 - 0.6 * u) + cup * width * (sideways * sideways) * 0.5;
    const bend = curl * u * u;                      // radians of upward curl at the tip
    const cx = x * Math.cos(bend) - z * Math.sin(bend), cz = x * Math.sin(bend) + z * Math.cos(bend);
    return new THREE.Vector3(cx, y, cz);
  });
}

/**
 * Build a shell. Returns { parts:[{name, slot, solid, matrices?}], cap,
 * surfaceAt(x,y), normalAt(x,y), printable:[{name, solids:[...]}] }.
 * All geometry is in the torso body frame (MuJoCo, +x forward, +z up).
 */
export function buildShell(look, info, { quality = 'high' } = {}) {
  const kind = look.shell.kind;
  if (!kind || kind === 'none') return null;
  const size = look.shell.size;
  const hi = quality !== 'low';
  const seg = { segU: hi ? 84 : 44, segV: hi ? 16 : 9 };
  const settings = {
    dome: { coverage: 0.56, profile: 2.2, rise: 0.4 },
    beetle: { coverage: 0.62, profile: 2.0, rise: 0.56 },
    turtle: { coverage: 0.6, profile: 1.8, rise: 0.5 },
    petals: { coverage: 0.42, profile: 2.6, rise: 0.26 },
    armor: { coverage: 0.6, profile: 3.2, rise: 0.36 },
    fluffy: { coverage: 0.56, profile: 2.0, rise: 0.32 },
    saddle: { coverage: 0.64, profile: 3.0, rise: 0.08 },
  }[kind];
  const cap = fitCap(info, { ...settings, size });
  const parts = [], random = rng(Math.round(cap.a * 1e4) * 31 + Math.round(cap.b * 1e4) + kind.length * 7919);
  const radial = info.arrangement === 'radial';
  const minAB = Math.min(cap.a, cap.b);
  let extra = () => 0;   // added height above the cap for surfaceAt
  const pipe = Math.max(0.0028, minAB * 0.022);

  if (kind === 'dome') {
    parts.push({ name: 'dome', slot: 'shell', solid: capSolid(cap, seg) });
    parts.push({ name: 'piping', slot: 'shellTrim', solid: rimPiping(cap, pipe, seg.segU) });
  } else if (kind === 'beetle') {
    const solid = capSolid(cap, seg), gap = Math.max(0.003, minAB * 0.025);
    const xp = cap.cx + cap.a * (radial ? 0.38 : 0.46);
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
    parts.push({ name: 'pronotum', slot: 'shellAccent', solid: clipSolid(solid, [{ normal: X, constant: xp + gap / 2 }]) });
    parts.push({ name: 'elytron-left', slot: 'shell', solid: clipSolid(solid, [{ normal: Y, constant: cap.cy + gap / 2 }, { normal: X.clone().negate(), constant: -(xp - gap / 2) }]) });
    parts.push({ name: 'elytron-right', slot: 'shell', solid: clipSolid(solid, [{ normal: Y.clone().negate(), constant: -(cap.cy - gap / 2) }, { normal: X.clone().negate(), constant: -(xp - gap / 2) }]) });
    solid.dispose();
  } else if (kind === 'turtle') {
    parts.push({ name: 'carapace', slot: 'shellAccent', solid: capSolid(cap, seg) });
    // Flat-top hex lattice: columns 1.5 R apart, rows sqrt(3) R, odd columns offset.
    const R = minAB * 0.27, plates = [];
    const thickness = Math.max(0.004, minAB * 0.045);
    for (let col = -14; col <= 14; col++) {
      for (let row = -10; row <= 10; row++) {
        const x = cap.cx + col * 1.5 * R, y = cap.cy + (row + (Math.abs(col) % 2 ? 0.5 : 0)) * Math.sqrt(3) * R;
        const { rho } = seInverse(x - cap.cx, y - cap.cy, cap.a, cap.b, cap.n);
        if (rho > 0.86) continue;
        const z = capZ(cap, x, y), nrm = capNormal(cap, x, y);
        const r = R * 0.9 * (1 - 0.22 * rho * rho);
        const hex = Array.from({ length: 6 }, (_, k) => [r * Math.cos((k / 6) * TAU), r * Math.sin((k / 6) * TAU)]);
        const plate = prismSolid(hex, -thickness * 0.6, thickness * 0.55, 0.22);
        plates.push(place(plate, new THREE.Vector3(x, y, z), alignTo(nrm)));
      }
    }
    parts.push({ name: 'scutes', slot: 'shell', solid: mergeSolids(plates) });
    plates.forEach(p => p.dispose());
    parts.push({ name: 'marginals', slot: 'shellTrim', solid: rimPiping(cap, pipe * 1.5, seg.segU) });
    extra = () => thickness * 0.55;
  } else if (kind === 'petals') {
    parts.push({ name: 'receptacle', slot: 'shell', solid: capSolid(cap, seg) });
    const count = radial ? Math.max(5, Math.min(8, info.legs.length)) : 8;
    const outer = [], inner = [];
    for (let ring = 0; ring < 2; ring++) {
      for (let k = 0; k < count; k++) {
        const th = ((k + (ring ? 0.5 : 0)) / count) * TAU + (radial ? info.legs[0]?.mountAngle ?? 0 : 0) + (radial ? Math.PI / count : 0);
        const base = capPoint(cap, th, ring ? 0.55 : 0.82);
        const reach = Math.hypot(base.x - cap.cx, base.y - cap.cy);
        const len = (ring ? 0.75 : 1.05) * Math.max(minAB * 0.75, reach * 0.95) * (0.9 + 0.2 * size);
        const width = len * (ring ? 0.62 : 0.58);
        const petal = petalSolid(len, width, Math.max(0.004, len * 0.05), { curl: ring ? 1.0 : 0.75, cup: 0.35, taper: 0.35, segments: hi ? 16 : 10, rings: hi ? 12 : 8 });
        const dir = Math.atan2(base.y - cap.cy, base.x - cap.cx);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dir)
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(ring ? 0.75 : 0.32)));
        (ring ? inner : outer).push(place(petal, base.clone().add(new THREE.Vector3(0, 0, -len * 0.04)), q));
      }
    }
    parts.push({ name: 'petals', slot: 'shell', solid: mergeSolids(outer) });
    parts.push({ name: 'inner-petals', slot: 'petalInner', solid: mergeSolids(inner) });
    outer.concat(inner).forEach(p => p.dispose());
    // Pistil: a little cluster of dots in the middle.
    const dots = [];
    const dotR = minAB * 0.075;
    for (let i = 0; i < 7; i++) {
      const a = i === 0 ? 0 : ((i - 1) / 6) * TAU, r = i === 0 ? 0 : dotR * 1.7;
      const x = cap.cx + r * Math.cos(a), y = cap.cy + r * Math.sin(a), z = capZ(cap, x, y);
      dots.push(place(sphereSolid(dotR, 12, 8), new THREE.Vector3(x, y, z + dotR * 0.35)));
    }
    parts.push({ name: 'pistil', slot: 'accent', solid: mergeSolids(dots) });
    dots.forEach(d => d.dispose());
  } else if (kind === 'armor') {
    const solid = capSolid(cap, seg), gap = Math.max(0.004, minAB * 0.03), bands = [];
    const rivets = [], rivetR = Math.max(0.003, minAB * 0.03);
    if (radial) {
      // Pie plates around a central boss, built straight from the cap's
      // (angle, radius) parameterisation: closed by construction.
      const count = Math.max(4, Math.min(8, info.legs.length || 6)), offset = (info.legs[0]?.mountAngle ?? 0) + Math.PI / count;
      const rhoB = 0.36, dTheta = gap / Math.max(1e-3, minAB * 0.9);
      for (let k = 0; k < count; k++) {
        const t0 = offset + (k / count) * TAU + dTheta / 2, t1 = offset + ((k + 1) / count) * TAU - dTheta / 2;
        bands.push(capPatchSolid(cap, t0, t1, rhoB + gap / minAB, { nu: hi ? 18 : 10, nv: hi ? 12 : 7 }));
        rivets.push(place(sphereSolid(rivetR, 10, 6), capPoint(cap, (t0 + t1) / 2, 0.82)));
      }
      bands.push(capBossSolid(cap, rhoB, { segU: hi ? 48 : 28, segV: hi ? 8 : 5 }));
    } else {
      const count = Math.max(3, Math.min(6, Math.round((2 * cap.a) / (minAB * 0.75))));
      const x0 = cap.cx - cap.a, step = (2 * cap.a) / count;
      for (let k = 0; k < count; k++) {
        const lo = x0 + k * step, hi2 = x0 + (k + 1) * step, planes = [];
        if (k > 0) planes.push({ normal: new THREE.Vector3(1, 0, 0), constant: lo + gap / 2 });
        if (k < count - 1) planes.push({ normal: new THREE.Vector3(-1, 0, 0), constant: -(hi2 - gap / 2) });
        let band = clipSolid(solid, planes);
        // Alternate bands stand proud, so the shell reads as overlapping plates.
        if (k % 2 === 1) {
          const s = 1 + (cap.t * 1.6) / minAB;
          band = deform(band, p => new THREE.Vector3(cap.cx + (p.x - cap.cx) * 1.0, cap.cy + (p.y - cap.cy) * s, cap.zBottom + (p.z - cap.zBottom) * s));
        }
        bands.push(band);
        for (const side of [-0.55, -0.2, 0.2, 0.55]) {
          const x = (lo + hi2) / 2, y = cap.cy + side * cap.b * 0.9, z = capZ(cap, x, y);
          if (z !== null) rivets.push(place(sphereSolid(rivetR, 10, 6), new THREE.Vector3(x, y, z + (k % 2 ? cap.t * 1.6 : 0))));
        }
      }
    }
    solid.dispose();
    parts.push({ name: 'plates', slot: 'shell', solid: mergeSolids(bands) });
    parts.push({ name: 'rivets', slot: 'shellTrim', solid: mergeSolids(rivets) });
    bands.concat(rivets).forEach(g => g.dispose());
  } else if (kind === 'fluffy') {
    parts.push({ name: 'base', slot: 'shell', solid: capSolid(cap, seg) });
    // Puffs are flattened along the surface normal and never reach below the
    // shell wall, so a printed fluffy shell still slips over the torso.
    const puffR = minAB * 0.24 * (0.9 + 0.2 * size), matrices = [];
    const area = Math.PI * cap.a * cap.b * 1.3, count = Math.min(hi ? 140 : 70, Math.max(24, Math.round((area / (Math.PI * puffR * puffR)) * 2.2)));
    const golden = Math.PI * (3 - Math.sqrt(5));
    const puff = (p, nrm, r) => {
      const hn = r * 0.62;
      const center = p.clone().addScaledVector(nrm, hn - cap.t * 0.9);
      matrices.push(new THREE.Matrix4().compose(center, alignTo(nrm, random() * TAU), new THREE.Vector3(r, r, hn)));
    };
    for (let i = 0; i < count; i++) {
      const rho = Math.sqrt((i + 0.5) / count) * 0.96, th = i * golden;
      const p = capPoint(cap, th, rho);
      puff(p, capNormal(cap, p.x, p.y), puffR * (0.75 + 0.45 * random()));
    }
    const rimCount = Math.round((2 * Math.PI * Math.sqrt((cap.a * cap.a + cap.b * cap.b) / 2)) / (puffR * 1.1));
    for (let k = 0; k < rimCount; k++) {
      const th = (k / rimCount) * TAU, [dx, dy] = seDir(th, cap.n);
      const out = new THREE.Vector3((cap.n / cap.a) * Math.sign(dx) * Math.abs(dx) ** (cap.n - 1), (cap.n / cap.b) * Math.sign(dy) * Math.abs(dy) ** (cap.n - 1), 0).normalize();
      const p = new THREE.Vector3(cap.cx + cap.a * dx, cap.cy + cap.b * dy, rimAt(cap, th) - cap.lip * 0.35);
      puff(p, out.add(new THREE.Vector3(0, 0, 0.25)).normalize(), puffR * (0.62 + 0.25 * random()));
    }
    parts.push({ name: 'puffs', slot: 'shell', solid: sphereSolid(1, hi ? 16 : 10, hi ? 10 : 7), matrices, smooth: true });
    extra = () => puffR * 1.1;
  } else if (kind === 'saddle') {
    const blanket = clipSolid(capSolid(cap, seg), [
      { normal: new THREE.Vector3(1, 0, 0), constant: cap.cx - cap.a * 0.42 },
      { normal: new THREE.Vector3(-1, 0, 0), constant: -(cap.cx + cap.a * 0.3) },
    ]);
    parts.push({ name: 'blanket', slot: 'accent', solid: blanket });
    const sx = cap.a * 0.3, sy = Math.min(cap.b * 0.62, cap.a * 0.3), sz = minAB * 0.12;
    const zSeat = capZ(cap, cap.cx - cap.a * 0.06, cap.cy) ?? cap.top;
    const seat = deform(superellipsoidSolid(sx, sy, sz, 0.5, 0.7, hi ? 32 : 20, hi ? 16 : 10), p => {
      const u = p.x / sx;   // raise pommel (front) and cantle (back): a saddle shape
      return new THREE.Vector3(p.x, p.y, p.z + sz * 1.3 * u * u * (p.z > 0 ? 1 : 0.6) - sz * 0.25 * (p.y / sy) ** 2 * (p.z > 0 ? 1 : 0));
    });
    parts.push({ name: 'seat', slot: 'shell', solid: place(seat, new THREE.Vector3(cap.cx - cap.a * 0.06, cap.cy, zSeat + sz * 0.45)) });
    const horn = latheSolid([[0, 0], [sz * 0.32, 0], [sz * 0.26, sz * 1.1], [sz * 0.55, sz * 1.35], [sz * 0.5, sz * 1.6], [0, sz * 1.65]], hi ? 18 : 10);
    parts.push({ name: 'horn', slot: 'shellTrim', solid: place(horn, new THREE.Vector3(cap.cx - cap.a * 0.06 + sx * 0.8, cap.cy, zSeat + sz * 1.4)) });
    const seatTop = zSeat + sz * 1.45;
    extra = (x, y) => (Math.abs(x - (cap.cx - cap.a * 0.06)) < sx && Math.abs(y - cap.cy) < sy ? Math.max(0, seatTop - (capZ(cap, x, y) ?? seatTop)) : 0);
  }

  const surfaceAt = (x, y) => { const z = capZ(cap, x, y); return z === null ? null : z + extra(x, y); };
  const normalAt = (x, y) => capNormal(cap, x, y);
  // Printable groups (built on demand, before the parts are disposed): one
  // STL per colour slot keeps multi-colour prints easy.
  const printable = () => {
    const bySlot = new Map();
    for (const part of parts) {
      const solids = part.matrices ? part.matrices.map(m => part.solid.clone().applyMatrix4(m)) : [part.solid.clone()];
      if (!bySlot.has(part.slot)) bySlot.set(part.slot, { names: [], solids: [] });
      const entry = bySlot.get(part.slot);
      entry.names.push(part.name.replace(/-(left|right)$/, '')); entry.solids.push(...solids);
    }
    // Name each file after what is in it ("shell-beetle-elytron", "shell-dome-piping").
    return [...bySlot.entries()].map(([slot, { names, solids }]) => ({ name: `shell-${kind}-${[...new Set(names)].join('+')}`, slot, solids }));
  };
  return { kind, cap, parts, surfaceAt, normalAt, printable, top: cap.top + extra(cap.cx, cap.cy) };
}

export { seInverse, rimAt };
// Re-exported for the print kit's tests.
export { puckSolid };
