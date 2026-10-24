// Deterministic waypoint driver for QA lanes and scripted captures.
// Not a planner and not AI: a proportional heading controller that asks the
// learned gait for bounded velocity commands, like a steady human driver.
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

export function createAutopilot({ waypoints, speed = .8, reach = .35, turnGain = 1.8, turnInPlace = .9 } = {}) {
  if (!Array.isArray(waypoints) || !waypoints.length) throw Error('Autopilot needs waypoints');
  let index = 0;
  return {
    get index() { return index; },
    get done() { return index >= waypoints.length; },
    // pose: { pos:[x,y,z], heading }, bounds: { vx:[lo,hi], wz:[lo,hi] }
    command(pose, bounds) {
      while (index < waypoints.length && Math.hypot(waypoints[index][0] - pose.pos[0], waypoints[index][1] - pose.pos[1]) < reach) index++;
      if (index >= waypoints.length) return [0, 0, 0];
      const [tx, ty] = waypoints[index];
      const error = wrap(Math.atan2(ty - pose.pos[1], tx - pose.pos[0]) - pose.heading);
      const vmax = bounds.vx[1] * speed;
      const vx = Math.abs(error) > turnInPlace ? 0 : vmax * Math.max(.3, Math.cos(error));
      const wz = Math.max(bounds.wz[0], Math.min(bounds.wz[1], error * turnGain));
      return [vx, 0, wz];
    },
  };
}
