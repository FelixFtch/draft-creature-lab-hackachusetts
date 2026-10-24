import * as THREE from 'three';
import { latheSolid, puckSolid, superellipsoidSolid, sphereSolid, torusSolid, boxSolid, deform, place, renderable, smooth, mergeSolids, cutSolid } from './solids.js';
import { geomGeometry, GEOM } from './analyze.js';

// Limb styles restyle the *visual* of Draft's link / motor / cap geoms in
// their own frames (axis on +z, centred), staying within a few millimetres
// of the collision shape so contacts still look right. Feet styles add a
// level, heading-aligned decoration around each spherical foot.

const roundKey = v => Math.round(v * 1e5);

/** Geometry for a link/motor/detail geom in the given style (shared via cache). */
export function limbGeometry(model, geom, style, cache, quality = 'high') {
  const hi = quality !== 'low';
  const seg = hi ? 28 : 16;
  const [r, h] = geom.size;
  const key = `${style}|${geom.role}|${geom.type}|${geom.size.map(roundKey).join(',')}|${quality}`;
  if (cache.has(key)) return cache.get(key);
  let geometry;
  const cylinderLike = geom.type === GEOM.CYLINDER || geom.type === GEOM.CAPSULE;
  if (style === 'classic' || !cylinderLike) {
    geometry = geomGeometry(model, geom.id, seg);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
  } else if (geom.role === 'motor') {
    if (style === 'sleek') geometry = renderable(puckSolid(r, h, 0.55, seg), Math.PI / 4);
    else if (style === 'chunky') geometry = renderable(puckSolid(r * 1.08, h * 1.08, 0.32, seg), Math.PI / 4);
    else geometry = smooth(sphereSolid(Math.min(r, h * 2.6) * 0.92, seg, Math.round(seg * 0.6)));   // bones: knobby joint
  } else if (geom.role === 'detail') {
    if (style === 'sleek') geometry = renderable(puckSolid(r, h, 0.7, seg, r * 0.7), Math.PI / 4);
    else if (style === 'chunky') geometry = renderable(hubcap(r * 1.02, h * 1.04, seg), Math.PI / 5);
    else geometry = smooth(sphereSolid(Math.min(r, h * 2.6) * 0.55, 16, 10));
  } else {
    // links
    if (style === 'sleek') geometry = renderable(taperedLink(r * 0.86, h, seg), Math.PI / 3);
    else if (style === 'chunky') geometry = renderable(superellipsoidSolid(r * 1.42, r * 1.42, h * 1.02, 0.25, 0.42, seg, Math.max(10, Math.round(seg * 0.6))), Math.PI / 4);
    else geometry = renderable(boneSolid(r, h, seg), Math.PI / 2.5);
  }
  geometry.computeBoundingSphere();
  cache.set(key, geometry);
  return geometry;
}

function taperedLink(r, h, seg) {
  // Slim in the middle, flared where it meets the motors.
  const steps = 10, profile = [[0, -h - r * 0.15]];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, z = -h + 2 * h * t, flare = 0.72 + 0.28 * (Math.abs(2 * t - 1) ** 3);
    profile.push([r * flare, z]);
  }
  profile.push([0, h + r * 0.15]);
  return latheSolid(profile, seg);
}

function boneSolid(r, h, seg) {
  // Slim shaft swelling into knobs at both ends (the ends hide in the joint balls).
  const knob = Math.min(r * 1.45, h * 0.5), shaft = r * 0.6, steps = 20, profile = [[0, -h]];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, e = Math.min(t, 1 - t), bump = Math.max(0, 1 - e / 0.2) ** 1.6;
    profile.push([shaft + (knob - shaft) * bump, -h + 2 * h * t]);
  }
  profile.push([0, h]);
  return latheSolid(profile, seg);
}

function hubcap(r, h, seg) {
  const p = [[0, -h * 1.12], [r * 0.32, -h * 1.12], [r * 0.38, -h], [r, -h], [r, h], [r * 0.38, h], [r * 0.32, h * 1.12], [0, h * 1.12]];
  return latheSolid(p, seg);
}

/**
 * A wheel in its geom frame (axis +z, radius R, half-width h): rubber tyre
 * with tread lugs, a rim and hub caps with bolts on both faces. The lugs and
 * bolts are what make the spin visible: a plain cylinder spinning looks still.
 * Returns [{geometry, slot}] (shared through the cache).
 */
export function wheelParts(geom, style, cache, quality = 'high') {
  const [R, h] = geom.size, hi = quality !== 'low', seg = hi ? 40 : 24;
  const key = `wheel|${style}|${roundKey(R)}|${roundKey(h)}|${quality}`;
  if (cache.has(key)) return cache.get(key);
  const rc = Math.min(h * 0.55, R * 0.16), profile = [[0, -h], [R - rc, -h]];
  for (let i = 1; i < 6; i++) { const a = -Math.PI / 2 + (i / 6) * Math.PI; profile.push([R - rc + rc * Math.cos(a), (Math.sin(a) < 0 ? -(h - rc) : h - rc) + rc * Math.sin(a) * 0.999]); }
  profile.push([R - rc, h], [0, h]);
  const tyre = renderable(latheSolid(profile, seg), Math.PI / 5);
  // Chevron tread: alternating lugs left and right of the centre line.
  const chunky = style === 'chunky', count = Math.max(12, Math.min(28, Math.round((2 * Math.PI * R) / (h * (chunky ? 1.1 : 0.85)))));
  const lugs = [];
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2, side = k % 2 ? 1 : -1;
    const lug = boxSolid(R * (chunky ? 0.07 : 0.045), (Math.PI * R / count) * 0.62, h * 0.4);
    lugs.push(place(lug, new THREE.Vector3(Math.cos(a) * (R - R * 0.01), Math.sin(a) * (R - R * 0.01), side * h * 0.42), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a + side * 0.35)));
  }
  const tread = renderable(mergeSolids(lugs), Math.PI / 4);
  lugs.forEach(l => l.dispose());
  const rim = renderable(puckSolid(R * 0.6, h * 1.05, 0.35, seg), Math.PI / 4);
  const caps = [], bolts = [];
  for (const s of [-1, 1]) {
    const dome = latheSolid([[0, 0], [R * 0.3, 0], [R * 0.27, R * 0.05], [R * 0.16, R * 0.1], [0, R * 0.12]], seg);
    caps.push(place(dome, new THREE.Vector3(0, 0, s * h * 1.04), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), s > 0 ? 0 : Math.PI)));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      bolts.push(place(sphereSolid(R * 0.045, 10, 6), new THREE.Vector3(Math.cos(a) * R * 0.44, Math.sin(a) * R * 0.44, s * h * 1.05)));
    }
  }
  const hub = smooth(mergeSolids(caps)), boltGeo = smooth(mergeSolids(bolts));
  caps.concat(bolts).forEach(g => g.dispose());
  const parts = [{ geometry: tyre, slot: 'feet' }, { geometry: tread, slot: 'feet' }, { geometry: rim, slot: 'joints' }, { geometry: hub, slot: 'details' }, { geometry: boltGeo, slot: 'ink' }];
  cache.set(key, parts);
  return parts;
}

/**
 * A flat sole (box half-sizes sx, sy, sz in its geom frame) dressed as a shoe:
 * ball = sneaker with toe cap, paw = slipper with toe beans, hoof = tall dark
 * boot, pad = robot plate with tread. Returns [{geometry, slot}].
 */
export function flatFootParts(geom, style, cache, quality = 'high') {
  const [sx, sy, sz] = geom.size, hi = quality !== 'low', seg = hi ? 28 : 18;
  const key = `flat|${style}|${geom.size.map(roundKey).join(',')}|${quality}`;
  if (cache.has(key)) return cache.get(key);
  const hz = Math.max(sz * 2.4, sy * (style === 'hoof' ? 0.95 : 0.55));
  const parts = [];
  const shoe = place(superellipsoidSolid(sx * 1.04, sy * 1.1, hz, 0.4, 0.45, seg, Math.round(seg * 0.6)), new THREE.Vector3(0, 0, -sz + hz * 0.98));
  parts.push({ geometry: renderable(shoe, Math.PI / 4), slot: style === 'hoof' ? 'ink' : 'feet' });
  const sole = place(superellipsoidSolid(sx * 1.07, sy * 1.14, sz * 0.75, 0.25, 0.45, seg, 10), new THREE.Vector3(0, 0, -sz + sz * 0.7));
  parts.push({ geometry: renderable(sole, Math.PI / 4), slot: style === 'hoof' ? 'feet' : 'ink' });
  if (style === 'ball') {
    const toe = cutSolid(superellipsoidSolid(sx * 0.42, sy * 1.12, hz * 0.95, 0.5, 0.5, seg, 12), new THREE.Vector3(1, 0, 0), sx * 0.05);
    parts.push({ geometry: renderable(place(toe, new THREE.Vector3(sx * 0.6, 0, -sz + hz * 0.98)), Math.PI / 4), slot: 'details' });
  } else if (style === 'paw') {
    const beans = [];
    for (const [x, y] of [[0.78, 0.6], [0.92, 0.2], [0.92, -0.2], [0.78, -0.6]]) beans.push(place(sphereSolid(sy * 0.32, 14, 10), new THREE.Vector3(sx * x, sy * y, -sz + hz * 1.55)));
    parts.push({ geometry: smooth(mergeSolids(beans)), slot: 'feet' });
    beans.forEach(b => b.dispose());
  } else if (style === 'pad') {
    const lugs = [];
    for (let i = 0; i < 6; i++) lugs.push(place(boxSolid(sx * 0.06, sy * 0.9, sz * 0.4), new THREE.Vector3(-sx * 0.8 + (i * sx * 1.6) / 5, 0, -sz - sz * 0.15)));
    parts.push({ geometry: renderable(mergeSolids(lugs), Math.PI / 4), slot: 'ink' });
    lugs.forEach(l => l.dispose());
    parts.push({ geometry: renderable(place(torusSolid(sy * 0.55, sy * 0.06, seg, 8), new THREE.Vector3(0, 0, -sz + hz * 1.9)), Math.PI / 4), slot: 'details' });
  }
  shoe.dispose(); sole.dispose();
  cache.set(key, parts);
  return parts;
}

/**
 * Foot decoration in a level, heading-aligned frame centred on the foot
 * sphere (radius R). Returns [{solid, slot}] or [] for 'ball'.
 */
export function footParts(style, R, quality = 'high') {
  const hi = quality !== 'low', seg = hi ? 24 : 14;
  if (style === 'paw') {
    const pad = place(superellipsoidSolid(R * 1.28, R * 1.14, R * 0.66, 0.7, 0.85, seg, Math.round(seg * 0.6)), new THREE.Vector3(-R * 0.08, 0, -R + R * 0.66));
    const parts = [{ solid: pad, slot: 'feet' }];
    for (const [x, y] of [[0.98, 0.58], [1.14, 0.2], [1.14, -0.2], [0.98, -0.58]]) {
      parts.push({ solid: place(deform(sphereSolid(R * 0.34, 14, 10), p => new THREE.Vector3(p.x, p.y, p.z * 0.85)), new THREE.Vector3(R * x * 0.86, R * y, -R + R * 0.3)), slot: 'feet' });
    }
    parts.push({ solid: place(deform(sphereSolid(R * 0.5, 16, 10), p => new THREE.Vector3(p.x * 0.9, p.y * 1.2, p.z * 0.3)), new THREE.Vector3(-R * 0.15, 0, -R + R * 0.06)), slot: 'blush' });
    return parts;
  }
  if (style === 'hoof') {
    const hoof = latheSolid([[0, -R], [R * 1.08, -R], [R * 1.02, -R + R * 0.2], [R * 0.84, R * 0.5], [R * 0.7, R * 0.62], [0, R * 0.62]], seg);
    const sole = latheSolid([[0, -R - R * 0.04], [R * 1.1, -R - R * 0.04], [R * 1.1, -R + R * 0.08], [0, -R + R * 0.08]], seg);
    const cleft = place(boxSolid(R * 0.35, R * 0.06, R * 0.5), new THREE.Vector3(R * 0.82, 0, -R + R * 0.45));
    return [{ solid: hoof, slot: 'feet' }, { solid: sole, slot: 'ink' }, { solid: cleft, slot: 'ink' }];
  }
  if (style === 'pad') {
    const pad = place(puckSolid(R * 1.38, R * 0.42, 0.55, seg), new THREE.Vector3(0, 0, -R + R * 0.42));
    const tread = place(torusSolid(R * 1.2, R * 0.1, seg, 8), new THREE.Vector3(0, 0, -R + R * 0.1));
    const ring = place(torusSolid(R * 0.86, R * 0.07, seg, 8), new THREE.Vector3(0, 0, -R + R * 0.86));
    return [{ solid: pad, slot: 'feet' }, { solid: tread, slot: 'ink' }, { solid: ring, slot: 'details' }];
  }
  return [];
}
