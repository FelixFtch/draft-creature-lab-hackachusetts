// Playground rules: sparks, challenges, stickers, timers and best times.
//
// Pure JS over plain state (no Three.js, no MuJoCo, no DOM) so the headless QA
// exercises the same rules as the browser. The engine calls update() after
// every control step with the robot pose and prop states; timers use the
// engine's monotonic simulation clock, never wall time.
const STORAGE_KEY = 'draft-creature-park-v1';
const TOPPLED_UP_Z = Math.cos(Math.PI / 4);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

export function createMemoryStorage() {
  const map = new Map();
  return { getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => { map.set(k, String(v)); } };
}
// localStorage can be missing (Node), blocked (privacy mode) or full: every
// access is wrapped so progress saving can never break play.
function defaultStorage() {
  try { return globalThis.localStorage ?? createMemoryStorage(); } catch { return createMemoryStorage(); }
}
function loadAll(storage) {
  try { const v = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null'); return v && typeof v === 'object' && v.creatures ? v : { version: 1, creatures: {} }; }
  catch { return { version: 1, creatures: {} }; }
}

export function sparkHover(size) { return .12 + .55 * (size?.height ?? .4); }
export function collectRadius(size) { return .25 + .4 * (size?.radius ?? .5); }
export function hoopGeometry(size) {
  const h = size?.height ?? .4;
  return { radius: .32 + .42 * h, bottom: .25 + .35 * h };
}

export function createGame({ layout, terrain, pilot, size, storage = defaultStorage(), onEvent = () => {}, resetProps = () => {}, respawnAt = () => {} }) {
  const skills = new Set(pilot.skills ?? []);
  const creatureKey = `${pilot.kind}:${pilot.policyId ?? pilot.label ?? 'creature'}`;
  let all = loadAll(storage);
  const mine = () => (all.creatures[creatureKey] ??= { best: {}, stickers: {}, totals: { sparks: 0, goals: 0, distance: 0, falls: 0 } });
  function persist() { try { storage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ } }

  const hover = sparkHover(size), reach = collectRadius(size), hoop = hoopGeometry(size);
  const sparks = layout.sparks.map(s => ({ ...s, z: terrain.groundHeight(s.x, s.y) + hover + (s.hover ?? 0), collected: false, collectedAt: null }));
  const sparkTotal = sparks.length;
  const zoneName = Object.fromEntries(layout.zones.map(z => [z.id, z.name]));
  const challengeDefs = new Map(layout.challenges.map(c => [c.id, c]));

  let clock = 0, round = 1, goals = 0, ballScoredAt = null, dominoesDown = 0, cratesDown = false;
  let zone = null, distance = 0, lastPos = null, falls = 0, visited = new Set();
  let challenge = null, lastAir = -Infinity, prevHoopSide = new Map(), explore = { reached: null };
  const stepCrossing = new Map(), hills = { entered: false };
  const recent = [];

  function emit(event) {
    const e = { ...event, at: +clock.toFixed(2) };
    recent.push(e); if (recent.length > 12) recent.shift();
    onEvent(e);
  }
  function award(id) {
    const def = layout.stickers.find(s => s.id === id);
    if (!def || mine().stickers[id]) return false;
    mine().stickers[id] = new Date().toISOString(); persist();
    emit({ type: 'sticker', id, title: def.title, blurb: def.blurb });
    return true;
  }
  function lockedReason(def) {
    const missing = def.requires.filter(s => !skills.has(s));
    return missing.length ? `Needs a trained ${missing.join(' + ')} skill` : null;
  }

  // ------------------------------------------------------------ challenges
  function setChallenge(id, { teleport = true } = {}) {
    if (id === null || id === undefined) { challenge = null; emit({ type: 'challenge', id: null, status: 'cleared' }); return null; }
    const def = challengeDefs.get(id);
    if (!def) throw Error(`Unknown challenge: ${id}`);
    const locked = lockedReason(def);
    if (locked) { challenge = { id, status: 'locked', lockedReason: locked, progress: 0, target: def.target, startedAt: null, timeMs: null }; emit({ type: 'challenge', id, status: 'locked', reason: locked }); return challenge; }
    // Fresh attempt: put this challenge's props/sparks back and start the clock.
    if (def.kind === 'sparks') for (const s of sparks) if (!def.sparkTag || s.tag === def.sparkTag) s.collected = false;
    if (def.kind === 'goal') { resetProps(p => p.kind === 'ball'); ballScoredAt = null; }
    if (def.kind === 'dominoes') { resetProps(p => p.kind === 'domino' || p.kind === 'crate'); dominoesDown = 0; cratesDown = false; }
    if (def.kind === 'hills') hills.entered = false;
    if (def.kind === 'steps') stepCrossing.clear();
    const pad = layout.pads.find(p => p.zone === def.zone) ?? layout.pads[0];
    if (teleport && def.kind !== 'explore' && def.kind !== 'sparks') respawnAt(pad);
    if (teleport && def.kind === 'sparks') respawnAt(layout.pads[0]);
    challenge = { id, status: 'active', progress: 0, target: def.target, startedAt: clock, timeMs: 0, goals0: goals, lockedReason: null };
    emit({ type: 'challenge', id, status: 'started', title: def.title });
    return challenge;
  }
  function completeChallenge() {
    const def = challengeDefs.get(challenge.id), ms = Math.round((clock - challenge.startedAt) * 1000);
    const best = mine().best[challenge.id];
    const isBest = !(best <= ms);
    if (isBest) { mine().best[challenge.id] = ms; persist(); }
    challenge = { ...challenge, status: 'complete', timeMs: ms, progress: challenge.target };
    emit({ type: 'challenge', id: def.id, status: 'complete', title: def.title, timeMs: ms, best: isBest, previousBestMs: best ?? null });
  }
  function progressFor(def) {
    switch (def.kind) {
      case 'sparks': return sparks.filter(s => s.collected && (!def.sparkTag || s.tag === def.sparkTag)).length;
      case 'goal': return goals - (challenge.goals0 ?? 0);
      case 'dominoes': return dominoesDown;
      default: return challenge.progress;
    }
  }

  // --------------------------------------------------------------- update
  // w: { clock, pose:{pos,heading,heightAboveTerrain}, props:[propState], airborne, fallen }
  function update(w) {
    clock = w.clock;
    const [x, y, z] = w.pose.pos;
    if (w.airborne) lastAir = clock;
    if (lastPos && !w.teleported) {
      const d = Math.hypot(x - lastPos[0], y - lastPos[1]);
      if (d < .5) { distance += d; mine().totals.distance += d; }
      if (distance >= 50) award('wanderer');
    }
    lastPos = [x, y];
    const zNow = layout.zoneAt(x, y);
    if (zNow !== zone) {
      const previous = zone; zone = zNow;
      if (zoneName[zNow]) {
        visited.add(zNow);
        emit({ type: 'zone', id: zNow, name: zoneName[zNow], previous });
        if (visited.size === layout.zones.length) award('tourist');
      }
    }
    if (w.fallen) return;

    // Sparks: proximity of the creature body, generous in height.
    for (const s of sparks) {
      if (s.collected) continue;
      if (Math.hypot(s.x - x, s.y - y) < reach && Math.abs(s.z - z) < .6 + (size?.height ?? .4)) {
        s.collected = true; s.collectedAt = clock; mine().totals.sparks++;
        const got = sparks.filter(q => q.collected).length;
        emit({ type: 'spark', id: s.id, zone: s.zone, got, total: sparkTotal, pos: [s.x, s.y, s.z] });
        award('first-spark');
        if (s.tag === 'meadow' && sparks.every(q => q.tag !== 'meadow' || q.collected)) award('meadow-sweep');
        if (got === sparkTotal) {
          award('collector');
          emit({ type: 'round', round, message: 'Every spark collected!' });
        }
      }
    }
    // A new round of sparks once all were collected (and any spark challenge ended).
    if (sparks.every(s => s.collected) && (!challenge || challenge.status !== 'active' || challengeDefs.get(challenge.id).kind !== 'sparks')) {
      const last = Math.max(...sparks.map(s => s.collectedAt ?? 0));
      if (clock - last > 6) { round++; for (const s of sparks) s.collected = false; emit({ type: 'round', round, message: 'The sparks are back!' }); }
    }

    // Ball into the goal (court frame). The engine resets the ball shortly after.
    const props = w.props ?? [];
    const ball = props.find(p => p.kind === 'ball');
    if (ball && ballScoredAt === null) {
      const [u, v] = layout.toZoneLocal('court', ball.pos[0], ball.pos[1]);
      if (u > layout.court.u1 + layout.court.ballRadius * .5 && Math.abs(v) < layout.court.goalHalfWidth) {
        goals++; ballScoredAt = clock; mine().totals.goals++; persist();
        emit({ type: 'goal', goals, pos: [...ball.pos] });
        award('goal'); if (goals >= 3) award('hat-trick');
      }
    }
    // Dominoes and crates.
    const down = props.filter(p => p.kind === 'domino' && p.up[2] < TOPPLED_UP_Z).length;
    if (down > dominoesDown) { emit({ type: 'topple', count: down, total: props.filter(p => p.kind === 'domino').length }); }
    dominoesDown = down;
    if (dominoesDown > 0 && dominoesDown === props.filter(p => p.kind === 'domino').length) award('domino');
    const crates = props.filter(p => p.kind === 'crate');
    if (!cratesDown && crates.length) {
      const top = crates.reduce((a, b) => (b.home[2] > a.home[2] ? b : a));
      if (top.pos[2] < top.home[2] - .2) { cratesDown = true; emit({ type: 'crash', what: 'crates' }); award('crate-crash'); }
    }

    // Terrace / summit: standing on the tier, not just bumping its wall.
    const ground = terrain.groundHeight(x, y);
    const onTerrace = Math.abs(ground - layout.plateau.terrace.height) < .01 && layout.zoneAt(x, y) === 'plateau';
    const onSummit = Math.abs(ground - layout.plateau.summit.height) < .01 && Math.hypot(x - layout.summit.x, y - layout.summit.y) < layout.summit.radius + reach;
    if (onTerrace) { award('terrace'); if (active('terrace')) challenge.progress = 1; }
    if (onSummit) { award('summit'); if (active('summit')) challenge.progress = 1; }

    // Stairs: enter a lane at one end, reach its landing, leave at the other.
    for (const [key, s] of Object.entries(layout.steps)) {
      const [u, v] = layout.toZoneLocal('steps', x, y);
      const inside = u >= s.u0 && u <= s.u0 + s.total && Math.abs(v - s.v) <= s.width / 2 + .1;
      const st = stepCrossing.get(key);
      if (inside && !st) stepCrossing.set(key, { from: u < s.u0 + s.total / 2 ? 'near' : 'far', top: false });
      else if (inside && st && ground >= s.top - .003) st.top = true;
      else if (!inside && st) {
        const side = u > s.u0 + s.total / 2 ? 'far' : 'near';
        if (st.top && side !== st.from) {
          emit({ type: 'stairs', lane: key, title: s.title });
          award('stair-hop'); if (active('steps')) challenge.progress = 1;
        }
        stepCrossing.delete(key);
      }
    }
    // Hills: from the near edge to the far edge without a tumble.
    {
      const [u, v] = layout.toZoneLocal('hills', x, y), [hu] = layout.hills.center, [sx, sy] = layout.hills.halfSize;
      if (Math.abs(v) < sy && u < hu - sx + .5 && u > hu - sx - .6) hills.entered = true;
      if (hills.entered && Math.abs(v) > sy + .6) hills.entered = false;
      if (hills.entered && u > hu + sx - .3 && Math.abs(v) < sy) {
        hills.entered = false; emit({ type: 'hills' }); award('hill-roll'); if (active('hills')) challenge.progress = 1;
      }
    }
    // Hoops: cross the hoop disc while airborne (only meaningful with jump).
    for (const h of layout.hoops) {
      const n = [Math.cos(h.yaw), Math.sin(h.yaw)], side = Math.sign((x - h.x) * n[0] + (y - h.y) * n[1]);
      const prev = prevHoopSide.get(h.id); prevHoopSide.set(h.id, side);
      if (!prev || side === prev) continue;
      const lateral = Math.abs(-(x - h.x) * n[1] + (y - h.y) * n[0]);
      const cz = terrain.groundHeight(h.x, h.y) + hoop.bottom + hoop.radius;
      if (lateral < hoop.radius && Math.abs(z - cz) < hoop.radius && clock - lastAir < .35 && skills.has('jump')) {
        emit({ type: 'hoop', id: h.id }); award('hoop'); if (active('hoop')) challenge.progress = 1;
      }
    }
    if (explore.reached && active('explore')) challenge.progress = 1;

    if (challenge?.status === 'active') {
      const def = challengeDefs.get(challenge.id);
      challenge.progress = Math.max(challenge.progress, progressFor(def));
      challenge.timeMs = Math.round((clock - challenge.startedAt) * 1000);
      if (challenge.progress >= challenge.target) completeChallenge();
    }
  }
  const active = id => challenge?.status === 'active' && challenge.id === id;

  function onFall(reason) {
    falls++; mine().totals.falls++; persist();
    hills.entered = false; stepCrossing.clear();
    award(reason === 'splash' ? 'splash' : 'oops');
  }
  function onPropsReset(kinds) { if (kinds.includes('ball')) ballScoredAt = null; if (kinds.includes('domino')) dominoesDown = 0; if (kinds.includes('crate')) cratesDown = false; }
  function onExplore(result) {
    if (result?.reached) { explore.reached = result.reached; award('explorer'); emit({ type: 'explore', phase: 'reached', landmark: result.reached }); }
  }
  function onTeleport() { lastPos = null; prevHoopSide.clear(); stepCrossing.clear(); hills.entered = false; }
  // Terrain Lab trial events (from terrain-lab.js via the engine).
  function onTrial(e) {
    if ((e.phase === 'grade' || e.phase === 'passed') && e.grade === 'gap-50cm') award('gap-jumper');
    if (e.phase === 'passed' && !e.grade) { award('lab-run'); if (active('lab')) challenge.progress = 1; }
  }

  function snapshot() {
    const zoneCounts = {};
    for (const s of sparks) { const z = (zoneCounts[s.zone] ??= { got: 0, total: 0 }); z.total++; if (s.collected) z.got++; }
    const best = mine().best;
    return {
      creatureKey,
      sparks: { got: sparks.filter(s => s.collected).length, total: sparkTotal, round, zones: zoneCounts, reach, hover,
        list: sparks.map(s => ({ id: s.id, zone: s.zone, tag: s.tag, x: s.x, y: s.y, z: s.z, collected: s.collected })) },
      challenge: challenge ? { ...challenge, ...pick(challengeDefs.get(challenge.id)), bestMs: best[challenge.id] ?? null } : null,
      challenges: layout.challenges.map(def => ({ ...pick(def), requires: [...def.requires], locked: !!lockedReason(def), lockedReason: lockedReason(def),
        bestMs: best[def.id] ?? null, status: challenge?.id === def.id ? challenge.status : (lockedReason(def) ? 'locked' : 'idle') })),
      stickers: layout.stickers.map(s => ({ ...s, earned: !!mine().stickers[s.id], earnedAt: mine().stickers[s.id] ?? null })),
      goals, dominoes: { down: dominoesDown, total: layout.blocks.domino.count }, crates: { knocked: cratesDown },
      zone: zone ? { id: zone, name: zoneName[zone] ?? (zone === 'hub' ? 'Spawn plaza' : zone === 'shore' ? 'Shore' : 'Trails') } : null,
      visitedZones: [...visited], hoop: { ...hoop, enabled: skills.has('jump') },
      stats: { distance: +distance.toFixed(2), falls, goals, totals: structuredClone(mine().totals) },
      recentEvents: recent.slice(-6),
    };
  }
  function pick(def) { return { id: def.id, title: def.title, zone: def.zone, goal: def.goal, kind: def.kind, target: def.target }; }

  return { update, setChallenge, onFall, onPropsReset, onExplore, onTeleport, onTrial, snapshot, award,
    get sparks() { return sparks; }, get challenge() { return challenge; }, get ballScoredAt() { return ballScoredAt; }, get goals() { return goals; },
    clearProgress() { all.creatures[creatureKey] = undefined; delete all.creatures[creatureKey]; persist(); } };
}
