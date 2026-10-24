// Terrain Lab trials: spawn points, pass/fail rules and the standard trial
// driver. Pure JS so the browser "Run trial" button and the headless
// qa/terrain-trials.mjs use exactly the same rules.
//
// Protocol (documented in contracts/world-api.md): forward command fixed at a
// standard fraction of the pilot's max forward speed; yaw-rate command is a
// heading hold toward the lane axis; if (and only if) the pilot has a
// validated `jump` skill, a jump is triggered deterministically when the front
// of the body is `lead` metres before a gap or step edge. This is a fixed test
// driver, not a planner and not AI.
export const TRIAL_PROTOCOL = Object.freeze({
  commandFraction: .7, settleSeconds: .6, headingGain: 2.2, lateralGain: 1.1, maxHeadingCorrection: .45,
  jumpLeadM: .1, jumpLeadS: .15, stuckSeconds: 8, stuckProgressM: .05,
});
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const laneById = (layout, id) => {
  const lane = layout.lab.lanes.find(l => l.id === id);
  if (!lane) throw Error(`Unknown Terrain Lab lane: ${id}`);
  return lane;
};
export function gradeById(lane, id) {
  const grade = lane.grades.find(g => g.id === id);
  if (!grade) throw Error(`Lane ${lane.id} has no grade ${id}`);
  return grade;
}
export function labPose(layout, pose) {
  const [u, v] = layout.labLocal(pose.pos[0], pose.pos[1]);
  return { u, v, z: pose.pos[2], heading: pose.heading };
}
const laneYaw = layout => Math.PI; // lanes run along -X (lab frame angle 180°)

// Where a trial starts. Full runs start on the lane pad behind the start line.
// Grade trials start on the surface just before the grade, as far forward as
// the robot's length allows (front of body ~0.7 m before the edge).
export function trialSpawn(layout, lane, grade, size) {
  let u = layout.lab.spawnU;
  if (grade) {
    const front = size?.boundsMax?.[0] ?? .3, back = -(size?.boundsMin?.[0] ?? -.3);
    u = Math.min(grade.at - front - .05, Math.max(grade.from + back + .06, grade.at - front - .7));
  }
  const [x, y] = layout.labWorld(u, lane.v);
  return { id: `lab-${lane.id}${grade ? `-${grade.id}` : ''}`, x, y, yaw: laneYaw(layout), u, lane: lane.id };
}

export function trialTimeLimit(layout, lane, grade, speed) {
  const from = grade ? Math.max(grade.from, grade.at - 1.5) : layout.lab.spawnU, to = grade ? grade.clear : layout.lab.finish;
  return (to - from) / Math.max(.05, speed) * 2.5 + (grade ? 8 : 12);
}

// One trial: a full lane run (gradeId null) or a single grade.
export function createTrial(layout, { laneId, gradeId = null, clock = 0, size, speed = .3, driver = 'auto' }) {
  const lane = laneById(layout, laneId), grade = gradeId ? gradeById(lane, gradeId) : null, lab = layout.lab;
  const spawn = trialSpawn(layout, lane, grade, size);
  const state = {
    lane: lane.id, grade: grade?.id ?? null, driver, phase: grade ? 'running' : 'armed', outcome: null,
    spawnedAt: clock, startedAt: grade ? clock : null, endedAt: null, timeS: null, sprintS: null,
    passed: [], failure: null, maxU: spawn.u, lastProgressAt: clock, limitS: trialTimeLimit(layout, lane, grade, speed), spawn,
  };
  const targets = grade ? [grade] : lane.grades;
  function onCourse(ground, z, level) {
    if (lane.id === 'gap') return z > lane.deck + .5 * (size?.rootHeight ?? .3);
    return ground >= level - .012;
  }
  function fail(clockNow, reason, u) {
    const pending = targets.find(g => !state.passed.includes(g.id));
    state.phase = 'failed'; state.outcome = reason === 'stuck' || reason === 'timeout' ? 'fail' : 'fall';
    state.endedAt = clockNow; state.failure = { reason, u: +u.toFixed(3), grade: pending?.id ?? null };
    return [{ type: 'trial', phase: 'failed', lane: lane.id, grade: state.grade, outcome: state.outcome, failure: state.failure, driver: state.driver,
      timeS: state.startedAt === null ? null : +(clockNow - state.startedAt).toFixed(2) }];
  }
  // world: { clock, pose, ground (terrain height under the root), fall (reason or null) }
  function update({ clock: now, pose, ground, fall }) {
    if (state.phase === 'passed' || state.phase === 'failed' || state.phase === 'cancelled') return [];
    const events = [], { u, z } = labPose(layout, pose);
    if (fall) return fail(now, fall, u);
    if (u > state.maxU + TRIAL_PROTOCOL.stuckProgressM) { state.maxU = u; state.lastProgressAt = now; }
    if (state.phase === 'armed' && u >= lab.start) {
      state.phase = 'running'; state.startedAt = now;
      events.push({ type: 'trial', phase: 'started', lane: lane.id, grade: null, driver: state.driver });
    }
    if (state.phase !== 'running') {
      if (now - state.spawnedAt > state.limitS) return fail(now, 'timeout', u);
      return events;
    }
    for (const g of targets) {
      if (state.passed.includes(g.id)) continue;
      if (u >= g.clear && onCourse(ground, z, g.level)) {
        state.passed.push(g.id);
        if (g.kind === 'sprint') state.sprintS = +(now - state.startedAt).toFixed(2);
        events.push({ type: 'trial', phase: 'grade', lane: lane.id, grade: g.id, label: g.label, timeS: +(now - state.startedAt).toFixed(2), driver: state.driver });
      } else break; // grades are passed in order
    }
    const done = grade ? state.passed.includes(grade.id) : (u >= lab.finish && onCourse(ground, z, lane.finishLevel) && state.passed.length === targets.length);
    if (done) {
      state.phase = 'passed'; state.outcome = 'pass'; state.endedAt = now; state.timeS = +(now - state.startedAt).toFixed(2);
      events.push({ type: 'trial', phase: 'passed', lane: lane.id, grade: state.grade, outcome: 'pass', timeS: state.timeS, sprintS: state.sprintS, driver: state.driver });
      return events;
    }
    if (now - state.lastProgressAt > TRIAL_PROTOCOL.stuckSeconds) return [...events, ...fail(now, 'stuck', u)];
    if (now - state.spawnedAt > state.limitS) return [...events, ...fail(now, 'timeout', u)];
    return events;
  }
  return {
    get state() { return state; }, lane, grade, spawn, update,
    cancel(now) { if (state.phase === 'armed' || state.phase === 'running') { state.phase = 'cancelled'; state.endedAt = now; } },
    snapshot: () => ({ ...structuredClone(state), laneTitle: lane.title, gradeLabel: grade?.label ?? null }),
  };
}

// Command ramp shared by the engine and the headless trials: the policy sees
// the same smooth command whether a person, a trial or the AI is driving.
export function createCommandSmoother(bounds, dt = .02) {
  const vmax = Math.max(Math.abs(bounds.vx[0]), Math.abs(bounds.vx[1])), dv = 1.8 * vmax * dt, dw = 4.5 * dt;
  const vy = clamp(0, bounds.vy?.[0] ?? 0, bounds.vy?.[1] ?? 0);
  let vx = 0, wz = 0;
  return {
    step(target) {
      vx = clamp(vx + clamp(target[0] - vx, -dv, dv), bounds.vx[0], bounds.vx[1]);
      wz = clamp(wz + clamp(target[2] - wz, -dw, dw), bounds.wz[0], bounds.wz[1]);
      return [vx, vy, wz];
    },
    reset() { vx = 0; wz = 0; },
    get value() { return [vx, vy, wz]; },
  };
}

// The standard automatic trial driver (fixed forward command + heading hold
// + deterministic approach-and-jump trigger when a jump skill exists).
export function createTrialDriver(layout, { laneId, bounds, size, canJump = false, fraction = TRIAL_PROTOCOL.commandFraction, settle = TRIAL_PROTOCOL.settleSeconds, startClock = 0 }) {
  const lane = laneById(layout, laneId), yaw = laneYaw(layout), vx = fraction * bounds.vx[1];
  const edges = lane.grades.filter(g => g.kind === 'gap' || g.kind === 'step').map(g => g.at);
  const fired = new Set();
  const front = size?.boundsMax?.[0] ?? .3;
  return {
    speed: vx,
    // Returns { command: [vx, vy, wz], jump: boolean }.
    step(pose, clock) {
      if (clock - startClock < settle) return { command: [0, 0, 0], jump: false };
      const { u, v } = labPose(layout, pose);
      const desired = yaw + clamp(TRIAL_PROTOCOL.lateralGain * (v - lane.v), -TRIAL_PROTOCOL.maxHeadingCorrection, TRIAL_PROTOCOL.maxHeadingCorrection);
      const wz = clamp(TRIAL_PROTOCOL.headingGain * wrap(desired - pose.heading), bounds.wz[0], bounds.wz[1]);
      let jump = false;
      if (canJump) {
        const lead = TRIAL_PROTOCOL.jumpLeadM + Math.abs(pose.forwardSpeed ?? vx) * TRIAL_PROTOCOL.jumpLeadS;
        for (const at of edges) {
          const gapToEdge = at - (u + front);
          if (!fired.has(at) && gapToEdge > -.02 && gapToEdge <= lead) { fired.add(at); jump = true; break; }
        }
      }
      return { command: [vx, 0, wz], jump };
    },
  };
}
