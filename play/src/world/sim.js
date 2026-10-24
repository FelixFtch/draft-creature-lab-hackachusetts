// Headless playground simulation: ONE MjModel = pilot scene + injected world.
//
// No Three.js and no DOM, so the browser engine and the Node QA run exactly
// this code with real MuJoCo WASM and the real policies. The sim owns the
// MuJoCo objects it creates and deletes each exactly once. The pilot owns its
// controller; props are preserved by the sim around every robot reset.
import { injectWorld } from './inject.js';
import { createTerrain } from './terrain.js';

export const CONTROL_DT = .02;
export const SUBSTEPS = 4;
const JOINT_QPOS = [7, 4, 1, 1], JOINT_DOF = [6, 3, 1, 1];
function allFinite(view) { for (let i = 0; i < view.length; i++) if (!Number.isFinite(view[i])) return false; return true; }

export async function createWorldSim({ mujoco: mj, pilot, layout, memory = '48M' }) {
  const prepared = await pilot.prepare();
  const meta = prepared.meta;
  const injected = injectWorld(prepared.xml, layout, { worldGroup: meta.worldGeomGroup ?? 0, robotGeoms: meta.robotGeomBits ?? {}, memory });
  const terrain = createTerrain(layout);
  let vfs = null, model = null, data = null, runtime = null, disposed = false;
  function release() { data?.delete(); model?.delete(); vfs?.delete(); data = model = vfs = null; }
  try {
    vfs = new mj.MjVFS();
    for (const [name, bytes] of prepared.assets) vfs.addBuffer(name, bytes);
    model = mj.MjModel.from_xml_string(injected.xml, vfs);
    data = new mj.MjData(model);
  } catch (error) { release(); throw error; }

  let index;
  try { index = buildIndex(); runtime = await pilot.attach({ mujoco: mj, model, data }); }
  catch (error) { release(); throw error; }

  function buildIndex() {
    const id = (type, name) => mj.mj_name2id(model, mj.mjtObj[type].value, name);
    const rootBody = id('mjOBJ_BODY', meta.rootBody);
    if (rootBody < 0) throw Error(`Robot root body ${meta.rootBody} not found`);
    // Contract: the robot leads the model so its qpos/qvel addresses are the
    // ones its policy was trained with; the world only appends after it.
    if (model.jnt_bodyid[0] !== rootBody || model.jnt_type[0] !== 0 || model.jnt_qposadr[0] !== 0)
      throw Error('The robot root free joint must be the first joint of the model');
    const robotBody = new Uint8Array(model.nbody);
    for (let b = 1; b < model.nbody; b++) if (model.body_rootid[b] === rootBody) robotBody[b] = 1;
    let qposEnd = 0, dofEnd = 0;
    for (let j = 0; j < model.njnt; j++) if (robotBody[model.jnt_bodyid[j]]) {
      qposEnd = Math.max(qposEnd, model.jnt_qposadr[j] + JOINT_QPOS[model.jnt_type[j]]);
      dofEnd = Math.max(dofEnd, model.jnt_dofadr[j] + JOINT_DOF[model.jnt_type[j]]);
    }
    const robotGeom = new Uint8Array(model.ngeom);
    for (let g = 0; g < model.ngeom; g++) if (robotBody[model.geom_bodyid[g]]) robotGeom[g] = 1;
    let footGeoms = (meta.footGeoms ?? []).map(n => id('mjOBJ_GEOM', n)).filter(g => g >= 0);
    if (!footGeoms.length) for (let g = 0; g < model.ngeom; g++) {
      const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, g) ?? '';
      if (robotGeom[g] && model.geom_type[g] === 2 && /foot|sphere/.test(name)) footGeoms.push(g);
    }
    const props = injected.props.map(p => {
      const joint = id('mjOBJ_JOINT', p.joint), body = id('mjOBJ_BODY', p.name), geom = id('mjOBJ_GEOM', p.geom);
      if (joint < 0 || body < 0 || geom < 0) throw Error(`Prop ${p.name} did not compile`);
      const qposadr = model.jnt_qposadr[joint], dofadr = model.jnt_dofadr[joint];
      if (qposadr < qposEnd || dofadr < dofEnd) throw Error(`Prop ${p.name} would precede robot state`);
      return { ...p, jointId: joint, bodyId: body, geomId: geom, qposadr, dofadr, homeQpos: [...p.home.pos, ...p.home.quat] };
    });
    const surface = new Array(model.ngeom).fill(null);
    for (const s of layout.statics) { const g = id('mjOBJ_GEOM', s.name); if (g >= 0) surface[g] = s.surface; }
    for (const h of injected.hfields) { const g = id('mjOBJ_GEOM', h.name); if (g >= 0) surface[g] = 'grass'; }
    for (const p of props) surface[p.geomId] = p.surface;
    const propByGeom = new Map(props.map((p, i) => [p.geomId, i]));
    const staticGeoms = new Map(layout.statics.map(s => [s.name, id('mjOBJ_GEOM', s.name)]));
    return { rootBody, robotBody, robotGeom, qposEnd, dofEnd, footGeoms, footIndex: new Map(footGeoms.map((g, i) => [g, i])),
      props, propByGeom, surface, staticGeoms };
  }

  let clock = 0, airSteps = 0;
  const feet = index.footGeoms.map(geom => ({ geom, grounded: false, air: 99 }));
  const propPrev = index.props.map(() => [0, 0, 0]);
  const propCool = index.props.map(() => 0);
  let touching = new Set();
  let robotSize = null;

  function surfaceOf(geom, pos) {
    const s = index.surface[geom];
    if (s) return s;
    return model.geom_type[geom] === 0 && pos ? terrain.surfaceAt(pos[0], pos[1]) : 'grass';
  }
  function resetTracking() {
    for (const f of feet) { f.grounded = true; f.air = 0; }
    airSteps = 0; touching = new Set();
    index.props.forEach((p, i) => { propPrev[i] = [data.qvel[p.dofadr], data.qvel[p.dofadr + 1], data.qvel[p.dofadr + 2]]; propCool[i] = 0; });
  }

  // One pass over the contact list per control step: foot strikes (with
  // surface + position), robot-prop touches, and whether the body is airborne.
  function postStep() {
    const strikes = [], bumps = [], impacts = [];
    const grounded = new Array(feet.length).fill(false), hit = new Array(feet.length).fill(null);
    const nowTouching = new Set();
    let bodyContact = false;
    const vec = data.contact;
    try {
      const n = vec.size();
      for (let i = 0; i < n; i++) {
        const c = vec.get(i);
        try {
          const g1 = c.geom1, g2 = c.geom2, r1 = index.robotGeom[g1], r2 = index.robotGeom[g2];
          if (r1 === r2) continue;
          const rg = r1 ? g1 : g2, other = r1 ? g2 : g1, fi = index.footIndex.get(rg);
          if (fi !== undefined) { if (!grounded[fi]) { grounded[fi] = true; hit[fi] = { other, pos: [c.pos[0], c.pos[1], c.pos[2]] }; } }
          else bodyContact = true;
          const pi = index.propByGeom.get(other);
          if (pi !== undefined) nowTouching.add(pi);
        } finally { c.delete(); }
      }
    } finally { vec.delete(); }
    feet.forEach((f, i) => {
      if (grounded[i] && !f.grounded && f.air >= 2) {
        const h = hit[i];
        strikes.push({ foot: i, pos: h.pos, surface: surfaceOf(h.other, h.pos), airSeconds: f.air * CONTROL_DT });
      }
      f.air = grounded[i] ? 0 : f.air + 1; f.grounded = grounded[i];
    });
    const anyFoot = grounded.some(Boolean);
    airSteps = anyFoot || bodyContact ? 0 : airSteps + 1;
    const qvel = data.qvel, xpos = data.xpos;
    index.props.forEach((p, i) => {
      const v = [qvel[p.dofadr], qvel[p.dofadr + 1], qvel[p.dofadr + 2]], prev = propPrev[i];
      const dv = Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]);
      propCool[i] = Math.max(0, propCool[i] - CONTROL_DT);
      if (dv > .45 && propCool[i] === 0) {
        impacts.push({ prop: p.name, kind: p.kind, pos: [xpos[p.bodyId * 3], xpos[p.bodyId * 3 + 1], xpos[p.bodyId * 3 + 2]], strength: dv, mass: p.mass });
        propCool[i] = .12;
      }
      propPrev[i] = v;
    });
    for (const i of nowTouching) if (!touching.has(i)) {
      const p = index.props[i];
      bumps.push({ prop: p.name, kind: p.kind, pos: [xpos[p.bodyId * 3], xpos[p.bodyId * 3 + 1], xpos[p.bodyId * 3 + 2]] });
    }
    touching = nowTouching;
    return { strikes, bumps, impacts, airborne: airSteps >= 3, airSteps, groundedFeet: grounded.filter(Boolean).length };
  }

  function robotPose() {
    const b = index.rootBody, p = b * 3, r = b * 9, xpos = data.xpos, xmat = data.xmat, qvel = data.qvel;
    const pos = [xpos[p], xpos[p + 1], xpos[p + 2]];
    const m = Array.from(xmat.subarray(r, r + 9));
    const yawRate = m[6] * qvel[3] + m[7] * qvel[4] + m[8] * qvel[5];
    return { pos, heading: Math.atan2(m[3], m[0]), tilt: Math.acos(Math.max(-1, Math.min(1, m[8]))), xmat: m,
      quat: Array.from(data.qpos.subarray(3, 7)), linvel: [qvel[0], qvel[1], qvel[2]], speed: Math.hypot(qvel[0], qvel[1]),
      forwardSpeed: qvel[0] * Math.cos(Math.atan2(m[3], m[0])) + qvel[1] * Math.sin(Math.atan2(m[3], m[0])), yawRate,
      heightAboveTerrain: pos[2] - terrain.groundHeight(pos[0], pos[1]) };
  }

  // Reasons the engine should play the "oops" and respawn. Legacy pilots
  // report their trained fall criteria; the terrain-relative height check
  // makes the Flower's ground-plane criterion meaningful on the plateau.
  function checkFall(snap) {
    if (snap?.error) return 'error';
    if (!allFinite(data.qpos) || !allFinite(data.qvel)) return 'unstable';
    const pose = robotPose(), [x, y, z] = pose.pos;
    const onLand = layout.isLand ? layout.isLand(x, y) : Math.hypot(x, y) <= layout.islandRadius + .05;
    if (!onLand) return 'splash';
    if (z < -.5) return 'void';
    const hazard = layout.labHazard?.(x, y, z);
    if (hazard) return hazard;
    if (snap?.fall) return 'tumble';
    const min = meta.fallCriteria?.minimumRootHeightAboveGround;
    if (Number.isFinite(min) && pose.heightAboveTerrain < min) return 'tumble';
    if (pose.tilt > (meta.fallCriteria?.orientationLimitRad ?? 1) + .2) return 'tumble';
    return null;
  }

  function saveProps() {
    const qpos = data.qpos, qvel = data.qvel;
    return index.props.map(p => ({ q: Array.from(qpos.subarray(p.qposadr, p.qposadr + 7)), v: Array.from(qvel.subarray(p.dofadr, p.dofadr + 6)) }));
  }
  function restoreProps(saved) {
    const qpos = data.qpos, qvel = data.qvel;
    saved.forEach((s, i) => { qpos.set(s.q, index.props[i].qposadr); qvel.set(s.v, index.props[i].dofadr); });
  }

  function spawnAt(pad) {
    return { x: pad.x, y: pad.y, z: terrain.groundHeight(pad.x, pad.y), yaw: pad.yaw ?? 0 };
  }
  // Robot-only reset: the pilot may reset the whole MjData (legacy controllers
  // call mj_resetData); props keep their state across it.
  function resetRobot(spawn) {
    if (disposed) throw Error('World sim was disposed');
    const saved = saveProps();
    const snap = runtime.reset(spawn);
    restoreProps(saved);
    mj.mj_forward(model, data);
    resetTracking();
    if (!robotSize) robotSize = measureRobot();
    return snap;
  }
  function resetProps(filter = () => true) {
    const qpos = data.qpos, qvel = data.qvel;
    index.props.forEach(p => {
      if (!filter(p)) return;
      qpos.set(p.homeQpos, p.qposadr); qvel.fill(0, p.dofadr, p.dofadr + 6);
    });
    mj.mj_forward(model, data);
    index.props.forEach((p, i) => { propPrev[i] = [0, 0, 0]; });
  }
  function propState(p) {
    const q = data.qpos, a = p.qposadr, b = p.bodyId * 9, x = data.xmat, v = data.qvel;
    return { name: p.name, kind: p.kind, group: p.group, pos: [q[a], q[a + 1], q[a + 2]], quat: [q[a + 3], q[a + 4], q[a + 5], q[a + 6]],
      up: [x[b + 2], x[b + 5], x[b + 8]], vel: [v[p.dofadr], v[p.dofadr + 1], v[p.dofadr + 2]], home: p.homeQpos };
  }
  // Props that left the island (or the world) go home.
  function strayProps() {
    return index.props.filter(p => {
      const q = data.qpos, a = p.qposadr;
      return Math.hypot(q[a], q[a + 1]) > layout.islandRadius + .4 || q[a + 2] < -1 || !Number.isFinite(q[a]);
    });
  }

  // Conservative axis-aligned bounds of the robot in its root frame, from the
  // compiled geoms' local AABBs at the current (reset) pose.
  function measureRobot() {
    const xpos = data.geom_xpos, xmat = data.geom_xmat, aabb = model.geom_aabb, b = index.rootBody;
    const R = Array.from(data.xmat.subarray(b * 9, b * 9 + 9)), o = Array.from(data.xpos.subarray(b * 3, b * 3 + 3));
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const tlo = [Infinity, Infinity, Infinity], thi = [-Infinity, -Infinity, -Infinity];
    let groundMin = Infinity, mass = 0;
    for (let body = 1; body < model.nbody; body++) if (index.robotBody[body]) mass += model.body_mass[body];
    for (let g = 0; g < model.ngeom; g++) {
      if (!index.robotGeom[g]) continue;
      const torso = model.geom_bodyid[g] === b;
      const G = xmat.subarray(g * 9, g * 9 + 9), c = aabb.subarray(g * 6, g * 6 + 3), h = aabb.subarray(g * 6 + 3, g * 6 + 6);
      const wc = [0, 1, 2].map(i => xpos[g * 3 + i] + G[i * 3] * c[0] + G[i * 3 + 1] * c[1] + G[i * 3 + 2] * c[2]);
      const d = [wc[0] - o[0], wc[1] - o[1], wc[2] - o[2]];
      for (let i = 0; i < 3; i++) {
        // Row i of R^T G gives the geom axes expressed on root axis i.
        const center = R[i] * d[0] + R[3 + i] * d[1] + R[6 + i] * d[2];
        let half = 0;
        for (let j = 0; j < 3; j++) half += Math.abs(R[i] * G[j] + R[3 + i] * G[3 + j] + R[6 + i] * G[6 + j]) * h[j];
        lo[i] = Math.min(lo[i], center - half); hi[i] = Math.max(hi[i], center + half);
        if (torso) { tlo[i] = Math.min(tlo[i], center - half); thi[i] = Math.max(thi[i], center + half); }
      }
      let wz = 0; for (let j = 0; j < 3; j++) wz += Math.abs(G[6 + j]) * h[j];
      groundMin = Math.min(groundMin, wc[2] - wz);
    }
    const length = hi[0] - lo[0], width = hi[1] - lo[1];
    return { boundsMin: lo, boundsMax: hi, torsoMin: tlo.map(v => Number.isFinite(v) ? v : 0), torsoMax: thi.map(v => Number.isFinite(v) ? v : 0),
      length, width, height: o[2] + hi[2] - Math.max(0, groundMin), mass,
      rootHeight: o[2] - Math.max(0, groundMin), radius: Math.hypot(length, width) / 2 };
  }

  async function step(command, opts) {
    if (disposed) throw Error('World sim was disposed');
    const snap = await runtime.step(command, opts);
    if (disposed) throw Error('World sim was disposed');
    clock += CONTROL_DT;
    return { snap, ...postStep() };
  }
  // Motors off (limp) physics for the "oops" moment after a fall.
  function passiveStep() {
    if (disposed) throw Error('World sim was disposed');
    data.ctrl.fill(0);
    for (let i = 0; i < SUBSTEPS; i++) mj.mj_step(model, data);
    clock += CONTROL_DT;
    if (!allFinite(data.qpos) || !allFinite(data.qvel)) return { unstable: true, strikes: [], bumps: [], impacts: [] };
    return postStep();
  }

  return {
    model, data, meta, layout, terrain, index, injectedXml: injected.xml, hfields: injected.hfields, runtime,
    get clock() { return clock; }, get size() { return robotSize; }, get feet() { return feet; },
    step, passiveStep, resetRobot, resetProps, propState, strayProps, robotPose, checkFall, spawnAt, measureRobot,
    propStates: () => index.props.map(propState),
    dispose() {
      if (disposed) return;
      disposed = true;
      try { runtime?.dispose(); } finally { release(); }
    },
    get disposed() { return disposed; },
  };
}
