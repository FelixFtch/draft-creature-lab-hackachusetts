import * as THREE from 'three';
import { tubeSolid, sphereSolid, latheSolid, superellipsoidSolid, torusSolid, bandSolid, loopTubeSolid, deform, place, cutSolid } from './solids.js';
import { petalSolid } from './shells.js';
import { frameFor } from './face.js';
import { scaleHex, mixHex } from './schema.js';

// Accessories: purely cosmetic parts parented to the torso body frame. Each
// builder returns mesh specs ({node, solid, material}) and an optional
// update(dt, time, motion) for secondary motion. motion carries the torso's
// own acceleration and speed (from the physics state, read in sync), so
// antennae wobble when the creature actually lurches. Nothing here feeds back.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const Y = V(0, 1, 0), Z = V(0, 0, 1), X = V(1, 0, 0);

// A damped spring on a 2D tilt, driven by body acceleration (inertia).
function spring(k = 180, c = 5, gain = 0.05) {
  const angle = new THREE.Vector2(), vel = new THREE.Vector2();
  return {
    angle,
    step(dt, accel, idle = new THREE.Vector2()) {
      const steps = Math.max(1, Math.ceil(dt / 0.008)), h = dt / steps;
      for (let i = 0; i < steps; i++) {
        // Lag opposite to the acceleration; idle adds a gentle sway target.
        const fx = -accel.x * gain * k - k * (angle.x - idle.x) - c * vel.x;
        const fy = -accel.y * gain * k - k * (angle.y - idle.y) - c * vel.y;
        vel.x += fx * h; vel.y += fy * h; angle.x += vel.x * h; angle.y += vel.y * h;
      }
      angle.clampScalar(-0.9, 0.9);
      return angle;
    },
  };
}

function anchorKit(info, sampler, head) {
  const { box, half, center } = info.torso;
  const radial = info.arrangement === 'radial';
  const headTop = (u, v = 0.82) => {
    if (head) return head.sample(u * 0.62, v);
    const x = center.x + half.x * (radial ? 0.25 : 0.55), y = center.y + u * half.y * 0.45;
    return { position: V(x, y, sampler.top(x, y) ?? box.max.z), normal: sampler.normal(x, y) };
  };
  const back = t => {
    const x = center.x + t * half.x, y = center.y;
    return { position: V(x, y, sampler.top(x, y) ?? box.max.z), normal: sampler.normal(x, y) };
  };
  const side = (t, s) => {
    const x = center.x + t * half.x, y = center.y + s * half.y * 0.5;
    return { position: V(x, y, sampler.top(x, y) ?? box.max.z), normal: sampler.normal(x, y) };
  };
  const rear = () => {
    // Just inside the rear top edge, so the tail grows out of the body.
    let x = box.min.x + half.x * 0.12;
    const z = sampler.top(x, center.y) ?? box.max.z;
    if (sampler.shell) x = Math.min(x, center.x - sampler.shell.cap.a * 0.82);
    return { position: V(x, center.y, Math.max(z - half.z * 0.25, center.z)), normal: V(-1, 0, 0.4).normalize() };
  };
  return { headTop, back, side, rear, scale: head ? head.hr : info.unit, hasHead: !!head };
}

/**
 * Build all accessories of a look. Returns { group, specs, updates, printable }.
 * A spec's material is a slot name ('gold', 'leaf', ...) or {color, role}.
 */
export function buildAccessories(look, info, sampler, head, { quality = 'high' } = {}) {
  const group = new THREE.Group(); group.name = 'accessories';
  const specs = [], updates = [], printable = [];
  const hi = quality !== 'low', seg = hi ? 20 : 12, rings = hi ? 12 : 8;
  const kit = anchorKit(info, sampler, head);
  const kinds = new Set(look.accessories.map(a => a.kind));
  let centerSlots = 0;
  const centerU = () => [0, -0.42, 0.42, -0.2][centerSlots++ % 4];

  for (const acc of look.accessories) {
    const s = kit.scale * acc.size, color = acc.color;
    const mat = { main: { color, role: 'plastic' }, dark: { color: scaleHex(color, 0.45), role: 'plastic' }, light: { color: mixHex(color, '#ffffff', 0.45), role: 'plastic' } };
    const node = new THREE.Group(); node.name = acc.kind; group.add(node);
    const own = [];
    const add = (target, solid, material, smooth = true) => { const spec = { node: target, solid, material, smooth, accessory: acc.kind }; specs.push(spec); own.push(spec); return solid; };

    if (acc.kind === 'antennae') {
      const u = kinds.has('ears') || kinds.has('horns') ? 0.26 : 0.4;
      for (const side of [-1, 1]) {
        const { position } = kit.headTop(side * u, 0.9);
        const pivot = new THREE.Group(); pivot.position.copy(position); node.add(pivot);
        const L = s * 1.55, r = s * 0.06;
        const pts = [V(0, 0, -r), V(L * 0.08, side * L * 0.1, L * 0.45), V(L * 0.26, side * L * 0.3, L * 0.85), V(L * 0.36, side * L * 0.42, L * 0.98)];
        add(pivot, tubeSolid(pts, [r, r * 0.85, r * 0.7, r * 0.6], { radial: 10, start: 'flat', end: 'round' }), mat.dark);
        add(pivot, place(sphereSolid(s * 0.17, seg, rings), pts[3].clone()), mat.main);
        const sp = spring(170, 3.2, 0.06), phase = side * 1.3;
        updates.push((dt, t, motion) => {
          const a = sp.step(dt, motion.accel, new THREE.Vector2(0.05 * Math.sin(t * 1.7 + phase), 0.05 * Math.sin(t * 1.3 + phase * 2)));
          pivot.rotation.set(-a.y, a.x, 0);
        });
      }
    } else if (acc.kind === 'horns') {
      const u = kinds.has('ears') ? 0.36 : 0.5;
      for (const side of [-1, 1]) {
        const { position } = kit.headTop(side * u, 0.78);
        const L = s * 0.95, r = s * 0.2;
        const pts = [V(0, 0, -r * 0.6), V(L * 0.05, side * L * 0.28, L * 0.35), V(L * 0.18, side * L * 0.52, L * 0.62), V(L * 0.42, side * L * 0.6, L * 0.95)];
        add(node, place(tubeSolid(pts, [r, r * 0.78, r * 0.48, r * 0.05], { radial: 14, start: 'flat', end: 'point' }), position), mat.main);
      }
    } else if (acc.kind === 'ears') {
      for (const side of [-1, 1]) {
        const { position, normal } = kit.headTop(side * 0.78, kit.hasHead ? 1.05 : 0.7);
        // Ear frame: +x up along the (softened) normal, +z forward, so the
        // petal's cupped face looks forward; then splay outwards about +z.
        const up = normal.clone().lerp(Z, 0.4).normalize();
        const lat = Y.clone().sub(up.clone().multiplyScalar(Y.dot(up))).normalize().negate();
        const fwd = new THREE.Vector3().crossVectors(up, lat).normalize();
        const pivot = new THREE.Group(); pivot.position.copy(position);
        pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(up, lat, fwd));
        node.add(pivot);
        const splay = new THREE.Group(); splay.rotation.z = -side * 0.32; pivot.add(splay);
        // Round heads (and headless bodies) get round ears (panda, bear,
        // mouse); snouts and robot heads get pointed ones (cat, tiger, cow).
        const round = !head || head.kind === 'round';
        const L = s * (round ? 0.7 : 0.95), W = L * (round ? 1.02 : 0.78), taper = round ? 0.05 : 0.55;
        add(splay, place(petalSolid(L, W, L * 0.18, { curl: -0.15, cup: round ? 0.4 : 0.55, taper, segments: seg, rings }), V(-L * 0.16, 0, 0)), mat.main);
        add(splay, place(petalSolid(L * 0.64, W * 0.6, L * 0.08, { curl: -0.1, cup: 0.4, taper, segments: seg, rings }), V(-L * 0.02, 0, L * 0.06)), 'blush');
        let twitch = -1, next = 2 + Math.random() * 5;
        updates.push(dt => {
          next -= dt;
          if (next <= 0 && twitch < 0) { twitch = 0; next = 3 + Math.random() * 6; }
          let a = 0;
          if (twitch >= 0) { twitch += dt; a = Math.sin(Math.min(1, twitch / 0.22) * Math.PI) * 0.3; if (twitch > 0.22) twitch = -1; }
          splay.rotation.z = -side * (0.32 + a);
        });
      }
    } else if (acc.kind === 'tail') {
      const { position } = kit.rear();
      const pivot = new THREE.Group(); pivot.position.copy(position); node.add(pivot);
      const L = Math.max(s * 1.7, info.torso.half.x * 0.7), r = s * 0.13;
      const pts = [V(L * 0.12, 0, 0), V(-L * 0.25, 0, L * 0.12), V(-L * 0.55, 0, L * 0.38), V(-L * 0.72, 0, L * 0.72), V(-L * 0.62, 0, L * 0.98)];
      add(pivot, tubeSolid(pts, [r, r * 0.9, r * 0.75, r * 0.6, r * 0.45], { radial: 12, start: 'round', end: 'round' }), mat.main);
      add(pivot, place(deform(sphereSolid(r * 1.5, seg, rings), p => V(p.x, p.y, p.z * 1.25)), pts[4].clone()), 'accent');
      const sp = spring(90, 3, 0.05);
      updates.push((dt, t, motion) => {
        const a = sp.step(dt, motion.accel, new THREE.Vector2(0, 0));
        pivot.rotation.set(0.12 * Math.sin(t * 1.3) - a.y * 0.5, -a.x * 0.6, 0.38 * Math.sin(t * 2.4) + motion.yawRate * -0.25);
      });
    } else if (acc.kind === 'spikes') {
      const n = hi ? 6 : 5;
      for (let i = 0; i < n; i++) {
        const t = -0.72 + (1.35 * i) / (n - 1), { position, normal } = kit.back(t);
        const h = s * (0.42 + 0.38 * Math.sin((Math.PI * (i + 0.5)) / n)), r = h * 0.36;
        const tip = position.clone().addScaledVector(normal, h).add(V(-h * 0.25, 0, 0));
        add(node, tubeSolid([position.clone().addScaledVector(normal, -r * 0.4), position.clone().addScaledVector(normal, h * 0.4).add(V(-h * 0.08, 0, 0)), tip], [r, r * 0.6, r * 0.02], { radial: 4 + (hi ? 4 : 0), start: 'flat', end: 'point' }), mat.main, false);
      }
    } else if (acc.kind === 'fin') {
      const { position } = kit.back(-0.05);
      const H = s * 1.25, C = s * 1.15;
      const fin = deform(sphereSolid(1, seg, rings), p => {
        const u = (p.z + 1) / 2;
        return V(p.x * C * 0.5 * (1 - u) ** 0.75 - H * 0.55 * u * u, p.y * s * 0.08 * (1 - u * 0.75), u * H);
      });
      add(node, place(fin, position.clone().add(V(0, 0, -s * 0.06))), mat.main);
    } else if (acc.kind === 'wings') {
      for (const side of [-1, 1]) {
        const { position } = kit.side(0.05, side * 0.7);
        const pivot = new THREE.Group(); pivot.position.copy(position); node.add(pivot);
        const L = s * 1.6;
        const wing = petalSolid(L, L * 0.55, s * 0.035, { curl: 0.25, cup: 0.1, taper: 0.3, segments: seg, rings });
        // span outwards, up and back
        const q = new THREE.Quaternion().setFromAxisAngle(Z, side * Math.PI / 2 + side * 0.45).multiply(new THREE.Quaternion().setFromAxisAngle(Y, -0.55));
        add(pivot, place(wing, V(0, 0, s * 0.05), q), { color, role: 'wing' });
        const small = petalSolid(L * 0.62, L * 0.4, s * 0.03, { curl: 0.2, cup: 0.1, taper: 0.3, segments: seg, rings });
        const q2 = new THREE.Quaternion().setFromAxisAngle(Z, side * Math.PI / 2 + side * 1.05).multiply(new THREE.Quaternion().setFromAxisAngle(Y, -0.3));
        add(pivot, place(small, V(-s * 0.1, 0, s * 0.04), q2), { color, role: 'wing' });
        updates.push((dt, t, motion) => {
          const buzz = 0.08 + Math.min(0.35, motion.speed * 0.6);
          pivot.rotation.x = side * buzz * Math.sin(t * (motion.speed > 0.05 ? 42 : 9));
        });
      }
    } else if (acc.kind === 'crown' || acc.kind === 'hat' || acc.kind === 'propeller' || acc.kind === 'flower' || acc.kind === 'sprout') {
      const u = centerU();
      const { position, normal } = kit.headTop(u, 0.95);
      const holder = new THREE.Group(); holder.position.copy(position);
      holder.quaternion.copy(frameFor(normal.clone().lerp(Z, 0.55).normalize())).multiply(new THREE.Quaternion().setFromAxisAngle(Z, Math.PI / 2));
      node.add(holder);
      if (acc.kind === 'crown') {
        const R = s * 0.48, H = s * 0.42, points = 5;
        const band = bandSolid(R, s * 0.06, a => H * (0.55 + 0.45 * Math.max(0, Math.cos(points * a))), hi ? 80 : 40);
        add(holder, place(band, V(0, 0, -s * 0.06)), 'gold', false);
        for (let k = 0; k < points; k++) {
          const a = (k / points) * Math.PI * 2;
          add(holder, place(sphereSolid(s * 0.055, 12, 8), V((R + s * 0.01) * Math.cos(a), (R + s * 0.01) * Math.sin(a), H - s * 0.06 + s * 0.04)), 'gold');
          add(holder, place(deform(sphereSolid(s * 0.07, 12, 8), p => V(p.x, p.y, p.z * 0.6)).applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2)), V((R + s * 0.035) * Math.cos(a + Math.PI / points), (R + s * 0.035) * Math.sin(a + Math.PI / points), H * 0.28)), 'jewel');
        }
      } else if (acc.kind === 'hat') {
        const Rb = s * 0.62, Rc = s * 0.4, H = s * 0.85, hb = s * 0.05;
        const hat = latheSolid([[0, 0], [Rb, 0], [Rb, hb], [Rc, hb], [Rc * 0.94, H], [0, H]], hi ? 32 : 18);
        holder.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X, 0.16));   // jaunty
        add(holder, place(hat, V(0, 0, -s * 0.05)), mat.main, false);
        add(holder, place(bandSolid(Rc * 1.01, s * 0.02, s * 0.16, hi ? 40 : 24), V(0, 0, hb - s * 0.05 + s * 0.005)), 'accent', false);
      } else if (acc.kind === 'propeller') {
        const capR = s * 0.42;
        const cap = cutSolid(sphereSolid(capR, seg + 4, rings + 2), Z, 0);
        add(holder, place(cap, V(0, 0, -capR * 0.25)), mat.main);
        add(holder, place(tubeSolid([V(0, 0, 0), V(0, 0, capR * 1.05)], s * 0.035, { radial: 8, start: 'flat', end: 'flat' }), V(0, 0, capR * 0.7)), 'joints');
        const rotor = new THREE.Group(); rotor.position.set(0, 0, capR * 1.78); holder.add(rotor);
        add(rotor, sphereSolid(s * 0.07, 12, 8), 'accent');
        for (const k of [0, 1, 2]) {
          const blade = petalSolid(s * 0.62, s * 0.2, s * 0.03, { curl: 0, cup: 0.1, taper: 0.2, segments: 12, rings: 8 });
          add(rotor, place(blade, V(0, 0, 0), new THREE.Quaternion().setFromAxisAngle(Z, (k * Math.PI * 2) / 3).multiply(new THREE.Quaternion().setFromAxisAngle(X, 0.3))), k === 0 ? 'accent' : mat.light);
        }
        updates.push((dt, t, motion) => { rotor.rotation.z += dt * (5 + motion.speed * 30); });
      } else if (acc.kind === 'flower' || acc.kind === 'sprout') {
        const sway = new THREE.Group(); holder.add(sway);
        const L = s * (acc.kind === 'flower' ? 0.6 : 0.75);
        const stem = [V(0, 0, -s * 0.05), V(s * 0.05, 0, L * 0.5), V(0, s * 0.02, L)];
        add(sway, tubeSolid(stem, s * 0.035, { radial: 8, start: 'flat', end: 'round' }), 'leaf');
        if (acc.kind === 'flower') {
          const head = new THREE.Group(); head.position.copy(stem[2]); head.rotation.y = -0.35; sway.add(head);
          for (let k = 0; k < 5; k++) {
            const petal = petalSolid(s * 0.38, s * 0.27, s * 0.04, { curl: 0.45, cup: 0.3, taper: 0.2, segments: 12, rings: 8 });
            add(head, place(petal, V(0, 0, 0), new THREE.Quaternion().setFromAxisAngle(Z, (k * Math.PI * 2) / 5)), mat.main);
          }
          add(head, place(sphereSolid(s * 0.12, 14, 10), V(0, 0, s * 0.03)), { color: '#ffd23f', role: 'plastic' });
        } else {
          for (const side of [-1, 1]) {
            const leaf = petalSolid(s * 0.48, s * 0.26, s * 0.035, { curl: 0.5, cup: 0.4, taper: 0.35, segments: 12, rings: 8 });
            add(sway, place(leaf, stem[2].clone(), new THREE.Quaternion().setFromAxisAngle(Z, side * Math.PI / 2).multiply(new THREE.Quaternion().setFromAxisAngle(Y, -0.55))), 'leaf');
          }
        }
        const sp = spring(60, 2.2, 0.08);
        updates.push((dt, t, motion) => { const a = sp.step(dt, motion.accel, new THREE.Vector2(0.06 * Math.sin(t * 1.1), 0.05 * Math.sin(t * 0.8))); sway.rotation.set(-a.y, a.x, 0); });
      }
    } else if (acc.kind === 'bow') {
      const { position, normal } = kit.headTop(0.48, 0.8);
      const holder = new THREE.Group(); holder.position.copy(position); holder.quaternion.copy(frameFor(normal)); node.add(holder);
      for (const side of [-1, 1]) {
        const loop = deform(sphereSolid(1, seg, rings), p => {
          const u = (p.z + 1) / 2;
          return V(side * (u * s * 0.5), p.x * s * 0.2 * (0.45 + u), p.y * s * 0.1 + s * 0.12);
        });
        add(holder, loop, mat.main);
        add(holder, place(petalSolid(s * 0.32, s * 0.14, s * 0.05, { curl: -0.2, cup: 0.1, taper: 0.1, segments: 10, rings: 8 }), V(0, 0, s * 0.08),
          new THREE.Quaternion().setFromAxisAngle(Z, -Math.PI / 2 + side * 0.45)), mat.main);
      }
      add(holder, place(sphereSolid(s * 0.1, 14, 10), V(0, 0, s * 0.12)), mat.dark);
    } else if (acc.kind === 'backpack') {
      const { position } = kit.back(-0.32);
      const half = info.torso.half;
      const w = Math.min(half.y * 0.62, s * 0.9), l = Math.min(half.x * 0.42, s * 0.85), h = s * 0.55;
      add(node, place(superellipsoidSolid(l, w, h, 0.4, 0.35, hi ? 28 : 18, hi ? 16 : 10), position.clone().add(V(0, 0, h * 0.7))), mat.main);
      add(node, place(superellipsoidSolid(l * 0.45, w * 1.02, h * 0.42, 0.4, 0.3, hi ? 24 : 16, 10), position.clone().add(V(l * 0.5, 0, h * 1.25))), mat.dark);
      add(node, place(superellipsoidSolid(l * 0.2, w * 0.55, h * 0.45, 0.4, 0.35, 16, 10), position.clone().add(V(-l * 1.0, 0, h * 0.6))), mat.light);
    } else if (acc.kind === 'mushroom') {
      const { position } = kit.back(-0.42);
      const at = position.clone().add(V(0, info.torso.half.y * 0.18, -s * 0.04));
      const H = s * 0.55, R = s * 0.48;
      add(node, place(latheSolid([[0, 0], [s * 0.15, 0], [s * 0.12, H * 0.6], [s * 0.14, H], [0, H]], 16), at.clone()), { color: '#f6efe0', role: 'plastic' });
      add(node, place(latheSolid([[0, 0], [R, 0.0], [R * 0.95, R * 0.22], [R * 0.6, R * 0.55], [0, R * 0.68]], hi ? 28 : 16), at.clone().add(V(0, 0, H * 0.82))), mat.main);
      for (let k = 0; k < 6; k++) {
        const a = k * 2.4, rr = R * (k === 0 ? 0 : 0.55), z = H * 0.82 + (k === 0 ? R * 0.68 : R * 0.42);
        add(node, place(deform(sphereSolid(s * 0.07, 10, 8), p => V(p.x, p.y, p.z * 0.4)), at.clone().add(V(rr * Math.cos(a), rr * Math.sin(a), z))), { color: '#fbf6ec', role: 'plastic' });
      }
    } else if (acc.kind === 'halo') {
      const { position } = kit.headTop(0, 1);
      const holder = new THREE.Group(); holder.position.copy(position).add(V(0, 0, s * 0.55)); node.add(holder);
      add(holder, torusSolid(s * 0.5, s * 0.05, hi ? 48 : 28, 10), { color: color === look.palette.accent ? '#ffd75e' : color, role: 'glowing' });
      const base = holder.position.z;
      updates.push((dt, t) => { holder.position.z = base + Math.sin(t * 1.6) * s * 0.06; holder.rotation.z += dt * 0.4; });
    } else if (acc.kind === 'goggles') {
      const node2 = new THREE.Group(); node.add(node2);
      for (const side of [-1, 1]) {
        const { position, normal } = kit.headTop(side * 0.3, kit.hasHead ? 0.55 : 0.6);
        const g = new THREE.Group(); g.position.copy(position).addScaledVector(normal, s * 0.06); g.quaternion.copy(frameFor(normal.clone().add(V(0.6, 0, 0)).normalize())); node2.add(g);
        add(g, torusSolid(s * 0.22, s * 0.055, hi ? 32 : 20, 10), mat.main);
        add(g, deform(sphereSolid(s * 0.21, 18, 12), p => V(p.x, p.y, p.z * 0.35)), 'eyeGlass');
      }
    } else if (acc.kind === 'scarf') {
      const { box, center, half } = info.torso;
      let holder, tailAt;
      if (head) {
        // Around the neck, tilted forward like a real knot.
        const anchor = head.center.clone().add(V(-head.radii[0] * 0.35, 0, -head.radii[2] * 0.72));
        const R = head.radii[1] * 0.85;
        holder = new THREE.Group(); holder.position.copy(anchor); holder.rotation.y = 0.35; node.add(holder);
        add(holder, deform(torusSolid(R, s * 0.16, hi ? 40 : 24, 12), p => V(p.x * 0.85, p.y, p.z * 1.6)), mat.main);
        tailAt = V(-R * 0.4, R * 0.6, 0);
      } else {
        // No head: wrap the chest like a collar, over the shell if there is one.
        const x = box.max.x - half.x * 0.22, topZ = sampler.top(x, center.y) ?? box.max.z;
        const ry = (sampler.shell ? Math.max(half.y, sampler.shell.cap.b) : half.y) + s * 0.1;
        const up = topZ - center.z + s * 0.12, down = half.z + s * 0.08;
        holder = new THREE.Group(); holder.position.set(x, center.y, center.z); node.add(holder);
        const ring = Array.from({ length: hi ? 56 : 32 }, (_, k) => { const a = (k / (hi ? 56 : 32)) * Math.PI * 2, sz = Math.sin(a); return V(0, Math.cos(a) * ry, sz * (sz > 0 ? up : down)); });
        add(holder, deform(loopTubeSolid(ring, s * 0.15, 12), p => V(p.x * 1.6, p.y, p.z)), mat.main);
        tailAt = V(s * 0.05, ry * 0.75, up * 0.55);
      }
      const tailPivot = new THREE.Group(); tailPivot.position.copy(tailAt); holder.add(tailPivot);
      add(tailPivot, place(petalSolid(s * 0.75, s * 0.3, s * 0.07, { curl: -0.35, cup: 0.1, taper: 0.1, segments: 12, rings: 8 }), V(0, 0, 0),
        new THREE.Quaternion().setFromAxisAngle(Y, Math.PI * 0.62)), mat.main);
      const sp = spring(50, 2, 0.1);
      updates.push((dt, t, motion) => { const a = sp.step(dt, motion.accel, new THREE.Vector2(0.08 * Math.sin(t * 2.1), 0)); tailPivot.rotation.set(0, a.x * 0.8, a.y * 0.8 + 0.1 * Math.sin(t * 3.1)); });
    }
    printable.push({ name: `accessory-${acc.kind}`, specs: own });
  }
  return { group, specs, updates, printable };
}
