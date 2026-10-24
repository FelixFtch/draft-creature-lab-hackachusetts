import * as THREE from 'three';
import { analyzeCreature, geomGeometry, GEOM } from './analyze.js';
import { normalizeLook } from './schema.js';
import { createMaterialKit } from './materials.js';
import { createSharedUniforms } from './shader.js';
import { buildShell } from './shells.js';
import { buildHead, buildFace, makeTopSampler } from './face.js';
import { buildAccessories } from './accessories.js';
import { limbGeometry, footParts } from './limbs.js';
import { renderable, smooth, weld } from './solids.js';
import { createModeController } from './modes.js';

// The creature view: everything a robot looks like, rebuilt from a compiled
// MjModel and a creature-look/1. Physics owns every transform: sync(data)
// copies body poses from MjData, cosmetics ride on those bodies, and nothing
// here writes to the model or data.
//
// Scene graph (add `group` under the Z-up MuJoCo root):
//   group
//     body:<name>      one Group per robot body, world pose from xpos/xmat
//       geom meshes    at their local geom_pos/geom_quat
//       (torso) decor  shell, head, face, accessories (torso frame)
//     foot:<leg>       level, heading-aligned foot styles at each foot centre
//     overlays         blueprint/x-ray helpers, print-reveal nozzle

const OUTLINE_SLOTS = new Set(['body', 'shell', 'shellAccent', 'shellTrim', 'limbs', 'joints', 'details', 'feet', 'accent', 'muzzle', 'lid', 'beak', 'marking', 'petalInner', 'leaf', 'gold', 'eyeWhite', 'eyePupil', 'eyeIris', 'eyeGlass', 'nose', 'ink', 'teeth']);
const DECOR_KEY = look => JSON.stringify([look.shell.kind, look.shell.size, look.face.eyes, look.face.size, look.face.head, look.face.mouth,
  look.face.cheeks, look.face.markings, look.accessories.map(a => [a.kind, a.size])]);

export function createCreatureView(options = {}) {
  const { mujoco, model, body = null, rootBody = null, quality = 'high', shadows = true } = options;
  if (!mujoco || !model) throw Error('createCreatureView needs mujoco and a compiled model');
  if (options.THREE && options.THREE.REVISION !== THREE.REVISION) console.warn(`appearance: THREE r${options.THREE.REVISION} passed, module uses r${THREE.REVISION}`);
  const info = analyzeCreature({ mujoco, model, body, rootBody });
  let look = normalizeLook(options.look);
  const shared = createSharedUniforms();
  const { half, box } = info.torso;
  const refSize = 2 * Math.max(half.x, half.y);

  const group = new THREE.Group(); group.name = 'creature-view';
  const overlays = new THREE.Group(); overlays.name = 'overlays';
  const nodes = new Map();
  for (const b of info.robotBodies) {
    const node = new THREE.Group(); node.name = `body:${info.bodyNames[b]}`;
    node.position.copy(info.restPos[b]); node.quaternion.copy(info.restQuat[b]);
    nodes.set(b, node); group.add(node);
  }
  group.add(overlays);
  const torsoNode = nodes.get(info.root);

  let kit = null;
  const meshes = new Set();               // every rendered mesh (for modes and materials)
  const limbCache = new Map();            // style geometries shared across legs
  const torsoGeometries = [];
  let geomMeshes = [];                     // { mesh, geom }
  let decor = null, feet = null, cosmeticsVisible = true;

  const resolve = material => (typeof material === 'string' ? kit.get(material) : kit.colored(material.color, material.role));
  function addMesh(parent, geometry, material, userData) {
    const mesh = userData.instances
      ? new THREE.InstancedMesh(geometry, resolve(material), userData.instances.length)
      : new THREE.Mesh(geometry, resolve(material));
    if (userData.instances) { userData.instances.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
    mesh.userData = { ...userData, material };
    mesh.castShadow = shadows; mesh.receiveShadow = shadows;
    parent.add(mesh); meshes.add(mesh);
    return mesh;
  }
  function removeMesh(mesh) {
    mesh.removeFromParent(); meshes.delete(mesh);
    for (const child of [...mesh.children]) if (child.userData.outline) mesh.remove(child);
  }

  // --- body geoms -------------------------------------------------------
  const ROLE_SLOT = { torso: 'body', limb: 'limbs', motor: 'joints', detail: 'details', foot: 'feet' };
  function buildGeomMeshes() {
    for (const { mesh } of geomMeshes) removeMesh(mesh);
    geomMeshes = [];
    for (const geom of info.geoms) {
      const node = nodes.get(geom.bodyId);
      if (!node) continue;
      let geometry, local = true;
      if (geom.role === 'torso') {
        // Bake the torso into the body frame so patterns run continuously
        // across torso, head and shell (all built in this frame).
        let g = geomGeometry(model, geom.id, quality === 'low' ? 20 : 36);
        g.applyMatrix4(new THREE.Matrix4().compose(
          new THREE.Vector3(...model.geom_pos.slice(geom.id * 3, geom.id * 3 + 3)),
          new THREE.Quaternion(model.geom_quat[geom.id * 4 + 1], model.geom_quat[geom.id * 4 + 2], model.geom_quat[geom.id * 4 + 3], model.geom_quat[geom.id * 4]),
          new THREE.Vector3(1, 1, 1)));
        if (geom.type === GEOM.MESH) { const welded = weld(g); g.dispose(); g = renderable(welded, (35 * Math.PI) / 180); welded.dispose(); }
        else if (!g.attributes.normal) g.computeVertexNormals();
        torsoGeometries.push(g); geometry = g; local = false;
      } else if (geom.role === 'foot' && look.limbs.feet !== 'ball') {
        continue;   // foot styles replace the sphere (built in buildFeet)
      } else {
        geometry = limbGeometry(model, geom, look.limbs.style, limbCache, quality);
      }
      const mesh = addMesh(node, geometry, ROLE_SLOT[geom.role] ?? 'limbs', { geomId: geom.id, name: geom.name, role: geom.role, kind: 'geom', slot: ROLE_SLOT[geom.role] });
      if (local) {
        mesh.position.set(...model.geom_pos.slice(geom.id * 3, geom.id * 3 + 3));
        mesh.quaternion.set(model.geom_quat[geom.id * 4 + 1], model.geom_quat[geom.id * 4 + 2], model.geom_quat[geom.id * 4 + 3], model.geom_quat[geom.id * 4]);
      }
      geomMeshes.push({ mesh, geom });
    }
  }

  // --- feet ---------------------------------------------------------------
  function buildFeet() {
    if (feet) { for (const f of feet.items) { for (const m of f.meshes) removeMesh(m); f.node.removeFromParent(); } for (const g of feet.geometries) g.dispose(); }
    feet = { items: [], geometries: [] };
    if (look.limbs.feet === 'ball') return;
    for (const leg of info.legs) {
      if (leg.footGeom < 0) continue;
      const node = new THREE.Group(); node.name = `foot:${leg.name}`; group.add(node);
      const item = { node, leg, meshes: [] };
      for (const part of footParts(look.limbs.feet, leg.footRadius, quality)) {
        const g = part.slot === 'feet' && look.limbs.feet === 'paw' ? smooth(part.solid) : renderable(part.solid, Math.PI / 4);
        part.solid.dispose(); feet.geometries.push(g);
        item.meshes.push(addMesh(node, g, part.slot, { kind: 'foot', slot: part.slot, cosmetic: true }));
      }
      feet.items.push(item);
    }
  }

  // --- decorations (shell, head, face, accessories) ------------------------
  function buildDecor() {
    if (decor) {
      for (const m of decor.meshes) removeMesh(m);
      decor.root.removeFromParent();
      for (const g of decor.geometries) g.dispose();
    }
    const root = new THREE.Group(); root.name = 'decor'; torsoNode.add(root);
    decor = { root, meshes: [], geometries: [], updates: [], face: null, shell: null, head: null, printable: [] };
    const shell = buildShell(look, info, { quality });
    const sampler = makeTopSampler(info, shell);
    const head = buildHead(look, info, sampler, { quality });
    decor.shell = shell; decor.head = head;
    const toMesh = (parent, solid, material, { smoothShade = false, instances = null, name = '' } = {}) => {
      const g = smoothShade ? smooth(solid) : renderable(solid, (38 * Math.PI) / 180);
      decor.geometries.push(g);
      const slot = typeof material === 'string' ? material : `color:${material.role}:${material.color}`;
      decor.meshes.push(addMesh(parent, g, material, { kind: 'decor', name, slot, cosmetic: true, instances }));
    };
    if (shell) for (const part of shell.parts) toMesh(root, part.solid, part.slot, { smoothShade: !!part.smooth, instances: part.matrices ?? null, name: `shell:${part.name}` });
    if (head) for (const part of head.parts) toMesh(root, part.solid, part.slot, { smoothShade: true, name: `head:${part.name}` });
    const face = buildFace(look, info, sampler, head, { quality });
    root.add(face.group);
    for (const spec of face.specs) toMesh(spec.node, spec.solid, spec.slot, { smoothShade: spec.smooth, name: `face:${spec.name}` });
    decor.face = face; decor.updates.push((dt, t) => face.update(dt, t));
    const acc = buildAccessories(look, info, sampler, head, { quality });
    root.add(acc.group);
    for (const spec of acc.specs) toMesh(spec.node, spec.solid, spec.material, { smoothShade: spec.smooth, name: `accessory:${spec.accessory}` });
    decor.updates.push(...acc.updates);
    // Every builder handed us closed solids; keep the source solids out of memory.
    if (shell) for (const part of shell.parts) part.solid.dispose();
    if (head) for (const part of head.parts) part.solid.dispose();
    for (const spec of face.specs) spec.solid.dispose();
    for (const spec of acc.specs) spec.solid.dispose();
    root.visible = cosmeticsVisible;
  }

  function applyMaterials() {
    const old = kit;
    let zMin = box.min.z, zMax = box.max.z;
    if (decor?.shell) zMax = Math.max(zMax, decor.shell.top);
    if (decor?.head) zMax = Math.max(zMax, decor.head.top);
    kit = createMaterialKit(look, { refSize, zRange: [zMin, zMax], shared, quality });
    for (const mesh of meshes) mesh.material = resolve(mesh.userData.material);
    old?.dispose();
    refreshOutlines();
    modes.refresh();
  }

  // Toon ink: inverted hulls sharing each mesh's geometry.
  function refreshOutlines() {
    for (const mesh of meshes) for (const child of [...mesh.children]) if (child.userData.outline) mesh.remove(child);
    if (!kit.outline || modes.mode !== 'normal') return;
    for (const mesh of meshes) {
      if (!OUTLINE_SLOTS.has(mesh.userData.slot?.startsWith('color:') ? 'accent' : mesh.userData.slot)) continue;
      const hull = mesh.isInstancedMesh ? new THREE.InstancedMesh(mesh.geometry, kit.outline, mesh.count) : new THREE.Mesh(mesh.geometry, kit.outline);
      if (mesh.isInstancedMesh) hull.instanceMatrix = mesh.instanceMatrix;
      hull.userData.outline = true; hull.castShadow = false; hull.raycast = () => {};
      mesh.add(hull);
    }
  }

  // --- life ---------------------------------------------------------------
  const motion = { accel: new THREE.Vector3(), speed: 0, yawRate: 0 };
  const prev = { p: new THREE.Vector3(), v: new THREE.Vector3(), yaw: 0, ready: false };
  let time = 0;
  const footQuat = new THREE.Quaternion(), tmpM = new THREE.Matrix4();
  function heading(q) { const f = new THREE.Vector3(1, 0, 0).applyQuaternion(q); return Math.atan2(f.y, f.x); }

  function sync(data) {
    if (!data) return;
    const xp = data.xpos, xm = data.xmat;
    for (const [b, node] of nodes) {
      const p = b * 3, r = b * 9;
      node.position.set(xp[p], xp[p + 1], xp[p + 2]);
      tmpM.set(xm[r], xm[r + 1], xm[r + 2], 0, xm[r + 3], xm[r + 4], xm[r + 5], 0, xm[r + 6], xm[r + 7], xm[r + 8], 0, 0, 0, 0, 1);
      node.quaternion.setFromRotationMatrix(tmpM);
    }
    syncFeet(data.geom_xpos);
    modes.sync();
  }
  function syncFeet(geomXpos = null) {
    if (!feet?.items.length) return;
    const yaw = heading(torsoNode.quaternion), torso = torsoNode.position;
    for (const { node, leg } of feet.items) {
      if (geomXpos) node.position.set(geomXpos[leg.footGeom * 3], geomXpos[leg.footGeom * 3 + 1], geomXpos[leg.footGeom * 3 + 2]);
      else {
        // No data yet: place from the rest pose of the foot's body.
        const fb = nodes.get(leg.footBody);
        if (fb) node.position.set(...model.geom_pos.slice(leg.footGeom * 3, leg.footGeom * 3 + 3)).applyQuaternion(fb.quaternion).add(fb.position);
      }
      // Level foot pointing along the heading (bilateral) or outward (radial).
      const a = info.arrangement === 'radial' ? Math.atan2(node.position.y - torso.y, node.position.x - torso.x) : yaw;
      footQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
      node.quaternion.copy(footQuat);
    }
  }

  function update(dt = 1 / 60) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    time += dt;
    if (dt > 0) {
      const p = torsoNode.position, yaw = heading(torsoNode.quaternion);
      if (!prev.ready || p.distanceTo(prev.p) > 0.4) { prev.p.copy(p); prev.v.set(0, 0, 0); prev.yaw = yaw; prev.ready = true; motion.accel.set(0, 0, 0); }
      const v = p.clone().sub(prev.p).divideScalar(dt);
      const a = v.clone().sub(prev.v).divideScalar(dt).clampLength(0, 40);
      motion.accel.lerp(a.applyQuaternion(torsoNode.quaternion.clone().invert()), 1 - Math.exp(-dt * 18));
      motion.speed = Math.hypot(v.x, v.y);
      let dyaw = yaw - prev.yaw; if (dyaw > Math.PI) dyaw -= 2 * Math.PI; if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      motion.yawRate += (dyaw / dt - motion.yawRate) * (1 - Math.exp(-dt * 10));
      prev.p.copy(p); prev.v.copy(v); prev.yaw = yaw;
    }
    for (const fn of decor?.updates ?? []) fn(dt, time, motion);
    modes.update(dt);
  }

  const modes = createModeController({
    THREE, info, model, group, overlays, nodes, meshes, shared,
    getKit: () => kit, refreshOutlines: () => refreshOutlines(),
    setShadows: on => { for (const m of meshes) m.castShadow = on && shadows; },
  });

  // Meshes need materials at creation; the final kit (with the shell/head
  // height range for gradients) replaces this one in applyMaterials().
  kit = createMaterialKit(look, { refSize, zRange: [box.min.z, box.max.z], shared, quality });
  buildGeomMeshes();
  buildFeet();
  buildDecor();
  applyMaterials();
  syncFeet();
  if (options.data) sync(options.data);

  function setLook(input) {
    const next = normalizeLook(input);
    const before = look;
    look = next;
    const styleChanged = before.limbs.style !== next.limbs.style;
    if (styleChanged) {
      for (const { mesh } of geomMeshes) removeMesh(mesh);
      for (const g of limbCache.values()) g.dispose();
      limbCache.clear();
      for (const g of torsoGeometries.splice(0)) g.dispose();
      buildGeomMeshes();
    } else if (before.limbs.feet !== next.limbs.feet && (before.limbs.feet === 'ball' || next.limbs.feet === 'ball')) {
      for (const { mesh } of geomMeshes) removeMesh(mesh);
      for (const g of torsoGeometries.splice(0)) g.dispose();
      buildGeomMeshes();
    }
    if (before.limbs.feet !== next.limbs.feet) buildFeet();
    if (DECOR_KEY(before) !== DECOR_KEY(next)) buildDecor();
    applyMaterials();
    syncFeet();
    return look;
  }

  function setCosmeticsVisible(visible) {
    cosmeticsVisible = !!visible;
    if (decor) decor.root.visible = cosmeticsVisible;
    for (const f of feet?.items ?? []) f.node.visible = cosmeticsVisible;
  }

  function dispose() {
    modes.dispose();
    group.removeFromParent();
    for (const m of [...meshes]) removeMesh(m);
    if (decor) for (const g of decor.geometries) g.dispose();
    if (feet) for (const g of feet.geometries) g.dispose();
    for (const g of limbCache.values()) g.dispose();
    for (const g of torsoGeometries) g.dispose();
    limbCache.clear(); torsoGeometries.length = 0;
    kit?.dispose(); kit = null; decor = null; feet = null;
    group.clear();
  }

  return {
    group, info,
    get look() { return look; },
    get mode() { return modes.mode; },
    get revealing() { return modes.revealing; },
    sync, update, setLook, dispose, setCosmeticsVisible,
    setMode: mode => { modes.setMode(mode); refreshOutlines(); },
    playPrintReveal: (seconds, hooks) => modes.playPrintReveal(seconds, hooks),
    stopPrintReveal: () => modes.stopPrintReveal(),
    getCallouts: () => modes.getCallouts(),
    /** Decorative solids in the torso frame, for the print kit. */
    printableParts: () => ({ shell: decor?.shell, head: decor?.head, look }),
    stats: () => ({ meshes: meshes.size, geoms: geomMeshes.length, decor: decor?.meshes.length ?? 0, feet: feet?.items.length ?? 0, materials: kit?.all().length ?? 0 }),
  };
}
