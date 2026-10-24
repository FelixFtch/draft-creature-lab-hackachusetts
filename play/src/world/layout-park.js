// "Creature Park": a ~25 m island diorama around a central spawn pad.
//
// Pure data + small geometry helpers; no Three.js, no MuJoCo, no DOM, so the
// same layout drives the browser engine and the headless Node QA.
// Coordinates are MuJoCo world metres: Z up, +X is "forward" from the spawn
// pad, +Y is left. Zones are authored in zone-local coordinates (u = outward
// from the hub along the zone's axis, v = to the left of that axis) and are
// converted to world coordinates once, at module load.
//
// Physics rules (docs/v2/PLAN.md §3): static world geoms are named world_*,
// collide as contype 1 / conaffinity 15; props are free bodies named prop_*,
// 8 / 15. Collectibles (sparks), hoops, signs and decoration are not physical.

const DEG = Math.PI / 180;
export const PARK_ID = 'park';
export const ISLAND_RADIUS = 12.5;
export const HUB_RADIUS = 1.6;

// Static collision classes from the shared plan.
export const STATIC_BITS = { contype: 1, conaffinity: 15 };
export const PROP_BITS = { contype: 8, conaffinity: 15 };

// ---------------------------------------------------------------- helpers
export const yawQuat = yaw => [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
export function quatMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
// Rotate vector v by unit quaternion q (w, x, y, z).
export function quatRotate(q, v) {
  const [w, x, y, z] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
const round = (x, n = 5) => Math.round(x * 10 ** n) / 10 ** n;
const r5 = a => a.map(x => round(x));

function zoneFrame(angleDeg) {
  const a = angleDeg * DEG, c = Math.cos(a), s = Math.sin(a);
  return {
    angle: a,
    toWorld: (u, v) => [u * c - v * s, u * s + v * c],
    toLocal: (x, y) => [x * c + y * s, -x * s + y * c],
  };
}

// ------------------------------------------------------------ zone frames
// Seven zones on six axes around the hub; the Meadow is the approach to the
// Ball Court on the forward axis. AI landmarks sit between the zone axes.
const FRAMES = {
  meadow: zoneFrame(0), court: zoneFrame(0), hills: zoneFrame(60), plateau: zoneFrame(120),
  steps: zoneFrame(180), jump: zoneFrame(240), blocks: zoneFrame(300),
};

const statics = [], props = [], sparks = [], hfields = [], hoops = [], signs = [], pads = [], lanes = [];

// A box given in zone-local coordinates. cz is the box centre height.
function box(zone, name, u, v, cz, hx, hy, hz, opts = {}) {
  const f = FRAMES[zone], [x, y] = f.toWorld(u, v);
  const yaw = f.angle + (opts.yaw ?? 0) * DEG;
  statics.push({ name: `world_${zone}_${name}`, zone, type: 'box', pos: r5([x, y, cz]), quat: r5(yawQuat(yaw)),
    size: r5([hx, hy, hz]), surface: opts.surface ?? 'stone', color: opts.color ?? '#d9cbb0',
    walkable: opts.walkable ?? true, role: opts.role ?? 'block', friction: opts.friction ?? null });
}
function cylinder(zone, name, u, v, cz, radius, halfHeight, opts = {}) {
  const f = FRAMES[zone] ?? zoneFrame(0), [x, y] = opts.world ? [u, v] : f.toWorld(u, v);
  statics.push({ name: `world_${zone}_${name}`, zone, type: 'cylinder', pos: r5([x, y, cz]), quat: [1, 0, 0, 0],
    size: r5([radius, halfHeight]), surface: opts.surface ?? 'stone', color: opts.color ?? '#d9cbb0',
    walkable: false, role: opts.role ?? 'post' });
}
function sphere(zone, name, x, y, z, radius, opts = {}) {
  statics.push({ name: `world_${zone}_${name}`, zone, type: 'sphere', pos: r5([x, y, z]), quat: [1, 0, 0, 0],
    size: [round(radius)], surface: opts.surface ?? 'paint', color: opts.color ?? '#ffffff', walkable: false, role: opts.role ?? 'landmark' });
}
// A capsule between two zone-local points at heights z0/z1.
function capsule(zone, name, a, b, radius, opts = {}) {
  const f = FRAMES[zone], p0 = [...f.toWorld(a[0], a[1]), a[2]], p1 = [...f.toWorld(b[0], b[1]), b[2]];
  statics.push({ name: `world_${zone}_${name}`, zone, type: 'capsule', fromto: r5([...p0, ...p1]), size: [round(radius)],
    pos: r5(p0.map((x, i) => (x + p1[i]) / 2)), quat: [1, 0, 0, 0],
    surface: opts.surface ?? 'metal', color: opts.color ?? '#ffffff', walkable: false, role: opts.role ?? 'post' });
}
// A straight ramp: low end centre at (u0, v0) at height `base` (default the
// ground), climbing `rise` over `run` metres along local direction dirDeg
// (0 = +u). The top surface is flush with the surfaces at both ends.
function ramp(zone, name, u0, v0, dirDeg, run, width, rise, opts = {}) {
  const f = FRAMES[zone], t = .05, slope = Math.atan2(rise, run), len = Math.hypot(run, rise), base = opts.base ?? 0;
  const d = dirDeg * DEG, du = Math.cos(d), dv = Math.sin(d);
  // Top-surface centre, then push the box centre down along the surface normal.
  const um = u0 + du * run / 2, vm = v0 + dv * run / 2;
  const cu = um + du * t * Math.sin(slope), cv = vm + dv * t * Math.sin(slope), cz = base + rise / 2 - t * Math.cos(slope);
  const [x, y] = f.toWorld(cu, cv);
  const q = quatMul(yawQuat(f.angle + d), [Math.cos(-slope / 2), 0, Math.sin(-slope / 2), 0]);
  statics.push({ name: `world_${zone}_${name}`, zone, type: 'box', pos: r5([x, y, cz]), quat: r5(q),
    size: r5([len / 2, width / 2, t]), surface: opts.surface ?? 'wood', color: opts.color ?? '#d9a066',
    walkable: true, role: 'ramp', slopeDeg: round(slope / DEG, 2) });
}
function prop(zone, name, kind, u, v, z, shape, opts = {}) {
  const f = FRAMES[zone], [x, y] = f.toWorld(u, v), yaw = f.angle + (opts.yaw ?? 0) * DEG;
  props.push({ name: `prop_${name}`, zone, kind, type: shape.type, size: r5(shape.size), pos: r5([x, y, z]),
    quat: r5(yawQuat(yaw)), mass: shape.mass, friction: shape.friction ?? [.7, .01, .002], condim: shape.condim ?? 3,
    solref: shape.solref ?? null, damping: shape.damping ?? 0, color: opts.color ?? '#ffffff', surface: shape.surface ?? 'wood',
    group: opts.group ?? kind });
}
function spark(zone, id, u, v, opts = {}) {
  const [x, y] = FRAMES[zone].toWorld(u, v);
  sparks.push({ id: `${zone}-${id}`, zone, x: round(x), y: round(y), hover: opts.hover ?? 0, tag: opts.tag ?? null });
}
function lane(zone, id, title, from, to, extra = {}) {
  const f = FRAMES[zone];
  lanes.push({ id, zone, title, from: r5(f.toWorld(...from)), to: r5(f.toWorld(...to)),
    yaw: round(Math.atan2(...[to[1] - from[1], to[0] - from[0]]) + f.angle), ...extra });
}

// ---------------------------------------------------------------- Meadow
// Flat, safe tutorial lawn on the forward axis. Eight sparks in an S.
for (const [i, [u, v]] of [[2.3, 0], [2.9, .75], [3.5, 1.25], [4.1, .7], [4.5, -.2], [4.9, -1.0], [5.4, -1.35], [5.75, -.55]].entries())
  spark('meadow', i + 1, u, v, { tag: 'meadow' });
lane('meadow', 'flat', 'Meadow (flat)', [.4, 0], [5.6, 0]);

// ------------------------------------------------------------ Ball Court
// Low bumper walls, a wide entrance facing the hub, and a goal box at the far
// end. The ball is a big, light "beach ball" so small creatures can push it.
// Walls are taller than the ball's centre (0.32 m) so it cannot hop over.
export const COURT = { u0: 6.2, u1: 10.8, halfWidth: 2.5, goalHalfWidth: 1.1, goalDepth: .75, wallH: .42, wallT: .12, ballRadius: .32 };
{
  const { u0, u1, halfWidth: hw, goalHalfWidth: gw, goalDepth: gd, wallH: h, wallT: t } = COURT;
  const paint = { surface: 'paint', color: '#fff6e8', walkable: false, role: 'wall' };
  for (const s of [-1, 1]) {
    box('court', `side_${s > 0 ? 'l' : 'r'}`, (u0 + u1) / 2, s * (hw + t / 2), h / 2, (u1 - u0) / 2 + t, t / 2, h / 2, paint);
    box('court', `end_${s > 0 ? 'l' : 'r'}`, u1 + t / 2, s * (gw + .06 + (hw - gw - .06) / 2), h / 2, t / 2, (hw - gw - .06) / 2 + t / 2, h / 2, paint);
    box('court', `front_${s > 0 ? 'l' : 'r'}`, u0 - t / 2, s * (1.3 + (hw - 1.3) / 2), h / 2, t / 2, (hw - 1.3) / 2 + t / 2, h / 2, paint);
    box('court', `goal_side_${s > 0 ? 'l' : 'r'}`, u1 + gd / 2, s * (gw + .06 + t / 2), .35, gd / 2, t / 2, .35, { ...paint, color: '#ffffff' });
    cylinder('court', `post_${s > 0 ? 'l' : 'r'}`, u1, s * gw, .5, .06, .5, { surface: 'metal', color: '#ffffff', role: 'goalpost' });
  }
  box('court', 'goal_back', u1 + gd + t / 2, 0, .4, t / 2, gw + .06 + t, .4, { ...paint, color: '#ffffff' });
  capsule('court', 'crossbar', [u1, -gw, 1.0], [u1, gw, 1.0], .06, { surface: 'metal', color: '#ffffff', role: 'goalpost' });
  prop('court', 'ball', 'ball', 8.0, 0, .32, { type: 'sphere', size: [.32], mass: .3, friction: [.7, .02, .004], condim: 6,
    solref: [.02, .6], damping: .03, surface: 'rubber' }, { color: '#ff6b5b' });
  spark('court', 1, 9.9, 1.8); spark('court', 2, 9.9, -1.8);
  lane('court', 'ball', 'Ball push', [6.5, 0], [10.6, 0], { ball: true });
}

// ----------------------------------------------------------- Bumpy Hills
// One static heightfield with two lanes: gentle swells on the left, choppier
// bumps on the right. Smooth raised-cosine bumps; the border is flat so the
// field blends into the lawn.
export const HILLS = { center: [7.0, 0], halfSize: [2.8, 2.6], spacing: .08 };
{
  const gentle = [[-1.7, 1.35, .04, .95], [0, 1.45, .045, 1.0], [1.7, 1.3, .04, .95], [-.85, 2.0, .025, .6], [.9, .7, .025, .6]];
  // Measured limits (qa/world-park-validation.json): the Flower's flat-ground
  // policy clears ~4 cm swells; the Cheetah's height-scan policy 14 cm bumps.
  const bumpy = [[-2.0, -1.35, .08, .62], [-1.05, -1.05, .1, .6], [-.1, -1.6, .09, .62], [.85, -1.15, .11, .6], [1.8, -1.55, .085, .6], [-1.5, -2.0, .06, .45], [1.3, -.6, .06, .45]];
  const f = FRAMES.hills, [cx, cy] = f.toWorld(...HILLS.center);
  hfields.push({ name: 'world_hills_terrain', zone: 'hills', center: r5([cx, cy]), yaw: f.angle,
    halfSize: HILLS.halfSize, spacing: HILLS.spacing, border: .45,
    bumps: [...gentle, ...bumpy].map(([x, y, h, r]) => ({ x, y, h, r })),
    surface: 'grass', color: '#8cc46a' });
  spark('hills', 1, 7.0 - 1.7, 1.35); spark('hills', 2, 7.0 + 1.7, 1.3);
  spark('hills', 3, 7.0 - 1.05, -1.05); spark('hills', 4, 7.0 + .85, -1.15);
  lane('hills', 'hills-gentle', 'Gentle swells', [3.6, 1.35], [10.3, 1.35]);
  lane('hills', 'hills-bumpy', 'Bumpy lane', [3.6, -1.3], [10.3, -1.3]);
}

// --------------------------------------------------------- Ramp & Plateau
// Two tiers. A long, very gentle ramp (~2.2°) climbs to a low terrace that
// small flat-ground walkers can reach; a steeper ramp (~12°) climbs straight
// from the lawn to the summit block beside it. The 24 cm wall between the
// tiers is deliberate: the summit is earned by the steep ramp.
export const PLATEAU = {
  terrace: { u: [6.5, 9.2], v: [-1.7, .2], height: .12 },
  summit: { u: [6.9, 9.2], v: [.2, 1.7], height: .36 },
  gentle: { u0: 3.4, v: -.8, width: 1.4 }, steep: { u: 8.05, v0: 3.4, width: 1.5 }, rim: .06,
};
{
  const { terrace: T, summit: S, gentle: G, steep: R, rim } = PLATEAU;
  const tier = (name, p, color) => box('plateau', name, (p.u[0] + p.u[1]) / 2, (p.v[0] + p.v[1]) / 2, p.height / 2,
    (p.u[1] - p.u[0]) / 2, (p.v[1] - p.v[0]) / 2, p.height / 2, { surface: 'stone', color, role: 'plateau' });
  tier('terrace', T, '#efdfbf'); tier('summit', S, '#e6cfa4');
  const gentleRun = T.u[0] - G.u0, steepRun = R.v0 - S.v[1];
  ramp('plateau', 'ramp_gentle', G.u0, G.v, 0, gentleRun, G.width, T.height, { color: '#dba56c' });
  ramp('plateau', 'ramp_steep', R.u, R.v0, -90, steepRun, R.width, S.height, { color: '#c98f55' });
  PLATEAU.gentle.slopeDeg = round(Math.atan2(T.height, gentleRun) / DEG, 2);
  PLATEAU.steep.slopeDeg = round(Math.atan2(S.height, steepRun) / DEG, 2);
  // Low rims along the outer edges keep wanderers from tumbling off.
  const rt = .03, rail = { surface: 'wood', color: '#b9824c', walkable: false, role: 'rim' };
  const rimX = (name, p, u, v0, v1) => box('plateau', name, u, (v0 + v1) / 2, p.height + rim / 2, rt, (v1 - v0) / 2, rim / 2, rail);
  const rimY = (name, p, v, u0, u1) => box('plateau', name, (u0 + u1) / 2, v, p.height + rim / 2, (u1 - u0) / 2, rt, rim / 2, rail);
  rimX('rim_terrace_far', T, T.u[1] - rt, T.v[0], T.v[1]);
  rimY('rim_terrace_right', T, T.v[0] + rt, T.u[0], T.u[1]);
  rimX('rim_terrace_near', T, T.u[0] + rt, T.v[0], G.v - G.width / 2);         // beside the gentle ramp
  rimX('rim_terrace_near_b', T, T.u[0] + rt, G.v + G.width / 2, T.v[1]);
  rimX('rim_summit_far', S, S.u[1] - rt, S.v[0], S.v[1]);
  rimX('rim_summit_near', S, S.u[0] + rt, S.v[0], S.v[1]);
  rimY('rim_summit_left_a', S, S.v[1] - rt, S.u[0], R.u - R.width / 2);         // around the steep ramp
  rimY('rim_summit_left_b', S, S.v[1] - rt, R.u + R.width / 2, S.u[1]);
  spark('plateau', 1, 5.0, G.v, { tag: 'ramp' }); spark('plateau', 2, 8.4, -1.0, { tag: 'terrace' });
  spark('plateau', 3, 8.0, 1.0, { tag: 'summit' }); spark('plateau', 4, R.u, 2.6, { tag: 'ramp' });
  lane('plateau', 'ramp-terrace', `Gentle ramp (${PLATEAU.gentle.slopeDeg}°) to the terrace`, [2.8, G.v], [7.8, G.v], { goal: 'terrace' });
  lane('plateau', 'ramp-summit', `Steep ramp (${PLATEAU.steep.slopeDeg}°) to the summit`, [R.u, 4.1], [R.u, .9], { goal: 'summit' });
}
export const SUMMIT = (() => { const [x, y] = FRAMES.plateau.toWorld(8.55, 1.05); return { x: round(x), y: round(y), z: PLATEAU.summit.height, radius: .5 }; })();
export const TERRACE = (() => { const [x, y] = FRAMES.plateau.toWorld(8.2, -.8); return { x: round(x), y: round(y), z: PLATEAU.terrace.height, radius: .7 }; })();

// ------------------------------------------------------------------ Steps
// Three stair "pyramids" side by side, a difficulty ladder: baby risers a
// shuffling hexapod can manage, medium, and giant steps near the limit of the
// legacy Cheetah (measured: 11 cm OK, 14 cm not).
export const STEPS = {
  baby: { title: 'Baby steps', label: 'BABY', v: 1.45, u0: 4.3, riser: .014, tread: .42, count: 4, landing: .9, width: 1.4, palette: ['#c4e8c4', '#a6dbb0', '#88cd9d', '#6abf8b'] },
  medium: { title: 'Medium steps', label: 'MEDIUM', v: 0, u0: 4.5, riser: .06, tread: .5, count: 3, landing: .8, width: 1.2, palette: ['#d9d1f4', '#bdb1ec', '#a192e3'] },
  giant: { title: 'Giant steps', label: 'GIANT', v: -1.4, u0: 4.5, riser: .12, tread: .6, count: 2, landing: .8, width: 1.2, palette: ['#f7d2e2', '#ec9fc1'] },
};
{
  for (const [key, s] of Object.entries(STEPS)) {
    const total = 2 * s.count * s.tread + s.landing;
    for (let k = 1; k <= s.count; k++) {
      const len = total - 2 * (k - 1) * s.tread, h = k * s.riser;
      box('steps', `${key}_${k}`, s.u0 + total / 2, s.v, h / 2, len / 2, s.width / 2, h / 2,
        { surface: 'stone', color: s.palette[(k - 1) % s.palette.length], role: 'step' });
    }
    s.total = round(total); s.top = round(s.count * s.riser);
    spark('steps', key, s.u0 + total / 2, s.v, { tag: 'landing' });
    lane('steps', `steps-${key}`, `${s.title} (${+(s.riser * 100).toFixed(1)} cm)`, [3.6, s.v], [s.u0 + total + .7, s.v], { steps: key });
  }
  spark('steps', 'end', 9.5, 0);
}

// ------------------------------------------------------------ Jump Garden
// Candy-coloured stepping stones, a gap, and hoops that only a creature with
// a trained jump skill can sail through. Hoops are visual + JS checks only;
// they scale with the creature so they read at any size.
export const JUMP = {
  stones: [
    { id: 'stone_1', u: 4.9, v: 0, half: [.5, .6], h: .06, color: '#ffd36e' },
    { id: 'stone_2', u: 6.2, v: 0, half: [.5, .6], h: .14, color: '#f7a8c4' },
    { id: 'stone_3', u: 7.6, v: 0, half: [.5, .6], h: .22, color: '#9ad7f0' },
    { id: 'gap_a', u: 5.0, v: -1.9, half: [.6, .5], h: .15, color: '#c7b6f2' },
    { id: 'gap_b', u: 6.6, v: -1.9, half: [.6, .5], h: .15, color: '#c7b6f2' },
  ],
};
{
  for (const s of JUMP.stones)
    box('jump', s.id, s.u, s.v, s.h / 2, s.half[0], s.half[1], s.h / 2, { surface: 'plastic', color: s.color, role: 'platform' });
  for (const [i, u] of [4.8, 6.0, 7.2].entries()) {
    const [x, y] = FRAMES.jump.toWorld(u, 1.6);
    hoops.push({ id: `hoop-${i + 1}`, zone: 'jump', x: round(x), y: round(y), yaw: round(FRAMES.jump.angle) });
  }
  spark('jump', 1, 4.9, 0, { tag: 'stone' }); spark('jump', 2, 7.6, 0, { tag: 'stone' }); spark('jump', 3, 8.2, 1.6, { tag: 'hoops' });
  lane('jump', 'stone-1', 'First stepping stone (8 cm)', [3.6, 0], [4.9, 0], { goal: 'stone_1' });
}

// ------------------------------------------------------------- Block Yard
// A domino line to topple, a crate pyramid to knock down, and a few cones.
export const BLOCKS = { domino: { v: .9, u0: 4.7, spacing: .3, count: 9, half: [.035, .18, .25], mass: .45 },
  crates: { u: 6.1, v: -1.25, half: .15, mass: .8 } };
{
  const rainbow = ['#ff6b5b', '#ff9f43', '#ffd23f', '#7bd389', '#4cc3d9', '#5b8def', '#9b6bff', '#f06fb6', '#ff6b5b'];
  const d = BLOCKS.domino;
  for (let i = 0; i < d.count; i++)
    prop('blocks', `domino_${i + 1}`, 'domino', d.u0 + i * d.spacing, d.v, d.half[2] + .0005,
      { type: 'box', size: d.half, mass: d.mass, friction: [.6, .005, .0001], surface: 'wood' }, { color: rainbow[i % rainbow.length], group: 'dominoes' });
  const c = BLOCKS.crates, s = c.half;
  const rows = [[-1, 0, 1], [-.5, .5], [0]];
  let n = 0;
  rows.forEach((row, level) => row.forEach(off => {
    prop('blocks', `crate_${++n}`, 'crate', c.u, c.v + off * (2 * s + .01), s + level * (2 * s + .002) + .0005,
      { type: 'box', size: [s, s, s], mass: c.mass, friction: [.7, .005, .0001], surface: 'wood' }, { color: '#d79a5b', group: 'crates' });
  }));
  for (const [i, [u, v]] of [[4.6, -2.1], [5.2, -2.5], [7.5, -.15]].entries())
    prop('blocks', `cone_${i + 1}`, 'cone', u, v, .15 + .0005, { type: 'cylinder', size: [.11, .15], mass: .2, friction: [.8, .005, .0001], surface: 'rubber' },
      { color: '#ff8c42', group: 'cones' });
  spark('blocks', 1, 7.6, .9); spark('blocks', 2, 6.9, -2.0);
  lane('blocks', 'dominoes', 'Domino push', [3.9, .9], [6.0, .9], { dominoes: true });
}

// --------------------------------------------------------------- Landmarks
// Big, saturated, distinctly shaped objects between the zone axes: easy for a
// vision model to name and steer toward ("go to the red ball").
export const LANDMARKS = [
  { id: 'red-ball', name: 'red ball', color: '#e8473f', angle: 30, shape: 'ball', aliases: ['red ball', 'red sphere', 'red'] },
  { id: 'green-tree', name: 'green tree', color: '#4cb050', angle: 90, shape: 'tree', aliases: ['green tree', 'big tree', 'tree', 'green'] },
  { id: 'yellow-arch', name: 'yellow arch', color: '#ffc928', angle: 150, shape: 'arch', aliases: ['yellow arch', 'arch', 'gate', 'yellow'] },
  { id: 'blue-tower', name: 'blue tower', color: '#3f7fe0', angle: 210, shape: 'tower', aliases: ['blue tower', 'tower', 'blue'] },
  { id: 'purple-crystal', name: 'purple crystal', color: '#9b5de5', angle: 270, shape: 'crystal', aliases: ['purple crystal', 'crystal', 'gem', 'purple'] },
  { id: 'orange-windmill', name: 'orange windmill', color: '#ff8c1a', angle: 330, shape: 'windmill', aliases: ['orange windmill', 'windmill', 'orange'] },
].map(l => {
  const r = 10.9, a = l.angle * DEG, x = round(r * Math.cos(a)), y = round(r * Math.sin(a));
  return { ...l, x, y, yaw: round(a + Math.PI), reach: l.shape === 'arch' ? 1.0 : l.shape === 'tree' ? 1.7 : 1.35 };
});
for (const l of LANDMARKS) {
  const z = 'landmark', a = l.angle * DEG, c = Math.cos(a), s = Math.sin(a);
  if (l.shape === 'ball') {
    cylinder(z, `${l.id}_pedestal`, l.x, l.y, .13, .42, .13, { world: true, surface: 'stone', color: '#f4efe4', role: 'landmark' });
    sphere(z, `${l.id}_ball`, l.x, l.y, .26 + .55, .55, { color: l.color });
  } else if (l.shape === 'tree') {
    cylinder(z, `${l.id}_trunk`, l.x, l.y, .8, .24, .8, { world: true, surface: 'wood', color: '#8a5a3b', role: 'landmark' });
    sphere(z, `${l.id}_canopy`, l.x, l.y, 2.25, 1.05, { color: l.color, surface: 'leaves' });
  } else if (l.shape === 'arch') {
    // Pillars stand left/right of the trail; the beam spans above it.
    for (const side of [-1, 1]) {
      const px = l.x - s * side * .85, py = l.y + c * side * .85;
      statics.push({ name: `world_${z}_${l.id}_pillar_${side > 0 ? 'l' : 'r'}`, zone: z, type: 'box', pos: r5([px, py, .8]),
        quat: r5(yawQuat(a)), size: [.16, .16, .8], surface: 'paint', color: l.color, walkable: false, role: 'landmark' });
    }
    statics.push({ name: `world_${z}_${l.id}_beam`, zone: z, type: 'box', pos: r5([l.x, l.y, 1.75]), quat: r5(yawQuat(a)),
      size: [.18, 1.05, .15], surface: 'paint', color: l.color, walkable: false, role: 'landmark' });
  } else if (l.shape === 'tower') {
    cylinder(z, `${l.id}_body`, l.x, l.y, 1.1, .5, 1.1, { world: true, surface: 'paint', color: l.color, role: 'landmark' });
  } else if (l.shape === 'crystal') {
    cylinder(z, `${l.id}_base`, l.x, l.y, .12, .55, .12, { world: true, surface: 'stone', color: '#ede6f7', role: 'landmark' });
    statics.push({ name: `world_${z}_${l.id}_gem`, zone: z, type: 'box', pos: r5([l.x, l.y, 1.05]),
      quat: r5(quatMul(yawQuat(a + Math.PI / 4), [Math.cos(.3), Math.sin(.3), 0, 0])), size: [.32, .32, .62],
      surface: 'crystal', color: l.color, walkable: false, role: 'landmark' });
  } else if (l.shape === 'windmill') {
    cylinder(z, `${l.id}_body`, l.x, l.y, .95, .45, .95, { world: true, surface: 'paint', color: l.color, role: 'landmark' });
  }
}
// One spark in front of every landmark: a reason to wander the outer ring.
for (const l of LANDMARKS) {
  const a = l.angle * DEG;
  sparks.push({ id: `landmark-${l.id}`, zone: 'landmark', x: round(9.5 * Math.cos(a)), y: round(9.5 * Math.sin(a)), hover: 0, tag: l.id });
}

// --------------------------------------------------------- pads and signs
// Respawn pads: the hub plus one at every zone entrance (facing the zone).
pads.push({ id: 'hub', zone: 'hub', x: 0, y: 0, yaw: 0 });
for (const [zone, u] of [['court', 5.85], ['hills', 3.4], ['plateau', 3.0], ['steps', 3.4], ['jump', 3.4], ['blocks', 3.4]]) {
  const [x, y] = FRAMES[zone].toWorld(u, 0);
  pads.push({ id: zone, zone, x: round(x), y: round(y), yaw: round(FRAMES[zone].angle) });
}

export const ZONES = [
  // Signs stand beside each zone's spoke path, facing the hub (never on a lane).
  { id: 'meadow', name: 'Meadow', blurb: 'Soft grass and an easy spark trail.', accent: '#7cc46a', angle: 0, u: [1.3, 6.0], v: [-2.6, 2.6], sign: [2.75, -1.25] },
  { id: 'court', name: 'Ball Court', blurb: 'Nudge the big ball into the goal.', accent: '#4fb6a8', angle: 0, u: [6.0, 11.8], v: [-2.75, 2.75], sign: [5.7, -1.95] },
  { id: 'hills', name: 'Bumpy Hills', blurb: 'Gentle swells on the left, choppy bumps on the right.', accent: '#8cc46a', angle: 60, u: [4.0, 10.0], v: [-2.8, 2.8], sign: [3.15, -1.0] },
  { id: 'plateau', name: 'Ramp & Plateau', blurb: 'A gentle ramp to the terrace, a steep one to the summit flag.', accent: '#e0a868', angle: 120, u: [3.2, 9.4], v: [-1.95, 3.55], sign: [3.0, .8] },
  { id: 'steps', name: 'Steps', blurb: 'Baby, medium and giant stairs side by side.', accent: '#b9a8e8', angle: 180, u: [3.9, 9.7], v: [-2.15, 2.3], sign: [3.15, -1.0] },
  { id: 'jump', name: 'Jump Garden', blurb: 'Stepping stones, a gap and hoops for jumpers.', accent: '#f39ac0', angle: 240, u: [3.9, 8.7], v: [-2.6, 2.3], sign: [3.15, -1.0] },
  { id: 'blocks', name: 'Block Yard', blurb: 'Topple the dominoes, crash the crates.', accent: '#ff9f43', angle: 300, u: [3.9, 8.2], v: [-2.9, 1.6], sign: [3.15, -1.0] },
].map(z => {
  const f = FRAMES[z.id], uc = (z.u[0] + z.u[1]) / 2, vc = (z.v[0] + z.v[1]) / 2, [x, y] = f.toWorld(uc, vc);
  const [sx, sy] = f.toWorld(...z.sign);
  signs.push({ zone: z.id, x: round(sx), y: round(sy), yaw: round(f.angle + Math.PI) });
  return { ...z, center: [round(x), round(y)], radius: round(Math.hypot((z.u[1] - z.u[0]) / 2, (z.v[1] - z.v[0]) / 2)) };
});

// Which zone contains world point (x, y)? Hub and the outer ring are zones too.
export function zoneAt(x, y) {
  const r = Math.hypot(x, y);
  if (r < HUB_RADIUS) return 'hub';
  for (const z of ZONES) {
    const [u, v] = FRAMES[z.id].toLocal(x, y);
    if (u >= z.u[0] && u <= z.u[1] && v >= z.v[0] && v <= z.v[1]) return z.id;
  }
  return r > ISLAND_RADIUS - .3 ? 'shore' : 'trail';
}
export const toZoneLocal = (zone, x, y) => FRAMES[zone].toLocal(x, y);
export const fromZoneLocal = (zone, u, v) => FRAMES[zone].toWorld(u, v);

// Ground decals (painted into the ground texture; never physical).
export const PATHS = [
  ...[0, 60, 120, 180, 240, 300].map(a => ({ kind: 'spoke', angle: a, r0: HUB_RADIUS - .2, r1: a === 0 ? 1.4 : 4.0, width: .9 })),
  ...LANDMARKS.map(l => ({ kind: 'trail', angle: l.angle, r0: HUB_RADIUS, r1: 9.9, width: .55 })),
];

// Challenges. `requires` lists skills the pilot must have; otherwise locked.
export const CHALLENGES = [
  { id: 'meadow-sparks', title: 'Spark Sprint', zone: 'meadow', requires: [], goal: 'Collect the 8 Meadow sparks', kind: 'sparks', sparkTag: 'meadow', target: 8 },
  { id: 'goal', title: 'Goal!', zone: 'court', requires: [], goal: 'Push the big ball into the goal', kind: 'goal', target: 1 },
  { id: 'terrace', title: 'Terrace', zone: 'plateau', requires: [], goal: 'Walk up the gentle ramp onto the terrace', kind: 'terrace', target: 1 },
  { id: 'summit', title: 'Summit', zone: 'plateau', requires: [], goal: 'Climb the steep ramp and touch the summit flag', kind: 'summit', target: 1 },
  { id: 'steps', title: 'Stair Hop', zone: 'steps', requires: [], goal: 'Walk all the way across any staircase', kind: 'steps', target: 1 },
  { id: 'hills', title: 'Hill Roll', zone: 'hills', requires: [], goal: 'Cross Bumpy Hills end to end without a tumble', kind: 'hills', target: 1 },
  { id: 'dominoes', title: 'Domino Rally', zone: 'blocks', requires: [], goal: 'Topple all 9 dominoes', kind: 'dominoes', target: BLOCKS.domino.count },
  { id: 'hoop', title: 'Hoop Jump', zone: 'jump', requires: ['jump'], goal: 'Jump through a hoop', kind: 'hoop', target: 1 },
  { id: 'explore', title: 'AI Explorer', zone: 'landmark', requires: [], goal: 'Let AI Explore steer you to a landmark', kind: 'explore', target: 1 },
  { id: 'all-sparks', title: 'Spark Collector', zone: 'park', requires: [], goal: `Collect all ${sparks.length} sparks in the park`, kind: 'sparks', sparkTag: null, target: sparks.length },
];

export const STICKERS = [
  { id: 'first-spark', title: 'First Spark', blurb: 'Collected your first spark.' },
  { id: 'meadow-sweep', title: 'Meadow Sweep', blurb: 'Every Meadow spark in one go.' },
  { id: 'goal', title: 'Golazo!', blurb: 'Scored a goal.' },
  { id: 'hat-trick', title: 'Hat Trick', blurb: 'Three goals.' },
  { id: 'terrace', title: 'Terrace', blurb: 'Walked up onto the terrace.' },
  { id: 'summit', title: 'Summit', blurb: 'Stood on the plateau summit.' },
  { id: 'stair-hop', title: 'Stair Hop', blurb: 'Crossed a staircase.' },
  { id: 'hill-roll', title: 'Hill Roll', blurb: 'Crossed Bumpy Hills.' },
  { id: 'domino', title: 'Domino Rally', blurb: 'Toppled every domino.' },
  { id: 'crate-crash', title: 'Crate Crasher', blurb: 'Knocked the crate pyramid down.' },
  { id: 'hoop', title: 'Hoop Star', blurb: 'Jumped through a hoop.' },
  { id: 'explorer', title: 'AI Explorer', blurb: 'AI Explore reached a landmark.' },
  { id: 'collector', title: 'Spark Collector', blurb: 'Collected every spark in the park.' },
  { id: 'tourist', title: 'Tourist', blurb: 'Visited every zone.' },
  { id: 'wanderer', title: 'Wanderer', blurb: 'Walked 50 metres.' },
  { id: 'oops', title: 'Oops!', blurb: 'Took a tumble. It happens to everyone.' },
  { id: 'splash', title: 'Splash!', blurb: 'Tried to swim. Robots sink.' },
];

export const PARK = Object.freeze({
  id: PARK_ID, name: 'Creature Park', islandRadius: ISLAND_RADIUS, hubRadius: HUB_RADIUS,
  spawn: { x: 0, y: 0, yaw: 0 }, pads, zones: ZONES, statics, props, hfields, sparks, hoops, signs, lanes,
  landmarks: LANDMARKS, paths: PATHS, challenges: CHALLENGES, stickers: STICKERS,
  court: COURT, plateau: PLATEAU, summit: SUMMIT, terrace: TERRACE, steps: STEPS, jump: JUMP, blocks: BLOCKS, hills: HILLS,
  zoneAt, toZoneLocal, fromZoneLocal,
});

export const LAYOUTS = { park: PARK };
export function getLayout(id = 'park') {
  const layout = LAYOUTS[id];
  if (!layout) throw Error(`Unknown world layout: ${id}`);
  return layout;
}
