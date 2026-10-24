import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

// This module owns policy tensors, never the caller's MjModel or MjData.
// Coordinates and all state updates are MuJoCo Z-up; rendering is separate.
const finite = values => Array.from(values).every(Number.isFinite);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const aborted = () => new DOMException('Controller step was cancelled', 'AbortError');
const DEFAULT_POLICY = '/controller/flower/policy.onnx';

export function readFlowerControllerWarnings(data) {
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

// Public helpers expose the exact exported 18-action/66-observation contract for
// independent parity tests. No terrain rays or four-leg assumptions are used.
// A playground may append static world geoms and free props after the robot.
// The exported robot must still lead the model unchanged: root free joint at
// qpos/qvel 0 and every named joint at its exported address, so the policy
// reads and drives exactly the state it was trained on.
function requireFlowerRobotPrefix(mujoco, model, manifest, jointIds) {
  const root = manifest.model?.joints?.[0]?.name;
  if (!root || mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, root) !== 0 ||
      model.jnt_type[0] !== 0 || model.jnt_qposadr[0] !== 0 || model.jnt_dofadr[0] !== 0)
    throw Error('Flower root free joint must be the first joint of the model');
  if (manifest.jointQposAdr?.length !== 18 || manifest.jointDofAdr?.length !== 18 ||
      jointIds.some((id, i) => model.jnt_qposadr[id] !== manifest.jointQposAdr[i] || model.jnt_dofadr[id] !== manifest.jointDofAdr[i]))
    throw Error('Flower joints must keep their exported qpos/qvel addresses');
}

export function createFlowerControllerContext(mujoco, model, data, manifest) {
  if (model.nq < 25 || model.nv < 24 || model.nu !== 18)
    throw Error('Flower control requires the exported nq=25, nv=24, nu=18 training model');
  if (manifest.observationSize !== 66 || manifest.actionSize !== 18 || manifest.scan != null || manifest.normalizerIncluded !== true)
    throw Error('Flower requires the normalized 66-input, 18-output proprioceptive policy export');
  for (const key of ['jointNames', 'actuatorNames', 'motors', 'defaultJointPosition', 'defaultJointVelocity', 'encoderBias'])
    if (manifest[key]?.length !== 18) throw Error(`Flower manifest must specify 18 ${key}`);
  for (const key of ['defaultJointPosition', 'defaultJointVelocity', 'encoderBias'])
    if (!finite(manifest[key])) throw Error(`Flower manifest contains invalid ${key}`);
  if (manifest.initialQpos?.length !== 25 || manifest.initialQvel?.length !== 24 || !finite(manifest.initialQpos) || !finite(manifest.initialQvel))
    throw Error('Flower manifest has an invalid initial state');
  if (manifest.footSiteNames?.length !== 6 || new Set(manifest.footSiteNames).size !== 6)
    throw Error('Flower manifest must identify six distinct foot sites');
  if (Math.abs(model.opt.timestep - .005) > 1e-10 || manifest.decimation !== 4 || Math.abs(manifest.controlDt - .02) > 1e-10)
    throw Error('Flower requires four 0.005-second physics substeps per control step');
  if (manifest.actionScale !== .25 || manifest.actionClip != null)
    throw Error('Flower uses raw actions, scale 0.25, without action clipping');
  const expectedTerms = [[0,3],[3,3],[6,3],[9,18],[27,18],[45,18],[63,3]];
  if (manifest.observationTerms?.length !== 7 || manifest.observationTerms.some((t,i) => t.start !== expectedTerms[i][0] || t.length !== expectedTerms[i][1] || t.scale !== 1))
    throw Error('Flower observation ordering/scales do not match the exported contract');
  const jointIds = manifest.jointNames.map(n => idByName(mujoco, model, 'mjOBJ_JOINT', n));
  const actuatorIds = manifest.actuatorNames.map(n => idByName(mujoco, model, 'mjOBJ_ACTUATOR', n));
  if (new Set(jointIds).size !== 18 || new Set(actuatorIds).size !== 18)
    throw Error('Flower joints and actuators must be distinct');
  requireFlowerRobotPrefix(mujoco, model, manifest, jointIds);
  for (let i = 0; i < 18; i++) {
    const motor = manifest.motors[i];
    if (model.actuator_trnid[actuatorIds[i] * 2] !== jointIds[i] || motor.jointName !== manifest.jointNames[i] || motor.actuatorName !== manifest.actuatorNames[i])
      throw Error(`Flower actuator/joint mapping differs at ${manifest.jointNames[i]}`);
    for (const key of ['kp', 'kd', 'effortLimit', 'saturationEffort', 'velocityLimit'])
      if (!Number.isFinite(motor[key]) || motor[key] <= 0) throw Error(`Invalid Flower motor ${key}`);
  }
  const sensorAddress = name => {
    const id = idByName(mujoco, model, 'mjOBJ_SENSOR', name);
    if (model.sensor_dim[id] !== 3) throw Error(`Expected three-axis sensor ${name}`);
    return model.sensor_adr[id];
  };
  const fall = manifest.fallCriteria;
  if (!Number.isFinite(fall?.orientationLimitRad) || !Number.isFinite(fall?.minimumRootHeightAboveGround))
    throw Error('Flower ground-relative fall criteria are required');
  const planes = (manifest.model?.geoms ?? []).filter(g => g.type === 0);
  if (planes.length !== 1) throw Error('Flower controller requires the exported single ground plane');
  return {
    mujoco, model, data, manifest, jointIds, actuatorIds,
    qposAddresses: jointIds.map(i => model.jnt_qposadr[i]),
    qvelAddresses: jointIds.map(i => model.jnt_dofadr[i]),
    linearAddress: sensorAddress(manifest.sensorNames.linearVelocity),
    angularAddress: sensorAddress(manifest.sensorNames.angularVelocity),
    torsoId: idByName(mujoco, model, 'mjOBJ_BODY', manifest.torsoBodyName),
    groundGeomId: idByName(mujoco, model, 'mjOBJ_GEOM', planes[0].name),
    footSiteIds: manifest.footSiteNames.map(n => idByName(mujoco, model, 'mjOBJ_SITE', n)),
    disposed: false,
  };
}

export function disposeFlowerControllerContext(context) { context.disposed = true; }

// Actor order: body linear/ angular velocity, projected gravity, 18 relative
// positions, 18 velocities, 18 previous raw actions, and the 3-value command.
export function observeFlower(context, command = [0, 0, 0], previousAction = new Float32Array(18)) {
  const { data, manifest, torsoId, linearAddress, angularAddress, qposAddresses, qvelAddresses } = context;
  if (context.disposed) throw aborted();
  if (command.length !== 3 || !finite(command) || previousAction.length !== 18 || !finite(previousAction))
    throw Error('Command and previous action must be finite vectors of length 3 and 18');
  const observation = new Float32Array(66);
  observation.set(data.sensordata.slice(linearAddress, linearAddress + 3), 0);
  observation.set(data.sensordata.slice(angularAddress, angularAddress + 3), 3);
  const r = torsoId * 9;
  observation.set([-data.xmat[r + 6], -data.xmat[r + 7], -data.xmat[r + 8]], 6);
  for (let i = 0; i < 18; i++) {
    observation[9 + i] = data.qpos[qposAddresses[i]] - manifest.defaultJointPosition[i];
    observation[27 + i] = data.qvel[qvelAddresses[i]] - manifest.defaultJointVelocity[i];
  }
  observation.set(previousAction, 45); observation.set(command, 63);
  if (!finite(observation)) throw Error('Flower observation contains non-finite values');
  return { observation };
}

export function computeFlowerMotorTorques(context, action) {
  const { data, manifest, qposAddresses, qvelAddresses } = context;
  if (context.disposed) throw aborted();
  if (action.length !== 18 || !finite(action)) throw Error('Policy action must contain 18 finite values');
  const torques = new Float64Array(18);
  for (let i = 0; i < 18; i++) {
    const m = manifest.motors[i], velocity = data.qvel[qvelAddresses[i]];
    const target = manifest.defaultJointPosition[i] + manifest.actionScale * action[i] - manifest.encoderBias[i];
    const effort = m.kp * (target - data.qpos[qposAddresses[i]]) - m.kd * velocity;
    const corner = m.velocityLimit * (1 + m.effortLimit / m.saturationEffort);
    const v = clamp(velocity, -corner, corner);
    const lo = Math.max(m.saturationEffort * (-1 - v / m.velocityLimit), -m.effortLimit);
    const hi = Math.min(m.saturationEffort * (1 - v / m.velocityLimit), m.effortLimit);
    torques[i] = clamp(effort, lo, hi);
  }
  return torques;
}

export function measureFlower(context) {
  const { data, torsoId, groundGeomId, linearAddress, angularAddress, footSiteIds, manifest } = context;
  if (context.disposed) throw aborted();
  const r = torsoId * 9, p = torsoId * 3;
  const position = Array.from(data.xpos.slice(p, p + 3));
  const footPositions = footSiteIds.map(i => Array.from(data.site_xpos.slice(i * 3, i * 3 + 3)));
  const heightAboveFeet = position[2] - footPositions.reduce((sum, foot) => sum + foot[2], 0) / 6;
  const heightAboveGround = position[2] - data.geom_xpos[groundGeomId * 3 + 2];
  const tilt = Math.acos(clamp(data.xmat[r + 8], -1, 1));
  return {
    position, actualVelocity: [data.sensordata[linearAddress], data.sensordata[linearAddress + 1], data.sensordata[angularAddress + 2]],
    heading: Math.atan2(data.xmat[r + 3], data.xmat[r]), footPositions,
    tilt, heightAboveFeet, heightAboveGround,
    fall: tilt > manifest.fallCriteria.orientationLimitRad || heightAboveGround < manifest.fallCriteria.minimumRootHeightAboveGround,
  };
}

// The caller owns model/data. pause/cancelStep invalidates asynchronous inference;
// dispose never deletes borrowed MuJoCo objects and makes late results inert.
export async function createFlowerController({ mujoco, model, data, policyUrl = DEFAULT_POLICY,
  manifest, manifestUrl = '/controller/flower/manifest.json', ort: injectedOrt, session: injectedSession } = {}) {
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
  try { context = createFlowerControllerContext(mujoco, model, data, manifest); }
  catch (error) { if (!injectedSession) await session.release(); throw error; }
  let disposed = false, generation = 0, busy = false, previousAction = new Float32Array(18);
  let startPosition = [0, 0, 0], warningsBaseline = [], evidence;
  const inputName = manifest.onnxInput, outputName = manifest.onnxOutput;
  if (session.inputNames.length !== 1 || session.outputNames.length !== 1 || session.inputNames[0] !== inputName || session.outputNames[0] !== outputName) {
    disposeFlowerControllerContext(context);
    if (!injectedSession) await session.release();
    throw Error('Flower ONNX input/output names differ from the export');
  }
  function currentState() {
    const motion = measureFlower(context);
    return { ...motion, simTime: data.time, contacts: data.ncon,
      displacement: motion.position.map((x, i) => x - startPosition[i]) };
  }
  function snapshot() {
    if (!disposed) Object.assign(evidence, currentState());
    return { ...evidence, ready: !disposed, busy, command: [...evidence.command],
      action: [...evidence.action], warningCounts: [...evidence.warningCounts],
      manifestId: manifest.robotId ?? 'draft-flower-sixleg-s0', controller: 'Flower six-leg PPO; independently trained nominal body',
      physicsEngine: 'MuJoCo WASM 3.11.0', policyRuntime: 'ONNX Runtime Web WASM 1.27.0' };
  }
  function cancelStep() { generation++; if (evidence) evidence.active = false; }
  function reset() {
    if (disposed) throw aborted();
    cancelStep();
    mujoco.mj_resetData(model, data);
    data.qpos.set(manifest.initialQpos); data.qvel.set(manifest.initialQvel); data.ctrl.fill(0);
    mujoco.mj_forward(model, data);
    previousAction = new Float32Array(18); startPosition = measureFlower(context).position;
    warningsBaseline = readFlowerControllerWarnings(data);
    evidence = { ready: true, active: false, error: null, controlSteps: 0, physicsSteps: 0,
      timeResets: 0, warningCounts: [...warningsBaseline], command: [0, 0, 0], action: Array(18).fill(0),
      ...currentState() };
    return snapshot();
  }
  async function step(command = [0, 0, 0]) {
    if (disposed) throw aborted();
    if (busy) throw Error('A Flower control step is already running');
    if (evidence.error || evidence.fall) throw Error(evidence.error ?? 'Robot fell; reset before continuing');
    if (command.length !== 3 || !finite(command)) throw Error('Command must be three finite values');
    for (const [i, key] of ['vx', 'vy', 'wz'].entries()) {
      const bounds = manifest.commandBounds?.[key];
      if (!bounds || command[i] < bounds[0] || command[i] > bounds[1])
        throw Error(`Flower ${key} command is outside its trained range`);
    }
    const tick = generation; busy = true;
    let inputTensor, outputs;
    try {
      mujoco.mj_forward(model, data);
      const { observation } = observeFlower(context, command, previousAction);
      inputTensor = new ort.Tensor('float32', observation, [1, 66]);
      outputs = await session.run({ [inputName]: inputTensor });
      // Caller may dispose/reset/switch models during inference. Never touch
      // released model/data or apply a stale action after an await.
      if (disposed || tick !== generation) throw aborted();
      const action = Float32Array.from(outputs[outputName].data);
      if (action.length !== 18 || !finite(action)) throw Error('Policy returned an invalid action');
      previousAction = action; evidence.command = [...command]; evidence.action = Array.from(action); evidence.active = true;
      for (let substep = 0; substep < manifest.decimation; substep++) {
        const torques = computeFlowerMotorTorques(context, action);
        for (let i = 0; i < 18; i++) data.ctrl[context.actuatorIds[i]] = torques[i];
        const before = data.time; mujoco.mj_step(model, data); evidence.physicsSteps++;
        evidence.warningCounts = readFlowerControllerWarnings(data);
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
    cancelStep(); disposed = true; if (evidence) evidence.ready = false;
    disposeFlowerControllerContext(context);
    // Release after any in-flight run has returned; generation checks make its
    // result inert immediately, even if the caller deletes model/data now.
    if (!injectedSession) {
      const release = () => busy ? setTimeout(release, 0) : session.release().catch(() => {});
      release();
    }
  }
  try { reset(); } catch (error) { dispose(); throw error; }
  return { reset, step, cancelStep, pause: cancelStep, dispose, snapshot,
    observe: (command = [0, 0, 0]) => observeFlower(context, command, previousAction), manifest };
}
