import * as THREE from 'three';
import { quatRotate } from './layout-park.js';

// Third-person camera for the playground (three.js world coords, Y up).
// chase: springs behind the creature; a Schmitt trigger on heading ignores the
// gait's natural yaw wiggle but follows real turns at once. orbit: drag (or
// right stick) to look around the creature; returns to chase after a while of
// driving. overview: high view of the park. intro: cinematic sweep from the
// sky down behind the creature, skippable. Occlusion uses the layout's
// analytic primitives (cheap ray tests), never mesh raycasts.
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const ease = t => (t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const toMj = v => [v.x, -v.z, v.y];

function rayBox(o, d, s) {
  const inv = [s.quat[0], -s.quat[1], -s.quat[2], -s.quat[3]];
  const p = quatRotate(inv, [o[0] - s.pos[0], o[1] - s.pos[1], o[2] - s.pos[2]]), r = quatRotate(inv, d);
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const h = s.size[i] + .04;
    if (Math.abs(r[i]) < 1e-9) { if (Math.abs(p[i]) > h) return null; continue; }
    let a = (-h - p[i]) / r[i], b = (h - p[i]) / r[i]; if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return null;
  }
  return t0 > 0 ? t0 : null;
}
function raySphere(o, d, c, radius) {
  const m = [o[0] - c[0], o[1] - c[1], o[2] - c[2]], b = m[0] * d[0] + m[1] * d[1] + m[2] * d[2], cc = m[0] ** 2 + m[1] ** 2 + m[2] ** 2 - radius * radius;
  const disc = b * b - cc; if (cc < 0 || disc < 0) return null;
  const t = -b - Math.sqrt(disc); return t > 0 ? t : null;
}
function rayCylinder(o, d, s) {
  const [r, hh] = s.size, R = r + .05, dx = o[0] - s.pos[0], dy = o[1] - s.pos[1];
  const a = d[0] * d[0] + d[1] * d[1], b = dx * d[0] + dy * d[1], c = dx * dx + dy * dy - R * R;
  if (c < 0) return null;
  const disc = b * b - a * c; if (a < 1e-9 || disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a, z = o[2] + d[2] * t;
  return t > 0 && Math.abs(z - s.pos[2]) <= hh + .05 ? t : null;
}

export function createCameraRig({ camera, dom, terrain, obstacles = [], size, onModeChange = () => {} }) {
  const h = Math.max(.2, size?.height ?? .45);
  // Close third-person view from behind the robot's back, looking at the robot.
  const chase = { dist: 1.0 + 2.6 * h, pitch: .3, lift: .35 * h, ahead: .1 };
  let mode = 'chase', zoom = 1, intro = null, lastInteract = -1e9, disposed = false;
  let yawSmooth = 0, yawFollow = 0, tracking = false;
  const orbit = { yaw: 0, pitch: .45 };
  const target = new THREE.Vector3(), goal = new THREE.Vector3(), desired = new THREE.Vector3(), tmp = new THREE.Vector3();
  const prims = obstacles.filter(s => s.type === 'box' || s.type === 'cylinder' || s.type === 'sphere')
    .map(s => ({ s, c: s.pos, r: s.type === 'sphere' ? s.size[0] : s.type === 'cylinder' ? Math.hypot(s.size[0], s.size[1]) : Math.hypot(...s.size) }));
  function setMode(next, { silent = false } = {}) {
    if (!['chase', 'orbit', 'overview'].includes(next)) throw Error(`Unknown camera mode ${next}`);
    if (next === 'orbit' && mode !== 'orbit') {
      tmp.copy(camera.position).sub(target);
      orbit.yaw = Math.atan2(tmp.x, tmp.z); orbit.pitch = Math.max(.08, Math.min(1.35, Math.asin(Math.min(1, tmp.y / Math.max(1e-3, tmp.length())))));
    }
    intro = null; mode = next; if (!silent) onModeChange(mode);
  }

  // Pointer: drag to orbit, wheel / pinch to zoom.
  const pointers = new Map();
  let pinch = null;
  function onDown(e) {
    if (e.button !== undefined && e.button > 2) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dom.setPointerCapture?.(e.pointerId);
    if (intro) skipIntro();
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom }; }
  }
  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoom = Math.max(.45, Math.min(2.8, pinch.zoom * pinch.d / Math.max(20, d))); return;
    }
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    if (mode !== 'orbit') setMode('orbit');
    orbit.yaw -= dx * .006; orbit.pitch = Math.max(.06, Math.min(1.4, orbit.pitch + dy * .005));
    lastInteract = performance.now();
  }
  function onUp(e) { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; }
  function onWheel(e) { e.preventDefault(); zoom = Math.max(.45, Math.min(2.8, zoom * Math.exp(e.deltaY * .0012))); lastInteract = performance.now(); }
  dom.addEventListener('pointerdown', onDown); dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp); dom.addEventListener('pointercancel', onUp);
  dom.addEventListener('wheel', onWheel, { passive: false });
  dom.style.touchAction = 'none';

  function occlude(from, to) {
    const o = toMj(from), e = toMj(to), d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]], len = Math.hypot(...d);
    if (len < 1e-4) return to;
    d[0] /= len; d[1] /= len; d[2] /= len;
    let best = len;
    for (const { s, c, r } of prims) {
      // Bounding-sphere reject first.
      const m = [o[0] - c[0], o[1] - c[1], o[2] - c[2]], b = m[0] * d[0] + m[1] * d[1] + m[2] * d[2];
      const closest = m[0] ** 2 + m[1] ** 2 + m[2] ** 2 - b * b;
      if (closest > (r + .3) ** 2 || -b > best + r) continue;
      const t = s.type === 'box' ? rayBox(o, d, s) : s.type === 'cylinder' ? rayCylinder(o, d, s) : raySphere(o, d, s.pos, s.size[0] + .05);
      if (t !== null && t < best) best = t;
    }
    if (best >= len) return to;
    const keep = Math.max(.35 * h + .25, best - .18);
    return tmp.copy(to).sub(from).normalize().multiplyScalar(Math.min(len, keep)).add(from);
  }
  function clampGround(p) {
    const g = terrain.groundHeight(p.x, -p.z, { solids: true });
    if (p.y < g + .16) p.y = g + .16;
    return p;
  }
  function chasePose(yaw, distScale = 1, pitch = chase.pitch) {
    const dist = chase.dist * zoom * distScale;
    return desired.set(target.x - Math.cos(yaw) * dist * Math.cos(pitch), target.y + dist * Math.sin(pitch), target.z + Math.sin(yaw) * dist * Math.cos(pitch));
  }
  function startIntro(heading, seconds = 3) {
    intro = { t: 0, seconds, a0: heading + 2.4, a1: heading, from: new THREE.Vector3(0, .6, 0) };
    mode = 'chase';
  }
  function skipIntro() { if (intro) intro.seconds = Math.min(intro.seconds, intro.t * intro.seconds + .7); }

  // robot: { pos: Vector3 (three, torso), heading (MuJoCo yaw), turning, moving }
  function update(dt, robot, padCamera = { x: 0, y: 0 }) {
    if (disposed) return;
    const f = new THREE.Vector3(Math.cos(robot.heading), 0, -Math.sin(robot.heading));
    goal.copy(robot.pos).addScaledVector(f, chase.ahead * chase.dist * (mode === 'chase' ? 1 : .2)); goal.y += chase.lift;
    target.lerp(goal, 1 - Math.exp(-dt * 7));
    // Heading follow with hysteresis (see header).
    yawSmooth = wrap(yawSmooth + wrap(robot.heading - yawSmooth) * (1 - Math.exp(-dt * (robot.turning ? 9 : 2.2))));
    const err = wrap(yawSmooth - yawFollow);
    if (robot.turning || Math.abs(err) > .17) tracking = true;
    if (tracking) { yawFollow = wrap(yawFollow + err * (1 - Math.exp(-dt * (robot.turning ? 5.5 : 3)))); if (!robot.turning && Math.abs(err) < .03) tracking = false; }
    if (Math.abs(padCamera.x) + Math.abs(padCamera.y) > .05) {
      if (mode !== 'orbit') setMode('orbit');
      orbit.yaw -= padCamera.x * dt * 2.4; orbit.pitch = Math.max(.06, Math.min(1.4, orbit.pitch - padCamera.y * dt * 1.6)); lastInteract = performance.now();
    }
    if (mode === 'orbit' && pointers.size === 0 && robot.moving && performance.now() - lastInteract > 5000) setMode('chase');

    if (intro) {
      intro.t = Math.min(1, intro.t + dt / intro.seconds);
      const e = ease(intro.t), a = intro.a0 + (intro.a1 - intro.a0) * e;
      const end = chasePose(a), radius = 24 + (Math.hypot(end.x - target.x, end.z - target.z) - 24) * e, height = 13 + (end.y - target.y - 13) * e;
      const look = tmp.copy(intro.from).lerp(target, e);
      camera.position.set(look.x - Math.cos(a) * radius, look.y + height, look.z + Math.sin(a) * radius);
      camera.lookAt(look);
      if (intro.t >= 1) { intro = null; yawFollow = yawSmooth = robot.heading; onModeChange('chase'); }
      return;
    }
    if (mode === 'chase') chasePose(yawFollow);
    else if (mode === 'orbit') {
      const dist = chase.dist * zoom;
      desired.set(target.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * dist, target.y + Math.sin(orbit.pitch) * dist, target.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * dist);
    } else chasePose(yawFollow, 5.5 + 2 / h * .2, .95);
    const smoothed = tmp.copy(camera.position).lerp(desired, 1 - Math.exp(-dt * (mode === 'overview' ? 2.5 : 5)));
    const safe = clampGround(occlude(target, smoothed).clone());
    camera.position.copy(safe);
    camera.lookAt(target);
  }
  function snapBehind(robot) {
    const f = new THREE.Vector3(Math.cos(robot.heading), 0, -Math.sin(robot.heading));
    target.copy(robot.pos).addScaledVector(f, chase.ahead * chase.dist); target.y += chase.lift;
    yawSmooth = yawFollow = robot.heading; tracking = false;
    if (mode === 'orbit') mode = 'chase';
    camera.position.copy(clampGround(chasePose(yawFollow).clone())); camera.lookAt(target);
  }
  return {
    update, setMode, snapBehind, startIntro, skipIntro,
    recenter() { setMode('chase'); },
    cycle() { setMode(mode === 'chase' ? 'overview' : 'chase'); return mode; },
    setPose(position, look) { intro = null; mode = 'orbit'; lastInteract = Infinity; camera.position.set(...position); target.set(...look); camera.lookAt(target);
      tmp.copy(camera.position).sub(target); orbit.yaw = Math.atan2(tmp.x, tmp.z); orbit.pitch = Math.asin(Math.min(1, tmp.y / Math.max(1e-3, tmp.length()))); zoom = tmp.length() / chase.dist; },
    get mode() { return intro ? 'intro' : mode; }, get zoom() { return zoom; }, get target() { return target; },
    dispose() {
      disposed = true;
      dom.removeEventListener('pointerdown', onDown); dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp); dom.removeEventListener('pointercancel', onUp); dom.removeEventListener('wheel', onWheel);
    },
  };
}
