import * as THREE from 'three';
import { createOutlineMaterial } from './shader.js';

// Workshop modes for a creature view:
//  - blueprint: technical drawing. Flat blue fill shaded by facing ratio,
//    white crease edges and silhouettes, colour-coded joint axes, motor
//    callout leaders (positions exposed for UI labels; canvas sprites when a
//    DOM exists) and torso dimension lines in millimetres.
//  - xray: fresnel ghost for shells and body, motors lit up, joint axes.
//  - print reveal (normal mode): a rising cut in world height, the fresh
//    layer glowing, gyroid infill on inside faces, a hot-end tracing the
//    layer, and a per-layer hook the UI can use for a tick sound.

export const AXIS_COLORS = { roll: '#ff9b73', pitch: '#ffd36b', yaw: '#7fdcff', knee: '#b7f48c', hinge: '#ffffff' };
const BLUEPRINT = { paper: '#1d4f8f', fillDark: '#2a62a8', fillLight: '#5b97da', line: '#eef6ff' };

function fillMaterial(dark, light, opacity = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { uDark: { value: new THREE.Color(dark) }, uLight: { value: new THREE.Color(light) }, uOpacity: { value: opacity } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 p = vec4( position, 1.0 ); vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p; n = mat3( instanceMatrix ) * n;
        #endif
        vec4 mv = modelViewMatrix * p;
        vN = normalize( normalMatrix * n ); vV = - mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uDark; uniform vec3 uLight; uniform float uOpacity;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float ndv = abs( dot( normalize( vN ), normalize( vV ) ) );
        gl_FragColor = vec4( mix( uDark, uLight, pow( ndv, 0.7 ) ), uOpacity );
        #include <colorspace_fragment>
      }`,
    transparent: opacity < 1,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

function ghostMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 p = vec4( position, 1.0 ); vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p; n = mat3( instanceMatrix ) * n;
        #endif
        vec4 mv = modelViewMatrix * p;
        vN = normalize( normalMatrix * n ); vV = - mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
      void main() {
        float rim = 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) );
        gl_FragColor = vec4( uColor * ( 0.06 + 1.1 * pow( rim, 2.2 ) ), 1.0 );
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

function textSprite(text, { color = '#eef6ff', background = 'rgba(16,52,102,0.82)', scale = 0.05 } = {}) {
  if (typeof document === 'undefined') return null;   // headless: the UI labels from getCallouts()
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  const font = '600 40px "Inter", "Helvetica Neue", Arial, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36, h = 60;
  canvas.width = w; canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = background; ctx.strokeStyle = color; ctx.lineWidth = 3;
  const r = 14;
  ctx.beginPath(); ctx.moveTo(r, 2); ctx.arcTo(w - 2, 2, w - 2, h - 2, r); ctx.arcTo(w - 2, h - 2, 2, h - 2, r); ctx.arcTo(2, h - 2, 2, 2, r); ctx.arcTo(2, 2, w - 2, 2, r); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 18, h / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false, transparent: true }));
  sprite.scale.set(scale * (w / h), scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function createModeController(ctx) {
  const { info, model, group, overlays, nodes, meshes, shared, getKit, setShadows } = ctx;
  let mode = 'normal';
  let bp = null, xr = null, reveal = null;
  const refSize = 2 * Math.max(info.torso.half.x, info.torso.half.y);
  const disposables = new Set();
  const own = x => { disposables.add(x); return x; };

  const category = mesh => {
    const slot = mesh.userData.slot ?? '';
    if (slot === 'joints' || slot === 'details') return 'mech';
    if (slot === 'limbs') return 'limb';
    if (slot === 'feet' || slot === 'ink') return 'feet';
    if (slot.startsWith('eye')) return 'eye';
    return 'shell';
  };

  // --- joint axes (blueprint + xray) --------------------------------------
  function buildAxes() {
    const items = [];
    const len = refSize * 0.16;
    for (const joint of info.joints) {
      const node = nodes.get(joint.bodyId);
      if (!node) continue;
      const g = new THREE.Group(); g.name = `axis:${joint.logical}`; g.visible = false;
      const color = AXIS_COLORS[joint.role] ?? AXIS_COLORS.hinge;
      const lineGeo = own(new THREE.BufferGeometry().setFromPoints([joint.axis.clone().multiplyScalar(-len / 2).add(joint.pos), joint.axis.clone().multiplyScalar(len / 2).add(joint.pos)]));
      const lineMat = own(new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false }));
      const line = new THREE.Line(lineGeo, lineMat); line.renderOrder = 6; g.add(line);
      // Rotation ring: 300 degrees of arc plus an arrow head, around the axis.
      const ringR = len * 0.22, pts = [];
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), joint.axis);
      for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 1.65; pts.push(new THREE.Vector3(Math.cos(a) * ringR, Math.sin(a) * ringR, 0).applyQuaternion(q).add(joint.pos)); }
      const end = Math.PI * 1.65, tip = new THREE.Vector3(Math.cos(end) * ringR, Math.sin(end) * ringR, 0);
      const back = new THREE.Vector3(Math.cos(end - 0.35) * ringR * 0.75, Math.sin(end - 0.35) * ringR * 0.75, 0);
      const back2 = new THREE.Vector3(Math.cos(end - 0.35) * ringR * 1.25, Math.sin(end - 0.35) * ringR * 1.25, 0);
      pts.push(back.applyQuaternion(q).add(joint.pos), tip.applyQuaternion(q).add(joint.pos), back2.applyQuaternion(q).add(joint.pos));
      const ring = new THREE.Line(own(new THREE.BufferGeometry().setFromPoints(pts)), lineMat); ring.renderOrder = 6; g.add(ring);
      node.add(g);
      items.push(g);
    }
    return items;
  }

  // --- callouts ---------------------------------------------------------
  const calloutJoints = info.joints.filter(j => j.motorGeom >= 0);
  const callout = joint => {
    const node = nodes.get(model.geom_bodyid[joint.motorGeom]);
    const anchor = new THREE.Vector3(...model.geom_pos.slice(joint.motorGeom * 3, joint.motorGeom * 3 + 3)).applyQuaternion(node.quaternion).add(node.position);
    const torso = nodes.get(info.root);
    const out = anchor.clone().sub(torso.position); out.z = 0;
    if (out.lengthSq() < 1e-8) out.set(1, 0, 0);
    out.normalize();
    const tip = anchor.clone().addScaledVector(out, refSize * 0.22).add(new THREE.Vector3(0, 0, refSize * 0.16 + (joint.role === 'knee' ? -refSize * 0.05 : 0)));
    return { anchor, tip };
  };
  const effortOf = joint => {
    const hi = model.jnt_actfrcrange ? Math.abs(model.jnt_actfrcrange[joint.id * 2 + 1]) : 0;
    return Number.isFinite(hi) && hi > 0 ? hi : null;
  };
  const labelOf = joint => {
    const leg = info.legs.find(l => l.joints.includes(joint.id));
    const role = { roll: 'hip roll', pitch: 'hip pitch', yaw: 'hip yaw', knee: 'knee', hinge: 'joint' }[joint.role];
    const effort = effortOf(joint);
    return `${(leg?.name ?? '').toUpperCase()} ${role}${effort ? ` · ${Math.round(effort)} N·m` : ''}`.trim();
  };

  function buildBlueprint() {
    const materials = {
      shell: own(fillMaterial(BLUEPRINT.fillDark, BLUEPRINT.fillLight)),
      mech: own(fillMaterial('#21528f', '#86b8ef')),
      limb: own(fillMaterial('#245a9c', '#6ea6e4')),
      feet: own(fillMaterial('#1b4680', '#4d86c8')),
      eye: own(fillMaterial('#2a62a8', '#9cc8f6')),
    };
    const edgeMat = own(new THREE.LineBasicMaterial({ color: BLUEPRINT.line, transparent: true, opacity: 0.85, toneMapped: false }));
    const hullMat = own(createOutlineMaterial(BLUEPRINT.line, Math.max(0.0016, refSize * 0.004)));
    const edgeCache = new Map();
    // Callout leaders: one dynamic LineSegments in the MuJoCo frame.
    const leaderGeo = own(new THREE.BufferGeometry());
    leaderGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(calloutJoints.length * 6 + 6), 3));
    const leaders = new THREE.LineSegments(leaderGeo, own(new THREE.LineDashedMaterial({ color: BLUEPRINT.line, dashSize: refSize * 0.02, gapSize: refSize * 0.012, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false })));
    leaders.renderOrder = 7; leaders.frustumCulled = false; leaders.visible = false; overlays.add(leaders);
    const dotGeo = own(new THREE.SphereGeometry(refSize * 0.009, 10, 8)), dotMat = own(new THREE.MeshBasicMaterial({ color: BLUEPRINT.line, depthTest: false, toneMapped: false }));
    const dots = calloutJoints.map(() => { const m = new THREE.Mesh(dotGeo, dotMat); m.renderOrder = 8; m.visible = false; overlays.add(m); return m; });
    const sprites = calloutJoints.map(j => { const s = textSprite(labelOf(j), { scale: refSize * 0.05 }); if (s) { s.visible = false; overlays.add(s); own(s.material.map); own(s.material); } return s; });
    // Dimension lines in the torso frame (they ride with the body).
    const dims = new THREE.Group(); dims.visible = false; nodes.get(info.root).add(dims);
    const { box, half } = info.torso, pad = refSize * 0.08;
    const dimLines = [];
    const dimension = (a, b, tickDir, text) => {
      const t = tickDir.clone().multiplyScalar(refSize * 0.025);
      dimLines.push(a, b, a.clone().add(t), a.clone().sub(t), b.clone().add(t), b.clone().sub(t));
      const s = textSprite(text, { scale: refSize * 0.045 });
      if (s) { s.position.copy(a).add(b).multiplyScalar(0.5).add(tickDir.clone().multiplyScalar(refSize * 0.05)); dims.add(s); own(s.material.map); own(s.material); }
    };
    const zLow = box.min.z;
    dimension(new THREE.Vector3(box.min.x, box.min.y - pad, zLow), new THREE.Vector3(box.max.x, box.min.y - pad, zLow), new THREE.Vector3(0, -1, 0), `L ${Math.round(half.x * 2000)} mm`);
    dimension(new THREE.Vector3(box.max.x + pad, box.min.y, zLow), new THREE.Vector3(box.max.x + pad, box.max.y, zLow), new THREE.Vector3(1, 0, 0), `W ${Math.round(half.y * 2000)} mm`);
    const dimGeo = own(new THREE.BufferGeometry().setFromPoints(dimLines));
    const dimSeg = new THREE.LineSegments(dimGeo, own(new THREE.LineBasicMaterial({ color: BLUEPRINT.line, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false })));
    dimSeg.renderOrder = 7; dims.add(dimSeg);
    return { materials, edgeMat, hullMat, edgeCache, leaders, dots, sprites, dims };
  }

  function buildXray() {
    return {
      shell: own(ghostMaterial('#76d0ff')),
      eye: own(ghostMaterial('#9fe2ff')),
      mech: own(new THREE.MeshStandardMaterial({ color: '#ff9d45', emissive: '#ff7a1c', emissiveIntensity: 0.65, roughness: 0.35, metalness: 0.3 })),
      limb: own(new THREE.MeshStandardMaterial({ color: '#d7e1ef', roughness: 0.45, metalness: 0.25 })),
      feet: own(new THREE.MeshStandardMaterial({ color: '#39414f', roughness: 0.8 })),
    };
  }

  let axes = null;
  function clearModeChildren() {
    for (const mesh of meshes) for (const child of [...mesh.children]) if (child.userData.modeChild) mesh.remove(child);
  }
  function apply() {
    clearModeChildren();
    const kit = getKit();
    if (!axes && mode !== 'normal') axes = buildAxes();
    for (const a of axes ?? []) a.visible = mode !== 'normal';
    if (bp) { bp.leaders.visible = mode === 'blueprint'; bp.dims.visible = mode === 'blueprint'; for (const d of bp.dots) d.visible = mode === 'blueprint'; for (const s of bp.sprites) if (s) s.visible = mode === 'blueprint'; }
    for (const mesh of meshes) {
      const c = category(mesh);
      if (mode === 'normal') {
        const m = mesh.userData.material;
        mesh.material = typeof m === 'string' ? kit.get(m) : kit.colored(m.color, m.role);
      } else if (mode === 'blueprint') {
        mesh.material = bp.materials[c];
        if (!mesh.isInstancedMesh) {
          let edges = bp.edgeCache.get(mesh.geometry);
          if (!edges) { edges = own(new THREE.EdgesGeometry(mesh.geometry, 28)); bp.edgeCache.set(mesh.geometry, edges); }
          const lines = new THREE.LineSegments(edges, bp.edgeMat); lines.userData.modeChild = true; lines.raycast = () => {}; mesh.add(lines);
        }
        const hull = mesh.isInstancedMesh ? new THREE.InstancedMesh(mesh.geometry, bp.hullMat, mesh.count) : new THREE.Mesh(mesh.geometry, bp.hullMat);
        if (mesh.isInstancedMesh) hull.instanceMatrix = mesh.instanceMatrix;
        hull.userData.modeChild = true; hull.raycast = () => {}; mesh.add(hull);
      } else if (mode === 'xray') {
        mesh.material = xr[c];
      }
    }
    setShadows(mode === 'normal');
    if (bp) {
      // Forget edge geometry of meshes that were rebuilt since.
      const live = new Set([...meshes].map(m => m.geometry));
      for (const [geometry, edges] of bp.edgeCache) if (!live.has(geometry)) { edges.dispose(); disposables.delete(edges); bp.edgeCache.delete(geometry); }
    }
    if (mode === 'blueprint') sync();
  }

  function setMode(next) {
    if (!['normal', 'blueprint', 'xray'].includes(next)) throw Error(`Unknown mode ${next}`);
    if (reveal) stopPrintReveal();
    if (next === 'blueprint' && !bp) bp = buildBlueprint();
    if (next === 'xray' && !xr) xr = buildXray();
    mode = next;
    apply();
  }

  function sync() {
    if (mode !== 'blueprint' || !bp) return;
    const pos = bp.leaders.geometry.attributes.position;
    calloutJoints.forEach((joint, i) => {
      const { anchor, tip } = callout(joint);
      pos.setXYZ(i * 2, anchor.x, anchor.y, anchor.z); pos.setXYZ(i * 2 + 1, tip.x, tip.y, tip.z);
      bp.dots[i].position.copy(anchor);
      if (bp.sprites[i]) bp.sprites[i].position.copy(tip).add(new THREE.Vector3(0, 0, refSize * 0.03));
    });
    pos.needsUpdate = true;
    bp.leaders.computeLineDistances();
  }

  function getCallouts() {
    group.updateWorldMatrix(true, true);
    return calloutJoints.map(joint => {
      const { anchor, tip } = callout(joint);
      return { joint: joint.name, logical: joint.logical, role: joint.role, label: labelOf(joint), effortNm: effortOf(joint),
        color: AXIS_COLORS[joint.role], anchor: group.localToWorld(anchor), tip: group.localToWorld(tip) };
    });
  }

  // --- print reveal --------------------------------------------------------
  let nozzle = null;
  function buildNozzle() {
    const g = new THREE.Group(); g.name = 'print-head'; g.visible = false;
    const s = refSize * 0.09;
    const metal = own(new THREE.MeshStandardMaterial({ color: '#c9ced6', metalness: 0.85, roughness: 0.3 }));
    const block = own(new THREE.MeshStandardMaterial({ color: '#e8eaee', metalness: 0.6, roughness: 0.35 }));
    const hot = own(new THREE.MeshBasicMaterial({ color: '#ffb067', toneMapped: false }));
    const fan = own(new THREE.MeshStandardMaterial({ color: '#2a2f3a', roughness: 0.6 }));
    const add = (geometry, material, y) => { const m = new THREE.Mesh(own(geometry), material); m.position.y = y; g.add(m); return m; };
    add(new THREE.ConeGeometry(s * 0.18, s * 0.3, 18).rotateX(Math.PI), metal, s * 0.15);
    add(new THREE.BoxGeometry(s * 0.7, s * 0.4, s * 0.55), block, s * 0.5);
    add(new THREE.CylinderGeometry(s * 0.07, s * 0.07, s * 0.9, 12), metal, s * 1.1);
    add(new THREE.BoxGeometry(s * 0.9, s * 0.62, s * 0.18), fan, s * 0.62).position.z = s * 0.42;
    add(new THREE.SphereGeometry(s * 0.07, 12, 8), hot, 0.0);
    const glowMat = own(new THREE.PointsMaterial({ color: '#ff9a4a', size: s * 0.12, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false }));
    const trailGeo = own(new THREE.BufferGeometry()); trailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(64 * 3), 3));
    const trail = new THREE.Points(trailGeo, glowMat); trail.frustumCulled = false;
    const holder = new THREE.Group(); holder.add(g); holder.add(trail); overlays.add(holder);
    return { holder, head: g, trail, history: [] };
  }

  function playPrintReveal(seconds = 6, hooks = {}) {
    if (reveal) stopPrintReveal();
    if (mode !== 'normal') setMode('normal');
    if (!nozzle) nozzle = buildNozzle();
    group.updateWorldMatrix(true, true);
    const bbox = new THREE.Box3();
    for (const mesh of meshes) if (mesh.visible) bbox.expandByObject(mesh);
    if (bbox.isEmpty()) return Promise.resolve();
    const height = bbox.max.y - bbox.min.y, kit = getKit();
    for (const m of kit.all()) { if (m.userData.outlineUniforms) continue; m.userData.revealSide = m.side; m.side = THREE.DoubleSide; m.needsUpdate = true; }
    // Ink hulls are not cut by the reveal; hide them while it runs.
    for (const mesh of meshes) for (const child of mesh.children) if (child.userData.outline) child.visible = false;
    setShadows(false);
    const layerHeight = Math.max(0.0015, height / 90);
    shared.uLookReveal.value.set(bbox.min.y, Math.max(0.003, height * 0.02), 1, 0);
    nozzle.head.visible = true; nozzle.trail.visible = true; nozzle.history.length = 0;
    return new Promise(resolve => {
      reveal = { t: 0, duration: Math.max(0.5, seconds), bbox, height, layerHeight, layer: -1, hooks, resolve };
      hooks.onStart?.({ layers: Math.ceil(height / layerHeight), height });
    });
  }

  function stopPrintReveal(complete = false) {
    if (!reveal) return;
    const done = reveal; reveal = null;
    const kit = getKit();
    for (const m of kit.all()) { if (m.userData.revealSide !== undefined) { m.side = m.userData.revealSide; delete m.userData.revealSide; m.needsUpdate = true; } }
    shared.uLookReveal.value.set(1e6, 0.004, 0, 0);
    for (const mesh of meshes) for (const child of mesh.children) if (child.userData.outline) child.visible = true;
    setShadows(true);
    if (nozzle) { nozzle.head.visible = false; nozzle.trail.visible = false; }
    if (complete) done.hooks.onDone?.();
    done.resolve(complete);
  }

  const worldDown = new THREE.Vector3(0, -1, 0);
  function update(dt) {
    if (!reveal) return;
    reveal.t += dt;
    const p = Math.min(1, reveal.t / reveal.duration);
    // Printers lay layers at a steady pace; ease only the very start and end.
    const eased = p < 0.04 ? p * p / 0.08 : p > 0.96 ? 1 - (1 - p) * (1 - p) / 0.08 : p;
    const y = reveal.bbox.min.y + reveal.height * Math.min(1, Math.max(0, eased)) * 1.002;
    shared.uLookReveal.value.x = y; shared.uLookReveal.value.w = reveal.t;
    const layer = Math.floor((y - reveal.bbox.min.y) / reveal.layerHeight);
    if (layer !== reveal.layer) { reveal.layer = layer; reveal.hooks.onLayer?.({ layer, layers: Math.ceil(reveal.height / reveal.layerHeight), progress: p, height: y - reveal.bbox.min.y }); }
    // Hot-end traces a Lissajous path across the current layer.
    const c = reveal.bbox.getCenter(new THREE.Vector3()), size = reveal.bbox.getSize(new THREE.Vector3());
    const w = new THREE.Vector3(c.x + size.x * 0.48 * Math.sin(reveal.t * 7.3), y, c.z + size.z * 0.48 * Math.sin(reveal.t * 5.1 + 0.7));
    overlays.updateWorldMatrix(true, false);
    const local = overlays.worldToLocal(w.clone());
    nozzle.head.position.copy(local);
    const inv = overlays.getWorldQuaternion(new THREE.Quaternion()).invert();
    const down = worldDown.clone().applyQuaternion(inv);
    nozzle.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), down);
    nozzle.history.unshift(local.clone()); nozzle.history.length = Math.min(nozzle.history.length, 64);
    const tp = nozzle.trail.geometry.attributes.position;
    for (let i = 0; i < 64; i++) { const h = nozzle.history[Math.min(i, nozzle.history.length - 1)]; tp.setXYZ(i, h.x, h.y, h.z); }
    tp.needsUpdate = true;
    if (p >= 1) stopPrintReveal(true);
  }

  function refresh() { if (mode !== 'normal') apply(); }

  function dispose() {
    if (reveal) stopPrintReveal();
    clearModeChildren();
    for (const a of axes ?? []) a.removeFromParent();
    if (bp) { bp.leaders.removeFromParent(); for (const d of bp.dots) d.removeFromParent(); for (const s of bp.sprites) s?.removeFromParent(); bp.dims.removeFromParent(); }
    nozzle?.holder.removeFromParent();
    for (const d of disposables) d.dispose?.();
    disposables.clear();
  }

  return {
    get mode() { return mode; }, get revealing() { return !!reveal; },
    setMode, sync, update, refresh, getCallouts, playPrintReveal, stopPrintReveal, dispose,
    resources: () => [...disposables],
  };
}
