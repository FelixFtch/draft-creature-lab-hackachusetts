import * as THREE from 'three';
import { getLayout } from './layout-park.js';
import { createWorldSim, CONTROL_DT } from './sim.js';
import { createWorldView } from './view.js';
import { loadCreatureViewFactory } from './robot-view.js';
import { createGame } from './game.js';
import { createFx } from './fx.js';
import { createAudio } from './audio.js';
import { createInput } from './input.js';
import { createCameraRig } from './camera.js';
import { createExplore, landmarkGoal } from './explore.js';
import { createAutopilot } from './autopilot.js';
import { zoneSuitability, signChips, capabilityMeta } from './capabilities.js';
import { createTrial, createTrialDriver, createCommandSmoother, trialSpawn, laneById, TRIAL_PROTOCOL } from './terrain-lab.js';
import terrainResults from './terrain-results.json';

// The playground engine (contracts/world-api.md): one MuJoCo model of the
// pilot's verified robot + an injected world, driven like a game character.
// Physics owns every rendered transform; the learned policy owns every joint
// torque. Nothing here moves the robot except pilot.reset() at a spawn pad.
const FALL_TEXT = { tumble: 'Oops! Took a tumble', splash: 'Splash! Robots don’t swim', void: 'Whoa — fell off the world', error: 'Physics hiccup', unstable: 'Physics hiccup' };
const toThree = (p, out = new THREE.Vector3()) => out.set(p[0], p[2], -p[1]);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export async function createPlayground(container, options = {}) {
  const { mujoco, pilot, look = '#4fb6a8', layout: layoutId = 'park', onEvent = () => {}, quality = 'high',
    intro = true, storage, muted = false } = options;
  if (!container?.appendChild) throw Error('createPlayground needs a container element');
  if (!mujoco?.MjModel) throw Error('createPlayground needs the loaded MuJoCo module');
  if (typeof pilot?.prepare !== 'function' || typeof pilot?.attach !== 'function') throw Error('createPlayground needs a pilot');
  const layout = getLayout(layoutId), high = quality !== 'low';
  const emit = e => { try { onEvent(e); } catch (error) { console.error('Playground onEvent handler failed', error); } };

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, high ? 2 : 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = high ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.02;
  Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%', outline: 'none' });
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Creature Park: drive with WASD or arrow keys, drag to look around');
  renderer.domElement.tabIndex = 0;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, .03, 500);
  const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);

  let sim = null, creatureView = null, view = null, fx = null, audio = null, input = null, rig = null, explore = null, game = null;
  let disposed = false, observer = null, raf = 0;
  const cleanups = [];
  function teardown() {
    disposed = true; cancelAnimationFrame(raf); observer?.disconnect();
    for (const fn of cleanups.splice(0)) { try { fn(); } catch (error) { console.error(error); } }
    explore?.dispose(); input?.dispose(); rig?.dispose(); audio?.dispose(); fx?.dispose(); creatureView?.dispose(); view?.dispose(); sim?.dispose();
    renderer.dispose(); renderer.forceContextLoss?.(); renderer.domElement.remove();
  }
  try {
    sim = await createWorldSim({ mujoco, pilot, layout });
    if (disposed) throw Error('disposed');
    sim.resetRobot(sim.spawnAt(layout.pads[0]));
  } catch (error) { teardown(); throw error; }

  const meta = sim.meta, size = sim.size, bounds = meta.commandBounds, skills = new Set(meta.skills ?? []);
  const suitability = zoneSuitability(meta.kind, layout, { skills: [...skills] });
  let viewSource = 'fallback';
  try {
    const factory = await loadCreatureViewFactory();
    viewSource = factory.source;
    creatureView = factory.create({ THREE, mujoco, model: sim.model, look, body: options.body ?? null, rootBody: meta.rootBody });
    root.add(creatureView.group);
    view = createWorldView({ scene, root, layout, terrain: sim.terrain, hfields: sim.hfields, props: sim.index.props, quality, renderer, creatureSize: size });
    view.setSignChips(signChips(suitability, meta.short ?? meta.label));
    fx = createFx({ quality }); root.add(fx.group);
    audio = createAudio({ muted });
  } catch (error) { teardown(); throw error; }

  // ------------------------------------------------------------ game state
  let oops = null, paused = false, busy = false, frozen = false, last = 0, fpsEMA = 60, combo = 0, lastSparkAt = -10;
  let cmd = { vx: 0, wz: 0 }, inputState = { vx: 0, wz: 0, boost: false, active: false, source: null, camera: { x: 0, y: 0 } };
  let jumpPending = false, devDrive = null, devAuto = null, exploreCmd = null, wasAirborne = false, airSince = 0, hidden = false;
  let trial = null, trialDriver = null, shakeUntil = 0;
  const labRuns = [];
  const locomotion = skills.has('drive') && !skills.has('walk') ? 'drive' : 'walk';
  const measuredLab = (terrainResults.pilots ?? []).find(p => p.id === (meta.policyId && meta.kind === 'creature' ? meta.policyId : meta.kind)) ?? null;
  const pending = [], propResets = [];
  const weight = clamp((size?.mass ?? 10) / 10, .5, 4), dustScale = clamp(.6 + (size?.height ?? .4) * 1.1, .6, 2.2);
  const exclusive = fn => { if (busy) pending.push(fn); else fn(); };

  game = createGame({ layout, terrain: sim.terrain, pilot: { kind: meta.kind, label: meta.label, policyId: meta.policyId, skills: [...skills] }, size, storage,
    onEvent: e => onGameEvent(e),
    resetProps: filter => { sim.resetProps(filter); },
    respawnAt: pad => respawnAt(pad, 'challenge'),
  });
  view.setSparks(game.sparks); view.setHoops(game.snapshot().hoop);
  view.setLabResults(measuredLab, meta.short ?? meta.label);

  function onGameEvent(e) {
    if (e.type === 'spark') {
      combo = sim.clock - lastSparkAt < 3.5 ? combo + 1 : 0; lastSparkAt = sim.clock;
      fx.sparkBurst(e.pos, { scale: dustScale * .9 }); audio.chime(combo, toThree(e.pos).toArray()); view.setSparks(game.sparks);
      e = { ...e, combo };
    } else if (e.type === 'round') view.setSparks(game.sparks);
    else if (e.type === 'goal') {
      const [gx, gy] = layout.fromZoneLocal('court', layout.court.u1 + .3, 0);
      fx.confetti([gx, gy, .6], 160); audio.cheer(toThree([gx, gy, .6]).toArray());
      propResets.push({ kinds: ['ball'], at: sim.clock + 2.5 });
    } else if (e.type === 'sticker') audio.sticker();
    else if (e.type === 'challenge' && e.status === 'complete') { const p = sim.robotPose().pos; fx.confetti([p[0], p[1], p[2] + .3], 90); audio.cheer(toThree(p).toArray()); }
    emit(e);
  }

  // ------------------------------------------------------------ explore
  const visionW = 640, visionH = 400;
  const visionCamera = new THREE.PerspectiveCamera(70, visionW / visionH, .02, 80);
  const visionTarget = new THREE.WebGLRenderTarget(visionW, visionH, { depthBuffer: true });
  visionTarget.texture.colorSpace = THREE.SRGBColorSpace;
  const visionPixels = new Uint8Array(visionW * visionH * 4), visionFlipped = new Uint8ClampedArray(visionW * visionH * 4);
  const visionCanvas = document.createElement('canvas'); visionCanvas.width = visionW; visionCanvas.height = visionH;
  let visionSeq = 0, session = 1, previewFrame = null;
  cleanups.push(() => visionTarget.dispose());
  function placeVisionCamera() {
    // Torso-mounted, forward-looking sensor in the creature's own frame.
    const m = sim.robotPose().xmat, o = sim.robotPose().pos, tMax = size.torsoMax ?? [.2, 0, .1];
    const local = [tMax[0] + .03, 0, tMax[2] + .1 + .2 * size.height], fwd = [1, 0, -.16], up = [0, 0, 1];
    const rot = v => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
    const p = rot(local), f = rot(fwd), u = rot(up);
    visionCamera.position.set(o[0] + p[0], o[2] + p[2], -(o[1] + p[1]));
    visionCamera.up.set(u[0], u[2], -u[1]);
    visionCamera.lookAt(visionCamera.position.x + f[0], visionCamera.position.y + f[2], visionCamera.position.z - f[1]);
  }
  function captureRobotView() {
    if (disposed) throw Error('Playground was disposed');
    placeVisionCamera();
    const previous = renderer.getRenderTarget();
    try {
      view.update(0, visionCamera, null);
      renderer.setRenderTarget(visionTarget); renderer.render(scene, visionCamera);
      renderer.readRenderTargetPixels(visionTarget, 0, 0, visionW, visionH, visionPixels);
    } finally { renderer.setRenderTarget(previous); view.update(0, camera, null); }
    for (let row = 0; row < visionH; row++) visionFlipped.set(visionPixels.subarray((visionH - 1 - row) * visionW * 4, (visionH - row) * visionW * 4), row * visionW * 4);
    visionCanvas.getContext('2d').putImageData(new ImageData(visionFlipped, visionW, visionH), 0, 0);
    const imageDataUrl = visionCanvas.toDataURL('image/png'); previewFrame = imageDataUrl;
    return { imageDataUrl, observationId: `park-${session}-${++visionSeq}`, width: visionW, height: visionH };
  }
  explore = createExplore({
    capture: captureRobotView, landmarks: layout.landmarks,
    apply: command => { exploreCmd = command; },
    freeze: () => { exploreCmd = null; },
    context: () => `${session}:${disposed}:${hidden}`,
    getSimTime: () => sim.clock, getPosition: () => sim.robotPose().pos,
    isReady: () => !oops && !paused && !disposed,
    // `jump` decisions run only on a validated jump skill; otherwise refused.
    canJump: () => skills.has('jump'), jump: () => api.trigger('jump', { source: 'explore' }),
    onChange: state => emit({ type: 'explore', phase: state.phase, reason: state.reason, error: state.error, landmark: state.landmark, provider: state.provider, model: state.model, steps: state.completedSteps }),
    onReached: landmark => { game.onExplore({ reached: landmark.id }); fx.confetti(sim.robotPose().pos, 80); audio.cheer(); },
  });

  // ------------------------------------------------------------- respawns
  function robotForCamera() {
    const pose = sim.robotPose();
    return { pos: toThree(pose.pos), heading: pose.heading, turning: Math.abs(cmd.wz) > .05, moving: Math.abs(cmd.vx) > .05 || pose.speed > .08 };
  }
  function respawnAt(pad, reason = 'respawn') {
    const reach = (size?.radius ?? .5) + .45;
    for (const p of sim.propStates()) if (Math.hypot(p.pos[0] - pad.x, p.pos[1] - pad.y) < reach) sim.resetProps(q => q.name === p.name);
    sim.resetRobot(sim.spawnAt(pad));
    const strays = sim.strayProps(); if (strays.length) sim.resetProps(p => strays.includes(p));
    cmd = { vx: 0, wz: 0 }; oops = null; wasAirborne = false; creatureView.group.visible = true; session++;
    game.onTeleport();
    creatureView.sync(sim.data); view.syncProps(mujoco, sim.model, sim.data);
    rig.snapBehind(robotForCamera());
    const p = sim.robotPose().pos; fx.poof([p[0], p[1], sim.terrain.groundHeight(p[0], p[1])], { scale: dustScale }); audio.whoosh();
    emit({ type: 'respawn', pad: pad.id, reason });
  }
  function nearestPad(pos) {
    return layout.pads.reduce((a, b) => (Math.hypot(b.x - pos[0], b.y - pos[1]) < Math.hypot(a.x - pos[0], a.y - pos[1]) ? b : a));
  }
  function startOops(reason, detail = null) {
    if (oops) return;
    const pos = sim.robotPose().pos;
    // In a Terrain Lab trial the creature goes back to its lane start.
    const pad = trial && trial.state.lane ? trial.spawn : nearestPad(pos);
    oops = { reason, message: FALL_TEXT[reason] ?? 'Oops!', detail, pos, pad, until: performance.now() + (reason === 'splash' ? 1300 : 2000) };
    cmd = { vx: 0, wz: 0 }; exploreCmd = null; devAuto = null; devDrive = null;
    explore.fail(`Creature stopped: ${oops.message}`);
    game.onFall(reason); audio.oops();
    if (reason === 'splash') {
      const r = Math.hypot(pos[0], pos[1]), k = (layout.islandRadius + .25) / Math.max(1e-6, r);
      fx.splash([pos[0] * k, pos[1] * k, -.25], { scale: dustScale }); audio.splash(toThree(pos).toArray());
      creatureView.group.visible = false;
    }
    emit({ type: 'fall', reason, message: oops.message, detail, respawnInMs: oops.until - performance.now() });
  }

  // ------------------------------------------------------------- commands
  function fromNormalized(v, boost) {
    const speed = boost ? 1 : .72, turn = boost ? 1 : .85;
    return [v.vx >= 0 ? v.vx * bounds.vx[1] * speed : -v.vx * bounds.vx[0] * speed, 0, v.wz >= 0 ? v.wz * bounds.wz[1] * turn : -v.wz * bounds.wz[0] * turn];
  }
  function desiredCommand(pose) {
    if (inputState.active) {
      if (explore.isActive()) explore.cancel('manual');
      devAuto = null; devDrive = null; exploreCmd = null;
      // Taking the stick during an automatic trial turns it into a driven run.
      if (trialDriver) { trialDriver = null; if (trial) trial.state.driver = 'mixed'; }
      return fromNormalized(inputState, inputState.boost);
    }
    if (devAuto) { const c = devAuto.command(pose, bounds); if (devAuto.done) devAuto = null; return c; }
    if (devDrive) return devDrive;
    if (trialDriver && trial && (trial.state.phase === 'armed' || trial.state.phase === 'running')) {
      const out = trialDriver.step(pose, sim.clock);
      if (out.jump && skills.has('jump')) jumpPending = true;
      return out.command;
    }
    if (exploreCmd && explore.moving) return exploreCmd;
    return [0, 0, 0];
  }
  const smoother = createCommandSmoother(bounds, CONTROL_DT);
  function smoothCommand(target) {
    if (cmd.vx === 0 && cmd.wz === 0) smoother.reset(); // after a respawn/pause
    const out = smoother.step(target);
    cmd.vx = out[0]; cmd.wz = out[2];
    return out;
  }

  // ---------------------------------------------------------- control step
  async function controlStep() {
    while (pending.length) pending.shift()();
    for (let i = propResets.length - 1; i >= 0; i--) if (sim.clock >= propResets[i].at) {
      const { kinds } = propResets.splice(i, 1)[0];
      sim.resetProps(p => kinds.includes(p.kind)); game.onPropsReset(kinds);
      if (kinds.includes('ball')) { const b = sim.propStates().find(p => p.kind === 'ball'); if (b) fx.poof(b.pos, { scale: 1.2 }); }
    }
    if (oops) {
      if (oops.reason === 'tumble' || oops.reason === 'void') { const r = sim.passiveStep(); if (r.unstable) oops.reason = 'unstable'; }
      if (performance.now() >= oops.until) respawnAt(oops.pad ?? nearestPad(oops.pos), 'fall');
      return;
    }
    const pose = sim.robotPose();
    inputState = paused ? { ...inputState, vx: 0, wz: 0, active: false } : input.read();
    const command = smoothCommand(desiredCommand(pose));
    const jump = jumpPending; jumpPending = false;
    let res;
    try { res = await sim.step(command, jump ? { jump: true } : undefined); }
    catch (error) {
      if (disposed || error?.name === 'AbortError') return;
      startOops(sim.checkFall({ error: error.message }) ?? 'error', error.message);
      return;
    }
    if (disposed) return;
    const after = sim.robotPose(), speed = Math.abs(after.forwardSpeed);
    for (const s of res.strikes) {
      fx.dust(s.pos, { surface: s.surface, scale: dustScale, strength: .6 + speed * 2 });
      audio.footstep(s.surface, toThree(s.pos).toArray(), { weight, speed });
    }
    for (const b of res.bumps) audio.thud(b.kind, toThree(b.pos).toArray(), 1);
    for (const i of res.impacts) audio.thud(i.kind, toThree(i.pos).toArray(), Math.min(2, i.strength));
    if (res.airborne && !wasAirborne) airSince = sim.clock;
    if (!res.airborne && wasAirborne && sim.clock - airSince > .12) {
      fx.ring([after.pos[0], after.pos[1], sim.terrain.groundHeight(after.pos[0], after.pos[1])], { radius: .5 + size.radius, duration: .6 });
      audio.thud('land', toThree(after.pos).toArray(), 1.4); emit({ type: 'land', airSeconds: +(sim.clock - airSince).toFixed(2) });
    }
    wasAirborne = res.airborne;
    const strays = sim.strayProps();
    if (strays.length) { sim.resetProps(p => strays.includes(p)); game.onPropsReset(strays.map(p => p.kind)); }
    const fall = sim.checkFall(res.snap);
    game.update({ clock: sim.clock, pose: after, props: sim.propStates(), airborne: res.airborne, fallen: !!fall });
    if (trial && (trial.state.phase === 'armed' || trial.state.phase === 'running'))
      for (const e of trial.update({ clock: sim.clock, pose: after, ground: sim.terrain.groundHeight(after.pos[0], after.pos[1]), fall })) onTrialEvent(e);
    explore.advance(sim.clock);
    if (fall) startOops(fall, res.snap?.error ?? null);
  }
  function onTrialEvent(e) {
    const p = sim.robotPose().pos;
    if (e.phase === 'grade') audio.chime(3, toThree(p).toArray());
    if (e.phase === 'passed') { fx.confetti([p[0], p[1], p[2] + .3], 120); audio.cheer(toThree(p).toArray()); }
    if (e.phase === 'passed' || e.phase === 'failed') {
      trialDriver = null;
      labRuns.push(trial.snapshot()); if (labRuns.length > 40) labRuns.shift();
    }
    game.onTrial(e);
    emit(e);
  }
  // Physics runs on its own 50 Hz schedule, independent of rendering: a slow
  // GPU frame never slows the gait down, and catching up is capped so a
  // stalled tab cannot spiral. Rendering just shows the latest state.
  const perf = { steps: 0, stepMs: 0, frameMs: 0, renderMs: 0, behind: 0 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let nextStepAt = performance.now(), holdLoop = 0;
  async function runStep() {
    busy = true;
    const t = performance.now();
    try { await controlStep(); perf.steps++; }
    catch (error) { console.error('Playground control step failed', error); emit({ type: 'error', message: String(error?.message ?? error) }); }
    finally { busy = false; perf.stepMs = perf.stepMs * .9 + (performance.now() - t) * .1; }
    while (!busy && pending.length) pending.shift()();
  }
  async function physicsLoop() {
    while (!disposed) {
      if (paused || hidden || frozen || holdLoop) { nextStepAt = performance.now(); await sleep(40); continue; }
      const wait = nextStepAt - performance.now();
      if (wait > 0) { await sleep(Math.min(wait, 20)); continue; }
      await runStep();
      nextStepAt += CONTROL_DT * 1000;
      const lag = performance.now() - nextStepAt;
      if (lag > 120) { perf.behind++; nextStepAt = performance.now(); }
      // Let rendering and input run between catch-up steps.
      if (lag > 0) await sleep(0);
    }
  }

  // ------------------------------------------------------------ input/cam
  input = createInput({ onAction: (action, info) => onAction(action, info) });
  function onAction(action) {
    if (disposed) return;
    audio.unlock(); rig?.skipIntro();
    if (action === 'jump') api.trigger('jump');
    else if (action === 'respawn') api.respawn();
    else if (action === 'camera') { const mode = rig.mode === 'orbit' ? (rig.recenter(), 'chase') : rig.cycle(); emit({ type: 'camera', mode }); }
    else if (action === 'mute') api.setMuted(!audio.muted);
    else if (action === 'pause') api.pause(!paused);
  }
  rig = createCameraRig({ camera, dom: renderer.domElement, terrain: sim.terrain, obstacles: layout.statics, size, onModeChange: mode => emit({ type: 'camera', mode }) });
  rig.snapBehind(robotForCamera());
  if (intro) rig.startIntro(sim.robotPose().heading);

  const onVisibility = () => {
    hidden = document.hidden;
    if (hidden) { explore.cancel('tab_hidden'); input.clear(); cmd = { vx: 0, wz: 0 }; }
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
  function resize() {
    if (disposed) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    fx.setViewport(h * renderer.getPixelRatio(), camera.fov);
  }
  observer = new ResizeObserver(resize); observer.observe(container); resize();

  // ------------------------------------------------------------ main loop
  const right = new THREE.Vector3(), focus = new THREE.Vector3();
  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (frozen) { last = now; return; }
    const gap = (now - last) / 1000 || 0, dt = Math.min(gap, .05); last = now;
    if (gap > 0) fpsEMA = fpsEMA * .9 + Math.min(240, 1 / gap) * .1;
    inputState = paused ? { ...inputState, vx: 0, wz: 0, active: false } : input.read();
    creatureView.sync(sim.data); creatureView.update?.(dt);
    // "No jump skill" feedback: a short sideways head-shake of the whole body view.
    if (now < shakeUntil) {
      const k = (shakeUntil - now) / 480, h = sim.robotPose().heading, a = Math.sin(now * .065) * .016 * k * (1 + (size?.height ?? .4));
      creatureView.group.position.set(-Math.sin(h) * a, Math.cos(h) * a, 0);
    } else if (creatureView.group.position.lengthSq() > 0) creatureView.group.position.set(0, 0, 0);
    view.syncProps(mujoco, sim.model, sim.data);
    const pose = sim.robotPose();
    rig.update(dt, robotForCamera(), inputState.camera);
    view.update(dt, camera, toThree(pose.pos, focus));
    fx.update(dt);
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    const r = Math.hypot(pose.pos[0], pose.pos[1]);
    audio.setListener(camera.position, right, clamp((r - (layout.islandRadius - 4)) / 4, 0, 1)); audio.update(dt);
    const t = performance.now();
    renderer.render(scene, camera);
    perf.renderMs = perf.renderMs * .9 + (performance.now() - t) * .1;
    perf.frameMs = perf.frameMs * .9 + (performance.now() - now) * .1;
  }
  raf = requestAnimationFrame(frame);
  void physicsLoop();

  // AI Explore goal presets. The environment judges completion (judge()),
  // never the vision model; start = where the creature is placed first.
  function explorePresets() {
    const gap = laneById(layout, 'gap'), step = laneById(layout, 'step'), top = step.grades.at(-1);
    const flag = layout.landmarks.find(l => l.id === 'yellow-flag'), getPos = () => sim.robotPose().pos;
    return [
      { id: 'flag-beyond-gap', title: 'Reach the yellow flag beyond the gap', zone: 'lab', start: trialSpawn(layout, gap, null, size),
        instruction: 'You are on a raised catwalk. Get across the gaps in the catwalk and reach the yellow flag at the far end.',
        goal: () => landmarkGoal(flag, getPos) },
      { id: 'ball-into-goal', title: 'Push the ball into the goal', zone: 'court', start: { ...layout.pads.find(p => p.zone === 'court') },
        instruction: 'Push the big red and white striped ball into the white goal.',
        goal: () => { const g0 = game.goals; return { id: 'ball-into-goal', name: 'ball in the goal', judge: () => game.goals > g0 }; } },
      { id: 'climb-platform', title: 'Climb onto the platform', zone: 'lab', start: trialSpawn(layout, step, null, size),
        instruction: 'Climb the purple steps in front of you onto the highest platform.',
        goal: () => ({ id: 'climb-platform', name: 'top platform', judge: () => {
          const p = getPos(), [u, v] = layout.labLocal(p[0], p[1]);
          return u >= top.at + .2 && Math.abs(v - step.v) < layout.lab.laneWidth / 2 && sim.terrain.groundHeight(p[0], p[1]) >= top.level - .01;
        } }) },
      ...layout.landmarks.filter(l => !l.lab).map(l => ({ id: `visit-${l.id}`, title: `Visit the ${l.name}`, zone: 'landmark', start: null,
        instruction: `Go to the ${l.name}.`, goal: () => landmarkGoal(l, getPos) })),
    ];
  }

  // --------------------------------------------------------------- the API
  const api = {
    get layout() { return layout.id; },
    // Touch joystick: normalised stick values in [-1, 1]; send {0, 0} on release.
    setCommand(command) { input.setTouch(command ?? {}); },
    // One-shot skills. Jump fires only when the pilot lists a validated jump
    // skill; otherwise the creature gives a small "no" shake and nothing moves.
    trigger(skill, { source = 'user' } = {}) {
      if (skill !== 'jump') throw Error(`Unknown skill trigger: ${skill}`);
      if (!skills.has('jump')) {
        shakeUntil = performance.now() + 480; audio.bonk();
        emit({ type: 'skill-unavailable', skill: 'jump', source, message: `${meta.short ?? meta.label} has no validated jump skill` });
        return false;
      }
      if (oops || paused) return false;
      jumpPending = true; emit({ type: 'jump', phase: 'requested', source }); return true;
    },
    // Terrain Lab: put the creature on a lane's start line (or just before
    // one grade), or run a timed trial there. auto = the standard trial
    // driver (fixed forward command + heading hold + jump trigger); taking
    // the controls turns it into a driven run.
    selectLane(laneId, { grade = null } = {}) {
      const lane = laneById(layout, laneId), g = grade ? lane.grades.find(x => x.id === grade) : null;
      if (grade && !g) throw Error(`Lane ${laneId} has no grade ${grade}`);
      exclusive(() => { trial?.cancel(sim.clock); trialDriver = null; explore.cancel('lane'); respawnAt(trialSpawn(layout, lane, g, size), 'lane'); emit({ type: 'lane', lane: laneId, grade }); });
    },
    runTrial(laneId, { grade = null, auto = true } = {}) {
      const lane = laneById(layout, laneId), g = grade ? lane.grades.find(x => x.id === grade) : null;
      if (grade && !g) throw Error(`Lane ${laneId} has no grade ${grade}`);
      exclusive(() => {
        trial?.cancel(sim.clock); explore.cancel('trial');
        const spawn = trialSpawn(layout, lane, g, size);
        respawnAt(spawn, 'trial');
        trial = createTrial(layout, { laneId, gradeId: grade, clock: sim.clock, size, speed: TRIAL_PROTOCOL.commandFraction * bounds.vx[1], driver: auto ? 'auto' : 'manual' });
        trialDriver = auto ? createTrialDriver(layout, { laneId, bounds, size, canJump: skills.has('jump'), startClock: sim.clock }) : null;
        emit({ type: 'trial', phase: 'armed', lane: laneId, grade, driver: auto ? 'auto' : 'manual' });
      });
    },
    stopTrial() { exclusive(() => { if (trial && (trial.state.phase === 'armed' || trial.state.phase === 'running')) { trial.cancel(sim.clock); emit({ type: 'trial', phase: 'cancelled', lane: trial.state.lane, grade: trial.state.grade }); } trialDriver = null; }); },
    setCameraMode(mode) { rig.setMode(mode); },
    recenterCamera() { rig.recenter(); },
    setChallenge(id, opts) { exclusive(() => game.setChallenge(id, opts)); },
    // Full reset: props home, sparks back, creature at the spawn pad.
    reset() {
      exclusive(() => {
        sim.resetProps(); game.onPropsReset(['ball', 'domino', 'crate', 'cone']);
        propResets.length = 0; explore.cancel('reset'); respawnAt(layout.pads[0], 'reset');
        const active = game.challenge; if (active && active.status !== 'locked') game.setChallenge(active.id, { teleport: false });
      });
    },
    // Quick respawn at the nearest pad (R key); in a lab trial, its start.
    respawn() {
      exclusive(() => {
        explore.cancel('respawn');
        const pad = trial && (trial.state.phase === 'armed' || trial.state.phase === 'running') ? trial.spawn : nearestPad(sim.robotPose().pos);
        if (trial && trial.state.phase !== 'passed' && trial.state.phase !== 'failed') { trial.cancel(sim.clock); trialDriver = null; }
        respawnAt(pad, 'respawn');
      });
    },
    pause(value = true) {
      paused = !!value; if (paused) { cmd = { vx: 0, wz: 0 }; explore.cancel('paused'); input.clear(); }
      emit({ type: 'paused', paused });
    },
    setMuted(value) { audio.setMuted(value); emit({ type: 'muted', muted: !!value }); },
    // AI Explore. opts.preset picks a goal preset (see snapshot().explorePresets):
    // the creature starts at the preset's start and the environment judges
    // completion. Free text works too; a named landmark becomes the goal.
    async startExplore(instruction, opts = {}) {
      audio.unlock();
      const preset = opts.preset ? explorePresets().find(p => p.id === opts.preset) : null;
      if (opts.preset && !preset) throw Error(`Unknown AI Explore preset: ${opts.preset}`);
      if (preset?.start) await new Promise(resolve => exclusive(() => { trial?.cancel(sim.clock); trialDriver = null; respawnAt(preset.start, 'explore'); resolve(); }));
      return explore.start(instruction || preset?.instruction || '', { ...opts, goal: preset ? preset.goal() : null });
    },
    stopExplore(reason = 'user') { explore.cancel(reason); },
    getExploreFrame: () => previewFrame,
    setLook(next) { creatureView.setLook(next); },
    captureRobotView,
    capture() { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); },
    snapshot() {
      const pose = sim.robotPose(), g = game.snapshot();
      return {
        ready: !disposed, paused, muted: audio.muted, audioStarted: audio.started, quality, layout: layout.id,
        time: { sim: +sim.clock.toFixed(3) }, fps: Math.round(fpsEMA),
        perf: { steps: perf.steps, behind: perf.behind, stepMs: +perf.stepMs.toFixed(2), frameMs: +perf.frameMs.toFixed(2), renderMs: +perf.renderMs.toFixed(2) },
        pilot: { kind: meta.kind, label: meta.label, short: meta.short ?? meta.label, honesty: meta.honesty, skills: [...skills], policyId: meta.policyId ?? null,
          commandBounds: structuredClone(bounds), collision: meta.collision ?? null, readinessChecked: meta.readinessChecked ?? null, provenance: meta.provenance ?? null, view: viewSource },
        robot: { pos: pose.pos, heading: pose.heading, speed: pose.speed, forwardSpeed: pose.forwardSpeed, yawRate: pose.yawRate, tilt: pose.tilt,
          heightAboveTerrain: pose.heightAboveTerrain, fall: !!oops, fallReason: oops?.reason ?? null,
          oops: oops ? { reason: oops.reason, message: oops.message, remainingMs: Math.max(0, oops.until - performance.now()) } : null,
          airborne: wasAirborne, groundedFeet: sim.feet.filter(f => f.grounded).length, zone: g.zone },
        size: structuredClone(size),
        command: { input: { vx: inputState.vx, wz: inputState.wz }, boost: inputState.boost, source: inputState.active ? inputState.source : devAuto || devDrive ? 'script' : exploreCmd ? 'explore' : null,
          actual: [cmd.vx, 0, cmd.wz], gamepad: inputState.gamepad ?? null },
        ...g,
        skills: { walk: skills.has('walk'), drive: skills.has('drive'), jump: skills.has('jump'), locomotion },
        camera: { mode: rig.mode, zoom: +rig.zoom.toFixed(2) },
        explore: explore.snapshot(),
        explorePresets: explorePresets().map(p => ({ id: p.id, title: p.title, zone: p.zone, instruction: p.instruction, movesCreature: !!p.start })),
        terrainLab: {
          start: layout.lab.start, finish: layout.lab.finish, sprintMark: layout.lab.sprint, protocol: { ...TRIAL_PROTOCOL },
          lanes: layout.lab.lanes.map(l => ({ id: l.id, title: l.title, accent: l.accent, pad: `lab-${l.id}`,
            grades: l.grades.map(g => ({ id: g.id, label: g.label, kind: g.kind, value: g.value, unit: g.unit })) })),
          trial: trial ? trial.snapshot() : null,
          active: !!trial && (trial.state.phase === 'armed' || trial.state.phase === 'running'), autoDriver: !!trialDriver,
          session: labRuns.map(r => ({ lane: r.lane, grade: r.grade, outcome: r.outcome, timeS: r.timeS, sprintS: r.sprintS, failure: r.failure, driver: r.driver })),
          measured: measuredLab ? { createdAt: terrainResults.createdAt, source: terrainResults.source, protocol: terrainResults.protocol ?? null,
            runs: measuredLab.runs, grades: measuredLab.grades, matrix: terrainResults.matrix?.[measuredLab.id] ?? null } : null,
        },
        zones: layout.zones.map(z => ({ id: z.id, name: z.name, blurb: z.blurb, accent: z.accent, center: z.center, suitability: suitability[z.id] })),
        landmarks: layout.landmarks.map(l => {
          const dx = l.x - pose.pos[0], dy = l.y - pose.pos[1];
          return { id: l.id, name: l.name, color: l.color, pos: [l.x, l.y], distance: +Math.hypot(dx, dy).toFixed(2),
            bearing: +Math.atan2(Math.sin(Math.atan2(dy, dx) - pose.heading), Math.cos(Math.atan2(dy, dx) - pose.heading)).toFixed(3) };
        }),
        capability: { ...capabilityMeta, pilot: meta.kind },
      };
    },
    resize,
    dispose() {
      if (disposed) return;
      teardown();
      emit({ type: 'disposed' });
    },
    // Test/dev hooks (deterministic captures and QA); not for product UI.
    dev: {
      get sim() { return sim; },
      teleport(x, y, yaw = 0) { exclusive(() => respawnAt({ id: 'dev', x, y, yaw }, 'dev')); },
      setCameraPose(position, target) { rig.setPose(position, target); },
      drive(command) { devDrive = command ? [...command] : null; devAuto = null; },
      autopilot(waypoints, opts = {}) { devAuto = waypoints ? createAutopilot({ waypoints, ...opts }) : null; devDrive = null; },
      skipIntro() { rig.skipIntro(); },
      // Stop rendering and physics (e.g. while a headless screenshot is taken).
      freeze(value = true) { frozen = !!value; },
      // Run exactly `seconds` of control steps now (deterministic captures).
      async advance(seconds) {
        holdLoop++;
        try {
          for (let i = 0, n = Math.round(seconds / CONTROL_DT); i < n && !disposed; i++) { while (busy) await sleep(1); await runStep(); }
        } finally { holdLoop--; nextStepAt = performance.now(); }
        return sim.clock;
      },
      renderOnce() { creatureView.sync(sim.data); view.syncProps(mujoco, sim.model, sim.data); rig.update(.016, robotForCamera()); view.update(.016, camera, toThree(sim.robotPose().pos, new THREE.Vector3())); renderer.render(scene, camera); },
    },
  };
  emit({ type: 'ready', pilot: meta.kind, label: meta.label, view: viewSource });
  return api;
}
