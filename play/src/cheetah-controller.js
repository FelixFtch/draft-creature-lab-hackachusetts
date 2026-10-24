import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

// This module owns policy/ray buffers, never the caller's MjModel or MjData.
// Coordinates and all state updates are MuJoCo Z-up; rendering is separate.
const finite = values => Array.from(values).every(Number.isFinite);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const aborted = () => new DOMException('Controller step was cancelled', 'AbortError');
const DEFAULT_POLICY = '/controller/cheetah/policy.onnx';

export function readControllerWarnings(data) {
  const vector = data.warning, counts = [];
  // vector is borrowed from MjData; get() returns an owned entry copy.
  for (let i = 0; i < vector.size(); i++) {
    const item = vector.get(i);
    try { counts.push(item.number); } finally { item.delete(); }
  }
  return counts;
}

function idByName(mj, model, type, name) {
  const id = mj.mj_name2id(model, mj.mjtObj[type].value, name);
  if (id < 0) throw Error(`Controller model is missing ${type}: ${name}`);
  return id;
}

// A playground may append static world geoms and free props after the robot.
// The exported robot must still lead the model unchanged: root free joint at
// qpos/qvel 0 and every named joint at its exported address, so the policy
// reads and drives exactly the state it was trained on.
function requireRobotPrefix(mujoco, model, manifest, jointIds) {
  const root = manifest.model?.joints?.[0]?.name;
  if (!root || mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, root) !== 0 ||
      model.jnt_type[0] !== 0 || model.jnt_qposadr[0] !== 0 || model.jnt_dofadr[0] !== 0)
    throw Error('Cheetah root free joint must be the first joint of the model');
  if (manifest.jointQposAdr?.length !== 12 || manifest.jointDofAdr?.length !== 12 ||
      jointIds.some((id, i) => model.jnt_qposadr[id] !== manifest.jointQposAdr[i] || model.jnt_dofadr[id] !== manifest.jointDofAdr[i]))
    throw Error('Cheetah joints must keep their exported qpos/qvel addresses');
}

export function createControllerContext(mujoco, model, data, manifest) {
  if (model.nq < 19 || model.nv < 18 || model.nu !== 12)
    throw Error('Cheetah control requires the exported nq=19, nv=18, nu=12 training model');
  if (manifest.jointNames?.length !== 12 || manifest.motors?.length !== 12)
    throw Error('Controller manifest must specify 12 ordered joints and motors');
  if (Math.abs(model.opt.timestep - .005) > 1e-10)
    throw Error('Controller model timestep must be 0.005 seconds');
  const jointIds = manifest.jointNames.map(n => idByName(mujoco, model, 'mjOBJ_JOINT', n));
  requireRobotPrefix(mujoco, model, manifest, jointIds);
  const actuatorIds = manifest.actuatorNames.map(n => idByName(mujoco, model, 'mjOBJ_ACTUATOR', n));
  for (let i = 0; i < 12; i++) {
    if (model.actuator_trnid[actuatorIds[i] * 2] !== jointIds[i])
      throw Error(`Actuator/joint mapping differs at ${manifest.jointNames[i]}`);
  }
  const sensorAddress = name => {
    const id = idByName(mujoco, model, 'mjOBJ_SENSOR', name);
    if (model.sensor_dim[id] !== 3) throw Error(`Expected three-axis sensor ${name}`);
    return model.sensor_adr[id];
  };
  const scan = manifest.scan;
  if (scan.localOffsets?.length !== 187 || scan.localDirections?.length !== 187)
    throw Error('Controller manifest must provide the exact 187-ray pattern');
  const torsoId = idByName(mujoco, model, 'mjOBJ_BODY', manifest.torsoBodyName);
  const prefix = manifest.torsoBodyName.includes('/') ? manifest.torsoBodyName.slice(0, manifest.torsoBodyName.lastIndexOf('/') + 1) : '';
  const footNames = manifest.footSiteNames ?? ['fl', 'fr', 'rl', 'rr'].map(leg => `${prefix}${leg}_foot`);
  const context = {
    mujoco, model, data, manifest, jointIds, actuatorIds,
    qposAddresses: jointIds.map(i => model.jnt_qposadr[i]),
    qvelAddresses: jointIds.map(i => model.jnt_dofadr[i]),
    linearAddress: sensorAddress(manifest.sensorNames.linearVelocity),
    angularAddress: sensorAddress(manifest.sensorNames.angularVelocity),
    torsoId,
    scanBodyId: idByName(mujoco, model, 'mjOBJ_BODY', scan.bodyName),
    excludedBodyId: idByName(mujoco, model, 'mjOBJ_BODY', scan.excludeBodyName),
    footSiteIds: footNames.map(n => idByName(mujoco, model, 'mjOBJ_SITE', n)),
    geomGroups: Array.from({ length: 6 }, (_, i) => scan.geomGroups.includes(i) ? 1 : 0),
    rayGeom: new mujoco.IntBuffer(1),
    disposed: false,
  };
  return context;
}

export function disposeControllerContext(context) {
  if (!context.disposed) { context.disposed = true; context.rayGeom.delete(); }
}

export function scanTerrain(context) {
  const { mujoco: mj, model, data, manifest, scanBodyId, excludedBodyId, geomGroups, rayGeom } = context;
  if (context.disposed) throw aborted();
  const r = scanBodyId * 9, p = scanBodyId * 3, mat = data.xmat;
  let x = mat[r], y = mat[r + 3], norm = Math.hypot(x, y);
  if (norm < .1) {
    const ynorm = Math.max(1e-6, Math.hypot(mat[r + 1], mat[r + 4]));
    x = mat[r + 4] / ynorm; y = -mat[r + 1] / ynorm; norm = 1;
  }
  x /= Math.max(norm, 1e-6); y /= Math.max(norm, 1e-6);
  const pos = Array.from(data.xpos.slice(p, p + 3));
  const origins = [], directions = [], distances = [], geomIds = [], heights = [];
  for (let i = 0; i < 187; i++) {
    const o = manifest.scan.localOffsets[i], v = manifest.scan.localDirections[i];
    const origin = [pos[0] + x * o[0] - y * o[1], pos[1] + y * o[0] + x * o[1], pos[2] + o[2]];
    const direction = [x * v[0] - y * v[1], y * v[0] + x * v[1], v[2]];
    let distance = mj.mj_ray(model, data, origin, direction, geomGroups, true, excludedBodyId, rayGeom, null);
    const geom = rayGeom.GetView()[0];
    if (distance > manifest.scan.maxDistance) distance = -1;
    origins.push(origin); directions.push(direction); distances.push(distance); geomIds.push(geom);
    heights.push(distance < 0 ? manifest.scan.maxDistance : pos[2] - (origin[2] + direction[2] * distance));
  }
  return { origins, directions, distances, geomIds, heights };
}

export function observeCheetah(context, command = [0, 0, 0], previousAction = new Float32Array(12)) {
  const { data, manifest, torsoId, linearAddress, angularAddress, qposAddresses, qvelAddresses } = context;
  if (command.length !== 3 || !finite(command) || previousAction.length !== 12 || !finite(previousAction))
    throw Error('Command and previous action must be finite vectors of length 3 and 12');
  const ray = scanTerrain(context), observation = new Float32Array(235);
  observation.set(data.sensordata.slice(linearAddress, linearAddress + 3), 0);
  observation.set(data.sensordata.slice(angularAddress, angularAddress + 3), 3);
  const r = torsoId * 9;
  observation.set([-data.xmat[r + 6], -data.xmat[r + 7], -data.xmat[r + 8]], 6);
  for (let i = 0; i < 12; i++) {
    observation[9 + i] = data.qpos[qposAddresses[i]] - manifest.defaultJointPosition[i];
    observation[21 + i] = data.qvel[qvelAddresses[i]] - manifest.defaultJointVelocity[i];
  }
  observation.set(previousAction, 33); observation.set(command, 45);
  for (let i = 0; i < 187; i++) observation[48 + i] = ray.heights[i] * .2;
  if (!finite(observation)) throw Error('Cheetah observation contains non-finite values');
  return { observation, ray };
}

export function computeMotorTorques(context, action) {
  const { data, manifest, qposAddresses, qvelAddresses } = context;
  if (action.length !== 12 || !finite(action)) throw Error('Policy action must contain 12 finite values');
  const torques = new Float64Array(12);
  for (let i = 0; i < 12; i++) {
    const m = manifest.motors[i], velocity = data.qvel[qvelAddresses[i]];
    const target = manifest.defaultJointPosition[i] + .175 * action[i] - manifest.encoderBias[i];
    const effort = m.kp * (target - data.qpos[qposAddresses[i]]) - m.kd * velocity;
    const corner = m.velocityLimit * (1 + m.effortLimit / m.saturationEffort);
    const v = clamp(velocity, -corner, corner);
    const lo = Math.max(m.saturationEffort * (-1 - v / m.velocityLimit), -m.effortLimit);
    const hi = Math.min(m.saturationEffort * (1 - v / m.velocityLimit), m.effortLimit);
    torques[i] = clamp(effort, lo, hi);
  }
  return torques;
}

export function measureCheetah(context) {
  const { data, torsoId, linearAddress, angularAddress, footSiteIds, manifest } = context;
  const r = torsoId * 9, p = torsoId * 3;
  const position = Array.from(data.xpos.slice(p, p + 3));
  const footPositions = footSiteIds.map(i => Array.from(data.site_xpos.slice(i * 3, i * 3 + 3)));
  const heightAboveFeet = position[2] - footPositions.reduce((s, f) => s + f[2], 0) / 4;
  const tilt = Math.acos(clamp(data.xmat[r + 8], -1, 1));
  const minHeight = manifest.termination?.minimumHeightAboveFeet ?? manifest.initialQpos[2] * .5;
  return {
    position, actualVelocity: [data.sensordata[linearAddress], data.sensordata[linearAddress + 1], data.sensordata[angularAddress + 2]],
    heading: Math.atan2(data.xmat[r + 3], data.xmat[r]), footPositions,
    tilt, heightAboveFeet, fall: tilt > 1 || heightAboveFeet < minHeight,
  };
}

export async function createCheetahController({ mujoco, model, data, policyUrl = DEFAULT_POLICY,
  manifest, manifestUrl = '/controller/cheetah/manifest.json', ort: injectedOrt, session: injectedSession } = {}) {
  if (!manifest) {
    const response = await fetch(manifestUrl);
    if (!response.ok) throw Error(`Controller manifest could not be loaded (${response.status})`);
    manifest = await response.json();
  }
  const ort = injectedOrt ?? await import('onnxruntime-web/wasm');
  if (!injectedOrt) ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
  ort.env.wasm.numThreads = 1;
  let session = injectedSession;
  if (!session) {
    const response = await fetch(policyUrl);
    if (!response.ok) throw Error(`Controller policy could not be loaded (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!manifest.policySha256) throw Error('Controller manifest is missing the policy SHA-256');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actualHash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    if (actualHash !== manifest.policySha256) throw Error('Controller policy SHA-256 does not match the verified export');
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  let context;
  try { context = createControllerContext(mujoco, model, data, manifest); }
  catch (error) { if (!injectedSession) await session.release(); throw error; }
  let disposed = false, generation = 0, busy = false, previousAction = new Float32Array(12);
  let startPosition = [0, 0, 0], warningsBaseline = [], evidence;
  const inputName = session.inputNames[0], outputName = session.outputNames[0];
  function currentState() {
    const motion = measureCheetah(context);
    return { ...motion, simTime: data.time, contacts: data.ncon,
      displacement: motion.position.map((x, i) => x - startPosition[i]) };
  }
  function snapshot() {
    if (!disposed) Object.assign(evidence, currentState());
    return { ...evidence, ready: !disposed, busy, command: [...evidence.command],
      action: [...evidence.action], warningCounts: [...evidence.warningCounts],
      manifestId: manifest.id ?? 'cheetah', controller: 'Draft Cheetah PPO; nominal exported native model',
      physicsEngine: 'MuJoCo WASM 3.11.0', policyRuntime: 'ONNX Runtime Web WASM 1.27.0' };
  }
  function cancelStep() { generation++; if (evidence) evidence.active = false; }
  function reset() {
    if (disposed) throw aborted();
    cancelStep();
    mujoco.mj_resetData(model, data);
    data.qpos.set(manifest.initialQpos); data.qvel.set(manifest.initialQvel); data.ctrl.fill(0);
    mujoco.mj_forward(model, data);
    previousAction = new Float32Array(12); startPosition = measureCheetah(context).position;
    warningsBaseline = readControllerWarnings(data);
    evidence = { ready: true, active: false, error: null, controlSteps: 0, physicsSteps: 0,
      timeResets: 0, warningCounts: [...warningsBaseline], command: [0, 0, 0], action: Array(12).fill(0),
      ...currentState() };
    return snapshot();
  }
  async function step(command = [0, 0, 0]) {
    if (disposed) throw aborted();
    if (busy) throw Error('A Cheetah control step is already running');
    if (evidence.error || evidence.fall) throw Error(evidence.error ?? 'Robot fell; reset before continuing');
    if (command.length !== 3 || !finite(command)) throw Error('Command must be three finite values');
    const tick = generation; busy = true;
    let inputTensor, outputs;
    try {
      mujoco.mj_forward(model, data);
      const { observation } = observeCheetah(context, command, previousAction);
      inputTensor = new ort.Tensor('float32', observation, [1, 235]);
      outputs = await session.run({ [inputName]: inputTensor });
      // Caller may dispose/reset/switch models during inference. Never touch
      // released model/data or apply a stale action after an await.
      if (disposed || tick !== generation) throw aborted();
      const action = Float32Array.from(outputs[outputName].data);
      if (action.length !== 12 || !finite(action)) throw Error('Policy returned an invalid action');
      previousAction = action; evidence.command = [...command]; evidence.action = Array.from(action); evidence.active = true;
      for (let substep = 0; substep < 4; substep++) {
        const torques = computeMotorTorques(context, action);
        for (let i = 0; i < 12; i++) data.ctrl[context.actuatorIds[i]] = torques[i];
        const before = data.time; mujoco.mj_step(model, data); evidence.physicsSteps++;
        evidence.warningCounts = readControllerWarnings(data);
        if (data.time <= before) evidence.timeResets++;
        if (evidence.timeResets || evidence.warningCounts.some((n, i) => n > warningsBaseline[i]) || !finite(data.qpos) || !finite(data.qvel))
          throw Error('MuJoCo warning, non-finite state or automatic time reset; reset the robot');
      }
      mujoco.mj_forward(model, data); evidence.controlSteps++;
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
    cancelStep(); disposed = true; evidence.ready = false;
    disposeControllerContext(context);
    // Release after any in-flight run has returned; generation checks make its
    // result inert immediately, even if the caller deletes model/data now.
    if (!injectedSession) {
      const release = () => busy ? setTimeout(release, 0) : session.release().catch(() => {});
      release();
    }
  }
  reset();
  return { reset, step, cancelStep, pause: cancelStep, dispose, snapshot,
    observe: (command = [0, 0, 0]) => observeCheetah(context, command, previousAction), manifest };
}
