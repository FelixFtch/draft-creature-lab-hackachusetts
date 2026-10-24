// Visual checkpoint game. All coordinates are MuJoCo world XY, in metres.
// This module never writes robot state or changes physics/sensor geometry.
export const TRAIL_TARGETS = [[1.45, 0], [2.6, .85], [3.8, .1]];
export const TRAIL_RADIUS = .45;
// A watchdog for a stuck guide, not a time limit for manual play.
export const TRAIL_LIMIT_SECONDS = 60;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const validPosition = p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite);

export function createTrail(simTime = 0, assisted = false) {
  return { phase: 'active', collected: 0, total: TRAIL_TARGETS.length, assisted: !!assisted,
    targets: TRAIL_TARGETS.map(p => [...p]), radius: TRAIL_RADIUS, records: [],
    startSimTime: simTime, lastSimTime: simTime, elapsedSeconds: 0, assistedSeconds: 0,
    distance: Math.hypot(...TRAIL_TARGETS[0]), reason: null };
}

export function updateTrail(trail, state) {
  if (!trail || trail.phase !== 'active') return trail;
  const { position, simTime, fall, error } = state;
  const elapsedSeconds = Number.isFinite(simTime) ? Math.max(0, simTime - trail.startSimTime) : trail.elapsedSeconds;
  const delta = Number.isFinite(simTime) ? Math.max(0, simTime - trail.lastSimTime) : 0;
  const assistedSeconds = trail.assistedSeconds + (trail.assisted ? delta : 0);
  const clock = { elapsedSeconds, assistedSeconds, lastSimTime: Number.isFinite(simTime) ? simTime : trail.lastSimTime };
  if (fall || error || !validPosition(position) || !Number.isFinite(simTime))
    return { ...trail, ...clock, phase: 'failed', assisted: false, reason: 'fall' };
  if (assistedSeconds >= TRAIL_LIMIT_SECONDS)
    return { ...trail, ...clock, phase: 'failed', assisted: false, reason: 'timeout' };
  const target = trail.targets[trail.collected];
  const distance = Math.hypot(position[0] - target[0], position[1] - target[1]);
  if (distance > trail.radius) return { ...trail, ...clock, distance };
  const collected = trail.collected + 1, complete = collected === trail.total;
  const records = [...trail.records, { targetIndex: trail.collected, target: [...target], position: [...position], simTime, distance }];
  const next = trail.targets[collected];
  return { ...trail, ...clock, collected, records, distance: complete ? 0 : Math.hypot(position[0]-next[0], position[1]-next[1]),
    phase: complete ? 'complete' : 'active', assisted: complete ? false : trail.assisted, reason: null };
}

// A small heading controller requests bounded velocities from the learned gait.
// It is a deterministic demo assistant, not a VLM or learned navigation policy.
export function trailDrive(trail, state) {
  if (!trail || trail.phase !== 'active' || !trail.assisted || state.fall || state.error ||
      !validPosition(state.position) || !Number.isFinite(state.heading)) return [0, 0, 0];
  // Allow the stance to settle before asking for travel.
  if (state.simTime - trail.startSimTime < .6) return [0, 0, 0];
  const target = trail.targets[trail.collected];
  const bearing = Math.atan2(target[1] - state.position[1], target[0] - state.position[0]);
  const error = Math.atan2(Math.sin(bearing - state.heading), Math.cos(bearing - state.heading));
  const forward = Math.abs(error) > .8 ? 0 : .45 * Math.max(.25, Math.cos(error));
  return [forward, 0, clamp(error * 1.8, -.7, .7)];
}
