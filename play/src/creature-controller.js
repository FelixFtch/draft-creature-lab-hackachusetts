import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

// Generic controller for creature-gym policy bundles (contracts/policy-bundle.md).
// It owns policy tensors and controller state, never the caller's MjModel/MjData.
// All state is MuJoCo Z-up. Observation maths mirrors training/creature_gym/obs.py
// and evaluate.py:ReferenceController exactly (float64 maths, float32 policy input);
// qa/creature-controller-validation.mjs checks parity on Python-recorded fixtures.
const finite = values => Array.from(values).every(Number.isFinite);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const aborted = () => new DOMException('Controller step was cancelled', 'AbortError');
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL_DT = 0.02;
const SUBSTEPS = 4;
const SPAWN_CLEARANCE = 0.005;
export const POLICY_SCHEMA = 'creature-policy/1';

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export function readCreatureWarnings(data) {
  const vector = data.warning, counts = [];
  // vector is borrowed from MjData; get() returns an owned entry copy.
  for (let i = 0; i < vector.size(); i++) {
    const item = vector.get(i);
    try { counts.push(item.number); } finally { item.delete(); }
  }
  return counts;
}

function safeName(name, what) {
  if (typeof name !== 'string' || !SAFE_FILE.test(name)) throw Error(`Bundle ${what} has an unsafe file name`);
  return name;
}

function joinUrl(base, name) {
  return base.endsWith('/') ? base + name : `${base}/${name}`;
}

// Fetch and verify one bundle. Refuses hash mismatches and bundles whose eval.json
// does not pass for exactly this policy and scene (same spirit as the Flower gate).
// Unbound `fetch` references can throw "Illegal invocation"; always call through globalThis.
const defaultFetch = (...args) => globalThis.fetch(...args);

export async function loadCreatureBundle(baseUrl, { fetchImpl = defaultFetch } = {}) {
  const get = async (name, kind = 'bytes') => {
    const response = await fetchImpl(joinUrl(baseUrl, safeName(name, 'file')));
    if (!response.ok) throw Error(`Bundle file ${name} could not be loaded (${response.status})`);
    return kind === 'json' ? response.json() : new Uint8Array(await response.arrayBuffer());
  };
  const manifest = await get('manifest.json', 'json');
  if (manifest?.schema !== POLICY_SCHEMA) throw Error('Not a creature-policy/1 bundle');
  if (!['walk', 'jump'].includes(manifest.skill)) throw Error(`Unknown skill ${manifest.skill}`);
  const sceneBytes = await get(manifest.sceneXml);
  if (await sha256Hex(sceneBytes) !== manifest.sceneSha256) throw Error('Bundle scene.xml SHA-256 does not match its manifest');
  const assets = new Map();
  for (const asset of manifest.assets ?? []) {
    const bytes = await get(asset.name);
    if (await sha256Hex(bytes) !== asset.sha256) throw Error(`Bundle asset ${asset.name} SHA-256 does not match`);
    assets.set(asset.name, bytes);
  }
  const policyBytes = await get(manifest.policy);
  if (await sha256Hex(policyBytes) !== manifest.policySha256) throw Error('Bundle policy SHA-256 does not match the verified export');
  const evaluationInfo = manifest.evaluation;
  if (!evaluationInfo?.evalSha256) throw Error('Bundle has no evaluation; it is not ready to play');
  const evalBytes = await get(evaluationInfo.evalFile ?? 'eval.json');
  if (await sha256Hex(evalBytes) !== evaluationInfo.evalSha256) throw Error('Bundle eval.json SHA-256 does not match');
  const evaluation = JSON.parse(new TextDecoder().decode(evalBytes));
  assertEvaluation(manifest, evaluation);
  return { url: baseUrl, manifest, sceneXml: new TextDecoder().decode(sceneBytes), assets, policyBytes, evaluation };
}

function assertEvaluation(manifest, evaluation) {
  if (evaluation?.pass !== true) throw Error(`The ${manifest.skill} policy did not pass validation; refusing to run it`);
  if (evaluation.policySha256 !== manifest.policySha256 || evaluation.sceneSha256 !== manifest.sceneSha256)
    throw Error('Evaluation belongs to a different policy or scene');
}

function idByName(mj, model, type, name) {
  const id = mj.mj_name2id(model, mj.mjtObj[type].value, name);
  if (id < 0) throw Error(`Creature model is missing ${type}: ${name}`);
  return id;
}

// Manifest-derived constants for one skill.
function skillRuntime(manifest) {
  const n = manifest.jointNames.length;
  for (const key of ['defaultJointPositions', 'actionScale'])
    if (manifest[key]?.length !== n || !finite(manifest[key])) throw Error(`Manifest ${key} must list ${n} finite values`);
  const terms = manifest.observation?.terms ?? [];
  let size = 0;
  for (const term of terms) {
    if (term.start !== size || !(term.length > 0) || !Number.isFinite(term.scale)) throw Error('Observation terms must be contiguous');
    size += term.length;
  }
  if (size !== manifest.observation.size) throw Error('Observation size does not match its terms');
  const bounds = manifest.commandBounds;
  return {
    manifest, terms, size,
    defaults: Float64Array.from(manifest.defaultJointPositions),
    scale: Float64Array.from(manifest.actionScale),
    clip: manifest.actionClip,
    bounds: [bounds.vx, bounds.vy, bounds.wz],
    clock: manifest.clock ?? null,
    duration: manifest.episode?.durationS ?? null,
  };
}

// Robot addresses by name: extra world bodies (larger nq) are tolerated.
export function createCreatureContext(mujoco, model, data, manifest) {
  if (Math.abs(model.opt.timestep - manifest.control.timestep) > 1e-12 || manifest.control.decimation !== SUBSTEPS)
    throw Error('Creature policy requires 0.005-second timesteps and 4 substeps per control step');
  const rootJoint = idByName(mujoco, model, 'mjOBJ_JOINT', manifest.rootJoint);
  const jointIds = manifest.jointNames.map(n => idByName(mujoco, model, 'mjOBJ_JOINT', n));
  const actuatorIds = manifest.actuatorNames.map(n => idByName(mujoco, model, 'mjOBJ_ACTUATOR', n));
  if (new Set(jointIds).size !== jointIds.length || new Set(actuatorIds).size !== actuatorIds.length)
    throw Error('Creature joints and actuators must be distinct');
  actuatorIds.forEach((a, i) => {
    if (model.actuator_trnid[a * 2] !== jointIds[i]) throw Error(`Actuator/joint mapping differs at ${manifest.jointNames[i]}`);
  });
  const sensorAddress = (name, dim) => {
    const id = idByName(mujoco, model, 'mjOBJ_SENSOR', name);
    if (model.sensor_dim[id] !== dim) throw Error(`Sensor ${name} must have dimension ${dim}`);
    return model.sensor_adr[id];
  };
  return {
    mujoco, model, data, manifest, jointIds, actuatorIds,
    rootBody: idByName(mujoco, model, 'mjOBJ_BODY', manifest.rootBody),
    rootQpos: model.jnt_qposadr[rootJoint], rootDof: model.jnt_dofadr[rootJoint],
    qposAddresses: jointIds.map(j => model.jnt_qposadr[j]),
    qvelAddresses: jointIds.map(j => model.jnt_dofadr[j]),
    ctrlLo: actuatorIds.map(a => model.actuator_ctrlrange[a * 2]),
    ctrlHi: actuatorIds.map(a => model.actuator_ctrlrange[a * 2 + 1]),
    footSiteIds: manifest.footSites.map(n => idByName(mujoco, model, 'mjOBJ_SITE', n)),
    touchAddresses: manifest.sensors.touch.map(n => sensorAddress(n, 1)),
    torsoContactAddress: sensorAddress(manifest.sensors.torsoContact, 1),
    disposed: false,
  };
}

function rootQuat(context) {
  const q = context.data.qpos, a = context.rootQpos + 3;
  const norm = Math.sqrt(q[a] * q[a] + q[a + 1] * q[a + 1] + q[a + 2] * q[a + 2] + q[a + 3] * q[a + 3]);
  return [q[a] / norm, q[a + 1] / norm, q[a + 2] / norm, q[a + 3] / norm];
}

// R(q)^T v for q = (w, x, y, z); same expansion as obs.py:quat_rotate_inverse.
export function quatRotateInverse([w, x, y, z], [vx, vy, vz]) {
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
  return [r00 * vx + r10 * vy + r20 * vz, r01 * vx + r11 * vy + r21 * vz, r02 * vx + r12 * vy + r22 * vz];
}

export function projectedGravity([w, x, y, z]) {
  return [-(2 * (x * z - w * y)), -(2 * (y * z + w * x)), -(1 - 2 * (x * x + y * y))];
}

export function isMoving(command, moving) {
  return Math.abs(command[0]) > moving.fraction * moving.vmax || Math.abs(command[1]) > moving.fraction * moving.vmax ||
    Math.abs(command[2]) > moving.fraction * moving.wmax;
}

// Build one observation for `skill` from robot qpos/qvel and controller state.
export function observeCreature(context, skill, state, command) {
  if (context.disposed) throw aborted();
  const { data, rootDof, qposAddresses, qvelAddresses } = context;
  const q = rootQuat(context), qvel = data.qvel;
  const raw = {
    base_lin_vel: () => quatRotateInverse(q, [qvel[rootDof], qvel[rootDof + 1], qvel[rootDof + 2]]),
    base_ang_vel: () => [qvel[rootDof + 3], qvel[rootDof + 4], qvel[rootDof + 5]],
    projected_gravity: () => projectedGravity(q),
    command: () => command,
    joint_pos: () => qposAddresses.map((a, i) => data.qpos[a] - skill.defaults[i]),
    joint_vel: () => qvelAddresses.map(a => qvel[a]),
    last_action: () => Array.from(state.lastAction),
    gait_clock: () => {
      const moving = isMoving(command, context.manifest.moving);
      return skill.clock.legPhaseOffsets.flatMap(offset => {
        let p = state.phase + offset; p -= Math.floor(p);
        const angle = 2 * Math.PI * p;
        return moving ? [Math.sin(angle), Math.cos(angle)] : [0, 0];
      });
    },
    jump_phase: () => [state.jumpPhase, Math.sin(2 * Math.PI * state.jumpPhase), Math.cos(2 * Math.PI * state.jumpPhase)],
  };
  const observation = new Float32Array(skill.size);
  for (const term of skill.terms) {
    const make = raw[term.name];
    if (!make) throw Error(`Unknown observation term ${term.name}`);
    const values = make();
    if (values.length !== term.length) throw Error(`Observation term ${term.name} has the wrong length`);
    for (let i = 0; i < term.length; i++) observation[term.start + i] = term.scale === 1 ? values[i] : values[i] * term.scale;
  }
  if (!finite(observation)) throw Error('Creature observation contains non-finite values');
  return observation;
}

export function measureCreature(context) {
  if (context.disposed) throw aborted();
  const { data, manifest, rootQpos, rootDof, footSiteIds, touchAddresses, torsoContactAddress } = context;
  const q = rootQuat(context);
  const v = quatRotateInverse(q, [data.qvel[rootDof], data.qvel[rootDof + 1], data.qvel[rootDof + 2]]);
  const g = projectedGravity(q);
  const position = [data.qpos[rootQpos], data.qpos[rootQpos + 1], data.qpos[rootQpos + 2]];
  const footPositions = footSiteIds.map(i => Array.from(data.site_xpos.slice(i * 3, i * 3 + 3)));
  const heightAboveFeet = position[2] - footPositions.reduce((s, f) => s + f[2], 0) / footPositions.length;
  const tilt = Math.acos(clamp(-g[2], -1, 1));
  const footContact = touchAddresses.map(a => data.sensordata[a] > manifest.contactThresholdN);
  const torsoContact = data.sensordata[torsoContactAddress] > 0;
  const fall = tilt > manifest.fallCriteria.tiltRad || heightAboveFeet < manifest.fallCriteria.minHeightAboveFeetM || torsoContact;
  const [w, x, y, z] = q;
  return {
    position, heading: Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z)),
    actualVelocity: [v[0], v[1], data.qvel[rootDof + 5]], tilt, heightAboveFeet, footPositions, footContact,
    torsoContact, fall,
  };
}

async function sessionFor(ort, bundle, injected) {
  if (injected) return { session: injected, owned: false };
  if (!(bundle.policyBytes instanceof Uint8Array)) throw Error('Bundle policy bytes are missing');
  if (await sha256Hex(bundle.policyBytes) !== bundle.manifest.policySha256) throw Error('Bundle policy SHA-256 does not match the verified export');
  return { session: await ort.InferenceSession.create(bundle.policyBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }), owned: true };
}

// Direct factory (like the legacy controllers). `walk`/`jump` are loaded bundles
// ({manifest, evaluation, policyBytes}) or, for tests, {manifest, evaluation, session}.
export async function createCreatureController({ mujoco, model, data, walk, jump = null, ort: injectedOrt } = {}) {
  if (!walk?.manifest || walk.manifest.skill !== 'walk') throw Error('A walk bundle is required');
  assertEvaluation(walk.manifest, walk.evaluation);
  let jumpError = null;
  if (jump) {
    try {
      if (jump.manifest?.skill !== 'jump') throw Error('Jump bundle has the wrong skill');
      assertEvaluation(jump.manifest, jump.evaluation);
      if (jump.manifest.sceneSha256 !== walk.manifest.sceneSha256) throw Error('Jump was trained on a different scene');
      if (jump.manifest.handoff?.walkPolicySha256 !== walk.manifest.policySha256)
        throw Error('Jump handoff was validated with a different walk policy');
    } catch (error) { jumpError = String(error.message ?? error); jump = null; }
  }
  const needsOrt = !walk.session || (jump && !jump.session);
  const ort = injectedOrt ?? (needsOrt ? await import('onnxruntime-web/wasm') : null);
  if (ort && !injectedOrt) ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
  if (ort) ort.env.wasm.numThreads = 1;
  const sessions = [];
  const release = () => { for (const s of sessions) if (s.owned) s.session.release().catch(() => {}); };
  let context;
  const skills = {};
  try {
    for (const [name, bundle] of [['walk', walk], ['jump', jump]]) {
      if (!bundle) continue;
      const s = await sessionFor(ort, bundle, bundle.session);
      sessions.push(s);
      const runtime = skillRuntime(bundle.manifest);
      if (s.session.inputNames.length !== 1 || s.session.outputNames.length !== 1 ||
          s.session.inputNames[0] !== bundle.manifest.onnxInput || s.session.outputNames[0] !== bundle.manifest.onnxOutput)
        throw Error(`${name} ONNX input/output names differ from its manifest`);
      skills[name] = { ...runtime, session: s.session };
    }
    context = createCreatureContext(mujoco, model, data, walk.manifest);
  } catch (error) { release(); throw error; }

  const manifest = walk.manifest, nu = manifest.jointNames.length;
  let disposed = false, generation = 0, busy = false, warningsBaseline = [], evidence;
  const state = { mode: 'walk', phase: 0, jumpPhase: 0, lastAction: new Float32Array(nu) };
  let startPosition = [0, 0, 0];

  function currentState() {
    const motion = measureCreature(context);
    return { ...motion, simTime: data.time, displacement: motion.position.map((x, i) => x - startPosition[i]) };
  }
  function snapshot() {
    if (!disposed) Object.assign(evidence, currentState());
    return { ...evidence, ready: !disposed, busy, mode: state.mode, jumpPhase: state.mode === 'jump' ? state.jumpPhase : null,
      skills: Object.keys(skills), jumpAvailable: !!skills.jump, jumpError,
      command: [...evidence.command], action: [...evidence.action], warningCounts: [...evidence.warningCounts],
      bodyId: manifest.bodyId, walkPolicySha256: manifest.policySha256, jumpPolicySha256: skills.jump?.manifest.policySha256 ?? null,
      controller: 'creature-gym PPO bundle; validated in Python MuJoCo 3.11.0', honesty: manifest.honesty,
      physicsEngine: 'MuJoCo WASM 3.11.0', policyRuntime: 'ONNX Runtime Web WASM 1.27.0' };
  }
  function cancelStep() { generation++; if (evidence) evidence.active = false; }

  // Robot-only reset: world bodies/props keep their state (pilot contract).
  function reset(spawn = {}) {
    if (disposed) throw aborted();
    cancelStep();
    const x = spawn.x ?? 0, y = spawn.y ?? 0, yaw = spawn.yaw ?? 0, ground = spawn.z ?? 0;
    for (const value of [x, y, yaw, ground]) if (!Number.isFinite(value)) throw Error('Spawn must be finite');
    const init = manifest.initialQpos, r = context.rootQpos;
    const [w0, x0, y0, z0] = init.slice(3, 7), cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    // q = q_yaw * q0 (yaw about world z)
    const quat = [cy * w0 - sy * z0, cy * x0 - sy * y0, cy * y0 + sy * x0, cy * z0 + sy * w0];
    data.qpos[r] = x; data.qpos[r + 1] = y; data.qpos[r + 2] = init[2] + ground + SPAWN_CLEARANCE;
    for (let i = 0; i < 4; i++) data.qpos[r + 3 + i] = quat[i];
    for (let i = 0; i < 6; i++) data.qvel[context.rootDof + i] = 0;
    context.qposAddresses.forEach((a, i) => { data.qpos[a] = init[7 + i]; });
    context.qvelAddresses.forEach(a => { data.qvel[a] = 0; });
    context.actuatorIds.forEach((a, i) => { data.ctrl[a] = skills.walk.defaults[i]; });
    mujoco.mj_forward(model, data);
    state.mode = 'walk'; state.phase = 0; state.jumpPhase = 0; state.lastAction = new Float32Array(nu);
    startPosition = measureCreature(context).position;
    warningsBaseline = readCreatureWarnings(data);
    evidence = { ready: true, active: false, error: null, controlSteps: 0, physicsSteps: 0, timeResets: 0, jumps: 0,
      warningCounts: [...warningsBaseline], command: [0, 0, 0], commandClamped: false, action: Array(nu).fill(0), ...currentState() };
    return snapshot();
  }

  // Exactly ReferenceController.restore for parity tests (fixtures carry full state).
  function restore(saved) {
    if (disposed) throw aborted();
    cancelStep();
    data.qpos.set(saved.qpos); data.qvel.set(saved.qvel);
    if (saved.qaccWarmstart && data.qacc_warmstart) data.qacc_warmstart.set(saved.qaccWarmstart);
    data.time = saved.time;
    mujoco.mj_forward(model, data);
    state.mode = saved.mode; state.phase = saved.phase; state.jumpPhase = saved.jumpPhase;
    state.lastAction = Float32Array.from(saved.lastAction);
    warningsBaseline = readCreatureWarnings(data);
    if (evidence) { evidence.error = null; evidence.fall = false; }
  }

  function clampCommand(command) {
    const bounds = skills.walk.bounds;
    const clamped = command.map((c, i) => clamp(c, bounds[i][0], bounds[i][1]));
    return { clamped, changed: clamped.some((c, i) => c !== command[i]) };
  }

  async function step(command = [0, 0, 0], { jump: wantJump = false } = {}) {
    if (disposed) throw aborted();
    if (busy) throw Error('A creature control step is already running');
    if (evidence.error || evidence.fall) throw Error(evidence.error ?? 'Robot fell; reset before continuing');
    if (command?.length !== 3 || !finite(command)) throw Error('Command must be three finite values [vx, vy, wz]');
    const { clamped, changed } = clampCommand(Array.from(command, Number));
    if (wantJump && state.mode === 'walk' && skills.jump) {
      state.mode = 'jump'; state.jumpPhase = 0; evidence.jumps++;
      const ratio = skills.walk.scale.map((s, i) => s / skills.jump.scale[i]);
      state.lastAction = Float32Array.from(state.lastAction, (a, i) => clamp(a * ratio[i], -skills.jump.clip, skills.jump.clip));
    }
    const skill = skills[state.mode];
    const tick = generation; busy = true;
    let inputTensor, outputs;
    try {
      const observation = observeCreature(context, skill, state, clamped);
      inputTensor = new ort.Tensor('float32', observation, [1, skill.size]);
      outputs = await skill.session.run({ [skill.manifest.onnxInput]: inputTensor });
      // Caller may dispose/reset/switch models during inference. Never touch
      // released model/data or apply a stale action after an await.
      if (disposed || tick !== generation) throw aborted();
      const raw = Float32Array.from(outputs[skill.manifest.onnxOutput].data);
      if (raw.length !== nu || !finite(raw)) throw Error('Policy returned an invalid action');
      const action = Float32Array.from(raw, a => clamp(a, -skill.clip, skill.clip));
      context.actuatorIds.forEach((id, i) => {
        data.ctrl[id] = clamp(skill.defaults[i] + skill.scale[i] * action[i], context.ctrlLo[i], context.ctrlHi[i]);
      });
      evidence.command = clamped; evidence.commandClamped = changed; evidence.action = Array.from(action); evidence.active = true;
      for (let substep = 0; substep < SUBSTEPS; substep++) {
        const before = data.time; mujoco.mj_step(model, data); evidence.physicsSteps++;
        evidence.warningCounts = readCreatureWarnings(data);
        if (data.time <= before) evidence.timeResets++;
        if (evidence.timeResets || evidence.warningCounts.some((n, i) => n > warningsBaseline[i]) || !finite(data.qpos) || !finite(data.qvel))
          throw Error('MuJoCo warning, non-finite state or automatic time reset; reset the robot');
      }
      mujoco.mj_forward(model, data); evidence.controlSteps++;
      state.lastAction = action;
      if (skills.walk.clock) { state.phase += skills.walk.clock.frequencyHz * CONTROL_DT; if (state.phase >= 1) state.phase -= 1; }
      if (state.mode === 'jump') {
        state.jumpPhase += CONTROL_DT / skill.duration;
        if (state.jumpPhase >= 1 - 1e-9) {
          // Microduck-style handoff: the walk policy resumes with the last targets in its own units.
          state.mode = 'walk';
          const ratio = skills.jump.scale.map((s, i) => s / skills.walk.scale[i]);
          state.lastAction = Float32Array.from(state.lastAction, (a, i) => clamp(a * ratio[i], -skills.walk.clip, skills.walk.clip));
        }
      }
      Object.assign(evidence, currentState());
      if (evidence.fall) evidence.active = false;
      return snapshot();
    } catch (error) {
      if (!disposed && tick === generation && error.name !== 'AbortError') {
        evidence.error = String(error.message ?? error); evidence.active = false;
      }
      throw error;
    } finally {
      inputTensor?.dispose();
      if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
      busy = false;
    }
  }

  function dispose() {
    if (disposed) return;
    cancelStep(); disposed = true; context.disposed = true; if (evidence) evidence.ready = false;
    // Release after any in-flight run has returned; generation checks make its
    // result inert immediately, even if the caller deletes model/data now.
    const later = () => busy ? setTimeout(later, 0) : release();
    later();
  }

  try { reset(); } catch (error) { dispose(); throw error; }
  return { reset, restore, step, cancelStep, pause: cancelStep, dispose, snapshot,
    observe: (command = [0, 0, 0]) => observeCreature(context, skills[state.mode], state, clampCommand(Array.from(command, Number)).clamped),
    controllerState: () => ({ mode: state.mode, phase: state.phase, jumpPhase: state.jumpPhase, lastAction: Array.from(state.lastAction) }),
    manifest, skills: Object.keys(skills) };
}

// Optional stale-body check: the bundle must have been trained on these exact body files.
async function assertBodyMatches(bodyUrl, manifest, fetchImpl) {
  const response = await fetchImpl(bodyUrl);
  if (!response.ok) throw Error(`Body contract could not be loaded (${response.status})`);
  const body = await response.json();
  const declared = body?.provenance?.assetSha256 ?? {};
  const trained = manifest.bodyAssetSha256 ?? {};
  const keys = new Set([...Object.keys(declared), ...Object.keys(trained)]);
  if (body.id !== manifest.bodyId || [...keys].some(k => declared[k] !== trained[k]))
    throw Error('This policy was trained on a different version of the body; retrain it');
}

// Playground pilot (contracts/world-api.md). The engine injects world geoms/bodies
// into `xml` after the robot (keep the robot's free joint first), compiles one
// model, then calls attach(). `meta.floorGeom` names this scene's flat floor plane.
export function createCreaturePilot({ walkUrl, jumpUrl = null, bodyUrl = null, fetchImpl = defaultFetch, ort = null } = {}) {
  let walk = null, jump = null, jumpError = null;
  return {
    kind: 'creature',
    async prepare() {
      walk = await loadCreatureBundle(walkUrl, { fetchImpl });
      if (bodyUrl) await assertBodyMatches(bodyUrl, walk.manifest, fetchImpl);
      if (jumpUrl) {
        try {
          jump = await loadCreatureBundle(jumpUrl, { fetchImpl });
          if (jump.manifest.sceneSha256 !== walk.manifest.sceneSha256) throw Error('Jump was trained on a different scene');
          if (jump.manifest.handoff?.walkPolicySha256 !== walk.manifest.policySha256) throw Error('Jump handoff was validated with a different walk policy');
        } catch (error) { jump = null; jumpError = String(error.message ?? error); }
      }
      const m = walk.manifest;
      return {
        xml: walk.sceneXml, assets: walk.assets,
        meta: { bodyId: m.bodyId, bodyName: m.bodyName, rootBody: m.rootBody, rootJoint: m.rootJoint,
          footSites: m.footSites, jointNames: m.jointNames, commandBounds: m.commandBounds,
          skills: jump ? ['walk', 'jump'] : ['walk'], jumpError, floorGeom: m.floorGeom,
          nominalRootHeight: m.nominalRootHeight, honesty: m.honesty,
          evaluation: { walk: walk.evaluation.pass, jump: jump ? jump.evaluation.pass : null } },
      };
    },
    async attach({ mujoco, model, data }) {
      if (!walk) throw Error('prepare() must succeed before attach()');
      const controller = await createCreatureController({ mujoco, model, data, walk, jump, ort: ort ?? undefined });
      return {
        reset: spawn => controller.reset(spawn),
        step: (command, opts) => controller.step(command, opts),
        snapshot: () => controller.snapshot(),
        dispose: () => controller.dispose(),
        controller,
      };
    },
  };
}
