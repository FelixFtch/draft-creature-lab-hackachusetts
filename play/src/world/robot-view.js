import * as THREE from 'three';

// Creature rendering for the playground goes through the appearance module's
// createCreatureView (contracts/appearance-api.md). Until the look agent's
// play/src/appearance/index.js exists, this file provides a stand-in with the
// same signature, built from the workshop's geometryFor(). Vite resolves the
// glob at build time ({} while the module is absent), so the swap needs no
// code change; to make it static later, import createCreatureView directly.
const appearance = import.meta.glob('../appearance/index.js');

export async function loadCreatureViewFactory() {
  const load = appearance['../appearance/index.js'];
  if (load) {
    try {
      const mod = await load();
      if (typeof mod.createCreatureView === 'function') return { create: mod.createCreatureView, source: 'appearance' };
    } catch (error) { console.warn('Appearance module failed to load; using the stand-in view', error); }
  }
  return { create: createFallbackCreatureView, source: 'fallback' };
}

// Copy of draft-lab.js geometryFor (sphere/capsule/ellipsoid/cylinder/box/mesh).
function geometryFor(model, id) {
  const t = model.geom_type[id], s = model.geom_size.slice(id * 3, id * 3 + 3);
  if (t === 2) return new THREE.SphereGeometry(s[0], 20, 14);
  if (t === 3) return new THREE.CapsuleGeometry(s[0], s[1] * 2, 6, 14).rotateX(Math.PI / 2);
  if (t === 4) return new THREE.SphereGeometry(1, 20, 14).scale(...s);
  if (t === 5) return new THREE.CylinderGeometry(s[0], s[0], s[1] * 2, 24).rotateX(Math.PI / 2);
  if (t === 6) return new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2);
  if (t === 7) {
    const mesh = model.geom_dataid[id], va = model.mesh_vertadr[mesh] * 3, fa = model.mesh_faceadr[mesh] * 3;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(model.mesh_vert.slice(va, va + model.mesh_vertnum[mesh] * 3), 3));
    geometry.setIndex(Array.from(model.mesh_face.slice(fa, fa + model.mesh_facenum[mesh] * 3)));
    geometry.computeVertexNormals(); return geometry;
  }
  return null;
}

// Classic look (the legacy single-colour rule), or the palette of a
// creature-look/1 object. Unknown fields are ignored here on purpose.
function colorFor(name, look) {
  const palette = typeof look === 'object' && look ? look.palette ?? {} : {};
  const base = new THREE.Color(typeof look === 'string' && /^#[0-9a-f]{6}$/i.test(look) ? look : palette.body ?? '#4fb6a8');
  if (name.endsWith('_sphere')) return new THREE.Color(palette.feet ?? '#394944');
  if (name.endsWith('_motor')) return palette.joints ? new THREE.Color(palette.joints) : base.clone().multiplyScalar(.52);
  if (name.endsWith('_detail')) return palette.accent ? new THREE.Color(palette.accent) : base.clone().multiplyScalar(.33);
  if (name.endsWith('_link')) return palette.limbs ? new THREE.Color(palette.limbs) : base.clone().lerp(new THREE.Color('#ffffff'), .2);
  return base;
}

export function createFallbackCreatureView({ THREE: T = THREE, mujoco, model, look = '#4fb6a8', rootBody }) {
  const group = new T.Group(); group.name = 'creature-view';
  const rootId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, rootBody);
  if (rootId < 0) throw Error(`Creature root body ${rootBody} not found`);
  const meshes = [], matrix = new T.Matrix4();
  let current = look;
  for (let g = 0; g < model.ngeom; g++) {
    // Only the creature: world geoms and props are rendered by the world view.
    if (model.body_rootid[model.geom_bodyid[g]] !== rootId) continue;
    const geometry = geometryFor(model, g);
    if (!geometry) continue;
    const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM.value, g) ?? '';
    const material = new T.MeshStandardMaterial({ color: colorFor(name, look), roughness: .42, metalness: .08 });
    const mesh = new T.Mesh(geometry, material);
    mesh.userData = { geomId: g, name }; mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh); meshes.push(mesh);
  }
  // A friendly face on the torso so the stand-in reads as a character. Built
  // in the root BODY frame (+x forward): MuJoCo re-orients mesh geoms to
  // their inertia axes, so the geom frame is not a reliable "front".
  const face = new T.Group(); group.add(face);
  const torso = meshes.find(m => model.geom_bodyid[m.userData.geomId] === rootId && model.geom_type[m.userData.geomId] === 7) ?? meshes.find(m => model.geom_bodyid[m.userData.geomId] === rootId);
  if (torso) {
    const g = torso.userData.geomId, gp = model.geom_pos.slice(g * 3, g * 3 + 3), gq = model.geom_quat.slice(g * 4, g * 4 + 4);
    const toBody = new T.Matrix4().compose(new T.Vector3(...gp), new T.Quaternion(gq[1], gq[2], gq[3], gq[0]), new T.Vector3(1, 1, 1));
    const box = new T.Box3().setFromBufferAttribute(torso.geometry.attributes.position).applyMatrix4(toBody), size = box.getSize(new T.Vector3());
    const eyeR = Math.max(.012, Math.min(size.x, size.y) * .085);
    const white = new T.MeshStandardMaterial({ color: '#fffdf6', roughness: .3 }), dark = new T.MeshStandardMaterial({ color: '#1d2421', roughness: .25 });
    for (const side of [-1, 1]) {
      // On the front surface: works for round (Flower) and boxy (Cheetah) shells.
      const eye = new T.Mesh(new T.SphereGeometry(eyeR, 16, 12), white), y = side * Math.max(eyeR * 1.3, size.y * .16), R = box.max.x;
      eye.position.set(Math.sqrt(Math.max(0, R * R - y * y)) + eyeR * .3, y, box.max.z * .55 + box.min.z * .45);
      const pupil = new T.Mesh(new T.SphereGeometry(eyeR * .55, 12, 10), dark);
      pupil.position.set(eyeR * .62, 0, eyeR * .08); eye.add(pupil); face.add(eye);
    }
  }
  const hasFace = !!torso;
  return {
    group, source: 'fallback',
    sync(data) {
      const p = data.geom_xpos, a = data.geom_xmat;
      for (const mesh of meshes) {
        const i = mesh.userData.geomId, r = i * 9;
        mesh.position.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        matrix.set(a[r], a[r + 1], a[r + 2], 0, a[r + 3], a[r + 4], a[r + 5], 0, a[r + 6], a[r + 7], a[r + 8], 0, 0, 0, 0, 1);
        mesh.quaternion.setFromRotationMatrix(matrix);
      }
      if (hasFace) {
        const bp = data.xpos, bm = data.xmat, i = rootId, r = i * 9;
        face.position.set(bp[i * 3], bp[i * 3 + 1], bp[i * 3 + 2]);
        matrix.set(bm[r], bm[r + 1], bm[r + 2], 0, bm[r + 3], bm[r + 4], bm[r + 5], 0, bm[r + 6], bm[r + 7], bm[r + 8], 0, 0, 0, 0, 1);
        face.quaternion.setFromRotationMatrix(matrix);
      }
    },
    setLook(next) { current = next; for (const mesh of meshes) mesh.material.color.copy(colorFor(mesh.userData.name, current)); },
    setMode() {}, update() {}, playPrintReveal() {},
    dispose() {
      group.traverse(o => { o.geometry?.dispose(); if (o.material) o.material.dispose(); });
      group.removeFromParent();
    },
  };
}
