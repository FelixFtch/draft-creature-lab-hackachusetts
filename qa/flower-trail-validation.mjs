// CPU-only course validation of the public Flower export with production rules.
// Run: node qa/flower-trail-validation.mjs
// This does not exercise a browser, renderer, UI input, or a GPU.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import mujocoFactory from '../play/node_modules/@mujoco/mujoco/mujoco.js';
import * as ort from '../play/node_modules/onnxruntime-web/dist/ort.node.min.mjs';
import { createTrail, updateTrail, trailDrive, TRAIL_TARGETS, TRAIL_RADIUS, TRAIL_LIMIT_SECONDS } from '../play/src/trail-game.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'play/public/controller/flower');
const reportPath = path.join(root, 'qa/flower-trail-validation.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bounds = { vx: [-.3, .4], vy: [0, 0], wz: [-.7, .7] };
// Exactly the Flower branch of draft-lab.js clampDrive, checked below.
const clampDrive = command => [Math.max(-.3, Math.min(.4, command[0])), 0, Math.max(-.7, Math.min(.7, command[2]))];
const report = {
  createdAt: new Date().toISOString(), pass: false,
  scope: 'Node CPU; actual public Flower policy and production controller with MuJoCo WASM + ONNX Runtime Web WASM and production trail rules',
  commandBounds: bounds, targets: TRAIL_TARGETS, radiusMetres: TRAIL_RADIUS, limitSeconds: TRAIL_LIMIT_SECONDS,
  criteria: 'Collect all three ordered XY targets within 60 simulated seconds, finite state and bounded commands at every step, no fall, simulator warning or time reset; preserve result during one second of genuine zero-drive policy execution after completion.',
  limitations: [
    'One deterministic nominal Flower body and one fixed flat course; not a robustness or altered-body result.',
    'The heading assistant is deterministic steering, not a VLM or a learned navigation policy.',
    'Targets are render-only XY checkpoints, not colliders or a physical manipulation task.',
    'This test does not validate browser rendering, input, asynchronous UI lifecycle or physical touch.',
    'Zero drive still runs the learned controller and can step in place; it is not a physics pause.',
  ],
  assetHashes: [], course: null, samples: [], postCompletionSamples: [],
};
let mj, vfs, model, data, session, controller;
const started = performance.now();
try {
  const [source, trailSource, engineSource, manifestBytes, xml, policy, rawBody] = await Promise.all([
    fs.readFile(path.join(root, 'play/src/flower-controller.js'), 'utf8'),
    fs.readFile(path.join(root, 'play/src/trail-game.js'), 'utf8'),
    fs.readFile(path.join(root, 'play/src/draft-lab.js'), 'utf8'),
    fs.readFile(path.join(assetDir, 'manifest.json')),
    fs.readFile(path.join(assetDir, 'scene.xml')),
    fs.readFile(path.join(assetDir, 'policy.onnx')),
    fs.readFile(path.join(root, 'robots/flower/generated/flower.xml')),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const clampSource = engineSource.match(/function clampDrive\(command\)\s*\{[\s\S]*?\n  \}/)?.[0];
  assert(clampSource, 'Engine clampDrive source was not found');
  assert.equal(clampSource.replace(/\s/g, ''), "functionclampDrive(command){constflower=manifest?.preset==='flower';return[Math.max(flower?-.3:-.5,Math.min(flower?.4:.7,command[0])),0,Math.max(-.7,Math.min(.7,command[2]))];}", 'Engine command clamp changed; review this test before running');
  assert.deepEqual(manifest.commandBounds, bounds);
  report.controllerSha256 = hash(source);
  report.trailSourceSha256 = hash(trailSource);
  report.engineSourceSha256 = hash(engineSource);
  report.engineClampSourceSha256 = hash(clampSource);
  report.manifestSha256 = hash(manifestBytes);
  report.policySha256 = hash(policy);
  report.xmlSha256 = hash(xml);
  report.rawBodyXmlSha256 = hash(rawBody);
  report.checkpointSha256 = manifest.checkpointSha256;
  assert.equal(report.policySha256, manifest.policySha256);
  assert.equal(report.xmlSha256, manifest.xmlSha256);
  assert.equal(report.rawBodyXmlSha256, manifest.rawBodyXmlSha256);
  assert.equal(manifest.controlDt, .02);
  assert.equal(TRAIL_LIMIT_SECONDS, 60);

  // Replace only Vite's URL import so the unchanged production controller can
  // load in Node. Inference uses a real ORT Web WASM session injected below.
  const viteImport = "import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';";
  assert(source.includes(viteImport));
  const production = source.replace(viteImport, "const ortWasmUrl = 'node-injected-session';");
  const { createFlowerController } = await import(`data:text/javascript;base64,${Buffer.from(production).toString('base64')}`);
  mj = await mujocoFactory();
  vfs = new mj.MjVFS();
  for (const asset of manifest.assets) {
    const relative = new URL(asset.url, 'http://localhost').pathname.replace(/^\/controller\/flower\//, '');
    const file = path.resolve(assetDir, relative);
    assert(file.startsWith(`${assetDir}${path.sep}`), 'Asset escaped the public Flower directory');
    const bytes = await fs.readFile(file);
    assert.equal(hash(bytes), asset.sha256);
    report.assetHashes.push({ name: asset.name, sha256: hash(bytes) });
    vfs.addBuffer(asset.name, new Uint8Array(bytes));
  }
  model = mj.MjModel.from_xml_string(xml.toString('utf8'), vfs);
  data = new mj.MjData(model);
  assert.deepEqual([model.nq, model.nv, model.nu, model.ngeom], [25, 24, 18, manifest.model.ngeom]);
  ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create(new Uint8Array(policy), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  controller = await createFlowerController({ mujoco: mj, model, data, manifest, ort, session });
  report.engines = { mujoco: mj.mj_versionString(), onnxruntime: ort.env.versions };
  report.model = { nq: model.nq, nv: model.nv, nu: model.nu, ngeom: model.ngeom, controlDt: manifest.controlDt };

  let trail = createTrail(data.time, true), pathLength = 0, clampedSteps = 0, issue = null;
  const safety = { allFinite: true, allCommandsBounded: true, falls: 0, zeroWarnings: true, timeResets: 0 };
  const records = [];
  function recordState(state, command, destination, requestedCommand = command) {
    const qpos = Array.from(data.qpos), qvel = Array.from(data.qvel);
    const finite = [state.simTime, state.heading, state.tilt, ...state.position, ...state.actualVelocity, ...state.action, ...qpos, ...qvel].every(Number.isFinite);
    const bounded = command.every(Number.isFinite) && command[0] >= -.3 && command[0] <= .4 && command[1] === 0 && Math.abs(command[2]) <= .7;
    safety.allFinite &&= finite;
    safety.allCommandsBounded &&= bounded;
    safety.falls += Number(!!state.fall);
    safety.zeroWarnings &&= state.warningCounts.every(n => n === 0);
    safety.timeResets = Math.max(safety.timeResets, state.timeResets);
    destination.push({ simTime: state.simTime, command, requestedCommand, position: state.position, heading: state.heading,
      actualVelocity: state.actualVelocity, tilt: state.tilt, heightAboveGround: state.heightAboveGround,
      contacts: state.contacts, fall: state.fall, warningCounts: state.warningCounts, timeResets: state.timeResets,
      phase: trail.phase, collected: trail.collected, distanceToNextTarget: trail.distance, finite, bounded });
    if (!finite || !bounded || state.fall || !safety.zeroWarnings || safety.timeResets || state.error)
      throw Error(state.error || 'Course safety criterion failed; see recorded sample');
  }
  try {
    const maxTicks = Math.ceil(TRAIL_LIMIT_SECONDS / manifest.controlDt);
    for (let i = 0; i < maxTicks && trail.phase === 'active'; i++) {
      const before = controller.snapshot(), count = trail.collected;
      const requestedCommand = trailDrive(trail, before), command = clampDrive(requestedCommand);
      if (command.some((value, index) => value !== requestedCommand[index])) clampedSteps++;
      const after = await controller.step(command);
      trail = updateTrail(trail, after);
      pathLength += Math.hypot(after.position[0] - before.position[0], after.position[1] - before.position[1]);
      recordState(after, command, report.samples, requestedCommand);
      if (trail.collected !== count) {
        const event = { ...trail.records.at(-1), controlStep: i + 1 };
        records.push(event);
        console.log('COLLECTED', JSON.stringify(event));
      }
    }
  } catch (error) { issue = error.message; }
  const endState = controller.snapshot(), completedCopy = JSON.stringify(trail);
  if (trail.phase === 'complete' && !issue) {
    try {
      for (let i = 0; i < 50; i++) {
        const command = clampDrive(trailDrive(trail, controller.snapshot()));
        assert.deepEqual(command, [0, 0, 0]);
        const after = await controller.step(command);
        trail = updateTrail(trail, after);
        recordState(after, command, report.postCompletionSamples);
      }
    } catch (error) { issue = error.message; }
  }
  const collectionEvidenceValid = records.length === 3 && records.every((record, i) =>
    record.targetIndex === i && Math.hypot(record.position[0] - record.target[0], record.position[1] - record.target[1]) <= TRAIL_RADIUS);
  const postCompletion = { steps: report.postCompletionSamples.length,
    allZeroCommands: report.postCompletionSamples.every(s => s.command.every(x => x === 0)),
    frozenResult: JSON.stringify(trail) === completedCopy, finalState: controller.snapshot() };
  report.course = { phase: trail.phase, reason: trail.reason, score: trail.collected, total: trail.total,
    elapsedSeconds: trail.elapsedSeconds, assistedSeconds: trail.assistedSeconds, executedTicks: report.samples.length,
    records, pathLengthMetres: pathLength, clampedSteps, collectionEvidenceValid, ...safety,
    endState, postCompletion, error: issue };
  report.pass = trail.phase === 'complete' && trail.collected === 3 && trail.elapsedSeconds < TRAIL_LIMIT_SECONDS &&
    !issue && collectionEvidenceValid && safety.allFinite && safety.allCommandsBounded && safety.falls === 0 &&
    safety.zeroWarnings && safety.timeResets === 0 && postCompletion.steps === 50 &&
    postCompletion.allZeroCommands && postCompletion.frozenResult;
  report.course.pass = report.pass;
} catch (error) {
  report.error = error.message;
  report.pass = false;
} finally {
  // Injected inference session is caller-owned; controller disposes its own
  // context before native data/model are deleted.
  try { controller?.dispose(); await session?.release(); data?.delete(); model?.delete(); vfs?.delete(); }
  catch (error) { report.cleanupError = error.message; report.pass = false; }
  report.wallSeconds = (performance.now() - started) / 1000;
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log('RESULT', JSON.stringify({ pass: report.pass, score: report.course?.score, elapsedSeconds: report.course?.elapsedSeconds,
  ticks: report.course?.executedTicks, clampedSteps: report.course?.clampedSteps, falls: report.course?.falls,
  zeroWarnings: report.course?.zeroWarnings, timeResets: report.course?.timeResets, error: report.error ?? report.course?.error ?? null }));
process.exitCode = report.pass ? 0 : 1;
