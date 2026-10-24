// CPU-only validation of the production Flower controller. No browser or GPU.
// Usage: node qa/flower-controller-validation.mjs [--asset-dir play/public/controller/flower]
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mujocoFactory from '../play/node_modules/@mujoco/mujoco/mujoco.js';
import * as ort from '../play/node_modules/onnxruntime-web/dist/ort.node.min.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--asset-dir')) throw Error('Expected --asset-dir PATH only');
const assetDir = path.resolve(root, args[1] ?? 'play/public/controller/flower');
const reportPath = path.join(root, 'qa/flower-controller-validation.json');
const source = await fs.readFile(path.join(root, 'play/src/flower-controller.js'), 'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = {
  createdAt: new Date().toISOString(), pass: false,
  scope: 'Node CPU, actual production Flower controller, MuJoCo WASM and ONNX Runtime Web WASM; not live browser/device validation',
  controllerSha256: sha(source), policySha256: null, xmlSha256: null, rawBodyXmlSha256: null,
  assetHashes: [], modelParity: {}, fixtureParity: [], motorParity: [], fixedActionTrajectory: [], episodes: [], lifecycle: {},
  locomotionCriteria: {
    scope: 'Engineering acceptance for this one nominal flat six-leg body; not a paper benchmark or robustness study.',
    episodeSeconds: 12, settleSeconds: 2,
    stability: 'All 600 control steps, finite state, zero warning increments/time resets, no ground-relative fall.',
    standing: { maximumMeasuredXYDisplacementM: .35, maximumMeanPlanarSpeedMps: .12, maximumAbsYawChangeRad: .5 },
    translation: { minimumSignedMeanVxFractionOfCommand: .4, minimumSignedWorldXDisplacementStraightOnlyM: .5 },
    turning: { minimumSignedMeanWzFractionOfCommand: .4, minimumSignedHeadingChangeRad: 1 },
    movingFeet: { minimumTotalContactOnEdges: 6, minimumFeetWithVerticalExcursion: 3, verticalExcursionM: .01 },
    note: 'Lateral/heading drift is measured and reported; passing does not certify precise navigation.',
  },
  limitations: ['Single deterministic nominal body and initial state.', 'Only exported six foot colliders; no obstacle/manipulation evidence.', 'Fixtures use native CPU float32 reference math, not captured GPU Warp states.', 'Browser rendering, UI lifecycle and physical touch remain separate checks.'],
};
const flatten = x => Array.isArray(x) ? x.flat(Infinity) : Array.from(x);
const check = (label, actual, expected, tolerance = 1e-9) => {
  const a = flatten(actual), b = flatten(expected);
  const error = a.length === b.length ? Math.max(0, ...a.map((x, i) => Math.abs(x - b[i]))) : Infinity;
  return { label, maxAbs: Number.isFinite(error) ? error : null, tolerance, pass: Number.isFinite(error) && error <= tolerance };
};
const mean = values => values.reduce((sum, x) => sum + x, 0) / values.length;
const wrap = value => Math.atan2(Math.sin(value), Math.cos(value));
let mj, vfs, model, data, context, session, controller, api;
try {
  const manifest = JSON.parse(await fs.readFile(path.join(assetDir, 'manifest.json'), 'utf8'));
  const fixtures = JSON.parse(await fs.readFile(path.join(assetDir, 'fixtures.json'), 'utf8'));
  const xml = await fs.readFile(path.join(assetDir, 'scene.xml'));
  const policy = await fs.readFile(path.join(assetDir, 'policy.onnx'));
  report.xmlSha256 = sha(xml); report.policySha256 = sha(policy);
  report.rawBodyXmlSha256 = sha(await fs.readFile(path.join(root, 'robots/flower/generated/flower.xml')));
  report.checkpointSha256 = manifest.checkpointSha256;
  report.manifestSha256 = sha(await fs.readFile(path.join(assetDir, 'manifest.json')));
  report.fixtureSha256 = sha(await fs.readFile(path.join(assetDir, 'fixtures.json')));
  report.assetHashes.push(
    { name: 'scene.xml', pass: report.xmlSha256 === manifest.xmlSha256 },
    { name: 'policy.onnx', pass: report.policySha256 === manifest.policySha256 },
    { name: 'frozen body', pass: report.rawBodyXmlSha256 === (manifest.rawBodyXmlSha256 ?? manifest.sourceRobotXmlSha256) },
    { name: 'fixture model', pass: fixtures.source.modelSha256 === manifest.xmlSha256 },
    { name: 'fixture checkpoint', pass: fixtures.source.checkpointSha256 === manifest.checkpointSha256 },
  );
  // Only Vite's asset-URL import is replaced; inference still uses ORT Web WASM.
  const production = source.replace("import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';", "const ortWasmUrl = 'node-injected-session';");
  api = await import(`data:text/javascript;base64,${Buffer.from(production).toString('base64')}`);
  mj = await mujocoFactory(); vfs = new mj.MjVFS();
  for (const asset of manifest.assets) {
    const relative = new URL(asset.url, 'http://localhost').pathname.replace(/^\/controller\/flower\//, '');
    const file = path.resolve(assetDir, relative);
    if (!file.startsWith(`${assetDir}${path.sep}`)) throw Error('Asset path escaped export directory');
    const bytes = await fs.readFile(file);
    report.assetHashes.push({ name: asset.name, sha256: sha(bytes), pass: sha(bytes) === asset.sha256 });
    vfs.addBuffer(asset.name, new Uint8Array(bytes));
  }
  if (!report.assetHashes.every(x => x.pass)) throw Error('Export or frozen-body identity mismatch');
  model = mj.MjModel.from_xml_string(xml.toString(), vfs); data = new mj.MjData(model);
  context = api.createFlowerControllerContext(mj, model, data, manifest);
  ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create(new Uint8Array(policy), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  report.engines = { nativeFixture: fixtures.source.nativeMujoco, wasm: mj.mj_versionString(), onnxruntime: ort.env.versions };
  function restore(f) { mj.mj_resetData(model, data); data.qpos.set(f.qpos); data.qvel.set(f.qvel); mj.mj_forward(model, data); }
  async function infer(observation) {
    const input = new ort.Tensor('float32', Float32Array.from(observation), [1, 66]); let outputs;
    try { outputs = await session.run({ [manifest.onnxInput]: input }); return Array.from(outputs[manifest.onnxOutput].data); }
    finally { input.dispose(); if (outputs) for (const value of Object.values(outputs)) value.dispose(); }
  }
  const checks = [];
  for (const key of ['nq', 'nv', 'nu', 'nbody', 'ngeom', 'nsensor']) checks.push(check(key, [model[key]], [manifest.model[key]], 0));
  for (const body of manifest.model.bodies) {
    checks.push(check(`body ${body.id} mass`, [model.body_mass[body.id]], [body.mass], 1e-8));
    for (const [property, expected, count] of [['body_inertia', body.inertia, 3], ['body_ipos', body.inertialPosition, 3], ['body_iquat', body.inertialQuaternion, 4]])
      checks.push(check(`${property} ${body.id}`, model[property].slice(body.id * count, (body.id + 1) * count), expected, 1e-8));
  }
  for (const geom of manifest.model.geoms) {
    checks.push(check(`geom ${geom.id} masks`, [model.geom_group[geom.id], model.geom_contype[geom.id], model.geom_conaffinity[geom.id], model.geom_condim[geom.id], model.geom_priority[geom.id]], [geom.group, geom.contype, geom.conaffinity, geom.condim, geom.priority], 0));
    checks.push(check(`geom ${geom.id} friction`, model.geom_friction.slice(geom.id * 3, geom.id * 3 + 3), geom.friction));
    checks.push(check(`geom ${geom.id} size`, model.geom_size.slice(geom.id * 3, geom.id * 3 + 3), geom.size, 1e-7));
  }
  for (const joint of manifest.model.joints) {
    checks.push(check(`joint ${joint.id} addresses`, [model.jnt_qposadr[joint.id], model.jnt_dofadr[joint.id]], [joint.qposAdr, joint.dofAdr], 0));
    checks.push(check(`joint ${joint.id} range`, model.jnt_range.slice(joint.id * 2, joint.id * 2 + 2), joint.range));
    checks.push(check(`joint ${joint.id} passive`, [model.dof_armature[joint.dofAdr], model.dof_damping[joint.dofAdr], model.dof_frictionloss[joint.dofAdr]], [joint.armature, joint.damping, joint.frictionloss]));
  }
  for (const actuator of manifest.model.actuators) {
    checks.push(check(`actuator ${actuator.id} mapping/ranges`, [model.actuator_trnid[actuator.id * 2], ...model.actuator_ctrlrange.slice(actuator.id * 2, actuator.id * 2 + 2), ...model.actuator_forcerange.slice(actuator.id * 2, actuator.id * 2 + 2)], [actuator.jointId, ...actuator.ctrlRange, ...actuator.forceRange]));
    checks.push(check(`actuator ${actuator.id} gear`, model.actuator_gear.slice(actuator.id * 6, actuator.id * 6 + 6), actuator.gear));
  }
  for (const sensor of manifest.model.sensors) checks.push(check(`sensor ${sensor.id}`, [model.sensor_type[sensor.id], model.sensor_adr[sensor.id], model.sensor_dim[sensor.id], model.sensor_objtype[sensor.id], model.sensor_objid[sensor.id]], [sensor.type, sensor.adr, sensor.dim, sensor.objType, sensor.objId], 0));
  const expectedEnums = { integrator: mj.mjtIntegrator.mjINT_IMPLICITFAST.value, cone: mj.mjtCone.mjCONE_PYRAMIDAL.value, jacobian: mj.mjtJacobian.mjJAC_AUTO.value, solver: mj.mjtSolver.mjSOL_NEWTON.value };
  for (const key of ['timestep', 'impratio', 'integrator', 'cone', 'jacobian', 'solver', 'iterations', 'tolerance', 'ls_iterations', 'ls_tolerance']) checks.push(check(`physics ${key}`, [model.opt[key]], [expectedEnums[key] ?? manifest.physics[key]], 1e-12));
  checks.push(check('gravity', model.opt.gravity, manifest.physics.gravity, 1e-12));
  report.modelParity = { pass: checks.every(x => x.pass), robotMass: Array.from(model.body_mass).reduce((sum, mass) => sum + mass, 0), checks };
  console.log('MODEL', report.modelParity.pass, checks.filter(x => !x.pass));

  if (fixtures.fixtures.length < 6 || !fixtures.motorCases.length || fixtures.fixedActionTrajectory.steps.length !== 4) throw Error('Incomplete native fixture coverage');
  for (const fixture of fixtures.fixtures) {
    restore(fixture);
    const { observation } = api.observeFlower(context, fixture.command, fixture.previousAction);
    const action = await infer(observation);
    const comparisons = manifest.observationTerms.map(term => check(term.name, observation.slice(term.start, term.start + term.length), fixture.observation.slice(term.start, term.start + term.length), 3e-6));
    comparisons.push(check('onnxAction', action, fixture.onnxAction, 2e-5), check('pytorchAction', action, fixture.action, 2e-5), check('torque', api.computeFlowerMotorTorques(context, fixture.action), fixture.torque, 1e-4));
    const row = { name: fixture.name, pass: comparisons.every(x => x.pass), comparisons };
    report.fixtureParity.push(row); console.log('FIXTURE', fixture.name, row.pass, comparisons.filter(x => !x.pass));
  }
  for (const motor of fixtures.motorCases) {
    restore(fixtures.fixtures[0]);
    for (let i = 0; i < 18; i++) { data.qpos[context.qposAddresses[i]] = motor.jointPosition[i]; data.qvel[context.qvelAddresses[i]] = motor.jointVelocity[i]; }
    report.motorParity.push(check(motor.name, api.computeFlowerMotorTorques(context, motor.rawAction), motor.torque, 1e-4));
  }
  const trajectory = fixtures.fixedActionTrajectory;
  restore(fixtures.fixtures.find(fixture => fixture.name === trajectory.startFixture));
  for (const frame of trajectory.steps) {
    const torques = api.computeFlowerMotorTorques(context, trajectory.rawAction);
    for (let i = 0; i < 18; i++) data.ctrl[context.actuatorIds[i]] = torques[i];
    mj.mj_step(model, data); mj.mj_forward(model, data);
    const comparisons = [check('torque', torques, frame.torque, 1e-3), check('qpos', data.qpos, frame.qpos, 1e-5), check('qvel', data.qvel, frame.qvel, 1e-3)];
    report.fixedActionTrajectory.push({ substep: frame.substep, pass: comparisons.every(x => x.pass), comparisons });
  }
  api.disposeFlowerControllerContext(context); context = null;
  controller = await api.createFlowerController({ mujoco: mj, model, data, manifest, ort, session });
  const contactAddresses = manifest.footGeomNames.map(name => {
    const logical = name.split('/').at(-1), sensorName = `feet_ground_contact_${logical}_found`;
    const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_SENSOR.value, sensorName);
    if (id < 0) throw Error(`Missing foot contact evidence sensor: ${sensorName}`);
    return model.sensor_adr[id];
  });
  const scenarios = [
    ['stationary', [0,0,0]], ['forward', [.3,0,0]], ['backward', [-.2,0,0]],
    ['turn_left', [0,0,.5]], ['turn_right', [0,0,-.5]],
    ['forward_max', [.4,0,0]], ['backward_max', [-.3,0,0]],
    ['turn_left_max', [0,0,.7]], ['turn_right_max', [0,0,-.7]],
    ['forward_left_combined', [.4,0,.7]], ['forward_right_combined', [.4,0,-.7]],
  ];
  for (const [name, command] of scenarios) {
    controller.reset(); const started = performance.now(), samples = []; let error = null;
    for (let step = 0; step < 600; step++) {
      try {
        const state = await controller.step(command);
        samples.push({ step: step + 1, time: state.simTime, position: state.position, velocity: state.actualVelocity,
          heading: state.heading, tilt: state.tilt, heightAboveGround: state.heightAboveGround,
          fall: state.fall, contacts: state.contacts, footContact: contactAddresses.map(address => data.sensordata[address] > 0),
          footHeight: state.footPositions.map(foot => foot[2]), jointPosition: Array.from(data.qpos.slice(7)) });
        if (state.fall) break;
      } catch (err) { error = err.message; break; }
    }
    const measured = samples.slice(100), last = measured.at(-1), first = samples[99], final = controller.snapshot();
    const edges = Array(6).fill(0); let headingChange = 0;
    for (let i = 0; i < measured.length; i++) {
      const previous = i === 0 ? first : measured[i - 1];
      headingChange += wrap(measured[i].heading - previous.heading);
      for (let foot = 0; foot < 6; foot++) if (!previous.footContact[foot] && measured[i].footContact[foot]) edges[foot]++;
    }
    const velocity = measured.length ? [0,1,2].map(i => mean(measured.map(sample => sample.velocity[i]))) : [0,0,0];
    const displacement = first && last ? last.position.map((value, i) => value - first.position[i]) : [0,0,0];
    const excursion = measured.length ? Array.from({ length: 6 }, (_, foot) => Math.max(...measured.map(sample => sample.footHeight[foot])) - Math.min(...measured.map(sample => sample.footHeight[foot]))) : Array(6).fill(0);
    const stabilityPass = samples.length === 600 && !error && !final.fall && final.timeResets === 0 && final.warningCounts.every(value => value === 0);
    const moving = command[0] !== 0 || command[2] !== 0;
    const footActivityPass = !moving || (edges.reduce((sum, count) => sum + count, 0) >= 6 && excursion.filter(height => height >= .01).length >= 3);
    const outcomes = [];
    if (!moving) outcomes.push({ criterion: 'standingDrift', pass: Math.hypot(...displacement.slice(0,2)) <= .35 && measured.length > 0 && mean(measured.map(sample => Math.hypot(...sample.velocity.slice(0,2)))) <= .12 && Math.abs(headingChange) <= .5 });
    if (command[0] !== 0) outcomes.push({ criterion: 'translationResponse', pass: Math.sign(command[0]) * velocity[0] >= Math.abs(command[0]) * .4 && (command[2] !== 0 || Math.sign(command[0]) * displacement[0] >= .5) });
    if (command[2] !== 0) outcomes.push({ criterion: 'turnResponse', pass: Math.sign(command[2]) * velocity[2] >= Math.abs(command[2]) * .4 && Math.sign(command[2]) * headingChange >= 1 });
    const row = { name, command, pass: stabilityPass && footActivityPass && outcomes.every(outcome => outcome.pass), stabilityPass, footActivityPass, outcomes,
      requestedSteps: 600, executedSteps: samples.length, measuredSeconds: measured.length * .02, error, final,
      meanActualVelocity: velocity, meanAbsoluteTrackingError: measured.length ? [0,1,2].map(i => mean(measured.map(sample => Math.abs(sample.velocity[i] - command[i])))) : null,
      measurementDisplacement: displacement, headingChange, footContactOnEdges: edges, footVerticalExcursion: excursion,
      wallSeconds: (performance.now() - started) / 1000, traceSampleEverySteps: 10, samples: samples.filter((_, index) => index % 10 === 0 || index === samples.length - 1) };
    report.episodes.push(row);
    console.log('EPISODE', JSON.stringify({ name, pass: row.pass, stabilityPass, footActivityPass, outcomes, velocity, displacement, headingChange, error }));
  }
  controller.dispose(); controller = null;

  for (const operation of ['reset', 'pause', 'dispose']) {
    const localData = new mj.MjData(model); let resolveRun;
    const delayed = { inputNames: [manifest.onnxInput], outputNames: [manifest.onnxOutput], run: () => new Promise(resolve => { resolveRun = resolve; }) };
    const current = await api.createFlowerController({ mujoco: mj, model, data: localData, manifest, ort, session: delayed });
    const pending = current.step([.3,0,0]).then(() => ({ resolved: true }), err => ({ name: err.name, message: err.message }));
    current[operation](); if (operation === 'dispose') localData.delete();
    resolveRun({ [manifest.onnxOutput]: new ort.Tensor('float32', new Float32Array(18), [1,18]) });
    const result = await pending, time = operation === 'dispose' ? null : localData.time;
    report.lifecycle[operation] = { ...result, time, pass: result.name === 'AbortError' && (time === null || time === 0) };
    current.dispose(); if (operation !== 'dispose') localData.delete();
  }
  {
    const current = await api.createFlowerController({ mujoco: mj, model, data, manifest, ort, session });
    data.qvel[0] = NaN; let error = null;
    try { await current.step([0,0,0]); } catch (err) { error = err.message; }
    const state = current.snapshot(); report.lifecycle.invalidState = { error, pass: !!error && !state.active }; current.dispose();
  }
  {
    const current = await api.createFlowerController({ mujoco: mj, model, data, manifest, ort, session });
    let error = null; try { await current.step([.7,0,0]); } catch (err) { error = err.message; }
    report.lifecycle.rejectCheetahSpeed = { error, pass: !!error && data.time === 0 }; current.dispose();
  }
  {
    const current = await api.createFlowerController({ mujoco: mj, model, data, manifest, ort, session });
    await current.step([.3,0,0]); current.pause();
    const before = { qpos: Array.from(data.qpos), time: data.time };
    current.snapshot(); current.snapshot();
    const unchanged = data.time === before.time && check('paused qpos', data.qpos, before.qpos, 0).pass;
    await current.step([.3,0,0]);
    report.lifecycle.pauseResume = { pass: unchanged && data.time > before.time && current.snapshot().controlSteps === 2 };
    current.dispose();
  }
  {
    const c = api.createFlowerControllerContext(mj, model, data, manifest);
    const min = manifest.fallCriteria.minimumRootHeightAboveGround;
    const cases = [];
    for (const [name, height, roll, expectedFall] of [['belowHeight', min - 1e-5, 0, true], ['aboveHeight', min + 1e-5, 0, false], ['overTilt', .3, 1.001, true], ['underTilt', .3, .999, false]]) {
      data.qpos.set(manifest.initialQpos); data.qvel.fill(0); data.qpos[2] = height;
      data.qpos[3] = Math.cos(roll / 2); data.qpos[4] = Math.sin(roll / 2); data.qpos[5] = 0; data.qpos[6] = 0;
      mj.mj_forward(model, data); const state = api.measureFlower(c);
      cases.push({ name, heightAboveGround: state.heightAboveGround, tilt: state.tilt, pass: state.fall === expectedFall });
    }
    report.lifecycle.flowerGroundFallCriteria = { cases, pass: cases.every(value => value.pass) }; api.disposeFlowerControllerContext(c);
  }
  {
    const original = globalThis.fetch; let error = null;
    globalThis.fetch = async () => new Response(new Uint8Array([1,2,3]), { status: 200 });
    try { await api.createFlowerController({ mujoco: mj, model, data, manifest: { ...manifest, policySha256: '0'.repeat(64) }, ort }); }
    catch (err) { error = err.message; } finally { globalThis.fetch = original; }
    report.lifecycle.badPolicyHash = { error, pass: error === 'Controller policy SHA-256 does not match the verified export' };
  }
  {
    const failedReset = { ...mj, mj_resetData() { throw Error('Injected reset failure'); } };
    let error = null;
    try { await api.createFlowerController({ mujoco: failedReset, model, data, manifest, ort, session }); }
    catch (err) { error = err.message; }
    report.lifecycle.constructorFailure = { error, pass: error === 'Injected reset failure' };
  }
  report.parityPass = report.assetHashes.every(value => value.pass) && report.modelParity.pass && report.fixtureParity.every(value => value.pass) && report.motorParity.every(value => value.pass) && report.fixedActionTrajectory.every(value => value.pass);
  report.locomotionPass = report.episodes.every(value => value.pass);
  report.lifecyclePass = Object.values(report.lifecycle).every(value => value.pass);
  report.pass = report.parityPass && report.locomotionPass && report.lifecyclePass;
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error('VALIDATION ERROR', report.error);
} finally {
  controller?.dispose(); if (context) api?.disposeFlowerControllerContext(context);
  if (session) await session.release(); data?.delete(); model?.delete(); vfs?.delete();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log('RESULT', JSON.stringify({ pass: report.pass, parity: report.parityPass, locomotion: report.locomotionPass, lifecycle: report.lifecyclePass, report: reportPath }));
process.exitCode = report.pass ? 0 : 1;
