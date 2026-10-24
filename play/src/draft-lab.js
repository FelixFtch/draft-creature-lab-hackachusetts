import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getMujoco } from './app/mujoco.js';

// Workshop engine: one creature on the studio turntable. Physics owns every
// rendered robot transform. Pose mode only calls forward kinematics; the
// gravity experiment only calls mj_step with motors off. Policy-driven motion
// lives in the playground engine (src/world), never here.
const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));
const sha256Hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');

// MuJoCo can reset an unstable state to finite values during mj_step. Read
// its warning counters too. The vector belongs to MjData; get() returns an
// owned entry snapshot. Deleting the borrowed vector would abort WASM.
export function readPhysicsWarningCounts(data) {
  if (!data) return [];
  const list = data.warning, counts = [];
  for (let i = 0; i < list.size(); i++) {
    const item = list.get(i);
    try { counts.push(item.number); } finally { item.delete(); }
  }
  return counts;
}

export function stepDraftPhysics(mj, model, data, evidence) {
  const before = data.time, previous = evidence.lastTime ?? before;
  mj.mj_step(model, data);
  evidence.stepCount = (evidence.stepCount ?? 0) + 1;
  evidence.warningCounts = readPhysicsWarningCounts(data);
  const timeReset = before + 1e-12 < previous || data.time <= before;
  evidence.timeResets = (evidence.timeResets ?? 0) + (timeReset ? 1 : 0);
  evidence.lastTime = data.time;
  const warned = evidence.warningCounts.some((count, i) => count > (evidence.warningBaseline?.[i] ?? 0));
  if (timeReset || warned) return 'MuJoCo reported a warning or reset. Reset the experiment';
  if (!Array.from(data.qpos).every(Number.isFinite) || !Array.from(data.qvel).every(Number.isFinite))
    return 'Physics became unstable. Reset the experiment';
  return null;
}

export function geometryFor(model, id) {
  const t = model.geom_type[id], s = model.geom_size.slice(id * 3, id * 3 + 3);
  if (t === 2) return new THREE.SphereGeometry(s[0], 24, 16);
  if (t === 3) return new THREE.CapsuleGeometry(s[0], s[1] * 2, 8, 16).rotateX(Math.PI / 2);
  if (t === 4) return new THREE.SphereGeometry(1, 24, 16).scale(...s);
  if (t === 5) return new THREE.CylinderGeometry(s[0], s[0], s[1] * 2, 32).rotateX(Math.PI / 2);
  if (t === 6) return new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2);
  if (t === 7) {
    const mesh = model.geom_dataid[id], va = model.mesh_vertadr[mesh] * 3, fa = model.mesh_faceadr[mesh] * 3;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(model.mesh_vert.slice(va, va + model.mesh_vertnum[mesh] * 3), 3));
    geometry.setIndex(Array.from(model.mesh_face.slice(fa, fa + model.mesh_facenum[mesh] * 3)));
    geometry.computeVertexNormals(); return geometry;
  }
  throw Error(`Unsupported Draft geometry ${t}`);
}

// Fallback view used until/unless the appearance module is supplied: the
// original lab's look (one body colour, derived motor/detail/foot shades).
function createBasicView({ mujoco: mj, model, look }) {
  const group = new THREE.Group(), meshes = [], matrix = new THREE.Matrix4();
  for (let i = 0; i < model.ngeom; i++) {
    if (model.geom_type[i] === 0) continue;
    const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, i) ?? '';
    const mesh = new THREE.Mesh(geometryFor(model, i), new THREE.MeshStandardMaterial({ roughness: .38, metalness: .12 }));
    mesh.userData = { geomId: i, name }; mesh.castShadow = mesh.receiveShadow = true;
    meshes.push(mesh); group.add(mesh);
  }
  function setLook(next) {
    const base = /^#[0-9a-f]{6}$/i.test(next?.palette?.body || '') ? next.palette.body : '#1f8c80';
    for (const mesh of meshes) {
      const c = new THREE.Color(base), name = mesh.userData.name;
      if (name.endsWith('_sphere')) c.set('#394944');
      else if (name.endsWith('_motor')) c.multiplyScalar(.52);
      else if (name.endsWith('_detail')) c.multiplyScalar(.33);
      else if (name.endsWith('_link')) c.lerp(new THREE.Color('#ffffff'), .20);
      mesh.material.color.copy(c);
    }
  }
  setLook(look);
  return {
    group, setLook,
    sync(data) {
      for (const mesh of meshes) {
        const i = mesh.userData.geomId, p = i * 3, r = i * 9, a = data.geom_xmat;
        mesh.position.set(data.geom_xpos[p], data.geom_xpos[p + 1], data.geom_xpos[p + 2]);
        matrix.set(a[r], a[r + 1], a[r + 2], 0, a[r + 3], a[r + 4], a[r + 5], 0, a[r + 6], a[r + 7], a[r + 8], 0, 0, 0, 0, 1);
        mesh.quaternion.setFromRotationMatrix(matrix);
      }
    },
    dispose() { for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); } group.clear(); },
  };
}

function createBasicStudio({ scene }) {
  const objects = [];
  const add = object => { scene.add(object); objects.push(object); return object; };
  scene.background = new THREE.Color('#edece1'); scene.fog = new THREE.Fog('#edece1', 8, 18);
  add(new THREE.HemisphereLight('#fff6df', '#64796f', 2.5));
  const key = add(new THREE.DirectionalLight('#fff3d5', 4)); key.position.set(-2, 6, 3); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 });
  key.shadow.normalBias = .015; key.shadow.bias = -.0001;
  add(new THREE.DirectionalLight('#d4eeee', 2)).position.set(4, 3, -3);
  const ground = add(new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#e4e6da', roughness: .95 })));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  add(new THREE.GridHelper(20, 100, '#becbbd', '#cdd5c8')).position.y = .001;
  return {
    update() {},
    dispose() { for (const object of objects) { scene.remove(object); object.geometry?.dispose(); object.material?.dispose?.(); } },
  };
}

// Joint layouts for pose sliders. Legacy presets keep their tested absolute
// mapping; body contracts pose relative to their own nominal stance.
const QUADRUPED_DELTA = { crouch: { hip_roll: 0, hip_pitch: .475, knee: -.95 }, wave: { hip_pitch: -1.25, knee: -.3 } };
const MULTILEG_DELTA = { crouch: { hip_yaw: 0, hip_pitch: -.30, knee: .45 }, wave: { hip_pitch: -.35, knee: .35 } };
const roleOf = name => (/_hip_roll$/.test(name) ? 'hip_roll' : /_hip_yaw$/.test(name) ? 'hip_yaw' : /_hip_pitch$/.test(name) ? 'hip_pitch' : /_knee$/.test(name) ? 'knee' : 'other');

export async function createDraftLab(container, { onState = () => {}, createView = createBasicView, createStudio = createBasicStudio } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  renderer.domElement.setAttribute('aria-label', 'Your creature in the workshop: drag to orbit, scroll to zoom');
  renderer.domElement.setAttribute('role', 'img'); container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, .01, 80);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.minDistance = .5; controls.maxDistance = 9; controls.maxPolarAngle = Math.PI / 2 - .02;
  const turntable = new THREE.Group(); scene.add(turntable);
  const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; turntable.add(root);
  const studio = createStudio({ THREE, scene, renderer, camera });
  let mj = null, model = null, data = null, vfs = null, view = null, entry = null, disposed = false;
  let mode = 'pose', pose = { crouch: 0, wave: 0 }, look = null, error = null, viewMode = 'normal';
  let joints = [], feet = [], identityBase = .5, peakContacts = 0, dropStart = 0, physicsComplete = false;
  let loadSequence = 0, raf = 0, last = 0, accumulator = 0, lastEmit = 0, spin = true;
  let evidence = { stepCount: 0, warningCounts: [], warningBaseline: [], lastTime: 0, timeResets: 0 };
  const resetEvidence = () => { const c = readPhysicsWarningCounts(data); evidence = { stepCount: 0, warningCounts: c, warningBaseline: [...c], lastTime: data?.time ?? 0, timeResets: 0 }; };

  function snapshot() {
    return {
      ready: !!model, modelId: entry?.id ?? null, kind: entry?.kind ?? null, preset: entry?.preset ?? null, bodyPlan: entry?.bodyPlan ?? null,
      mode, viewMode, simTime: data?.time ?? 0, contacts: data?.ncon ?? 0, peakContacts, physicsComplete,
      baseHeight: data?.qpos[2] ?? 0, droppedStartHeight: dropStart,
      finite: data ? Array.from(data.qpos).every(Number.isFinite) && Array.from(data.qvel).every(Number.isFinite) : null,
      stepCount: evidence.stepCount, warningCounts: [...evidence.warningCounts], timeResets: evidence.timeResets,
      massKg: entry?.massKg ?? 0, nq: model?.nq ?? 0, nv: model?.nv ?? 0, nu: model?.nu ?? 0, geomCount: model?.ngeom ?? 0,
      jointNames: joints.map(j => j.name), pose: { ...pose }, error,
      physicsEngine: 'MuJoCo WASM 3.11.0', renderer: 'Three.js', source: entry?.kind === 'body' ? 'Draft body contract' : 'Draft-generated MJCF',
    };
  }
  const emit = () => onState(snapshot());

  function poseInto(poseModel, poseData, poseJoints, poseFeet) {
    mj.mj_resetData(poseModel, poseData);
    poseData.qpos.set([0, 0, 0, 1, 0, 0, 0], 0);
    for (const j of poseJoints) {
      const value = j.neutral + j.crouch * pose.crouch + j.wave * pose.wave;
      poseData.qpos[j.address] = Math.max(j.min, Math.min(j.max, value));
    }
    mj.mj_forward(poseModel, poseData);
    const footMin = Math.min(...poseFeet.map(i => poseData.geom_xpos[i * 3 + 2] - poseModel.geom_size[i * 3]));
    poseData.qpos[2] = -footMin + .015; mj.mj_forward(poseModel, poseData);
    if (!Array.from(poseData.qpos).every(Number.isFinite)) throw Error('Generated pose contains an invalid coordinate');
    return poseData.qpos[2];
  }
  function applyPose() { if (model) { identityBase = poseInto(model, data, joints, feet); view?.sync(data); } }

  function frameCamera() {
    turntable.updateMatrixWorld(true);
    const box = view ? new THREE.Box3().setFromObject(view.group) : null;
    const size = box && !box.isEmpty() ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(.8, .6, .8);
    const extent = Math.max(.7, size.x, size.y, size.z);
    controls.target.set(0, Math.max(.18, size.y * .45), 0);
    camera.position.set(extent * 1.85, extent * 1.15, extent * 2.25); controls.update();
  }

  // Compile a candidate completely before replacing the current creature.
  async function commit(next, xml, assets, plan) {
    const sequence = ++loadSequence;
    mj = await getMujoco();
    if (disposed || sequence !== loadSequence) return;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw Error('Invalid Draft MJCF');
    let option = doc.querySelector('option');
    if (!option) { option = doc.createElement('option'); doc.documentElement.prepend(option); }
    option.setAttribute('timestep', '0.002');
    const floor = doc.createElement('geom');
    Object.entries({ name: 'lab_floor', type: 'plane', size: '8 8 0.1', rgba: '.8 .8 .7 1', friction: '.8 .1 .1', contype: '1', conaffinity: '15' }).forEach(([k, v]) => floor.setAttribute(k, v));
    doc.querySelector('worldbody').appendChild(floor);
    let nextVfs, nextModel, nextData, nextView, height;
    const nextJoints = [], nextFeet = [];
    try {
      nextVfs = new mj.MjVFS();
      for (const [name, bytes] of assets) nextVfs.addBuffer(name, bytes);
      nextModel = mj.MjModel.from_xml_string(new XMLSerializer().serializeToString(doc), nextVfs);
      nextData = new mj.MjData(nextModel);
      for (let i = 1; i < nextModel.njnt; i++) {
        const name = mj.mj_id2name(nextModel, mj.mjtObj.mjOBJ_JOINT.value, i);
        const role = plan.roles?.[name] ?? roleOf(name), legIndex = plan.legOf?.[name] ?? -1;
        const neutral = plan.neutral(name, role);
        const table = plan.deltas;
        const joint = {
          name, address: nextModel.jnt_qposadr[i], min: nextModel.jnt_range[i * 2], max: nextModel.jnt_range[i * 2 + 1], neutral,
          crouch: table.crouch[role] ?? 0, wave: legIndex === plan.waveLeg ? table.wave[role] ?? 0 : 0,
        };
        if (![joint.neutral, joint.crouch, joint.wave].every(Number.isFinite)) throw Error('Invalid body pose contract');
        nextJoints.push(joint);
      }
      for (const name of plan.footGeoms) {
        const id = mj.mj_name2id(nextModel, mj.mjtObj.mjOBJ_GEOM.value, name);
        if (id < 0) throw Error(`Foot geom missing from the generated body: ${name}`);
        nextFeet.push(id);
      }
      if (!nextFeet.length || nextJoints.length !== plan.jointCount) throw Error('Generated joints or feet do not match the selected body');
      height = poseInto(nextModel, nextData, nextJoints, nextFeet);
      nextView = createView({ THREE, mujoco: mj, model: nextModel, look, body: next.body ?? null, rootBody: plan.rootBody });
      nextView.sync(nextData);
    } catch (e) {
      nextView?.dispose(); nextData?.delete(); nextModel?.delete(); nextVfs?.delete(); throw e;
    }
    if (disposed || sequence !== loadSequence) { nextView.dispose(); nextData.delete(); nextModel.delete(); nextVfs.delete(); return; }
    clearRobot();
    model = nextModel; data = nextData; vfs = nextVfs; view = nextView; entry = next;
    joints = nextJoints; feet = nextFeet; identityBase = height;
    root.add(view.group); view.setMode?.(viewMode);
    mode = 'pose'; physicsComplete = false; peakContacts = 0; dropStart = 0; error = null; accumulator = 0;
    resetEvidence(); frameCamera(); emit();
  }

  // Legacy /api/generate manifest (Draft presets at 0.8-1.2 scale, original Flower).
  async function loadModel(manifest) {
    if (!manifest?.xmlUrl || !manifest?.meshUrl) throw Error('Draft model manifest is incomplete');
    const responses = await Promise.all([fetch(manifest.xmlUrl), fetch(manifest.meshUrl)]);
    if (responses.some(r => !r.ok)) throw Error('Could not load the generated robot assets');
    const [xml, mesh] = await Promise.all([responses[0].text(), responses[1].arrayBuffer()]);
    const flower = manifest.preset === 'flower', plan = manifest.bodyPlan;
    const index = name => plan?.jointNames.indexOf(name) ?? -1;
    await commit({ kind: 'preset', id: manifest.id, preset: manifest.preset, bodyPlan: flower ? 'multileg' : 'quadruped', massKg: manifest.massKg, manifest },
      xml, [['torso_mesh.stl', new Uint8Array(mesh)]], {
        jointCount: flower ? 18 : 12,
        footGeoms: plan ? plan.footGeomNames : ['fl', 'fr', 'rl', 'rr'].map(leg => `${leg}_lower_leg_link_sphere`),
        rootBody: 'torso_link',
        deltas: flower ? MULTILEG_DELTA : QUADRUPED_DELTA,
        waveLeg: 0, legOf: flower ? null : { fl_hip_roll: 0, fl_hip_pitch: 0, fl_knee: 0 },
        neutral: (name, role) => plan ? plan.nominalJointPositions[index(name)] : role === 'knee' ? -1.10 : role === 'hip_pitch' ? .55 : 0,
        ...(flower ? { legOf: Object.fromEntries(plan.jointNames.map(n => [n, Number(n.match(/^leg(\d+)_/)?.[1] ?? -1)])) } : {}),
      });
  }

  // creature-body/1 contract served by draft-service (/creatures/<id>/...).
  async function loadBody(body, baseUrl = `/creatures/${body?.id}`) {
    if (body?.schema !== 'creature-body/1' || !Array.isArray(body.legs) || !Array.isArray(body.jointNames)) throw Error('Unsupported body contract');
    const files = [body.xmlFile, ...(body.meshFiles ?? [])];
    const blobs = await Promise.all(files.map(async name => {
      const response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`);
      if (!response.ok) throw Error(`Could not load ${name}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const expected = body.provenance?.assetSha256?.[name];
      if (expected && await sha256Hex(bytes) !== expected) throw Error(`${name} does not match its body contract`);
      return bytes;
    }));
    const legOf = {}, roles = {};
    body.legs.forEach((leg, i) => leg.joints.forEach(name => { legOf[name] = i; }));
    for (const joint of body.joints ?? []) if (joint.role) roles[joint.name] = joint.role;
    const nominal = Object.fromEntries(body.jointNames.map((name, i) => [name, body.nominalJointPositions?.[i] ?? 0]));
    await commit({ kind: 'body', id: body.id, bodyPlan: body.bodyPlan, massKg: body.massKg, body },
      new TextDecoder().decode(blobs[0]), files.slice(1).map((name, i) => [name, blobs[i + 1]]), {
        jointCount: body.jointNames.length, footGeoms: body.legs.map(leg => leg.footGeom), rootBody: body.rootBody,
        deltas: body.bodyPlan === 'multileg' ? MULTILEG_DELTA : QUADRUPED_DELTA, waveLeg: 0, legOf, roles,
        neutral: name => nominal[name] ?? 0,
      });
  }

  function clearRobot() {
    if (view) { root.remove(view.group); view.dispose(); view = null; }
    data?.delete(); model?.delete(); vfs?.delete(); data = model = vfs = null; entry = null; joints = []; feet = [];
  }
  function setLook(next) { look = next; view?.setLook(next); emit(); }
  function setPose(next) {
    pose = { crouch: clamp01(next.crouch ?? pose.crouch), wave: clamp01(next.wave ?? pose.wave) };
    mode = 'pose'; physicsComplete = false; peakContacts = 0; dropStart = 0; error = null; accumulator = 0;
    applyPose(); if (data) resetEvidence(); emit();
  }
  function reset() { setPose({ crouch: 0, wave: 0 }); spin = true; frameCamera(); }
  function drop() {
    if (!model) return;
    applyPose(); data.qpos[2] += .35; data.qvel.fill(0); mj.mj_forward(model, data);
    dropStart = data.qpos[2]; mode = 'physics'; physicsComplete = false; peakContacts = 0; error = null; accumulator = 0; spin = false;
    turntable.rotation.y = 0; resetEvidence(); view?.sync(data); emit();
  }
  function setViewMode(next) { viewMode = ['normal', 'blueprint', 'xray'].includes(next) ? next : 'normal'; view?.setMode?.(viewMode); studio.setMode?.(viewMode); emit(); }
  function printReveal(seconds = 2.4) { spin = true; view?.playPrintReveal?.(seconds); }
  function capture({ size = 512 } = {}) {
    renderer.render(scene, camera);
    const source = renderer.domElement, canvas = document.createElement('canvas');
    const side = Math.min(source.width, source.height);
    canvas.width = canvas.height = size;
    canvas.getContext('2d').drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/png');
  }

  const resize = () => { if (disposed) return; const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  controls.addEventListener('start', () => { spin = false; });
  function frame(now) {
    if (disposed) return;
    const dt = Math.min((now - last) / 1000 || 0, .05); last = now;
    if (data && mode === 'physics' && !physicsComplete && !error && !document.hidden) {
      accumulator += dt;
      while (accumulator >= .002) {
        const fault = stepDraftPhysics(mj, model, data, evidence); accumulator -= .002; peakContacts = Math.max(peakContacts, data.ncon);
        if (fault) { error = fault; physicsComplete = true; break; }
        if (data.time >= 4) { physicsComplete = true; break; }
      }
      if (!error) mj.mj_forward(model, data);
      view?.sync(data);
    }
    if (spin && mode === 'pose') turntable.rotation.y += dt * .25;
    view?.update?.(dt); studio.update?.(dt);
    controls.update(); renderer.render(scene, camera);
    if (now - lastEmit > 200) { emit(); lastEmit = now; }
    raf = requestAnimationFrame(frame);
  }
  frameCamera(); raf = requestAnimationFrame(frame);
  // The print kit is built from the current posed model; the exporter never
  // writes physics state.
  async function printKit(exporter) {
    if (!model || !data) throw Error('Load a creature before exporting its print kit');
    return exporter({ THREE, mujoco: mj, model, data, look, body: entry?.body ?? null });
  }
  const api = {
    loadModel, loadBody, setLook, setPose, reset, drop, home: frameCamera, setViewMode, printReveal, capture, snapshot, printKit,
    setSpin: on => { spin = !!on; },
    getScene: () => ({ scene, camera, renderer, root }),
    dispose() {
      disposed = true; loadSequence++; cancelAnimationFrame(raf); observer.disconnect(); controls.dispose();
      clearRobot(); studio.dispose();
      renderer.dispose(); renderer.domElement.remove(); if (window.draftLab === api) delete window.draftLab;
    },
  };
  window.draftLab = api;
  return api;
}
