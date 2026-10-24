import * as THREE from 'three';
import { superellipsoidSolid, sphereSolid, tubeSolid, deform, place, cutSolid, prismSolid, puckSolid } from './solids.js';
import { torsoTopAt } from './analyze.js';
import { capZ, capNormal } from './shells.js';

// Heads and faces. Everything is built in the torso body frame (MuJoCo:
// +x forward, +y left, +z up) and parented to the torso, so it moves with the
// physics body and never touches the model.
//
// Placement: Draft quadrupeds mount their hip motors on the torso's front
// face, so without a head the eyes sit on top of the front edge (frog style);
// bodies with a free front face get a front face; radial hubs use the top.
// With a head, everything goes on the head.

const UP = new THREE.Vector3(0, 0, 1);

/** Orientation whose +z is `normal` and +y leans towards body up. */
export function frameFor(normal, up = UP) {
  const z = normal.clone().normalize();
  let x = new THREE.Vector3().crossVectors(up, z);
  if (x.lengthSq() < 1e-8) x = new THREE.Vector3(0, 1, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Surface height of the creature's top (shell if any, else torso) at (x, y). */
export function makeTopSampler(info, shell) {
  const top = (x, y) => {
    const s = shell ? shell.surfaceAt(x, y) : null;
    const t = torsoTopAt(info, x, y);
    if (s !== null && s !== undefined && (t === null || s > t)) return s;
    return t ?? (s ?? null);
  };
  const normal = (x, y) => {
    if (shell && shell.surfaceAt(x, y) !== null) return shell.normalAt(x, y);
    const h = Math.max(1e-4, info.unit * 0.05), z = top(x, y) ?? 0;
    const zx = top(x + h, y) ?? z, zy = top(x, y + h) ?? z;
    return new THREE.Vector3(-(zx - z) / h, -(zy - z) / h, 1).normalize();
  };
  return { top, normal, shell };
}

// ---------------------------------------------------------------- heads --

function superFn(p, c, r, e1, e2) {
  const x = Math.abs((p.x - c.x) / r[0]), y = Math.abs((p.y - c.y) / r[1]), z = Math.abs((p.z - c.z) / r[2]);
  return ((x ** (2 / e2) + y ** (2 / e2)) ** (e2 / e1)) + z ** (2 / e1);
}

export function buildHead(look, info, sampler, { quality = 'high' } = {}) {
  const kind = look.face.head;
  if (!kind || kind === 'none') return null;
  const hi = quality !== 'low';
  const { box, half, center } = info.torso;
  const hr = Math.min(1.25 * info.unit, Math.max(0.9 * info.unit, 0.58 * half.y));
  const radii = kind === 'boxy' ? [hr * 0.86, hr * 1.02, hr * 0.84] : kind === 'snout' ? [hr * 0.92, hr * 0.98, hr * 0.9] : [hr * 0.9, hr, hr * 0.92];
  const [e1, e2] = kind === 'boxy' ? [0.38, 0.38] : [1, 1];
  const c = new THREE.Vector3();
  if (info.arrangement === 'radial') {
    // On top of a hub, a little forward.
    const x = center.x + half.x * 0.42, base = sampler.top(x, center.y) ?? box.max.z;
    c.set(x, center.y, base + radii[2] * 0.62);
  } else {
    c.set(box.max.x + radii[0] * 0.3, center.y, 0);
    // Clear the front machinery inside the head's footprint, stay attached.
    let machinery = -Infinity;
    for (const p of info.obstacles) {
      if (Math.abs(p.y - c.y) < radii[1] * 0.92 && p.x > c.x - radii[0] && p.x < c.x + radii[0]) machinery = Math.max(machinery, p.z);
    }
    const frontTop = sampler.top(box.max.x - 0.01, center.y) ?? box.max.z;
    c.z = Math.max(Number.isFinite(machinery) ? machinery + 0.008 + radii[2] * 0.92 : -Infinity, frontTop - radii[2] * 0.1, box.max.z * 0.5 + radii[2] * 0.5);
  }
  const parts = [];
  const skull = place(superellipsoidSolid(radii[0], radii[1], radii[2], e1, e2, hi ? 40 : 24, hi ? 24 : 14), c.clone());
  parts.push({ name: 'head', slot: 'body', solid: skull });
  let snoutTip = null;
  if (kind === 'snout') {
    const s = [hr * 0.55, hr * 0.6, hr * 0.42];
    const sc = c.clone().add(new THREE.Vector3(radii[0] * 0.78, 0, -radii[2] * 0.32));
    parts.push({ name: 'snout', slot: 'muzzle', solid: place(superellipsoidSolid(s[0], s[1], s[2], 0.9, 0.9, hi ? 32 : 20, hi ? 18 : 12), sc) });
    snoutTip = sc.clone().add(new THREE.Vector3(s[0] * 0.96, 0, s[2] * 0.22));
    const noseR = hr * 0.16;
    parts.push({ name: 'nose', slot: 'nose', solid: place(deform(sphereSolid(noseR, 16, 10), p => new THREE.Vector3(p.x * 0.75, p.y * 1.25, p.z * 0.85)), snoutTip.clone()) });
  }
  // Ray from the centre against the actual superellipsoid.
  const sample = (u, v) => {
    const theta = u * 1.15, phi = v * 1.0;
    const d = new THREE.Vector3(Math.cos(phi) * Math.cos(theta), Math.cos(phi) * Math.sin(theta), Math.sin(phi)).normalize();
    let lo = 0, hiT = Math.max(...radii) * 2;
    for (let i = 0; i < 40; i++) { const m = (lo + hiT) / 2; if (superFn(c.clone().addScaledVector(d, m), c, radii, e1, e2) < 1) lo = m; else hiT = m; }
    const position = c.clone().addScaledVector(d, lo);
    const h = hr * 0.01, f = q => superFn(q, c, radii, e1, e2);
    const normal = new THREE.Vector3(
      f(position.clone().add(new THREE.Vector3(h, 0, 0))) - f(position.clone().add(new THREE.Vector3(-h, 0, 0))),
      f(position.clone().add(new THREE.Vector3(0, h, 0))) - f(position.clone().add(new THREE.Vector3(0, -h, 0))),
      f(position.clone().add(new THREE.Vector3(0, 0, h))) - f(position.clone().add(new THREE.Vector3(0, 0, -h)))).normalize();
    return { position, normal };
  };
  // Printable (on demand): the skull with a flat back where it meets the
  // torso front, so it can be glued or bolted to the front face.
  const printable = () => {
    let solids = parts.map(p => p.solid.clone());
    if (info.arrangement !== 'radial') {
      const cutAt = box.max.x + 0.0015;
      solids = solids.map(s => { const cut = cutSolid(s, new THREE.Vector3(1, 0, 0), cutAt); s.dispose(); return cut; }).filter(s => s.index.count > 0);
    }
    return [{ name: `head-${kind}`, slot: 'body', solids }];
  };
  return { kind, center: c, radii, hr, parts, sample, snoutTip, printable, top: c.z + radii[2] };
}

// ---------------------------------------------------------------- faces --

function faceSurface(look, info, sampler, head) {
  const { box, half, center } = info.torso;
  if (head) return { kind: 'head', sample: head.sample, scale: head.hr, spacing: 0.42, eyeV: 0.32, mouthV: -0.28, snoutTip: head.snoutTip };
  if (!info.frontBlocked) {
    // Free front face: probe forward so a shell covering it is respected.
    const sample = (u, v) => {
      const y = center.y + u * half.y * 0.75, z = center.z + v * half.z * 0.75 + half.z * 0.25;
      let x = box.max.x;
      const shell = sampler.shell;
      if (shell) {
        let lo = center.x, hiX = center.x + shell.cap.a;
        for (let i = 0; i < 30; i++) { const m = (lo + hiX) / 2, s = capZ(shell.cap, m, y); if (s !== null && s > z) lo = m; else hiX = m; }
        if (lo > x) x = lo;
      }
      return { position: new THREE.Vector3(x, y, z), normal: new THREE.Vector3(1, 0, 0.12).normalize() };
    };
    return { kind: 'front', sample, scale: Math.min(half.y, half.z) * 0.9, spacing: 0.42, eyeV: 0.45, mouthV: -0.35 };
  }
  // Top of the front edge (frog style).
  const frontX = info.arrangement === 'radial' ? center.x + half.x * 0.5 : center.x + half.x * 0.7;
  const sample = (u, v) => {
    const x = frontX + v * half.x * 0.12, y = center.y + u * half.y * 0.62;
    const z = sampler.top(x, y) ?? box.max.z;
    const n = sampler.normal(x, y).clone().add(new THREE.Vector3(1.1, 0, 0)).normalize();
    return { position: new THREE.Vector3(x, y, z), normal: n };
  };
  return { kind: 'top', sample, scale: Math.min(half.y * 0.7, info.unit * 1.05), spacing: 0.5, eyeV: 0.2, mouthV: null };
}

/**
 * Builds the face. Returns { group, parts:[{mesh-spec}], update(dt, t), printable }.
 * Meshes are created by the caller from {solid, slot, smooth, node} specs so
 * the view owns materials and disposal; `node` is the Group to attach to.
 */
export function buildFace(look, info, sampler, head, { quality = 'high', random = Math.random } = {}) {
  const face = look.face;
  const root = new THREE.Group(); root.name = 'face';
  const specs = [], eyes = [];
  if (face.eyes === 'none' && face.mouth === 'none' && !face.cheeks && face.markings === 'none') return { group: root, specs, update() {}, eyes };
  const hi = quality !== 'low', seg = hi ? 24 : 14, rings = hi ? 16 : 10;
  const surf = faceSurface(look, info, sampler, head);
  const S = surf.scale, size = face.size;
  const eyeBase = { round: 0.3, cute: 0.36, visor: 0.3, cyclops: 0.44, sleepy: 0.3, compound: 0.36 }[face.eyes] ?? 0.3;
  const R = S * eyeBase * size * (surf.kind === 'top' ? 0.82 : 1);
  const add = (node, solid, slot, smooth = true, name = slot) => { specs.push({ node, solid, slot, smooth, name }); return solid; };
  const eyeNode = (u, v, push = 0.5) => {
    const { position, normal } = surf.sample(u, v);
    const g = new THREE.Group();
    g.position.copy(position).addScaledVector(normal, R * push);
    g.quaternion.copy(frameFor(normal));
    root.add(g);
    return g;
  };
  const spacing = surf.spacing * (face.eyes === 'cute' ? 1.06 : 1);

  // Markings go under the eyes, so build them first.
  if (face.markings === 'patches' && face.eyes !== 'none') {
    for (const side of [-1, 1]) {
      const g = eyeNode(side * spacing, surf.eyeV - 0.08, -0.25);
      add(g, deform(sphereSolid(R * 1.5, seg, rings), p => new THREE.Vector3(p.x * 1.0, p.y * 1.25, p.z * 0.28).applyAxisAngle(new THREE.Vector3(0, 0, 1), side * 0.5)), 'marking');
    }
  } else if (face.markings === 'mask' && face.eyes !== 'none') {
    for (const u of [-spacing, 0, spacing]) {
      const g = eyeNode(u, surf.eyeV, -0.2);
      add(g, deform(sphereSolid(R * 1.25, seg, rings), p => new THREE.Vector3(p.x * (u === 0 ? 1.3 : 1.35), p.y * 0.95, p.z * 0.25)), 'marking');
    }
  }

  const makeEye = (u, scale = 1) => {
    const g = eyeNode(u, surf.eyeV, face.eyes === 'compound' ? 0.25 : 0.42);
    const r = R * scale;
    const lid = new THREE.Group(); g.add(lid);      // blink scales this group
    const look = new THREE.Group(); lid.add(look);  // pupils move inside it
    const eye = { group: g, lid, look, r, kind: face.eyes, side: Math.sign(u) || 1 };
    if (face.eyes === 'round' || face.eyes === 'sleepy') {
      add(lid, deform(sphereSolid(r, seg, rings), p => new THREE.Vector3(p.x, p.y, p.z * 0.8)), 'eyeWhite');
      add(look, place(deform(sphereSolid(r * 0.46, seg, rings), p => new THREE.Vector3(p.x, p.y, p.z * 0.4)), new THREE.Vector3(0, -r * 0.02, r * 0.64)), 'eyeIris');
      add(lid, place(sphereSolid(r * 0.13, 12, 8), new THREE.Vector3(r * 0.22, r * 0.26, r * 0.74)), 'eyeShine');
    } else if (face.eyes === 'cute') {
      add(lid, deform(sphereSolid(r, seg, rings), p => new THREE.Vector3(p.x * 0.92, p.y * 1.12, p.z * 0.78)), 'eyePupil');
      add(look, place(deform(sphereSolid(r * 0.62, seg, rings), p => new THREE.Vector3(p.x, p.y * 1.1, p.z * 0.3)), new THREE.Vector3(0, -r * 0.18, r * 0.62)), 'eyeIris');
      add(lid, place(sphereSolid(r * 0.26, 14, 10), new THREE.Vector3(r * 0.3, r * 0.36, r * 0.68)), 'eyeShine');
      add(lid, place(sphereSolid(r * 0.12, 10, 8), new THREE.Vector3(-r * 0.22, -r * 0.34, r * 0.72)), 'eyeShine');
    } else if (face.eyes === 'cyclops') {
      add(lid, deform(sphereSolid(r, seg, rings), p => new THREE.Vector3(p.x, p.y, p.z * 0.82)), 'eyeWhite');
      add(look, place(deform(sphereSolid(r * 0.56, seg, rings), p => new THREE.Vector3(p.x, p.y, p.z * 0.32)), new THREE.Vector3(0, 0, r * 0.66)), 'eyeIris');
      add(look, place(deform(sphereSolid(r * 0.27, seg, rings), p => new THREE.Vector3(p.x, p.y, p.z * 0.35)), new THREE.Vector3(0, 0, r * 0.78)), 'eyePupil');
      add(lid, place(sphereSolid(r * 0.12, 12, 8), new THREE.Vector3(r * 0.28, r * 0.3, r * 0.76)), 'eyeShine');
      // A little brow ridge makes a single eye read as a face, not a lamp.
      add(g, place(deform(tubeSolid([new THREE.Vector3(-r * 0.95, 0, 0), new THREE.Vector3(0, r * 0.2, 0), new THREE.Vector3(r * 0.95, 0, 0)], r * 0.16, { radial: 10 }), p => p), new THREE.Vector3(0, r * 1.05, r * 0.25)), 'lid');
    } else if (face.eyes === 'compound') {
      const ico = new THREE.IcosahedronGeometry(r, hi ? 2 : 1);
      const solid = deform(weldIco(ico), p => new THREE.Vector3(p.x, p.y * 1.05, p.z * 0.85));
      ico.dispose();
      add(lid, solid, 'eyeIris', false);
      add(lid, place(sphereSolid(r * 0.12, 10, 8), new THREE.Vector3(r * 0.25, r * 0.35, r * 0.72)), 'eyeShine');
    }
    if (face.eyes === 'sleepy') {
      // Upper lid: a slightly larger cap over the top half, in body colour.
      const cap = cutSolid(sphereSolid(r * 1.07, seg, rings), new THREE.Vector3(0, 1, 0), -r * 0.08);
      const lidPivot = new THREE.Group(); g.add(lidPivot);
      lidPivot.rotation.x = 0.55;   // droopy at rest
      add(lidPivot, deform(cap, p => new THREE.Vector3(p.x, p.y, p.z * 0.82)), 'lid');
      eye.lidPivot = lidPivot;
    }
    eyes.push(eye);
    return eye;
  };

  if (face.eyes === 'visor') {
    let { position, normal } = surf.sample(0, surf.eyeV);
    const w = S * spacing * 1.25 + R, h = R * 1.05;
    if (surf.kind === 'top') {
      // A visor lying on a back reads as a smear: mount it on a little
      // turret that faces forward (tank periscope, robot brow).
      const housing = new THREE.Group(); housing.position.copy(position); root.add(housing);
      add(housing, place(superellipsoidSolid(R * 1.0, w * 1.06, h * 1.0, 0.35, 0.3, hi ? 32 : 20, hi ? 16 : 10), new THREE.Vector3(-R * 0.2, 0, h * 0.62)), 'joints');
      position = position.clone().add(new THREE.Vector3(R * 0.72, 0, h * 0.68));
      normal = new THREE.Vector3(1, 0, 0.12).normalize();
    }
    const g = new THREE.Group(); g.position.copy(position).addScaledVector(normal, R * 0.2); g.quaternion.copy(frameFor(normal)); root.add(g);
    const band = deform(superellipsoidSolid(w, h, R * 0.45, 0.35, 0.35, hi ? 40 : 24, hi ? 16 : 10), p => new THREE.Vector3(p.x, p.y, p.z - (p.x * p.x) / (w * 2.2)));
    add(g, band, 'eyeGlass');
    for (const side of [-1, 1]) {
      const lid = new THREE.Group(); lid.position.set(side * w * 0.42, 0, R * 0.42 - (w * 0.42) ** 2 / (w * 2.2)); g.add(lid);
      const look = new THREE.Group(); lid.add(look);
      add(look, deform(puckSolid(R * 0.36, R * 0.07, 0.6, 20), p => new THREE.Vector3(p.x * 1.35, p.y * 0.9, p.z)), 'eyeGlow');
      eyes.push({ group: g, lid, look, r: R * 0.36, kind: 'visor', side });
    }
  } else if (face.eyes === 'cyclops') {
    makeEye(0, 1);
  } else if (face.eyes !== 'none') {
    makeEye(-spacing); makeEye(spacing);
  }

  if (face.cheeks) {
    for (const side of [-1, 1]) {
      const g = eyeNode(side * spacing * 1.32, surf.eyeV - 0.42, -0.05);
      add(g, deform(sphereSolid(R * 0.55, 16, 10), p => new THREE.Vector3(p.x * 1.25, p.y * 0.8, p.z * 0.2)), 'blush');
    }
  }

  // Mouths: on the head below the eyes, on a snout, or on the front strip.
  if (face.mouth !== 'none') {
    let origin, normal;
    if (surf.snoutTip) { origin = surf.snoutTip.clone().add(new THREE.Vector3(-R * 0.15, 0, -R * 0.7)); normal = new THREE.Vector3(1, 0, -0.25).normalize(); }
    else if (surf.mouthV !== null) ({ position: origin, normal } = surf.sample(0, surf.mouthV));
    else {
      // Top-placed faces: mouth on the upper front edge of the torso/shell.
      const { box, center } = info.torso;
      const x = box.max.x, z = (sampler.top(x - 0.005, center.y) ?? box.max.z) - R * 0.35;
      origin = new THREE.Vector3(x + R * 0.1, center.y, z); normal = new THREE.Vector3(1, 0, 0.35).normalize();
    }
    const g = new THREE.Group(); g.position.copy(origin); g.quaternion.copy(frameFor(normal)); root.add(g);
    const w = R * (face.mouth === 'grin' ? 1.5 : 1.05);
    const arc = n => Array.from({ length: n }, (_, i) => { const t = -1 + (2 * i) / (n - 1); return new THREE.Vector3(t * w, -w * 0.38 * (1 - t * t) + w * 0.12, R * 0.12 * (1 - Math.abs(t))); });
    if (face.mouth === 'smile' || face.mouth === 'grin' || face.mouth === 'fangs') {
      add(g, tubeSolid(arc(9), R * (face.mouth === 'grin' ? 0.11 : 0.09), { radial: 8 }), 'ink');
      if (face.mouth === 'grin') {
        const teeth = Array.from({ length: 9 }, (_, i) => { const t = -0.8 + (1.6 * i) / 8; return [t * w, -w * 0.3 * (1 - t * t) + w * 0.1]; });
        const outline = teeth.concat(teeth.slice().reverse().map(([x, y]) => [x, y - R * 0.32 * (1 - Math.abs(x / w) * 0.6)]));
        add(g, prismSolid(convexHull(outline), 0, R * 0.08), 'teeth', false);
      }
      if (face.mouth === 'fangs') {
        for (const side of [-1, 1]) {
          const x = side * w * 0.45, y = -w * 0.38 * (1 - 0.2) + w * 0.12;
          add(g, tubeSolid([new THREE.Vector3(x, y, R * 0.1), new THREE.Vector3(x * 0.98, y - R * 0.42, R * 0.12)], [R * 0.13, R * 0.02], { radial: 10, start: 'flat', end: 'point' }), 'teeth');
        }
      }
    } else if (face.mouth === 'beak') {
      const beak = deform(sphereSolid(1, seg, rings), p => {
        const u = (p.z + 1) / 2;   // along the bill
        return new THREE.Vector3(p.x * R * 0.85 * (1 - 0.25 * u), p.y * R * 0.32 * (1 - 0.3 * u) - u * u * R * 0.1, u * R * 1.5 - R * 0.2);
      });
      add(g, beak, 'beak');
    } else if (face.mouth === 'whiskers') {
      for (const side of [-1, 1]) for (const k of [-1, 0, 1]) {
        const a = k * 0.28, len = R * 2.1;
        const pts = [new THREE.Vector3(side * R * 0.35, k * R * 0.18, R * 0.1), new THREE.Vector3(side * (R * 0.35 + len * 0.55 * Math.cos(a)), k * R * 0.18 + len * 0.55 * Math.sin(a), R * 0.32), new THREE.Vector3(side * (R * 0.35 + len * Math.cos(a)), k * R * 0.18 + len * Math.sin(a) - len * 0.06, R * 0.25)];
        add(g, tubeSolid(pts, [R * 0.035, R * 0.028, R * 0.012], { radial: 6, start: 'round', end: 'point' }), 'ink');
      }
      add(g, place(deform(sphereSolid(R * 0.22, 14, 10), p => new THREE.Vector3(p.x * 1.3, p.y, p.z * 0.7)), new THREE.Vector3(0, R * 0.22, R * 0.2)), 'nose');
    } else if (face.mouth === 'grill') {
      add(g, deform(puckSolid(R * 1.0, R * 0.08, 0.5, 28), p => new THREE.Vector3(p.x * 1.25, p.y * 0.6, p.z)), 'joints');
      for (const k of [-1, 0, 1]) add(g, place(deform(puckSolid(R * 0.12, R * 0.05, 0.5, 12), p => new THREE.Vector3(p.x * 7.5, p.y, p.z)), new THREE.Vector3(0, k * R * 0.17, R * 0.08)), 'ink');
    }
  }

  // Idle life: blinks every few seconds (sometimes twice), small saccades.
  let nextBlink = 1.5 + random() * 2.5, blinkT = -1, doubleBlink = false;
  let gaze = new THREE.Vector2(), gazeTarget = new THREE.Vector2(), nextGaze = 0.8;
  function update(dt, time) {
    if (!eyes.length) return;
    nextBlink -= dt; nextGaze -= dt;
    if (nextBlink <= 0 && blinkT < 0) { blinkT = 0; doubleBlink = random() < 0.2; nextBlink = 2.4 + random() * 3.6; }
    let open = 1;
    if (blinkT >= 0) {
      blinkT += dt;
      const len = 0.16, total = doubleBlink ? len * 2.2 : len;
      const local = doubleBlink && blinkT > len * 1.2 ? blinkT - len * 1.2 : blinkT;
      open = local < len ? Math.abs(Math.cos((local / len) * Math.PI)) : 1;
      if (blinkT > total) blinkT = -1;
    }
    if (nextGaze <= 0) { gazeTarget.set((random() - 0.5) * 2, (random() - 0.5) * 1.2); if (random() < 0.35) gazeTarget.set(0, 0); nextGaze = 0.6 + random() * 2.2; }
    gaze.lerp(gazeTarget, 1 - Math.exp(-dt * 14));
    for (const eye of eyes) {
      if (eye.kind === 'compound') continue;
      if (eye.lidPivot) eye.lidPivot.rotation.x = 0.55 + (1 - open) * 1.1;   // sleepy lids close
      else eye.lid.scale.y = Math.max(0.06, open);
      const m = eye.kind === 'visor' ? 0.28 : 0.17;
      eye.look.position.set(gaze.x * eye.r * m, gaze.y * eye.r * m, 0);
    }
    void time;
  }
  return { group: root, specs, update, eyes, surface: surf.kind, eyeRadius: R };
}

function weldIco(geometry) {
  // IcosahedronGeometry is non-indexed; weld it into a closed solid.
  const pos = geometry.attributes.position, map = new Map(), out = [], idx = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e6)},${Math.round(pos.getY(i) * 1e6)},${Math.round(pos.getZ(i) * 1e6)}`;
    let id = map.get(key);
    if (id === undefined) { id = out.length / 3; map.set(key, id); out.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    idx.push(id);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setIndex(idx);
  return g;
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
