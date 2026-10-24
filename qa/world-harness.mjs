// Shared headless harness for the playground QA: real MuJoCo WASM, real ONNX
// Runtime Web (WASM backend) and the production controllers/pilots/sim.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mujocoFactory from '../play/node_modules/@mujoco/mujoco/mujoco.js';
import * as ort from '../play/node_modules/onnxruntime-web/dist/ort.node.min.mjs';
import { createLegacyCheetahPilot, createLegacyFlowerPilot } from '../play/src/world/pilots.js';
import { createWorldSim } from '../play/src/world/sim.js';
import { createAutopilot } from '../play/src/world/autopilot.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Same single source adaptation as the legacy controller QA: only Vite's
// asset-URL import is replaced; inference still runs ORT Web WASM.
async function loadController(file) {
  const source = await fs.readFile(path.join(root, 'play/src', file), 'utf8');
  const production = source.replace("import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';", "const ortWasmUrl = 'node-injected-session';");
  if (production === source) throw Error(`${file}: expected Vite wasm import`);
  return { api: await import(`data:text/javascript;base64,${Buffer.from(production).toString('base64')}`), sha256: sha(source) };
}

// fetch() for /controller/... URLs, served from play/public like Vite would.
export async function localFetch(url) {
  const pathname = new URL(url, 'http://localhost').pathname;
  if (!pathname.startsWith('/controller/')) return new Response('not found', { status: 404 });
  const file = path.join(root, 'play/public', pathname);
  if (!file.startsWith(path.join(root, 'play/public') + path.sep)) return new Response('bad path', { status: 400 });
  try { return new Response(await fs.readFile(file), { status: 200 }); }
  catch { return new Response('not found', { status: 404 }); }
}

export async function createHarness() {
  const mj = await mujocoFactory();
  ort.env.wasm.numThreads = 1;
  const cheetah = await loadController('cheetah-controller.js');
  const flower = await loadController('flower-controller.js');
  const sessions = {};
  for (const name of ['cheetah', 'flower'])
    sessions[name] = await ort.InferenceSession.create(new Uint8Array(await fs.readFile(path.join(root, `play/public/controller/${name}/policy.onnx`))),
      { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  function pilot(kind, options = {}) {
    const isCheetah = kind === 'legacy-cheetah';
    const make = isCheetah ? createLegacyCheetahPilot : createLegacyFlowerPilot;
    // The browser Flower pilot checks /api/flower-status; headless, the same
    // gate is the passing, hash-matched report checked by the validation.
    return make({ fetch: localFetch, readinessUrl: null, ort, session: sessions[isCheetah ? 'cheetah' : 'flower'],
      createController: isCheetah ? cheetah.api.createCheetahController : flower.api.createFlowerController, ...options });
  }
  return {
    mj, ort, pilot, controllerSha256: { cheetah: cheetah.sha256, flower: flower.sha256 }, controllerApi: { cheetah: cheetah.api, flower: flower.api },
    sim: (kind, layout, options = {}) => createWorldSim({ mujoco: mj, pilot: pilot(kind, options), layout }),
    async close() { for (const s of Object.values(sessions)) await s.release(); },
  };
}

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// Drive one lane with the deterministic autopilot and measure the outcome.
export async function runLane(sim, lane, { speed = .8, timeout = 45, settle = 1, extraWaypoints = [], until = null, sample = null } = {}) {
  const pad = { x: lane.from[0], y: lane.from[1], yaw: lane.yaw };
  sim.resetRobot(sim.spawnAt(pad));
  const bounds = sim.meta.commandBounds;
  const pilotAp = createAutopilot({ waypoints: [...extraWaypoints, lane.to], speed, reach: .3 });
  const startPose = sim.robotPose();
  const total = Math.hypot(lane.to[0] - lane.from[0], lane.to[1] - lane.from[1]);
  let steps = 0, fall = null, error = null, maxTilt = 0, maxProgress = 0, stuckSince = 0, lastProgress = 0, peakZ = startPose.pos[2];
  const settleSteps = Math.round(settle / .02), limit = Math.round(timeout / .02);
  const dir = [(lane.to[0] - lane.from[0]) / total, (lane.to[1] - lane.from[1]) / total];
  let done = false, reason = 'timeout';
  for (; steps < limit; steps++) {
    const pose = sim.robotPose();
    const command = steps < settleSteps ? [0, 0, 0] : pilotAp.command(pose, bounds);
    let res;
    try { res = await sim.step(command); }
    catch (e) { error = e.message; fall = sim.checkFall({ error }) ?? 'error'; reason = 'fall'; break; }
    const after = sim.robotPose();
    maxTilt = Math.max(maxTilt, after.tilt); peakZ = Math.max(peakZ, after.pos[2]);
    const progress = ((after.pos[0] - lane.from[0]) * dir[0] + (after.pos[1] - lane.from[1]) * dir[1]) / total;
    maxProgress = Math.max(maxProgress, progress);
    sample?.(steps, after, res);
    fall = sim.checkFall(res.snap);
    if (fall) { reason = 'fall'; break; }
    if (until && until(after, res)) { done = true; reason = 'goal'; break; }
    if (pilotAp.done) { done = true; reason = 'arrived'; break; }
    if (maxProgress > lastProgress + .02) { lastProgress = maxProgress; stuckSince = steps; }
    else if (steps - stuckSince > 600 && steps > settleSteps + 600) { reason = 'stuck'; break; }
  }
  const end = sim.robotPose();
  const seconds = steps * .02;
  return { lane: lane.id, success: done, reason, fall, error, seconds: +seconds.toFixed(2), steps,
    progress: +Math.min(1, maxProgress).toFixed(3), maxTiltDeg: +(maxTilt * 180 / Math.PI).toFixed(1),
    meanSpeed: +(maxProgress * total / Math.max(.02, seconds - settle)).toFixed(3), peakZ: +peakZ.toFixed(3),
    end: end.pos.map(v => +v.toFixed(3)), headingErrorDeg: +(wrap(end.heading - lane.yaw) * 180 / Math.PI).toFixed(1) };
}
