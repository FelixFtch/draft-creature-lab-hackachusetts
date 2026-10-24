// Fake 3D stage for the UI harness only. The real stage comes from the
// workshop engine (draft-lab.js + appearance) and the playground engine
// (world/). This draws a toy creature from the mock design so screenshots
// show panels over something believable. Renders ~24 fps, or one frame
// when `still` is set (screenshots on a shared CPU).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { normalizeShape, lookForGlyph } from "./CreatureGlyph.jsx";

function gradientTexture(stops, height = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, height);
  stops.forEach(([at, color]) => g.addColorStop(at, color));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function gridTexture({ bg, line, major, cells = 16, size = 512 }) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i <= cells; i += 1) {
    const p = (i / cells) * size;
    ctx.strokeStyle = i % 4 === 0 ? major : line;
    ctx.lineWidth = i % 4 === 0 ? 2.2 : 1;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...opts });

function limb(a, b, radius, material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.001, len - radius * 2), 4, 10);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.castShadow = true;
  return mesh;
}

function ball(at, radius, material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 14), material);
  mesh.position.copy(at);
  mesh.castShadow = true;
  return mesh;
}

/** Toy creature from design + look, standing on y = 0, facing +x. */
export function buildCreature(design, look) {
  const parsed = normalizeShape(design);
  // Harness only: the fake stage has no wheel-leg / humanoid model yet.
  const shape = parsed.plan === "wheeled" || parsed.plan === "humanoid" ? normalizeShape("cheetah") : parsed;
  const lk = lookForGlyph(look);
  const p = lk.palette;
  const gloss = lk.finish === "gloss" ? 0.25 : lk.finish === "metal" ? 0.3 : 0.55;
  const m = {
    body: mat(p.body, { roughness: gloss, metalness: lk.finish === "metal" ? 0.6 : 0.05 }),
    limbs: mat(p.limbs, { roughness: 0.6 }),
    joints: mat(p.joints, { roughness: 0.45 }),
    feet: mat(p.feet, { roughness: 0.7 }),
    accent: mat(p.accent, { roughness: 0.4 }),
    eye: mat("#fffcf5", { roughness: 0.2 }),
    pupil: mat("#1c2440", { roughness: 0.3 }),
  };
  const group = new THREE.Group();
  if (shape.plan === "multileg") {
    const R = shape.bodyRadius;
    const asp = shape.arrangement === "bilateral" ? shape.bodyAspect : 1;
    const height = 0.17;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.05, 0.07, 36), m.body);
    hub.scale.set(asp, 1, 1);
    hub.position.y = height;
    hub.castShadow = true;
    group.add(hub);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 0.8, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), lk.shell ? mat(lk.shell.color, { roughness: 0.35 }) : m.accent);
    cap.scale.set(asp, 0.55, 1);
    cap.position.y = height + 0.03;
    cap.castShadow = true;
    group.add(cap);
    const n = shape.legCount;
    for (let i = 0; i < n; i += 1) {
      const th = Math.PI / n + (i * 2 * Math.PI) / n;
      const dir = new THREE.Vector3(Math.cos(th), 0, -Math.sin(th));
      const base = new THREE.Vector3(dir.x * R * asp, height, dir.z * R);
      const hip = base.clone().addScaledVector(dir, shape.coxa);
      const knee = hip.clone().addScaledVector(dir, shape.upperLeg * 0.8).add(new THREE.Vector3(0, 0.07, 0));
      const foot = knee.clone().addScaledVector(dir, shape.lowerLeg * 0.45);
      foot.y = 0.02;
      group.add(limb(base, hip, 0.016, m.limbs), limb(hip, knee, 0.016, m.limbs), limb(knee, foot, 0.014, m.limbs));
      group.add(ball(hip, 0.024, m.joints), ball(knee, 0.024, m.joints), ball(foot, 0.022, m.feet));
    }
    const eyeY = height + 0.06;
    [-0.035, 0.035].forEach(z => {
      group.add(ball(new THREE.Vector3(R * asp * 0.72, eyeY, z), 0.022, m.eye));
      group.add(ball(new THREE.Vector3(R * asp * 0.72 + 0.016, eyeY, z), 0.011, m.pupil));
    });
    return group;
  }
  const { torsoLength: L, torsoHeight: H, upperLeg: U, lowerLeg: W } = shape;
  const width = Math.min(0.32, Math.max(0.16, L * 0.55));
  const reach = (U + W) * 0.86;
  const a = Math.acos(Math.min(1, Math.max(-1, (U * U + reach * reach - W * W) / (2 * U * reach))));
  const hipY = reach + 0.02;
  const torso = new THREE.Mesh(new RoundedBoxGeometry(L, H, width, 4, Math.min(H, width) * 0.42), m.body);
  torso.position.y = hipY + H * 0.24;
  torso.castShadow = true;
  group.add(torso);
  if (lk.shell) {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat(lk.shell.color, { roughness: 0.3 }));
    shell.scale.set(L * 0.92, H * 1.1, width * 1.04);
    shell.position.y = torso.position.y + H * 0.35;
    shell.castShadow = true;
    group.add(shell);
  }
  for (const sx of [L / 2 - L * 0.15, -L / 2 + L * 0.15]) {
    for (const sz of [width / 2 + 0.01, -width / 2 - 0.01]) {
      const hip = new THREE.Vector3(sx, hipY, sz);
      const knee = new THREE.Vector3(sx - U * Math.sin(a), hipY - U * Math.cos(a), sz);
      const foot = new THREE.Vector3(sx, 0.025, sz);
      group.add(limb(hip, knee, 0.022, m.limbs), limb(knee, foot, 0.019, m.limbs));
      group.add(ball(hip, 0.04, m.joints), ball(knee, 0.032, m.joints), ball(foot, 0.028, m.feet));
    }
  }
  const eyeY = torso.position.y + H * 0.12;
  [-width * 0.22, width * 0.22].forEach(z => {
    group.add(ball(new THREE.Vector3(L / 2 + 0.005, eyeY, z), 0.03, m.eye));
    group.add(ball(new THREE.Vector3(L / 2 + 0.025, eyeY, z), 0.015, m.pupil));
  });
  if (lk.accessories.some(acc => acc.kind === "antennae")) {
    [-0.04, 0.04].forEach(z => {
      const base = new THREE.Vector3(L / 2 - 0.04, torso.position.y + H / 2, z);
      const tip = base.clone().add(new THREE.Vector3(0.06, 0.12, z * 0.8));
      group.add(limb(base, tip, 0.006, m.pupil), ball(tip, 0.018, mat(lk.accessories[0].color)));
    });
  }
  return group;
}

function workshopScene(scene) {
  scene.background = gradientTexture([[0, "#f3ead6"], [0.55, "#efe3c9"], [1, "#dccaa6"]]);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 48), mat("#e6d7b6", { roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const bedTex = gridTexture({ bg: "#1e4e95", line: "rgba(220,232,251,0.22)", major: "rgba(220,232,251,0.5)", cells: 16 });
  const side = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.08, 0.07, 72, 1, true), mat("#ffc63a", { roughness: 0.5 }));
  side.position.y = -0.035;
  scene.add(side);
  // Planar UVs on a disc keep the grid straight (cylinder caps don't).
  const top = new THREE.Mesh(new THREE.CircleGeometry(1.05, 72), mat("#ffffff", { map: bedTex, roughness: 0.85 }));
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.001;
  top.receiveShadow = true;
  scene.add(top);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.055, 0.016, 8, 96), mat("#1c2440"));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.002;
  scene.add(ring);
}

function playgroundScene(scene) {
  scene.background = gradientTexture([[0, "#8fd0f5"], [0.6, "#cfeefc"], [1, "#f4ecda"]]);
  scene.fog = new THREE.Fog("#e7f3f4", 9, 26);
  const groundTex = gridTexture({ bg: "#a7da84", line: "rgba(255,255,255,0.18)", major: "rgba(255,255,255,0.35)", cells: 8 });
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(14, 14);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat("#ffffff", { map: groundTex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const add = (geo, material, x, y, z, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(0, ry, rz);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(2.2, 0.12, 1.2), mat("#ffc63a"), 3.2, 0.35, -2.2, 0.3, 0.3);
  add(new THREE.BoxGeometry(1.6, 0.12, 1), mat("#49b6f0"), -3.4, 0.25, -3.6, -0.6, -0.25);
  for (let i = 0; i < 5; i += 1) add(new RoundedBoxGeometry(0.5, 0.5, 0.5, 2, 0.06), mat("#c9a36a", { roughness: 0.9 }), -2.6 + (i % 2) * 0.55, 0.25 + (i > 2 ? 0.5 : 0), 1.8 + (i % 3) * 0.1, 0.2 * i);
  add(new THREE.SphereGeometry(0.32, 28, 18), mat("#ec4d37", { roughness: 0.35 }), 1.6, 0.32, 1.1);
  const goalMat = mat("#fffcf5");
  [[-0.9, 0], [0.9, 0]].forEach(([dz]) => add(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 10), goalMat, 4.6, 0.55, 1.4 + dz));
  add(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 10), goalMat, 4.6, 1.1, 1.4, 0, Math.PI / 2).rotation.set(Math.PI / 2, 0, 0);
  const hoop = add(new THREE.TorusGeometry(0.6, 0.06, 12, 40), mat("#ff6f95"), -1.2, 1.2, -4.2, 0.4);
  hoop.rotation.y = 0.4;
  for (let i = 0; i < 7; i += 1) add(new THREE.BoxGeometry(0.06, 0.42, 0.22), mat(i % 2 ? "#7b5cf5" : "#fffcf5"), 0.6 + i * 0.32, 0.21, -1.6 - i * 0.12, 0.3);
  add(new THREE.CylinderGeometry(0.5, 0.55, 0.08, 32), mat("#1e4e95"), -1.8, 0.04, 0.4);
  const spark = new THREE.OctahedronGeometry(0.12);
  const sparkMat = mat("#ffd23f", { emissive: "#ffb000", emissiveIntensity: 0.55, roughness: 0.3 });
  [[0.8, 0.5, -0.6], [1.6, 0.6, -0.2], [-0.7, 0.55, 1.2], [2.6, 0.9, -1.2], [-2.2, 0.5, -1.4], [0.2, 0.5, 2.4]].forEach(([x, y, z]) => add(spark, sparkMat, x, y, z, 0.6));
}

export function createFakeStage(container, { kind = "workshop", design, look, still = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80);
  const hemi = new THREE.HemisphereLight("#fff8e8", "#b9a27a", 1.25);
  const key = new THREE.DirectionalLight("#ffffff", 2.1);
  key.position.set(2.5, 4.5, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = key.shadow.camera.bottom = -4;
  key.shadow.camera.right = key.shadow.camera.top = 4;
  key.shadow.bias = -0.0005;
  scene.add(hemi, key);

  let creature = null;
  let stopped = false;
  let timer = 0;

  function setCreature(nextDesign, nextLook) {
    if (creature) {
      scene.remove(creature);
      creature.traverse(o => {
        o.geometry?.dispose?.();
      });
    }
    creature = buildCreature(nextDesign, nextLook);
    scene.add(creature);
    if (kind === "playground") {
      creature.position.set(0.1, 0, 0.3);
      creature.rotation.y = 0.5;
    } else {
      creature.rotation.y = -0.6;
    }
    render();
  }

  function frame() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Center the creature between the side panels on wide screens.
    if (kind === "playground") {
      camera.fov = 46;
      camera.position.set(-2.6, 2.5, 3.9);
      camera.lookAt(0.5, 0.15, -0.6);
    } else if (w < 900) {
      // Phone: the bottom sheet covers the lower half, so frame high.
      camera.fov = 44;
      camera.position.set(2.1, 1.75, 2.5);
      camera.lookAt(0, -0.32, 0);
    } else {
      camera.fov = 30;
      camera.position.set(2.9, 1.5, 2.9);
      camera.lookAt(0, 0.2, 0);
    }
    camera.updateProjectionMatrix();
  }

  function render() {
    frame();
    renderer.render(scene, camera);
  }

  function setKind(next) {
    kind = next;
    while (scene.children.length > 2) scene.remove(scene.children[2]);
    scene.fog = null;
    if (kind === "playground") playgroundScene(scene);
    else workshopScene(scene);
    setCreature(design, look);
  }

  setKind(kind);
  const onResize = () => render();
  window.addEventListener("resize", onResize);
  if (!still) {
    const tick = () => {
      if (stopped) return;
      if (creature && kind === "workshop") creature.rotation.y += 0.004;
      render();
      timer = window.setTimeout(() => requestAnimationFrame(tick), 40);
    };
    tick();
  }
  return {
    setKind,
    setCreature: (d, l) => {
      design = d;
      look = l;
      setCreature(d, l);
    },
    dispose() {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
