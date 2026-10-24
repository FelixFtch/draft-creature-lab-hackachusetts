// Terrain Lab automated trials: every available pilot x every lane and grade,
// headless with real MuJoCo WASM + ONNX Runtime Web and the production
// playground modules. Protocol in play/src/world/terrain-lab.js and
// contracts/world-api.md ("Terrain trials"). Writes qa/terrain-trials.json and
// play/src/world/terrain-results.json (what the playground shows).
//
// Usage: nice -n 10 node qa/terrain-trials.mjs [--pilot legacy-cheetah] [--pilot legacy-flower]
//          [--bundle <url-or-path>]... [--map /creatures=creatures]... [--lanes gap,step] [--no-write-ui]
// With no --pilot/--bundle it runs both legacy pilots. Bundles are loaded
// through createCreaturePilot(bundleUrl) and play/src/creature-controller.js.
import { register } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
register('./world-vite-url-hooks.mjs', import.meta.url);
const { createHarness, root, sha } = await import('./world-harness.mjs');
const { PARK } = await import('../play/src/world/layout-park.js');
const { createWorldSim } = await import('../play/src/world/sim.js');
const { createCreaturePilot } = await import('../play/src/world/pilots.js');
const lab = await import('../play/src/world/terrain-lab.js');

const args = process.argv.slice(2), opt = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const pilotIds = opt('--pilot'), bundles = opt('--bundle');
const laneFilter = opt('--lanes')[0]?.split(',') ?? null;
const maps = [['/creatures', 'creatures'], ['/controller', 'play/public/controller'], ...opt('--map').map(m => m.split('='))];
const kinds = pilotIds.length || bundles.length ? pilotIds : ['legacy-cheetah', 'legacy-flower'];
const r3 = x => (Number.isFinite(x) ? +x.toFixed(3) : null);

// fetch for bundles: http(s) passes through; absolute paths map to repo dirs.
async function bundleFetch(url) {
  if (/^https?:/i.test(url)) return fetch(url);
  const pathname = decodeURIComponent(new URL(url, 'http://local').pathname);
  for (const [prefix, dir] of maps) if (pathname.startsWith(`${prefix}/`)) {
    const file = path.join(root, dir, pathname.slice(prefix.length));
    try { return new Response(await fs.readFile(file)); } catch { return new Response('not found', { status: 404 }); }
  }
  const direct = path.isAbsolute(pathname) && await fs.access(pathname).then(() => true, () => false) ? pathname : path.join(root, pathname);
  try { return new Response(await fs.readFile(direct)); } catch { return new Response('not found', { status: 404 }); }
}

function describe(result, lane, grade, size) {
  if (result.outcome === 'pass') return `passed in ${result.timeS} s`;
  const g = lane.grades.find(x => x.id === result.failure?.grade) ?? grade, front = size?.boundsMax?.[0] ?? 0;
  const where = g ? `${g.label}` : `u=${result.failure?.u}`;
  if (result.failure?.reason === 'pit') return `fell into the pit at the ${where}`;
  if (result.failure?.reason === 'tumble') return `tipped over at the ${where} (u=${result.failure.u} m)`;
  if (result.failure?.reason === 'splash') return `stepped off the pier near the ${where}`;
  if (result.failure?.reason === 'stuck' || result.failure?.reason === 'timeout')
    return g && Number.isFinite(g.at) ? `stalled with its front ${r3(g.at - (result.maxU + front))} m from the ${where} edge (u=${result.maxU} m)` : `stalled at u=${result.maxU} m`;
  return `${result.outcome}: ${result.failure?.reason ?? 'unknown'} at the ${where}`;
}

async function runTrial(sim, laneId, gradeId) {
  const { meta, size } = sim, bounds = meta.commandBounds, canJump = meta.skills.includes('jump');
  const lane = lab.laneById(PARK, laneId), grade = gradeId ? lab.gradeById(lane, gradeId) : null;
  const spawn = lab.trialSpawn(PARK, lane, grade, size);
  sim.resetRobot(sim.spawnAt(spawn));
  const speed = lab.TRIAL_PROTOCOL.commandFraction * bounds.vx[1];
  const trial = lab.createTrial(PARK, { laneId, gradeId, clock: sim.clock, size, speed, driver: 'auto' });
  const driver = lab.createTrialDriver(PARK, { laneId, bounds, size, canJump, startClock: sim.clock });
  const smoother = lab.createCommandSmoother(bounds);
  const jumps = [], t0 = performance.now();
  let steps = 0, peakZ = -Infinity;
  while (trial.state.phase === 'armed' || trial.state.phase === 'running') {
    const out = driver.step(sim.robotPose(), sim.clock), command = smoother.step(out.command);
    let res = null, error = null;
    try { res = await sim.step(command, out.jump ? { jump: true } : undefined); } catch (e) { error = e.message; }
    if (out.jump) jumps.push({ u: r3(lab.labPose(PARK, sim.robotPose()).u), t: r3(sim.clock - trial.state.spawnedAt) });
    const after = sim.robotPose(); peakZ = Math.max(peakZ, after.pos[2]); steps++;
    const fall = error ? (sim.checkFall({ error }) ?? 'error') : sim.checkFall(res.snap);
    trial.update({ clock: sim.clock, pose: after, ground: sim.terrain.groundHeight(after.pos[0], after.pos[1]), fall });
  }
  const s = trial.snapshot();
  const out = { outcome: s.outcome, timeS: s.timeS, sprintS: s.sprintS, passedGrades: s.passed, failure: s.failure,
    maxU: r3(s.maxU), spawnU: r3(spawn.u), commandVx: r3(speed), jumps, steps, peakZ: r3(peakZ), wallSeconds: r3((performance.now() - t0) / 1000) };
  out.observation = describe(out, lane, grade, size);
  return out;
}

const report = {
  schema: 'terrain-trials/1', createdAt: new Date().toISOString(), layout: PARK.id,
  scope: 'Headless Node: production pilots/sim/terrain-lab modules, MuJoCo WASM 3.11, ONNX Runtime Web WASM. One deterministic rollout per trial.',
  protocol: { ...lab.TRIAL_PROTOCOL, description: 'Forward command fixed at commandFraction x the pilot max forward speed, ramped like the game; yaw command = heading hold toward the lane axis; jump triggered at gap/step edges only when the pilot lists a validated jump skill. Full runs start behind the start line; grade trials start on the surface just before the grade.' },
  lab: { start: PARK.lab.start, finish: PARK.lab.finish, sprintMark: PARK.lab.sprint, laneWidth: PARK.lab.laneWidth, pitDepth: PARK.lab.lanes.find(l => l.id === 'gap').deck,
    lanes: PARK.lab.lanes.map(l => ({ id: l.id, title: l.title, grades: l.grades.map(g => ({ id: g.id, label: g.label, kind: g.kind, value: g.value, unit: g.unit, at: g.at, clear: g.clear })) })) },
  sources: {}, pilots: [], matrix: {},
};
for (const f of ['layout-park.js', 'terrain-lab.js', 'sim.js', 'pilots.js', 'inject.js'])
  report.sources[f] = sha(await fs.readFile(path.join(root, 'play/src/world', f)));

const h = await createHarness();
report.engines = { mujoco: h.mj.mj_versionString(), onnxruntime: h.ort.env.versions };
const entries = [...kinds.map(kind => ({ id: kind, kind })), ...bundles.map(b => ({ id: b, kind: 'creature', bundle: b }))];
try {
  for (const entry of entries) {
    const row = { id: entry.id, kind: entry.kind, bundle: entry.bundle ?? null, runs: {}, grades: {}, error: null };
    report.pilots.push(row);
    let sim = null;
    try {
      if (entry.kind === 'creature') {
        const file = path.resolve(root, opt('--controller')[0] ?? 'play/src/creature-controller.js');
        await fs.access(file).catch(() => { throw Error(`${file} is not available (pass --controller <path>)`); });
        const pilot = createCreaturePilot(entry.bundle, { loadModule: () => import(pathToFileURL(file).href), fetch: bundleFetch, ort: h.ort });
        sim = await createWorldSim({ mujoco: h.mj, pilot, layout: PARK });
        row.id = `creature:${sim.meta.policyId ?? entry.bundle}`;
        row.controllerSha256 = sha(await fs.readFile(file));
      } else sim = await h.sim(entry.kind, PARK, { collision: 'torso' });
      sim.resetRobot(sim.spawnAt(PARK.pads[0])); // measures the body at its spawn pose
      const m = sim.meta;
      Object.assign(row, { label: m.label, skills: [...m.skills], canJump: m.skills.includes('jump'), commandBounds: m.commandBounds,
        provenance: m.provenance ?? m.evaluation ?? null, controllerSha256: row.controllerSha256 ?? (entry.kind === 'legacy-cheetah' ? h.controllerSha256?.cheetah : entry.kind === 'legacy-flower' ? h.controllerSha256?.flower : null) ?? null,
        jumpError: m.jumpError ?? null,
        structure: { lengthM: r3(sim.size.length), widthM: r3(sim.size.width), heightM: r3(sim.size.height), rootHeightM: r3(sim.size.rootHeight), massKg: r3(sim.size.mass),
          frontReachM: r3(sim.size.boundsMax[0]), rearReachM: r3(-sim.size.boundsMin[0]), source: 'measured from the compiled MuJoCo model at the spawn pose' } });
      for (const lane of PARK.lab.lanes) {
        if (laneFilter && !laneFilter.includes(lane.id)) continue;
        row.runs[lane.id] = await runTrial(sim, lane.id, null);
        console.log('RUN  ', row.id.padEnd(15), lane.id.padEnd(7), row.runs[lane.id].outcome.padEnd(5), row.runs[lane.id].observation);
        for (const grade of lane.grades) {
          row.grades[grade.id] = { lane: lane.id, ...(await runTrial(sim, lane.id, grade.id)) };
          console.log('GRADE', row.id.padEnd(15), grade.id.padEnd(12), row.grades[grade.id].outcome.padEnd(5), row.grades[grade.id].observation);
        }
      }
      report.matrix[row.id] = Object.fromEntries(Object.entries(row.grades).map(([g, r]) => [g, r.outcome]));
    } catch (error) {
      row.error = String(error.message ?? error);
      console.error('PILOT ERROR', entry.id, error.stack ?? row.error);
    } finally { sim?.dispose(); }
  }
} finally { await h.close(); }

report.pass = report.pilots.length > 0 && report.pilots.filter(p => !p.bundle).every(p => !p.error && Object.keys(p.grades).length > 0);
await fs.writeFile(path.join(root, 'qa/terrain-trials.json'), JSON.stringify(report, null, 2) + '\n');
if (!args.includes('--no-write-ui')) {
  // The playground ships only what the UI needs (no per-step traces).
  const ui = { schema: report.schema, createdAt: report.createdAt, source: 'qa/terrain-trials.json', protocol: report.protocol, lab: report.lab,
    pilots: report.pilots.filter(p => !p.error).map(p => ({ id: p.id, kind: p.kind, label: p.label, skills: p.skills, structure: p.structure,
      runs: Object.fromEntries(Object.entries(p.runs).map(([k, r]) => [k, { outcome: r.outcome, timeS: r.timeS, sprintS: r.sprintS, failure: r.failure, observation: r.observation }])),
      grades: Object.fromEntries(Object.entries(p.grades).map(([k, r]) => [k, { lane: r.lane, outcome: r.outcome, timeS: r.timeS, failure: r.failure, observation: r.observation, jumps: r.jumps.length }])) })),
    matrix: report.matrix };
  await fs.writeFile(path.join(root, 'play/src/world/terrain-results.json'), JSON.stringify(ui, null, 2) + '\n');
}
console.log('RESULT', JSON.stringify({ pass: report.pass, pilots: report.pilots.map(p => ({ id: p.id, error: p.error, matrix: report.matrix[p.id] })) }));
process.exitCode = report.pass ? 0 : 1;
