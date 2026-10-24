import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { createCreatureView, createStudio, exportPrintKit, LOOK_PRESETS, getLookPreset } from './index.js';
import { multilegXml, standingPose } from './dev-bodies.js';

// Look Lab: the appearance module's dev harness (look-dev.html). It loads real
// Draft bodies from play/public, compiles them with MuJoCo WASM, poses them
// with forward kinematics (no stepping, no controller) and renders them in
// the studio. Query: ?body=cheetah&preset=ladybug&mode=blueprint&cam=hero
// &gallery=cheetah&shot=1&idle=0. window.lookDev drives it for screenshots.

const BODIES = {
  cheetah: { label: 'Cheetah', xml: '/draft/cheetah-31f2a9bfec7b90a8/quadruped.xml', mesh: '/draft/cheetah-31f2a9bfec7b90a8/torso_mesh.stl' },
  bear: { label: 'Bear', xml: '/draft/bear-58f91b599b31ad6b/quadruped.xml', mesh: '/draft/bear-58f91b599b31ad6b/torso_mesh.stl' },
  giraffe: { label: 'Giraffe', xml: '/draft/giraffe-3478a7075579bcab/quadruped.xml', mesh: '/draft/giraffe-3478a7075579bcab/torso_mesh.stl' },
  flower: { label: 'Flower', xml: '/draft/flower-ea73eb32a7a01dab/flower.xml', mesh: '/draft/flower-ea73eb32a7a01dab/torso_mesh.stl' },
  'legacy-cheetah': { label: 'Legacy scene', xml: '/controller/cheetah/scene.xml', mesh: '/controller/cheetah/assets/torso_mesh.stl' },
  tripod: { label: '3 legs', synthetic: { legs: 3, arrangement: 'radial', radius: 0.13 } },
  hexapod: { label: '6 bilateral', synthetic: { legs: 6, arrangement: 'bilateral', radius: 0.12, aspect: 1.8 } },
  octopod: { label: '8 radial', synthetic: { legs: 8, arrangement: 'radial', radius: 0.17 } },
};

const params = new URLSearchParams(location.search);
const state = {
  body: params.get('body') in BODIES ? params.get('body') : 'cheetah',
  preset: params.get('preset') ?? 'ladybug',
  mode: params.get('mode') ?? 'normal',
  idle: params.get('idle') !== '0',
  gallery: params.get('gallery'),
  galleryPresets: params.get('presets')?.split(',') ?? null,
  frozen: false,
  quality: params.get('quality') === 'low' ? 'low' : 'high',
};
if (params.get('shot') === '1') document.body.classList.add('shot');

const stage = document.getElementById('stage'), tags = document.getElementById('tags');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 80);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.03; controls.minDistance = 0.25; controls.maxDistance = 12;
let studio = createStudio({ scene, renderer, radius: state.gallery ? 2.9 : 1.1, quality: state.quality });

let mj = null;
const loaded = new Map();         // body id -> { model, data, vfs, poseInfo }
let creatures = [];               // { view, holder, body, preset }
let clock = performance.now() / 1000, simTime = 0, frames = 0, fps = 0, fpsT = clock;

async function loadBody(id) {
  if (loaded.has(id)) return loaded.get(id);
  const def = BODIES[id];
  let xml, mesh = null;
  if (def.synthetic) xml = multilegXml(def.synthetic);
  else {
    // /draft is proxied to draft-service in the app's vite config; when that
    // service is not running, the dev server still serves /public/... .
    const get = async url => {
      for (const candidate of [url, `/public${url}`]) {
        const r = await fetch(candidate).catch(() => null);
        if (r?.ok && !(r.headers.get('content-type') ?? '').includes('text/html')) return r;
      }
      throw Error(`Could not load ${url}`);
    };
    const [x, m] = await Promise.all([get(def.xml), get(def.mesh)]);
    xml = await x.text(); mesh = new Uint8Array(await m.arrayBuffer());
  }
  const vfs = new mj.MjVFS();
  if (mesh) vfs.addBuffer('torso_mesh.stl', mesh);
  const model = mj.MjModel.from_xml_string(xml, vfs), data = new mj.MjData(model);
  const joints = [], feet = [];
  let rootAdr = -1;
  for (let j = 0; j < model.njnt; j++) {
    const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, j) ?? '';
    if (model.jnt_type[j] === 0 && rootAdr < 0) rootAdr = model.jnt_qposadr[j];
    if (model.jnt_type[j] === 3) joints.push({ name, adr: model.jnt_qposadr[j], lo: model.jnt_range[j * 2], hi: model.jnt_range[j * 2 + 1] });
  }
  for (let g = 0; g < model.ngeom; g++) if (/_sphere$/.test(mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, g) ?? '')) feet.push(g);
  const body = { id, model, data, vfs, joints, feet, rootAdr };
  loaded.set(id, body);
  pose(body, 0);
  return body;
}

// Forward kinematics only: a standing pose plus an optional slow "breath".
function pose(body, crouch) {
  const { model, data, joints, feet, rootAdr } = body;
  mj.mj_resetData(model, data);
  if (rootAdr >= 0) { data.qpos[rootAdr] = 0; data.qpos[rootAdr + 1] = 0; data.qpos[rootAdr + 2] = 0; data.qpos[rootAdr + 3] = 1; data.qpos[rootAdr + 4] = data.qpos[rootAdr + 5] = data.qpos[rootAdr + 6] = 0; }
  for (const j of joints) {
    const n = j.name.replace(/^.*\//, ''), multileg = /^leg\d/.test(n);
    let v = standingPose(j.name);
    if (/_knee$/.test(n)) v += multileg ? 0.2 * crouch : -0.95 * crouch;
    if (/_hip_pitch$/.test(n)) v += multileg ? 0.18 * crouch : 0.475 * crouch;
    data.qpos[j.adr] = j.lo === 0 && j.hi === 0 ? v : Math.min(j.hi, Math.max(j.lo, v));
  }
  mj.mj_forward(model, data);
  if (rootAdr >= 0 && feet.length) {
    const low = Math.min(...feet.map(g => data.geom_xpos[g * 3 + 2] - model.geom_size[g * 3]));
    data.qpos[rootAdr + 2] = -low + 0.0005;
    mj.mj_forward(model, data);
  }
}

function clearCreatures() {
  for (const c of creatures) { c.view.dispose(); c.holder.removeFromParent(); }
  creatures = [];
  tags.innerHTML = '';
}

async function build() {
  clearCreatures();
  const ids = state.gallery ? (state.galleryPresets ?? LOOK_PRESETS.map(p => p.id)) : [state.preset];
  const body = await loadBody(state.gallery && state.gallery in BODIES ? state.gallery : state.body);
  const cols = Math.ceil(Math.sqrt(ids.length)), rows = Math.ceil(ids.length / cols);
  let spacing = 1;
  ids.forEach((id, i) => {
    const holder = new THREE.Group();
    const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; holder.add(root);
    const view = createCreatureView({ THREE, mujoco: mj, model: body.model, data: body.data, look: getLookPreset(id), quality: state.quality });
    root.add(view.group);
    scene.add(holder);
    if (i === 0) { const box = new THREE.Box3().setFromObject(holder); spacing = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 1.22; }
    // Gallery: rows recede from a camera on +x; each creature turns to show
    // a three-quarter view of its face.
    const c = i % cols, r = Math.floor(i / cols);
    if (state.gallery) { holder.rotation.y = 0.6; holder.position.set((r - (rows - 1) / 2) * spacing * 1.3, 0, -(c - (cols - 1) / 2) * spacing * 1.08); }
    creatures.push({ view, holder, body, preset: id });
    if (state.gallery) {
      const preset = LOOK_PRESETS.find(p => p.id === id);
      const tag = document.createElement('div'); tag.className = 'tag';
      tag.innerHTML = `<i style="background:${preset?.iconColor ?? '#999'}"></i>${preset?.label ?? id}`;
      tags.appendChild(tag);
    }
  });
  setMode(state.mode);
  frameCamera(params.get('cam') ?? (state.gallery ? 'gallery' : 'hero'));
  renderPanel();
}

function sceneBox() {
  const box = new THREE.Box3();
  for (const c of creatures) box.expandByObject(c.holder);
  return box;
}

const CAMS = {
  hero: { az: 38, el: 17, dist: 1.0 },
  front: { az: 0, el: 9, dist: 0.95 },
  side: { az: 90, el: 8, dist: 1.0 },
  rear: { az: 155, el: 20, dist: 1.0 },
  top: { az: 30, el: 62, dist: 1.0 },
  face: { az: 24, el: 12, dist: 0.5, focus: 'front' },
  shell: { az: 135, el: 34, dist: 0.62, focus: 'top' },
  gallery: { az: 0, el: 33, dist: 0.86 },
};
function frameCamera(name) {
  const cam = CAMS[name] ?? CAMS.hero, box = sceneBox();
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const target = center.clone();
  if (cam.focus === 'front') { target.x = box.max.x - size.x * 0.12; target.y = box.min.y + size.y * 0.7; }
  if (cam.focus === 'top') { target.y = box.max.y - size.y * 0.25; }
  // Fit the bounding sphere in the narrower field of view.
  const radius = size.length() * 0.5;
  const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * cam.dist * (state.gallery ? 0.74 : 0.92);
  const az = THREE.MathUtils.degToRad(cam.az), el = THREE.MathUtils.degToRad(cam.el);
  camera.position.set(target.x + dist * Math.cos(el) * Math.cos(az), target.y + dist * Math.sin(el), target.z - dist * Math.cos(el) * Math.sin(az) * -1);
  controls.target.copy(target); controls.update();
  studio.frame(box);
}

function setMode(mode) {
  state.mode = mode;
  for (const c of creatures) c.view.setMode(mode);
  studio.setMode(mode);
  document.body.classList.toggle('blueprint', mode === 'blueprint');
  renderPanel();
}

let audio = null;
function tick() {
  // Optional printer "tick" per layer; only after a user gesture created the context.
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = 1900 + Math.random() * 300; o.type = 'square';
  g.gain.setValueAtTime(0.018, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.03);
  o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.035);
}

async function reveal(seconds = 6) {
  setMode('normal');
  try { audio ??= new AudioContext(); } catch { audio = null; }
  studio.setContactShadowStrength(0);
  const runs = creatures.map(c => c.view.playPrintReveal(seconds, {
    onLayer: ({ progress }) => { if (c === creatures[0]) { tick(); studio.setContactShadowStrength(progress); } },
  }));
  await Promise.all(runs);
  studio.setContactShadowStrength(1);
}

/** Start a reveal and jump to a fraction of it, then freeze (screenshots). */
function revealAt(fraction, seconds = 10) {
  state.frozen = false;
  setMode('normal');
  for (const c of creatures) {
    c.view.playPrintReveal(seconds);
    const steps = Math.round((fraction * seconds) / 0.05);
    for (let i = 0; i < steps; i++) c.view.update(0.05);
  }
  studio.setContactShadowStrength(fraction);
  state.frozen = true;
}

async function downloadKit() {
  const c = creatures[0];
  const blob = await exportPrintKit({ mujoco: mj, model: c.body.model, data: c.body.data, look: c.view.look });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `draft-${c.body.id}-${c.view.look.theme.replace(/\W+/g, '-')}-print-kit.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let panel = null;
function renderPanel() {
  if (!panel) { panel = document.createElement('div'); panel.className = 'panel'; document.body.appendChild(panel); }
  const btn = (label, pressed, onClick, cls = '') => { const b = document.createElement('button'); b.textContent = label; if (pressed !== null) b.setAttribute('aria-pressed', String(!!pressed)); if (cls) b.className = cls; b.onclick = onClick; return b; };
  panel.innerHTML = '<h1>Look Lab</h1><p class="sub">Cosmetic looks on real Draft bodies. Physics untouched.</p>';
  const section = title => { const l = document.createElement('div'); l.className = 'label'; l.textContent = title; panel.appendChild(l); const r = document.createElement('div'); r.className = 'row'; panel.appendChild(r); return r; };
  const bodies = section('Body');
  for (const [id, def] of Object.entries(BODIES)) bodies.appendChild(btn(def.label, id === state.body && !state.gallery, () => { state.body = id; state.gallery = null; build(); }));
  const modes = section('Workshop');
  for (const [m, label] of [['normal', 'Studio'], ['blueprint', 'Blueprint'], ['xray', 'X-ray']]) modes.appendChild(btn(label, state.mode === m, () => setMode(m)));
  const actions = section('Make');
  actions.appendChild(btn('Print reveal', null, () => reveal(6), 'primary'));
  actions.appendChild(btn('Print kit (.zip)', null, () => downloadKit()));
  actions.appendChild(btn(state.spinning ? 'Stop turntable' : 'Turntable', null, () => { state.spinning = !state.spinning; studio.setSpin(state.spinning ? 0.35 : 0); renderPanel(); }));
  actions.appendChild(btn(state.gallery ? 'Single' : 'Gallery', null, () => { state.gallery = state.gallery ? null : state.body; rebuildStudio(); build(); }));
  const label = document.createElement('div'); label.className = 'label'; label.textContent = 'Looks'; panel.appendChild(label);
  const grid = document.createElement('div'); grid.className = 'presets'; panel.appendChild(grid);
  for (const p of LOOK_PRESETS) {
    const b = btn('', !state.gallery && p.id === state.preset, () => { state.preset = p.id; if (state.gallery) { state.gallery = null; rebuildStudio(); build(); } else for (const c of creatures) c.view.setLook(getLookPreset(p.id)); renderPanel(); }, 'preset');
    b.innerHTML = `<i class="chip" style="background:linear-gradient(135deg, ${p.swatch[0]} 0 55%, ${p.swatch[1] ?? p.swatch[0]} 55% 100%)"></i><span>${p.label}</span>`;
    b.title = p.blurb;
    grid.appendChild(b);
  }
}

function rebuildStudio() {
  studio.dispose();
  studio = createStudio({ scene, renderer, radius: state.gallery ? 2.9 : 1.1, quality: state.quality });
}

let stats = null;
// Screenshot mode renders on demand: software GL (SwiftShader) needs seconds
// per frame, and a free-running loop would starve the compositor.
const shotMode = params.get('shot') === '1';
function frame() {
  if (state.paused || shotMode) { requestAnimationFrame(frame); return; }
  const now = performance.now() / 1000, dt = Math.min(0.05, now - clock);
  clock = now;
  renderFrame(dt, now);
  requestAnimationFrame(frame);
}

function renderFrame(dt, now = performance.now() / 1000) {
  simTime += dt;
  if (!state.frozen) {
    if (state.idle) {
      const seen = new Set();
      for (const c of creatures) {
        if (!seen.has(c.body)) { seen.add(c.body); pose(c.body, 0.09 * (0.5 + 0.5 * Math.sin(simTime * 1.4))); }
        c.view.sync(c.body.data);
      }
    }
    for (const c of creatures) c.view.update(dt);
  }
  studio.update(dt);
  controls.update();
  renderer.render(scene, camera);
  if (state.gallery) {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    creatures.forEach((c, i) => {
      const tag = tags.children[i]; if (!tag) return;
      // Under the creature: centre of its screen footprint, below its lowest point.
      const box = new THREE.Box3().setFromObject(c.holder);
      let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).project(camera);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        if (y === box.min.y) maxY = Math.max(maxY, -p.y);
      }
      tag.style.left = `${(((minX + maxX) / 2) * 0.5 + 0.5) * w}px`; tag.style.top = `${(maxY * 0.5 + 0.5) * h - 4}px`;
    });
  }
  frames++;
  if (now - fpsT > 0.5) {
    fps = frames / (now - fpsT); frames = 0; fpsT = now;
    if (!stats) { stats = document.createElement('div'); stats.className = 'stats'; document.body.appendChild(stats); }
    const s = creatures[0]?.view.stats();
    stats.textContent = `${fps.toFixed(0)} fps · ${creatures.length} view${creatures.length === 1 ? '' : 's'} · ${s ? `${s.meshes} meshes, ${s.materials} materials` : ''} · ${renderer.info.render.calls} draws`;
  }
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage); resize();

const ready = (async () => {
  mj = await loadMujoco({ locateFile: p => (p.endsWith('.wasm') ? wasmUrl : p) });
  await build();
  requestAnimationFrame(frame);
  // Let shaders compile and a few frames settle before screenshots.
  await new Promise(r => setTimeout(r, 300));
  return true;
})();

window.lookDev = {
  ready,
  setBody: async id => { state.body = id; state.gallery = null; await build(); },
  setPreset: id => { state.preset = id; for (const c of creatures) c.view.setLook(getLookPreset(id)); renderPanel(); },
  setLook: look => { for (const c of creatures) c.view.setLook(look); },
  setMode, reveal, revealAt, camera: frameCamera, downloadKit,
  gallery: async (bodyId, presets = null) => { state.gallery = bodyId; state.galleryPresets = presets; rebuildStudio(); await build(); },
  freeze: on => { state.frozen = !!on; },
  setIdle: on => { state.idle = !!on; },
  orbit: (az, el, dist = 1) => { CAMS.custom = { az, el, dist }; frameCamera('custom'); },
  callouts: () => creatures[0]?.view.getCallouts().map(c => ({ ...c, anchor: c.anchor.toArray(), tip: c.tip.toArray() })),
  stats: () => ({ fps, views: creatures.length, ...creatures[0]?.view.stats(), draws: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
  views: () => creatures.map(c => c.view),
  bench: (n = 3) => {
    const t = [];
    const gl = renderer.getContext(), px = new Uint8Array(4);
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      studio.update(0.016); renderer.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // forces the GPU to finish
      t.push(Math.round(performance.now() - t0));
    }
    return { ms: t, programs: renderer.info.programs.length, calls: renderer.info.render.calls };
  },
  pause: on => { state.paused = !!on; },
  /** Advance creature life by `seconds` (in small steps) without rendering. */
  advance: (seconds = 0.5, step = 1 / 30) => { for (let t = 0; t < seconds; t += step) { if (!state.frozen) for (const c of creatures) c.view.update(step); } },
  /** Render one frame synchronously (shot mode). Returns the time it took. */
  renderOnce: (dt = 1 / 30) => {
    const t0 = performance.now();
    renderFrame(dt);
    const gl = renderer.getContext(), px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Math.round(performance.now() - t0);
  },
};
