// Synthetic multileg bodies for the look dev page and QA: the same naming
// and joint layout as the Flower (legN_mount / _yaw_link / _upper_leg_link /
// _lower_leg_link; hip_yaw, hip_pitch, knee; _link/_motor/_detail/_sphere
// geoms), with 3-8 legs in a radial ring or bilateral rows. They stand in for
// the morphology agent's robots/multileg template until it lands; they are
// not Draft output and never used for physics claims.

const f = n => Number(n.toFixed(5));

function leg(i, x, y, angle, s) {
  const c = Math.cos(angle / 2), q = `${f(c)} 0 0 ${f(Math.sin(angle / 2))}`;
  const r = 0.0346 * s, h = 0.0208 * s, link = 0.014 * s;
  const motor = (name, pos, quat = '') => `<geom name="${name}_motor" size="${f(r)} ${f(h)}" pos="${pos}" ${quat ? `quat="${quat}"` : ''} type="cylinder" density="1500" rgba="0.22 0.29 0.29 1"/>
        <geom name="${name}_detail" class="visual" size="${f(r * 0.8)} ${f(h * 1.1)}" pos="${pos}" ${quat ? `quat="${quat}"` : ''} type="cylinder" contype="1" conaffinity="1" group="0" density="0" rgba="0.79 0.58 0.3 1"/>`;
  const Y = '0.707107 0.707107 0 0', X = '0.707107 0 0.707107 0';
  return `
    <body name="leg${i}_mount" pos="${f(x)} ${f(y)} 0" quat="${q}">
      <geom name="leg${i}_mount_link" size="${f(link * 1.05)} ${f(0.007 * s)}" pos="${f(0.007 * s)} 0 0" quat="${X}" type="cylinder" density="750" rgba="0.25 0.56 0.44 1"/>
      ${motor(`leg${i}_mount`, `${f(0.044 * s)} 0 0`)}
      <body name="leg${i}_yaw_link" pos="${f(0.044 * s)} 0 0">
        <joint name="leg${i}_hip_yaw" axis="0 0 1" limited="true" range="-0.6 0.6" damping="0.003"/>
        <geom name="leg${i}_yaw_link_link" size="${f(link * 0.93)} ${f(0.015 * s)}" pos="${f(0.045 * s)} 0 0" quat="${X}" type="cylinder" density="750" rgba="0.25 0.56 0.44 1"/>
        ${motor(`leg${i}_yaw_link`, `${f(0.09 * s)} 0 0`, Y)}
        <body name="leg${i}_upper_leg_link" pos="${f(0.09 * s)} 0 0">
          <joint name="leg${i}_hip_pitch" axis="0 1 0" limited="true" range="-0.65 0.8" damping="0.003"/>
          <geom name="leg${i}_upper_leg_link_link" size="${f(link)} ${f(0.06 * s)}" pos="${f(0.09 * s)} 0 0" quat="${X}" type="cylinder" density="750" rgba="0.25 0.56 0.44 1"/>
          ${motor(`leg${i}_upper_leg_link`, `${f(0.18 * s)} 0 0`, Y)}
          <body name="leg${i}_lower_leg_link" pos="${f(0.18 * s)} 0 0">
            <joint name="leg${i}_knee" axis="0 1 0" limited="true" range="0.35 2.1" damping="0.003"/>
            <geom name="leg${i}_lower_leg_link_link" size="${f(link * 0.8)} ${f(0.11 * s)}" pos="${f(0.11 * s)} 0 0" quat="${X}" type="cylinder" density="750" rgba="0.25 0.56 0.44 1"/>
            <geom name="leg${i}_lower_leg_link_sphere" size="${f(0.025 * s)}" pos="${f(0.22 * s)} 0 0" density="500" rgba="0.25 0.31 0.3 1"/>
            <site name="leg${i}_foot" pos="${f(0.22 * s)} 0 0" group="5"/>
          </body>
        </body>
      </body>
    </body>`;
}

/** MJCF text for a synthetic multileg creature. */
export function multilegXml({ legs = 6, arrangement = 'radial', radius = 0.15, aspect = 1.6, scale = 1 } = {}) {
  const n = Math.max(3, Math.min(8, Math.round(legs)));
  let torso, legXml = '';
  if (arrangement === 'radial') {
    torso = `<geom name="torso_link_hub" type="cylinder" size="${f(radius)} 0.045" density="500" rgba="0.84 0.4 0.48 1"/>`;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; legXml += leg(i, radius * Math.cos(a), radius * Math.sin(a), a, scale); }
  } else {
    const a = radius * aspect, b = radius;
    torso = `<geom name="torso_link_hub" type="ellipsoid" size="${f(a)} ${f(b)} 0.06" density="500" rgba="0.84 0.4 0.48 1"/>`;
    const pairs = Math.ceil(n / 2);
    let i = 0;
    for (let p = 0; p < pairs && i < n; p++) {
      const x = pairs === 1 ? 0 : a * 0.7 * (1 - (2 * p) / (pairs - 1));
      const yEdge = b * Math.sqrt(Math.max(0.05, 1 - (x / a) ** 2));
      const fan = pairs === 1 ? 0 : 0.45 * (1 - (2 * p) / (pairs - 1));
      legXml += leg(i++, x, yEdge, Math.PI / 2 - fan, scale);
      if (i < n) legXml += leg(i++, x, -yEdge, -Math.PI / 2 + fan, scale);
    }
  }
  return `<mujoco model="multileg-${arrangement}-${n}">
  <compiler angle="radian"/>
  <option timestep="0.005"/>
  <default><joint damping="0.01"/><geom friction="0.8"/><default class="visual"><geom contype="0" conaffinity="0" group="2"/></default></default>
  <worldbody>
    <body name="torso_link" pos="0 0 0.3">
      <freejoint name="torso_link_freejoint"/>
      ${torso}
      <site name="imu" pos="0 0 0" group="5"/>${legXml}
    </body>
  </worldbody>
</mujoco>`;
}

/**
 * A wheel-biped in the style of Ollie/Diablo, with Draft naming: a box torso,
 * two legs (hip pitch, knee) ending in cylinder wheels on continuous joints.
 * A stand-in for morphology's robots/wheel_biped until it lands.
 */
export function wheelBipedXml({ wheelRadius = 0.085, width = 0.15, thigh = 0.18, shin = 0.18 } = {}) {
  const Y = '0.707107 0.707107 0 0';
  const leg = (side, s) => `
    <body name="${side}_hip_link" pos="0 ${f(s * width)} -0.01">
      <joint name="${side}_hip_pitch" axis="0 1 0" limited="true" range="-1.3 1.3" damping="0.01"/>
      <geom name="${side}_hip_link_motor" type="cylinder" size="0.052 0.026" pos="0 ${f(s * 0.012)} 0" quat="${Y}" density="1800" rgba="0.2 0.3 0.3 1"/>
      <geom name="${side}_hip_link_detail" class="visual" type="cylinder" size="0.042 0.029" pos="0 ${f(s * 0.012)} 0" quat="${Y}" contype="1" conaffinity="1" group="0" density="0" rgba="0.8 0.6 0.3 1"/>
      <geom name="${side}_hip_link_link" type="cylinder" size="0.02 ${f(thigh / 2)}" pos="0.03 ${f(s * 0.035)} ${f(-thigh / 2)}" quat="0.99452 0 -0.104528 0" density="900" rgba="0.3 0.6 0.5 1"/>
      <body name="${side}_shin_link" pos="0.06 ${f(s * 0.035)} ${f(-thigh)}">
        <joint name="${side}_knee" axis="0 1 0" limited="true" range="-2.3 0.2" damping="0.01"/>
        <geom name="${side}_shin_link_motor" type="cylinder" size="0.044 0.022" quat="${Y}" density="1800" rgba="0.2 0.3 0.3 1"/>
        <geom name="${side}_shin_link_detail" class="visual" type="cylinder" size="0.035 0.025" quat="${Y}" contype="1" conaffinity="1" group="0" density="0" rgba="0.8 0.6 0.3 1"/>
        <geom name="${side}_shin_link_link" type="cylinder" size="0.018 ${f(shin / 2)}" pos="-0.03 ${f(s * 0.03)} ${f(-shin / 2)}" quat="0.99452 0 0.104528 0" density="900" rgba="0.3 0.6 0.5 1"/>
        <body name="${side}_wheel_link" pos="-0.06 ${f(s * 0.06)} ${f(-shin)}">
          <joint name="${side}_wheel" axis="0 1 0" damping="0.002"/>
          <geom name="${side}_wheel_link_wheel" type="cylinder" size="${f(wheelRadius)} 0.028" quat="${Y}" density="700" friction="1.0" rgba="0.15 0.15 0.15 1"/>
        </body>
      </body>
    </body>`;
  return `<mujoco model="wheel-biped">
  <compiler angle="radian"/>
  <option timestep="0.005"/>
  <default><joint damping="0.01"/><geom friction="0.8"/><default class="visual"><geom contype="0" conaffinity="0" group="2"/></default></default>
  <worldbody>
    <body name="torso_link" pos="0 0 0.45">
      <freejoint name="torso_link_freejoint"/>
      <geom name="torso_link_body" type="box" size="0.11 0.115 0.075" density="600" rgba="0.3 0.45 0.7 1"/>
      <site name="imu" pos="0 0 0" group="5"/>${leg('left', 1)}${leg('right', -1)}
    </body>
  </worldbody>
</mujoco>`;
}

/** Joint pose that stands each body plan up (names may carry a prefix). */
export function standingPose(jointName, plan = null) {
  const n = jointName.replace(/^.*\//, '');
  if (plan === 'wheeled') return /_hip_pitch$/.test(n) ? 0.45 : /_knee$/.test(n) ? -0.9 : 0;
  if (plan === 'humanoid') return /_hip_pitch$/.test(n) ? -0.28 : /_knee$/.test(n) ? 0.55 : /_ankle_pitch$/.test(n) ? -0.27 : 0;
  if (/_knee$/.test(n)) return /^leg\d/.test(n) ? 1.25 : -1.1;
  if (/_hip_pitch$/.test(n)) return /^leg\d/.test(n) ? 0.15 : 0.55;
  return 0;
}
