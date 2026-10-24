// CPU-only validation of play/src/creature-controller.js against creature-gym bundles:
// real MuJoCo WASM 3.11.0 + ONNX Runtime Web WASM, no browser or GPU.
// Usage: node qa/creature-controller-validation.mjs [--bundle DIR] [--jump DIR] [--report FILE]
//   default bundle: training/dev-bundles/cheetah/policies/walk (jump: sibling ../jump if present)
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mujocoFactory from '../play/node_modules/@mujoco/mujoco/mujoco.js';
import * as ort from '../play/node_modules/onnxruntime-web/dist/ort.node.min.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[i + 1]]]), []));
const walkDir = path.resolve(root, args.bundle ?? 'training/dev-bundles/cheetah/policies/walk');
const jumpDir = args.jump ? path.resolve(root, args.jump) : (fss.existsSync(path.join(walkDir, '../jump/manifest.json')) ? path.resolve(walkDir, '../jump') : null);
const reportPath = path.resolve(root, args.report ?? 'qa/creature-controller-validation.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = await fs.readFile(path.join(root, 'play/src/creature-controller.js'), 'utf8');
const CONTROL_DT = 0.02;

const report = {
  createdAt: new Date().toISOString(), pass: false,
  scope: 'Node CPU: production creature-controller.js with MuJoCo WASM 3.11.0 and ONNX Runtime Web WASM; not a live-browser test',
  controllerSha256: sha(source), bundle: path.relative(root, walkDir), jumpBundle: jumpDir ? path.relative(root, jumpDir) : null,
  hashes: {}, fixtureParity: { walk: [], jump: [] }, closedLoop: { walk: [], jump: [] }, lifecycle: {},
  tolerances: {}, notes: [],
};
const flatten = x => Array.isArray(x) ? x.flat(Infinity) : Array.from(x);
const check = (label, actual, expected, tolerance) => {
  const a = flatten(actual), b = flatten(expected);
  const error = a.length === b.length ? Math.max(0, ...a.map((x, i) => Math.abs(x - b[i]))) : Infinity;
  return { label, maxAbs: Number.isFinite(error) ? error : null, tolerance, pass: Number.isFinite(error) && error <= tolerance };
};
const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// Local files served through the controller's own fetch-based loader.
const fileFetch = overrides => async url => {
  const file = path.resolve(url);
  if (overrides?.[path.basename(file)]) return new Response(overrides[path.basename(file)], { status: 200 });
  try { return new Response(await fs.readFile(file), { status: 200 }); } catch { return new Response('missing', { status: 404 }); }
};

const production = source.replace("import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';", "const ortWasmUrl = 'node-injected-session';");
if (production === source) throw Error('Could not adapt the Vite asset import');
const api = await import(`data:text/javascript;base64,${Buffer.from(production).toString('base64')}`);
let mj, vfs, model;
const toDelete = [];
try {
  ort.env.wasm.numThreads = 1;
  const walk = await api.loadCreatureBundle(walkDir, { fetchImpl: fileFetch() });
  const jump = jumpDir ? await api.loadCreatureBundle(jumpDir, { fetchImpl: fileFetch() }) : null;
  for (const [name, b] of [['walk', walk], ['jump', jump]]) {
    if (!b) continue;
    report.hashes[name] = { sceneSha256: b.manifest.sceneSha256, policySha256: b.manifest.policySha256,
      evalSha256: b.manifest.evaluation.evalSha256, evalPass: b.evaluation.pass, verifiedByController: true };
  }
  mj = await mujocoFactory(); vfs = new mj.MjVFS();
  for (const [name, bytes] of walk.assets) vfs.addBuffer(name, bytes);
  model = mj.MjModel.from_xml_string(walk.sceneXml, vfs);
  report.engines = { wasm: mj.mj_versionString(), onnxruntime: ort.env.versions, pythonEval: walk.evaluation.engine };
  const sessions = {};
  for (const [name, b] of [['walk', walk], ['jump', jump]]) if (b) sessions[name] = await ort.InferenceSession.create(b.policyBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const spy = name => {
    const real = sessions[name];
    const s = { inputNames: real.inputNames, outputNames: real.outputNames, lastInput: null, lastOutput: null,
      async run(feeds) {
        s.lastInput = Float32Array.from(feeds[real.inputNames[0]].data);
        const out = await real.run(feeds);
        s.lastOutput = Float32Array.from(out[real.outputNames[0]].data);
        return out;
      }, release: async () => {} };
    return s;
  };
  const m = walk.manifest;
  const rootDof = model.jnt_dofadr[mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, m.rootJoint)];
  const rootQpos = model.jnt_qposadr[mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, m.rootJoint)];

  // ---------------------------------------------------------------- fixture parity
  async function fixtureParity(fixtureBundle, label) {
    const fixtures = JSON.parse(await fs.readFile(path.join(fixtureBundle.url, 'fixtures.json'), 'utf8'));
    if (sha(await fs.readFile(path.join(fixtureBundle.url, 'fixtures.json'))) !== fixtureBundle.manifest.fixtures.sha256) throw Error('fixtures.json hash mismatch');
    const tol = fixtures.tolerances; report.tolerances[label] = tol;
    const data = new mj.MjData(model); toDelete.push(data);
    const walkSpy = spy('walk'), jumpSpy = jump ? spy('jump') : null;
    const controller = await api.createCreatureController({ mujoco: mj, model, data, ort,
      walk: { ...walk, session: walkSpy }, jump: jump ? { ...jump, session: jumpSpy } : null });
    for (const step of fixtures.steps) {
      controller.restore({ ...step.before });
      await controller.step(step.command, { jump: step.jump });
      const used = step.modeUsed === 'jump' ? jumpSpy : walkSpy;
      const state = controller.controllerState();
      const ctrl = Array.from(data.ctrl.slice(0, m.actuatorNames.length));
      const comparisons = [check('obs', used.lastInput, step.obs, tol.obs), check('action', used.lastOutput, step.action, tol.action),
        check('ctrl', ctrl, step.ctrl, tol.ctrl), check('qposAfter', data.qpos, step.after.qpos, tol.qposAfter),
        check('qvelAfter', data.qvel, step.after.qvel, tol.qvelAfter),
        check('phaseAfter', [state.phase, state.jumpPhase], [step.after.phase, step.after.jumpPhase], 1e-12),
        check('lastActionAfter', state.lastAction, step.after.lastAction, tol.action),
        { label: 'modeAfter', pass: state.mode === step.after.mode }];
      report.fixtureParity[label].push({ k: step.k, modeUsed: step.modeUsed, pass: comparisons.every(c => c.pass), comparisons });
    }
    controller.dispose();
    const failed = report.fixtureParity[label].filter(r => !r.pass);
    console.log('FIXTURES', label, `${report.fixtureParity[label].length - failed.length}/${report.fixtureParity[label].length}`, failed.slice(0, 2).map(r => r.comparisons.filter(c => !c.pass)));
  }
  await fixtureParity(walk, 'walk');
  if (jump) await fixtureParity(jump, 'jump');

  // ---------------------------------------------------------------- closed loop vs eval.json
  const schedule = (rows, t) => { let c = rows[0].slice(1); for (const r of rows) if (t + 1e-9 >= r[0]) c = r.slice(1); return c; };
  async function runScenario(sc, withJump) {
    const data = new mj.MjData(model); toDelete.push(data);
    const controller = await api.createCreatureController({ mujoco: mj, model, data, ort,
      walk: { ...walk, session: sessions.walk }, jump: withJump ? { ...jump, session: sessions.jump } : null });
    controller.reset();
    if (sc.initialQpos) {
      const q = sc.initialQpos;
      for (let i = 0; i < 7; i++) data.qpos[rootQpos + i] = q[i];
      data.qpos[rootQpos + 2] += 0.005;
      m.jointNames.forEach((n, i) => { data.qpos[model.jnt_qposadr[mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, n)]] = q[7 + i]; });
      mj.mj_forward(model, data);
    }
    if (sc.initialVelocity) { for (let i = 0; i < 3; i++) data.qvel[rootDof + i] = sc.initialVelocity[i]; mj.mj_forward(model, data); }
    const start = controller.snapshot();
    const steps = Math.round(sc.durationS / CONTROL_DT), samples = [];
    const pushes = new Map((sc.pushes ?? []).map(p => [Math.round(p[0] / CONTROL_DT), p.slice(1)]));
    const jumps = new Set((sc.jumps ?? []).map(t => Math.round(t / CONTROL_DT)));
    let error = null;
    for (let k = 0; k < steps; k++) {
      if (pushes.has(k)) { const [dvx, dvy] = pushes.get(k); data.qvel[rootDof] += dvx; data.qvel[rootDof + 1] += dvy; mj.mj_forward(model, data); }
      let s;
      try { s = await controller.step(schedule(sc.schedule, k * CONTROL_DT), { jump: jumps.has(k) }); } catch (e) { error = e.message; break; }
      // s.mode is the mode after this step (the last jump step already reports 'walk').
      samples.push({ t: (k + 1) * CONTROL_DT, mode: s.mode, pos: s.position, vel: s.actualVelocity, yaw: s.heading, tilt: s.tilt, heightAboveFeet: s.heightAboveFeet, fall: s.fall,
        airborne: s.footContact.every(c => !c) && s.footPositions.every((f, i) => f[2] - m.footRadius[i] > 0.005), jumps: s.jumps });
      if (s.fall) break;
    }
    controller.dispose();
    return { samples, start, error };
  }
  function summarize(samples, start, from) {
    const win = samples.filter(s => s.t > from + 1e-9); const w = win.length ? win : samples.slice(-1);
    let heading = 0, prev = start.heading;
    for (const s of samples) { heading += wrap(s.yaw - prev); prev = s.yaw; }
    return { meanVelocity: [0, 1, 2].map(i => mean(w.map(s => s.vel[i]))), planarSpeed: mean(w.map(s => Math.hypot(s.vel[0], s.vel[1]))),
      displacement: samples.at(-1).pos.map((x, i) => x - start.position[i]), headingChange: heading };
  }
  const vmax = m.moving.vmax, wmax = m.moving.wmax;
  for (const row of walk.evaluation.rows) {
    if (row.terrain) { report.closedLoop.walk.push({ name: row.name, skipped: 'terrain rows need the training height field (Python-only)' }); continue; }
    const res = await runScenario(row, false);
    const steps = Math.round(row.durationS / CONTROL_DT);
    const fell = !!res.samples.at(-1)?.fall, complete = res.samples.length === steps && !res.error && !fell;
    const sum = summarize(res.samples, res.start, row.measureFromS);
    const cmd = row.command, crit = row.criteria ?? {}, outcomes = [];
    if ('minVxFraction' in crit) outcomes.push(Math.sign(cmd[0]) * sum.meanVelocity[0] >= crit.minVxFraction * Math.abs(cmd[0]));
    if ('minWzFraction' in crit) outcomes.push(Math.sign(cmd[2]) * sum.meanVelocity[2] >= crit.minWzFraction * Math.abs(cmd[2]));
    if ('maxAbsWz' in crit) outcomes.push(Math.abs(sum.meanVelocity[2]) <= crit.maxAbsWz);
    if ('maxPlanarSpeed' in crit) outcomes.push(sum.planarSpeed <= crit.maxPlanarSpeed);
    if ('maxPlanarDriftM' in crit) outcomes.push(Math.hypot(sum.displacement[0], sum.displacement[1]) <= crit.maxPlanarDriftM);
    if ('maxAbsHeadingChange' in crit) outcomes.push(Math.abs(sum.headingChange) <= crit.maxAbsHeadingChange);
    const jsPass = complete && outcomes.every(Boolean);
    // Velocity agreement: WASM and native float paths may diverge slowly; statistics must stay close.
    const tolV = [0.05 * vmax + 0.15 * Math.abs(row.meanVelocity[0]), 0.05 * vmax + 0.15 * Math.abs(row.meanVelocity[1]), 0.05 * wmax + 0.15 * Math.abs(row.meanVelocity[2])];
    const agree = sum.meanVelocity.map((v, i) => Math.abs(v - row.meanVelocity[i]) <= tolV[i]);
    const result = { name: row.name, pythonPass: row.pass, jsPass, fallPython: row.fall, fallJs: fell, error: res.error,
      meanVelocityPython: row.meanVelocity, meanVelocityJs: sum.meanVelocity, toleranceVelocity: tolV,
      pass: jsPass === row.pass && fell === row.fall && agree.every(Boolean) };
    report.closedLoop.walk.push(result);
    console.log('CLOSED', row.name, JSON.stringify({ pass: result.pass, py: row.meanVelocity, js: sum.meanVelocity.map(v => +v.toFixed(4)), jsPass, pyPass: row.pass }));
  }
  if (jump) {
    for (const row of jump.evaluation.rows) {
      const res = await runScenario(row, true);
      const steps = Math.round(row.durationS / CONTROL_DT);
      const fell = !!res.samples.at(-1)?.fall, complete = res.samples.length === steps && !res.error && !fell;
      const measured = row.jumpsMeasured.map(pj => {
        const k0 = Math.round(pj.t / CONTROL_DT), before = k0 > 0 ? res.samples[k0 - 1] : { pos: res.start.position };
        const window = []; for (let k = k0; k < res.samples.length && res.samples[k].mode === 'jump'; k++) window.push(res.samples[k]);
        // a sample's mode is the mode *after* that step; the last jump step reports 'walk'
        if (k0 + window.length < res.samples.length) window.push(res.samples[k0 + window.length]);
        if (!window.length || !before) return { executed: false };
        const apex = Math.max(...window.map(s => s.pos[2])) - before.pos[2];
        const air = window.filter(s => s.airborne).length * CONTROL_DT;
        return { apexGainM: apex, airborneS: air, python: pj, agree: Math.abs(apex - pj.apexGainM) <= 0.02 + 0.2 * Math.abs(pj.apexGainM) };
      });
      const result = { name: row.name, pythonPass: row.pass, fallPython: row.fall, fallJs: fell, complete, error: res.error, jumps: measured,
        pass: fell === row.fall && measured.every(j => j.agree) };
      report.closedLoop.jump.push(result);
      console.log('CLOSED JUMP', row.name, JSON.stringify({ pass: result.pass, jumps: measured.map(j => [j.apexGainM, j.python?.apexGainM, j.airborneS, j.python?.airborneS]) }));
    }
  }

  // ---------------------------------------------------------------- lifecycle and refusals
  for (const operation of ['reset', 'pause', 'dispose']) {
    const localData = new mj.MjData(model); let resolveRun;
    const gated = { inputNames: [m.onnxInput], outputNames: [m.onnxOutput], run: () => new Promise(r => { resolveRun = r; }), release: async () => {} };
    const c = await api.createCreatureController({ mujoco: mj, model, data: localData, ort, walk: { ...walk, session: gated } });
    const t0 = localData.time;
    const pending = c.step([0.3 * vmax, 0, 0]).then(() => ({ resolved: true }), e => ({ name: e.name, message: e.message }));
    c[operation](); if (operation === 'dispose') localData.delete();
    resolveRun({ [m.onnxOutput]: new ort.Tensor('float32', new Float32Array(m.jointNames.length), [1, m.jointNames.length]) });
    const result = await pending, time = operation === 'dispose' ? null : localData.time;
    report.lifecycle[operation] = { ...result, pass: result.name === 'AbortError' && (time === null || time === t0) };
    c.dispose(); if (operation !== 'dispose') localData.delete();
  }
  {
    const d = new mj.MjData(model); toDelete.push(d);
    const c = await api.createCreatureController({ mujoco: mj, model, data: d, ort, walk: { ...walk, session: sessions.walk } });
    d.qvel[rootDof] = NaN; let error = null;
    try { await c.step([0, 0, 0]); } catch (e) { error = e.message; }
    report.lifecycle.invalidState = { error, pass: !!error && !c.snapshot().active }; c.dispose();
  }
  {
    const d = new mj.MjData(model); toDelete.push(d);
    const c = await api.createCreatureController({ mujoco: mj, model, data: d, ort, walk: { ...walk, session: sessions.walk } });
    const s = await c.step([10, 3, -10]);
    report.lifecycle.commandClamped = { command: s.command, clamped: s.commandClamped,
      pass: s.commandClamped && s.command[0] === m.commandBounds.vx[1] && s.command[1] === m.commandBounds.vy[1] && s.command[2] === m.commandBounds.wz[0] };
    c.dispose();
  }
  const refusal = async (label, overrides, expected) => {
    let error = null;
    try { await api.loadCreatureBundle(walkDir, { fetchImpl: fileFetch(overrides) }); } catch (e) { error = e.message; }
    report.lifecycle[label] = { error, pass: !!error && error.includes(expected) };
  };
  await refusal('badPolicyHash', { 'policy.onnx': new Uint8Array([1, 2, 3]) }, 'policy SHA-256 does not match');
  await refusal('tamperedScene', { 'scene.xml': walk.sceneXml.replace('cg_floor', 'cg_floor2') }, 'scene.xml SHA-256 does not match');
  {
    const failing = { ...walk.evaluation, pass: false };
    const evalBytes = Buffer.from(JSON.stringify(failing));
    const manifest = { ...m, evaluation: { ...m.evaluation, evalSha256: sha(evalBytes), pass: false } };
    await refusal('failingEvalRefused', { 'eval.json': evalBytes, 'manifest.json': JSON.stringify(manifest) }, 'did not pass validation');
    const noEval = { ...m }; delete noEval.evaluation;
    await refusal('missingEvalRefused', { 'manifest.json': JSON.stringify(noEval) }, 'no evaluation');
  }
  {
    // World content after the robot: a free prop body (larger nq) and a static box.
    const worldXml = walk.sceneXml.replace('</worldbody>',
      '  <geom name="world_box" type="box" size="0.3 0.3 0.05" pos="3 0 0.05" contype="1" conaffinity="15"/>\n' +
      '    <body name="prop_ball" pos="2 1 0.3"><freejoint name="prop_ball_free"/><geom name="prop_ball_geom" type="sphere" size="0.12" mass="0.5" contype="8" conaffinity="15"/></body>\n  </worldbody>');
    const worldModel = mj.MjModel.from_xml_string(worldXml, vfs); const d = new mj.MjData(worldModel);
    let error = null, propKept = false, steps = 0;
    try {
      const c = await api.createCreatureController({ mujoco: mj, model: worldModel, data: d, ort, walk: { ...walk, session: sessions.walk } });
      const propAdr = worldModel.jnt_qposadr[mj.mj_name2id(worldModel, mj.mjtObj.mjOBJ_JOINT.value, 'prop_ball_free')];
      d.qpos[propAdr] = 2.5; d.qpos[propAdr + 1] = -1.5; mj.mj_forward(worldModel, d);
      c.reset({ x: 1, y: -0.5, yaw: 0.7 });
      propKept = d.qpos[propAdr] === 2.5 && d.qpos[propAdr + 1] === -1.5;
      for (let k = 0; k < 50; k++) { await c.step([0.5 * vmax, 0, 0]); steps++; }
      const s = c.snapshot();
      report.lifecycle.extraWorldBodies = { nqRobot: model.nq, nqWorld: worldModel.nq, propKeptOnReset: propKept, steps, fall: s.fall,
        headingAfterSpawn: s.heading, pass: worldModel.nq === model.nq + 7 && propKept && steps === 50 && !s.fall };
      c.dispose();
    } catch (e) { error = e.message; report.lifecycle.extraWorldBodies = { error, pass: false }; }
    d.delete(); worldModel.delete();
  }
  {
    const pilot = api.createCreaturePilot({ walkUrl: walkDir, jumpUrl: jumpDir, fetchImpl: fileFetch(), ort });
    const prepared = await pilot.prepare();
    const pv = new mj.MjVFS(); for (const [n, b] of prepared.assets) pv.addBuffer(n, b);
    const pm = mj.MjModel.from_xml_string(prepared.xml, pv), pd = new mj.MjData(pm);
    const handle = await pilot.attach({ mujoco: mj, model: pm, data: pd });
    handle.reset({ x: 0, y: 0, yaw: 0 });
    let s; for (let k = 0; k < 25; k++) s = await handle.step([0.4 * vmax, 0, 0]);
    let jumped = null;
    if (prepared.meta.skills.includes('jump')) { s = await handle.step([0, 0, 0], { jump: true }); jumped = s.mode === 'jump'; }
    report.lifecycle.pilot = { meta: prepared.meta, steps: s.controlSteps, fall: s.fall, jumpEngaged: jumped,
      pass: prepared.xml === walk.sceneXml && s.controlSteps >= 25 && !s.fall && jumped !== false };
    handle.dispose(); pd.delete(); pm.delete(); pv.delete();
  }
  report.parityPass = [...report.fixtureParity.walk, ...report.fixtureParity.jump].every(r => r.pass) && report.fixtureParity.walk.length > 0;
  report.closedLoopPass = [...report.closedLoop.walk, ...report.closedLoop.jump].every(r => r.skipped || r.pass);
  report.lifecyclePass = Object.values(report.lifecycle).every(r => r.pass);
  report.pass = report.parityPass && report.closedLoopPass && report.lifecyclePass;
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error('VALIDATION ERROR', report.error);
} finally {
  for (const d of toDelete) { try { d.delete(); } catch { /* already deleted */ } }
  model?.delete(); vfs?.delete();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 1) + '\n');
}
console.log('RESULT', JSON.stringify({ pass: report.pass, parity: report.parityPass, closedLoop: report.closedLoopPass, lifecycle: report.lifecyclePass,
  lifecycleFailures: Object.entries(report.lifecycle).filter(([, v]) => !v.pass).map(([k]) => k), report: path.relative(root, reportPath) }));
process.exitCode = report.pass ? 0 : 1;
