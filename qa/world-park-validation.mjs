// Headless validation of the Creature Park playground with the two legacy
// policies: real MuJoCo WASM 3.11, real ONNX Runtime Web (WASM backend), the
// production controllers, pilots, injection, sim and game rules.
// Writes qa/world-park-validation.json and the honest per-zone capability map
// play/src/world/capability-map.json consumed by the playground UI.
// Usage: nice -n 10 node qa/world-park-validation.mjs [--quick]
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHarness, runLane, root, sha } from './world-harness.mjs';
import { PARK } from '../play/src/world/layout-park.js';
import { createGame, createMemoryStorage } from '../play/src/world/game.js';
import { createExplore, validateExploreDecision, findLandmark } from '../play/src/world/explore.js';
import { injectWorld } from '../play/src/world/inject.js';
import { createAutopilot } from '../play/src/world/autopilot.js';

const quick = process.argv.includes('--quick');
const reportPath = path.join(root, 'qa/world-park-validation.json');
const mapPath = path.join(root, 'play/src/world/capability-map.json');
const read = p => fs.readFile(path.join(root, p));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const r3 = x => +x.toFixed(3);
const report = {
  createdAt: new Date().toISOString(), pass: false,
  scope: 'Node CPU, production playground modules with MuJoCo WASM 3.11 and ONNX Runtime Web WASM; deterministic rollouts driven by a proportional waypoint driver (not a planner, not AI). Not a live-browser or real-robot test.',
  sources: {}, legacyReports: {}, layout: {}, compile: {}, prefixGuards: {}, terrainConsistency: {}, propPreservation: {}, standing: {},
  lanes: {}, collisionModes: {}, scanVisibility: {}, gameLogic: {}, explore: {}, capability: null, checks: [],
};
const check = (name, pass, detail = null) => { report.checks.push({ name, pass: !!pass, detail }); console.log(pass ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail).slice(0, 220) : ''); return !!pass; };

let h;
try {
  for (const file of ['layout-park.js', 'terrain.js', 'inject.js', 'sim.js', 'pilots.js', 'game.js', 'explore.js', 'autopilot.js'])
    report.sources[file] = sha(await read(`play/src/world/${file}`));
  h = await createHarness();
  report.engines = { mujoco: h.mj.mj_versionString(), onnxruntime: h.ort.env.versions };
  report.sources['cheetah-controller.js'] = h.controllerSha256.cheetah;
  report.sources['flower-controller.js'] = h.controllerSha256.flower;

  // 1. The legacy controller reports must pass for the EDITED controllers
  //    (same identity rule as the draft-service Flower readiness gate).
  for (const name of ['cheetah', 'flower']) {
    const legacy = JSON.parse(await read(`qa/${name}-controller-validation.json`));
    const ok = legacy.pass === true && legacy.controllerSha256 === h.controllerSha256[name];
    report.legacyReports[name] = { pass: legacy.pass, createdAt: legacy.createdAt, controllerSha256: legacy.controllerSha256, matchesSource: legacy.controllerSha256 === h.controllerSha256[name] };
    check(`legacy ${name} controller report passes and matches the edited controller`, ok, report.legacyReports[name]);
  }

  // 2. Layout sanity: everything on the island, zones apart, pads clear.
  {
    const R = PARK.islandRadius, far = [];
    // Farthest footprint point of each static (box corners / cylinder rim).
    const reach = s => {
      if (s.type === 'box') {
        let m = 0;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          const q = s.quat, v = [sx * s.size[0], sy * s.size[1], 0], [w, x, y, z] = q;
          const rx = (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1], ry = 2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1];
          m = Math.max(m, Math.hypot(s.pos[0] + rx, s.pos[1] + ry));
        }
        return m;
      }
      return Math.hypot(s.pos[0], s.pos[1]) + (s.type === 'capsule' ? 0 : s.size[0]);
    };
    for (const s of PARK.statics) if (reach(s) > R - .3) far.push(`${s.name}@${reach(s).toFixed(2)}`);
    for (const p of PARK.props) if (Math.hypot(p.pos[0], p.pos[1]) > R - 1) far.push(p.name);
    for (const s of PARK.sparks) if (Math.hypot(s.x, s.y) > R - .8) far.push(s.id);
    check('all world geoms, props and sparks are on the island', far.length === 0, { outside: far });
    // Every physical feature of a zone lies inside that zone (wedge + rect),
    // so zones never intrude on each other.
    const strays = [];
    for (const s of PARK.statics) if (PARK.zones.some(z => z.id === s.zone) && PARK.zoneAt(s.pos[0], s.pos[1]) !== s.zone) strays.push(s.name);
    for (const p of PARK.props) if (PARK.zoneAt(p.pos[0], p.pos[1]) !== p.zone) strays.push(p.name);
    for (const s of PARK.sparks) if (PARK.zones.some(z => z.id === s.zone) && PARK.zoneAt(s.x, s.y) !== s.zone) strays.push(s.id);
    for (const pad of PARK.pads.slice(1)) if (PARK.zoneAt(pad.x, pad.y) === 'shore') strays.push(pad.id);
    check('every zone feature lies inside its own zone', strays.length === 0, { strays });
    report.layout = { islandRadius: R, zones: PARK.zones.length, statics: PARK.statics.length, props: PARK.props.length, sparks: PARK.sparks.length,
      landmarks: PARK.landmarks.length, lanes: PARK.lanes.map(l => l.id), plateau: { gentleDeg: PARK.plateau.gentle.slopeDeg, steepDeg: PARK.plateau.steep.slopeDeg },
      steps: Object.fromEntries(Object.entries(PARK.steps).map(([k, s]) => [k, { riserM: s.riser, count: s.count }])), hills: PARK.hfields[0].bumps.length };
  }

  // 3. Compile with each pilot: robot prefix untouched, props after it.
  const kinds = ['legacy-flower', 'legacy-cheetah'];
  for (const kind of kinds) {
    const t0 = performance.now();
    const sim = await h.sim(kind, PARK, { collision: 'torso' });
    try {
      const manifest = JSON.parse(await read(`play/public/controller/${kind === 'legacy-cheetah' ? 'cheetah' : 'flower'}/manifest.json`));
      const { mj } = h, m = sim.model;
      const jointIds = manifest.jointNames.map(n => mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, n));
      const prefixOk = jointIds.every((id, i) => m.jnt_qposadr[id] === manifest.jointQposAdr[i] && m.jnt_dofadr[id] === manifest.jointDofAdr[i]) &&
        m.jnt_qposadr[0] === 0 && mj.mj_id2name(m, mj.mjtObj.mjOBJ_JOINT.value, 0) === manifest.model.joints[0].name;
      const bodyIdsOk = manifest.model.bodies.every(b => mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, b.name) === b.id);
      const geomIdsOk = manifest.model.geoms.every(g => mj.mj_name2id(m, mj.mjtObj.mjOBJ_GEOM.value, g.name) === g.id);
      const propsAfter = sim.index.props.every(p => p.qposadr >= manifest.model.nq);
      const keys = [...sim.injectedXml.matchAll(/<key\b[^>]*qpos="([^"]*)"/g)].map(k => k[1].trim().split(/\s+/).length);
      const info = { nq: m.nq, nv: m.nv, nu: m.nu, ngeom: m.ngeom, nbody: m.nbody, robotNq: manifest.model.nq, props: sim.index.props.length,
        keyframeQposLengths: keys, prefixOk, bodyIdsOk, geomIdsOk, propsAfter, compileAttachMs: Math.round(performance.now() - t0), size: sim.size };
      report.compile[kind] = info;
      check(`${kind}: park compiles, robot qpos/qvel prefix and ids unchanged, props after robot`, prefixOk && bodyIdsOk && geomIdsOk && propsAfter && m.nu === manifest.model.nu && keys.every(n => n === m.nq), info);

      // Terrain: analytic ground model vs MuJoCo rays on static world geoms.
      sim.resetRobot(sim.spawnAt(PARK.pads[0]));
      const g = new mj.IntBuffer(1); let worst = 0, samples = 0, rand = 1;
      const rnd = () => (rand = (rand * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 3000; i++) {
        const r = Math.sqrt(rnd()) * 11.5, a = rnd() * Math.PI * 2, x = r * Math.cos(a), y = r * Math.sin(a);
        if (r < 1.3) continue;
        const dist = mj.mj_ray(m, sim.data, [x, y, 3], [0, 0, -1], [1, 0, 0, 0, 0, 0], true, sim.index.rootBody, g, null);
        const geom = g.GetView()[0];
        if (geom < 0 || sim.index.robotGeom[geom] || sim.index.propByGeom.has(geom)) continue;
        const name = mj.mj_id2name(m, mj.mjtObj.mjOBJ_GEOM.value, geom) ?? '';
        const s = PARK.statics.find(q => q.name === name);
        if (name !== 'terrain' && !name.startsWith('world_hills') && !(s && s.walkable)) continue;
        worst = Math.max(worst, Math.abs((3 - dist) - sim.terrain.groundHeight(x, y))); samples++;
      }
      g.delete();
      report.terrainConsistency[kind] = { samples, worstAbsErrM: r3(worst) };
      check(`${kind}: analytic terrain matches physics within 6 mm`, worst < .006 && samples > 1500, report.terrainConsistency[kind]);

      // Props keep their state across robot resets (pilot calls mj_resetData).
      const ball = sim.index.props.find(p => p.kind === 'ball');
      sim.data.qpos[ball.qposadr] += 1.234; sim.data.qvel[ball.dofadr] = .5; mj.mj_forward(m, sim.data);
      const before = sim.propState(ball);
      sim.resetRobot(sim.spawnAt(PARK.pads[1]));
      const after = sim.propState(ball);
      const kept = before.pos.every((v, i) => Math.abs(v - after.pos[i]) < 1e-12) && Math.abs(after.vel[0] - .5) < 1e-12;
      const robotAt = sim.robotPose().pos;
      report.propPreservation[kind] = { kept, ballBefore: before.pos.map(r3), ballAfter: after.pos.map(r3), robotSpawn: robotAt.map(r3), pad: PARK.pads[1] };
      check(`${kind}: robot reset preserves prop state and spawns at the pad`, kept && Math.hypot(robotAt[0] - PARK.pads[1].x, robotAt[1] - PARK.pads[1].y) < .05, report.propPreservation[kind]);
      sim.resetProps();

      // Stand still 6 s on the hub.
      sim.resetRobot(sim.spawnAt(PARK.pads[0]));
      const start = sim.robotPose().pos; let fall = null, t1 = performance.now();
      for (let i = 0; i < 300 && !fall; i++) { const res = await sim.step([0, 0, 0]); fall = sim.checkFall(res.snap); }
      const end = sim.robotPose().pos;
      report.standing[kind] = { fall, driftM: r3(Math.hypot(end[0] - start[0], end[1] - start[1])), msPerControlStep: r3((performance.now() - t1) / 300) };
      check(`${kind}: stands 6 s in the park without falling`, !fall && report.standing[kind].driftM < .35, report.standing[kind]);

      // Fall detection: tipped over, and walked into the sea.
      const q = sim.data.qpos; q[3] = Math.cos(.9); q[4] = Math.sin(.9); q[5] = 0; q[6] = 0; mj.mj_forward(m, sim.data);
      const tipped = sim.checkFall(sim.runtime.snapshot());
      sim.resetRobot({ x: PARK.islandRadius + .3, y: 0, z: 0, yaw: 0 });
      const sea = sim.checkFall(sim.runtime.snapshot());
      report.gameLogic[`${kind}:fallDetection`] = { tipped, sea };
      check(`${kind}: fall detection reports tumble and splash`, tipped === 'tumble' && sea === 'splash', { tipped, sea });
    } finally { sim.dispose(); }
  }

  // 4. Relaxed controller guards still reject models whose robot moved.
  {
    const scene = (await read('play/public/controller/flower/scene.xml')).toString();
    const shifted = scene.replace('<body name="robot/torso_link"', '<body name="prop_intruder" pos="3 0 .2"><freejoint/><geom type="sphere" size=".05" contype="8" conaffinity="15"/></body><body name="robot/torso_link"');
    const extraActuator = scene.replace('</actuator>', '<motor name="world_motor" joint="robot/leg0_knee" gear="1"/></actuator>');
    const injected = injectWorld(scene, PARK, {}).xml;
    const manifest = JSON.parse(await read('play/public/controller/flower/manifest.json'));
    const mesh = await read('play/public/controller/flower/assets/torso_mesh.stl');
    const tryCtx = xml => {
      const vfs = new h.mj.MjVFS(); vfs.addBuffer('torso_mesh.stl', new Uint8Array(mesh));
      let model, data;
      try { model = h.mj.MjModel.from_xml_string(xml, vfs); data = new h.mj.MjData(model); h.controllerApi.flower.createFlowerControllerContext(h.mj, model, data, manifest); return 'accepted'; }
      catch (e) { return `rejected: ${e.message}`; } finally { data?.delete(); model?.delete(); vfs.delete(); }
    };
    report.prefixGuards = { worldAppended: tryCtx(injected), propBeforeRobot: tryCtx(shifted), extraActuator: tryCtx(extraActuator) };
    check('relaxed Flower guard accepts world-after-robot and rejects a shifted robot or extra actuator',
      report.prefixGuards.worldAppended === 'accepted' && report.prefixGuards.propBeforeRobot.startsWith('rejected') && report.prefixGuards.extraActuator.startsWith('rejected'), report.prefixGuards);
    const cscene = (await read('play/public/controller/cheetah/scene.xml')).toString();
    const cmanifest = JSON.parse(await read('play/public/controller/cheetah/manifest.json'));
    const cmesh = await read('play/public/controller/cheetah/assets/torso_mesh.stl');
    const tryCheetah = xml => {
      const vfs = new h.mj.MjVFS(); vfs.addBuffer('torso_mesh.stl', new Uint8Array(cmesh));
      let model, data, ctx;
      try { model = h.mj.MjModel.from_xml_string(xml, vfs); data = new h.mj.MjData(model); ctx = h.controllerApi.cheetah.createControllerContext(h.mj, model, data, cmanifest); return 'accepted'; }
      catch (e) { return `rejected: ${e.message}`; } finally { if (ctx) h.controllerApi.cheetah.disposeControllerContext(ctx); data?.delete(); model?.delete(); vfs.delete(); }
    };
    const cshift = cscene.replace('<body name="robot/torso_link"', '<body name="prop_intruder" pos="3 0 .2"><freejoint/><geom type="sphere" size=".05"/></body><body name="robot/torso_link"');
    report.prefixGuards.cheetah = { worldAppended: tryCheetah(injectWorld(cscene, PARK, {}).xml), propBeforeRobot: tryCheetah(cshift) };
    check('relaxed Cheetah guard accepts world-after-robot and rejects a shifted robot',
      report.prefixGuards.cheetah.worldAppended === 'accepted' && report.prefixGuards.cheetah.propBeforeRobot.startsWith('rejected'), report.prefixGuards.cheetah);
  }

  // 5. Drive every lane with both policies (torso collisions, world visible
  //    to the Cheetah's height scan): the measured capability map.
  const ballGoal = PARK.fromZoneLocal('court', PARK.court.u1 + .6, 0);
  async function laneRun(sim, lane) {
    const rootH = sim.meta.nominalRootHeight;
    sim.resetProps();
    if (lane.goal) {
      const target = PARK.plateau[lane.goal].height;
      return runLane(sim, lane, { timeout: 40, until: p => sim.terrain.groundHeight(p.pos[0], p.pos[1]) >= target - .005 && p.heightAboveTerrain > rootH * .6 });
    }
    if (lane.ball) return ballRun(sim, lane);
    if (lane.stone) {
      const stone = PARK.jump.stones.find(s => s.id === lane.stone);
      return runLane(sim, lane, { timeout: 25, until: p => sim.terrain.groundHeight(p.pos[0], p.pos[1]) >= stone.h - .005 && p.heightAboveTerrain > rootH * .6 });
    }
    const res = await runLane(sim, lane, { timeout: lane.dominoes ? 25 : 45 });
    if (lane.dominoes) {
      for (let i = 0; i < 100; i++) { try { await sim.step([0, 0, 0]); } catch { break; } }
      res.dominoesToppled = sim.propStates().filter(p => p.kind === 'domino' && p.up[2] < Math.cos(Math.PI / 4)).length;
      res.success = res.dominoesToppled >= 1;
    }
    return res;
  }
  // Ball: approach behind the ball on the ball->goal line, then push.
  async function ballRun(sim, lane) {
    sim.resetRobot(sim.spawnAt({ x: lane.from[0], y: lane.from[1], yaw: lane.yaw }));
    const ball = sim.index.props.find(p => p.kind === 'ball'), bounds = sim.meta.commandBounds, R = PARK.court.ballRadius;
    const start = sim.propState(ball).pos, limit = 60 / .02;
    let steps = 0, goal = false, fall = null;
    for (; steps < limit; steps++) {
      const pose = sim.robotPose(), b = sim.propState(ball).pos;
      const dir = [ballGoal[0] - b[0], ballGoal[1] - b[1]], d = Math.hypot(...dir); dir[0] /= d; dir[1] /= d;
      const behind = [b[0] - dir[0] * (R + sim.size.length * .5 + .1), b[1] - dir[1] * (R + sim.size.length * .5 + .1)];
      const rel = [pose.pos[0] - b[0], pose.pos[1] - b[1]], along = rel[0] * dir[0] + rel[1] * dir[1], lateral = Math.abs(-rel[0] * dir[1] + rel[1] * dir[0]);
      const aligned = along < -R && lateral < .25;
      let target = aligned ? [b[0] + dir[0] * .5, b[1] + dir[1] * .5] : behind;
      if (!aligned && along > -R) { const side = Math.sign(-rel[0] * dir[1] + rel[1] * dir[0]) || 1; target = [b[0] - dir[1] * side * (R + sim.size.radius + .25) - dir[0] * .4, b[1] + dir[0] * side * (R + sim.size.radius + .25) - dir[1] * .4]; }
      const ap = createAutopilot({ waypoints: [target], speed: aligned ? .75 : .6, reach: .05 });
      const command = steps < 50 ? [0, 0, 0] : ap.command(pose, bounds);
      let res; try { res = await sim.step(command); } catch (e) { fall = 'error'; break; }
      fall = sim.checkFall(res.snap); if (fall) break;
      const [u, v] = PARK.toZoneLocal('court', ...sim.propState(ball).pos.slice(0, 2));
      if (u > PARK.court.u1 + R * .5 && Math.abs(v) < PARK.court.goalHalfWidth) { goal = true; break; }
    }
    const end = sim.propState(ball).pos;
    const towardGoal = ((end[0] - start[0]) * (ballGoal[0] - start[0]) + (end[1] - start[1]) * (ballGoal[1] - start[1])) / Math.hypot(ballGoal[0] - start[0], ballGoal[1] - start[1]);
    return { lane: lane.id, success: goal, reason: goal ? 'goal' : fall ? 'fall' : 'timeout', fall, seconds: r3(steps * .02), ballTowardGoalM: r3(towardGoal), ballEnd: end.map(r3) };
  }
  for (const kind of kinds) {
    const sim = await h.sim(kind, PARK, { collision: 'torso' });
    report.lanes[kind] = [];
    try {
      for (const lane of PARK.lanes) {
        const t0 = performance.now();
        const res = { ...(await laneRun(sim, lane)), title: lane.title, zone: lane.zone, wallSeconds: r3((performance.now() - t0) / 1000) };
        report.lanes[kind].push(res);
        console.log('LANE', kind, lane.id, res.success ? 'ok' : 'no', res.reason, res.progress ?? '', res.dominoesToppled ?? '', res.ballTowardGoalM ?? '');
      }
    } finally { sim.dispose(); }
  }

  // 6. Collision mode A/B: legacy torso shells colliding with world + props.
  for (const kind of kinds) {
    report.collisionModes[kind] = {};
    for (const collision of ['feet', 'torso']) {
      const sim = await h.sim(kind, PARK, { collision });
      try {
        const out = {};
        for (const id of quick ? ['flat'] : ['flat', 'hills-gentle', 'dominoes', 'ball']) {
          const lane = PARK.lanes.find(l => l.id === id);
          const res = await laneRun(sim, lane);
          out[id] = { success: res.success, reason: res.reason, meanSpeed: res.meanSpeed ?? null, maxTiltDeg: res.maxTiltDeg ?? null, dominoesToppled: res.dominoesToppled ?? null, ballTowardGoalM: res.ballTowardGoalM ?? null };
        }
        // Walk straight into a court side wall from outside: does the body ghost through?
        const [wx, wy] = PARK.fromZoneLocal('court', 8.5, -(PARK.court.halfWidth + 1.2));
        sim.resetRobot(sim.spawnAt({ x: wx, y: wy, yaw: Math.PI / 2 }));
        for (let i = 0; i < 400; i++) { try { const r = await sim.step([sim.meta.commandBounds.vx[1] * .8, 0, 0]); if (sim.checkFall(r.snap)) break; } catch { break; } }
        const p = sim.robotPose().pos, [, v] = PARK.toZoneLocal('court', p[0], p[1]);
        out.wall = { torsoCentreBeyondWallFaceM: r3(v + PARK.court.halfWidth), fall: sim.checkFall(sim.runtime.snapshot()) };
        report.collisionModes[kind][collision] = out;
      } finally { sim.dispose(); }
    }
    const f = report.collisionModes[kind].feet, t = report.collisionModes[kind].torso;
    check(`${kind}: torso collisions keep open-ground gait (flat lane unchanged)`, t.flat.success === f.flat.success && Math.abs((t.flat.meanSpeed ?? 0) - (f.flat.meanSpeed ?? 0)) < .03, { feet: f.flat, torso: t.flat });
  }

  // 7. Cheetah height scan: world visible (group 0) vs hidden (group 3).
  {
    for (const group of [0, 3]) {
      const sim = await h.sim('legacy-cheetah', PARK, { collision: 'torso', worldGeomGroup: group });
      try {
        const out = {};
        for (const id of quick ? ['steps-medium'] : ['ramp-summit', 'steps-medium', 'steps-giant', 'hills-bumpy']) {
          const res = await laneRun(sim, PARK.lanes.find(l => l.id === id));
          out[id] = { success: res.success, reason: res.reason, progress: res.progress ?? null };
        }
        report.scanVisibility[`group${group}`] = out;
      } finally { sim.dispose(); }
    }
    const visible = Object.values(report.scanVisibility.group0).filter(r => r.success).length, hidden = Object.values(report.scanVisibility.group3).filter(r => r.success).length;
    report.scanVisibility.decision = visible >= hidden ? 'World geoms stay in geom group 0: the Cheetah policy relies on its height scan to climb.' : 'Hidden world performed better.';
    check('Cheetah: world visible to its height scan performs at least as well as hidden', visible >= hidden, { visible, hidden });
  }

  // 8. Game rules on real physics: goal, dominoes, sparks, stairs, summit.
  {
    const sim = await h.sim('legacy-cheetah', PARK, { collision: 'torso' });
    try {
      const events = [];
      const game = createGame({ layout: PARK, terrain: sim.terrain, pilot: { kind: 'legacy-cheetah', label: 'Cheetah', skills: ['walk'] }, size: sim.size,
        storage: createMemoryStorage(), onEvent: e => events.push(e), resetProps: f => sim.resetProps(f), respawnAt: pad => sim.resetRobot(sim.spawnAt(pad)) });
      sim.resetRobot(sim.spawnAt(PARK.pads[0]));
      const tick = (extra = {}) => game.update({ clock: sim.clock, pose: sim.robotPose(), props: sim.propStates(), airborne: false, fallen: false, ...extra });
      tick();
      // Ball placed into the goal mouth -> one goal.
      const ball = sim.index.props.find(p => p.kind === 'ball');
      const [gx, gy] = PARK.fromZoneLocal('court', PARK.court.u1 + .4, 0);
      sim.data.qpos[ball.qposadr] = gx; sim.data.qpos[ball.qposadr + 1] = gy; h.mj.mj_forward(sim.model, sim.data);
      tick(); tick();
      const goals = events.filter(e => e.type === 'goal').length;
      // A domino knocked flat -> counted.
      const domino = sim.index.props.find(p => p.kind === 'domino');
      const dq = sim.data.qpos, a = domino.qposadr; const qy = [Math.cos(.75), 0, Math.sin(.75), 0];
      dq[a + 3] = qy[0]; dq[a + 4] = qy[1]; dq[a + 5] = qy[2]; dq[a + 6] = qy[3]; h.mj.mj_forward(sim.model, sim.data); tick();
      const toppled = game.snapshot().dominoes.down;
      // Challenge flow: meadow sparks collected by driving through them.
      game.setChallenge('meadow-sparks');
      const meadow = PARK.sparks.filter(s => s.tag === 'meadow');
      const ap = createAutopilot({ waypoints: meadow.map(s => [s.x, s.y]), speed: .8, reach: .25 });
      for (let i = 0; i < 2500 && !ap.done; i++) {
        const res = await sim.step(i < 25 ? [0, 0, 0] : ap.command(sim.robotPose(), sim.meta.commandBounds));
        game.update({ clock: sim.clock, pose: sim.robotPose(), props: sim.propStates(), airborne: res.airborne, fallen: !!sim.checkFall(res.snap) });
      }
      const sprint = game.snapshot().challenge;
      // Stairs: drive the medium lane end to end with the game watching.
      const lane = PARK.lanes.find(l => l.id === 'steps-medium');
      game.onTeleport(); sim.resetRobot(sim.spawnAt({ x: lane.from[0], y: lane.from[1], yaw: lane.yaw }));
      const ap2 = createAutopilot({ waypoints: [lane.to], speed: .8, reach: .3 });
      for (let i = 0; i < 1500 && !ap2.done; i++) {
        const res = await sim.step(i < 25 ? [0, 0, 0] : ap2.command(sim.robotPose(), sim.meta.commandBounds));
        game.update({ clock: sim.clock, pose: sim.robotPose(), props: sim.propStates(), airborne: res.airborne, fallen: false });
      }
      // Summit via the steep ramp.
      const steep = PARK.lanes.find(l => l.id === 'ramp-summit');
      game.onTeleport(); sim.resetRobot(sim.spawnAt({ x: steep.from[0], y: steep.from[1], yaw: steep.yaw }));
      const ap3 = createAutopilot({ waypoints: [steep.to, [PARK.summit.x, PARK.summit.y]], speed: .7, reach: .25 });
      for (let i = 0; i < 1500 && !ap3.done; i++) {
        const res = await sim.step(i < 25 ? [0, 0, 0] : ap3.command(sim.robotPose(), sim.meta.commandBounds));
        game.update({ clock: sim.clock, pose: sim.robotPose(), props: sim.propStates(), airborne: res.airborne, fallen: false });
      }
      const types = events.map(e => e.type), stickers = events.filter(e => e.type === 'sticker').map(e => e.id);
      report.gameLogic.cheetah = { goals, toppled, sprint: { status: sprint.status, progress: sprint.progress, timeMs: sprint.timeMs }, stairs: types.includes('stairs'), stickers, eventTypes: [...new Set(types)] };
      check('game: goal, topple, spark sprint, stairs and summit are detected on real physics',
        goals === 1 && toppled === 1 && sprint.status === 'complete' && types.includes('stairs') && stickers.includes('summit'), report.gameLogic.cheetah);
      // Hoops stay locked without a jump skill.
      const hoopChallenge = game.setChallenge('hoop');
      check('game: hoop challenge is locked without a trained jump skill', hoopChallenge.status === 'locked', { reason: hoopChallenge.lockedReason });
    } finally { sim.dispose(); }
  }

  // 9. AI Explore validation (no network): strict decision contract.
  {
    const png = 'data:image/png;base64,' + Buffer.from('fake-frame-bytes').toString('base64');
    const imageSha256 = sha(Buffer.from('fake-frame-bytes'));
    const decision = (observationId, source = 'local_vlm', extra = {}) => ({ ok: true, executesMotion: false, observationId, decisionId: 'd1',
      provenance: { source, model: 'qwen2.5-vl', provider: source === 'cloud_vlm' ? 'dashscope' : undefined, imageSha256 }, action: { operation: 'forward', vx: .35, vy: 0, wz: 0, durationSeconds: 1 }, ...extra });
    const results = {};
    const attempt = (label, fn) => { try { fn(); results[label] = 'accepted'; } catch (e) { results[label] = `rejected: ${e.message}`; } };
    attempt('local', () => validateExploreDecision(decision('o1'), 'o1'));
    attempt('cloud', () => validateExploreDecision(decision('o1', 'cloud_vlm'), 'o1'));
    attempt('unknownSource', () => validateExploreDecision(decision('o1', 'remote_vlm'), 'o1'));
    attempt('staleObservation', () => validateExploreDecision(decision('o0'), 'o1'));
    attempt('tooLong', () => validateExploreDecision({ ...decision('o1'), action: { operation: 'forward', vx: .35, vy: 0, wz: 0, durationSeconds: 3 } }, 'o1'));
    attempt('fasterThanContract', () => validateExploreDecision({ ...decision('o1'), action: { operation: 'forward', vx: .8, vy: 0, wz: 0, durationSeconds: 1 } }, 'o1'));
    const cloud = validateExploreDecision(decision('o1', 'cloud_vlm'), 'o1');
    results.cloudProvider = `${cloud.provenance.provider}/${cloud.provenance.model}`;
    // Landmark goal reached while moving: success is checked by the engine.
    let simTime = 0, pos = [0, 0, .3], applied = null;
    const red = PARK.landmarks.find(l => l.id === 'red-ball');
    const explore = createExplore({ capture: () => ({ imageDataUrl: png, observationId: `obs-${simTime}` }), apply: c => { applied = c; }, freeze: () => { applied = null; },
      context: () => 'session', getSimTime: () => simTime, getPosition: () => pos, landmarks: PARK.landmarks,
      request: async body => decision(body.observationId, 'cloud_vlm') });
    await explore.start('please go to the red ball');
    const moving = explore.snapshot();
    pos = [red.x - .5, red.y, .3]; simTime = .5; explore.advance(simTime);
    const done = explore.snapshot();
    results.landmarkFromText = findLandmark('Go to the RED BALL!', PARK.landmarks)?.id ?? null;
    results.flow = { firstPhase: moving.phase, applied: !!moving.action, landmark: moving.landmark?.id, provider: moving.provider, model: moving.model, endPhase: done.phase, reason: done.reason, reached: done.reached };
    report.explore = results;
    check('AI Explore: accepts local/cloud provenance, rejects stale/unknown/out-of-contract, reports provider and reaches a landmark',
      results.local === 'accepted' && results.cloud === 'accepted' && results.unknownSource.startsWith('rejected') && results.staleObservation.startsWith('rejected') &&
      results.tooLong.startsWith('rejected') && results.fasterThanContract.startsWith('rejected') && results.landmarkFromText === 'red-ball' &&
      results.flow.firstPhase === 'moving' && results.flow.provider === 'dashscope' && results.flow.reached === 'red-ball', results);
  }

  // 10. Capability map from the lane runs (measured only).
  const lanesOf = kind => Object.fromEntries(report.lanes[kind].map(r => [r.lane, r]));
  const pct = r => `${Math.round((r.progress ?? 0) * 100)}%`;
  function zoneLevels(kind) {
    const L = lanesOf(kind), lane = id => ({ id, title: L[id].title, pass: !!L[id].success, reason: L[id].reason, seconds: L[id].seconds, progress: L[id].progress ?? null });
    const z = {};
    z.meadow = L.flat.success ? { level: 'great', note: `Flat lawn: walked it end to end (${L.flat.meanSpeed} m/s).`, lanes: [lane('flat')] } : { level: 'hard', note: 'Could not cross the flat lawn.', lanes: [lane('flat')] };
    z.court = L.ball.success ? { level: 'great', note: `Pushed the ball into the goal in ${Math.round(L.ball.seconds)} s.`, lanes: [lane('ball')] }
      : L.ball.ballTowardGoalM >= 1 ? { level: 'ok', note: `Moves the ball (${L.ball.ballTowardGoalM} m toward the goal) but no goal in 60 s.`, lanes: [lane('ball')] }
        : { level: 'hard', note: 'Could not move the ball toward the goal.', lanes: [lane('ball')] };
    const g = L['hills-gentle'], b = L['hills-bumpy'];
    z.hills = g.success && b.success ? { level: 'great', note: 'Crossed both the gentle swells and the bumpy lane.' }
      : g.success ? { level: 'ok', note: `Gentle swells OK; bumpy lane too rough (stalled at ${pct(b)}).` } : { level: 'hard', note: `Stalled on the gentle swells (${pct(g)}).` };
    z.hills.lanes = [lane('hills-gentle'), lane('hills-bumpy')];
    const t = L['ramp-terrace'], s = L['ramp-summit'];
    z.plateau = t.success && s.success ? { level: 'great', note: `Climbs the ${PARK.plateau.gentle.slopeDeg}° ramp to the terrace and the ${PARK.plateau.steep.slopeDeg}° ramp to the summit.` }
      : t.success ? { level: 'ok', note: `Terrace OK (${PARK.plateau.gentle.slopeDeg}° ramp); the ${PARK.plateau.steep.slopeDeg}° summit ramp is too steep.` }
        : { level: 'hard', note: `Even the ${PARK.plateau.gentle.slopeDeg}° ramp stalls it.` };
    z.plateau.lanes = [lane('ramp-terrace'), lane('ramp-summit')];
    const steps = ['baby', 'medium', 'giant'].map(k => ({ k, r: L[`steps-${k}`], cm: +(PARK.steps[k].riser * 100).toFixed(1) }));
    const okSteps = steps.filter(x => x.r.success), tooTall = steps.find(x => !x.r.success);
    z.steps = okSteps.length === 3 ? { level: 'great', note: `All stairs, up to ${steps[2].cm} cm risers.` }
      : okSteps.length ? { level: 'ok', note: `${okSteps.map(x => `${x.cm} cm`).join(' and ')} risers OK; ${tooTall.cm} cm is too tall.` } : { level: 'hard', note: `Even ${steps[0].cm} cm risers stop it.` };
    z.steps.lanes = steps.map(x => lane(`steps-${x.k}`));
    const d = L.dominoes;
    z.blocks = d.dominoesToppled >= 7 ? { level: 'great', note: `Toppled ${d.dominoesToppled}/9 dominoes in one push.` } : d.dominoesToppled >= 1 ? { level: 'ok', note: `Toppled ${d.dominoesToppled}/9 dominoes.` } : { level: 'hard', note: 'Could not topple the dominoes.' };
    z.blocks.lanes = [lane('dominoes')];
    const st = L['stone-1'];
    z.jump = { level: 'needs-jump', note: `Built for a trained jump skill. Walking onto the first ${Math.round(PARK.jump.stones[0].h * 100)} cm stone: ${st.success ? 'OK' : 'not possible'}.`, lanes: [lane('stone-1')] };
    return z;
  }
  const meta = JSON.parse(await read('play/public/controller/cheetah/manifest.json')), fmeta = JSON.parse(await read('play/public/controller/flower/manifest.json'));
  const map = {
    schema: 'world-capability/1', layout: PARK.id, generatedAt: report.createdAt, source: 'qa/world-park-validation.json',
    method: 'Deterministic headless rollouts of the exact browser modules (MuJoCo WASM + ONNX Runtime Web), steered by a proportional waypoint driver; torso collisions on; world visible to height scans. One rollout per lane.',
    pilots: {
      'legacy-cheetah': { label: 'Draft Cheetah', policySha256: meta.policySha256, controllerSha256: h.controllerSha256.cheetah, zones: zoneLevels('legacy-cheetah') },
      'legacy-flower': { label: 'Flower crawler', policySha256: fmeta.policySha256, controllerSha256: h.controllerSha256.flower, zones: zoneLevels('legacy-flower') },
    },
  };
  report.capability = map;
  await fs.writeFile(mapPath, JSON.stringify(map, null, 2) + '\n');
  check('capability map written', true, { path: path.relative(root, mapPath), cheetah: Object.fromEntries(Object.entries(map.pilots['legacy-cheetah'].zones).map(([k, v]) => [k, v.level])), flower: Object.fromEntries(Object.entries(map.pilots['legacy-flower'].zones).map(([k, v]) => [k, v.level])) });
  // The main loop must be fun with both legacy walkers.
  const fun = kind => ['meadow', 'court', 'hills', 'plateau', 'steps', 'blocks'].filter(z => ['great', 'ok'].includes(map.pilots[kind].zones[z].level)).length;
  check('both legacy walkers can play every ground zone at least partly', fun('legacy-cheetah') === 6 && fun('legacy-flower') === 6, { cheetah: fun('legacy-cheetah'), flower: fun('legacy-flower') });
  report.pass = report.checks.every(c => c.pass);
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error('VALIDATION ERROR', report.error);
} finally {
  await h?.close();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log('RESULT', JSON.stringify({ pass: report.pass, checks: report.checks.length, failed: report.checks.filter(c => !c.pass).map(c => c.name), report: path.relative(root, reportPath) }));
process.exitCode = report.pass ? 0 : 1;
