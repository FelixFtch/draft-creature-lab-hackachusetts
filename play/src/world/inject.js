// Inject a playground world into a pilot's verified scene MJCF.
//
// String-based on purpose: the browser and the headless Node QA (which has no
// DOMParser) must produce byte-identical models. The pilot verifies its scene
// hashes first; injection happens after, so the robot itself is untouched
// apart from optional, documented collision-bit changes for legacy bodies.
//
// Ordering rules that keep the robot's addresses fixed:
// - world geoms live in static bodies appended at the END of <worldbody>, so
//   robot bodies, geoms and joints keep their ids (geoms placed directly in
//   <worldbody> would be numbered first and shift every robot geom id);
// - props are free bodies appended after the robot, so robot qpos/qvel come
//   first and every keyframe is extended with the props' home poses.
import { STATIC_BITS, PROP_BITS } from './layout-park.js';
import { hfieldGrid } from './terrain.js';

const fmt = x => { const v = Math.abs(x) < 5e-7 ? 0 : x; return String(+v.toFixed(6)); };
const list = a => a.map(fmt).join(' ');
const rgba = (hex, alpha = 1) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return '0.8 0.8 0.8 1';
  const n = parseInt(m[1], 16);
  return list([(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, alpha]);
};
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const attrs = obj => Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  .map(([k, v]) => ` ${k}="${Array.isArray(v) ? list(v) : typeof v === 'number' ? fmt(v) : v}"`).join('');

// Replace (or add) attributes on the single geom element with this name.
export function setGeomAttributes(xml, name, values) {
  const re = new RegExp(`<geom\\b[^>]*\\bname="${escapeRe(name)}"[^>]*>`, 'g');
  const found = xml.match(re);
  if (!found || found.length !== 1) throw Error(`Expected exactly one geom named ${name}`);
  let tag = found[0];
  for (const [key, value] of Object.entries(values)) {
    const attr = new RegExp(`\\s${key}="[^"]*"`);
    tag = attr.test(tag) ? tag.replace(attr, ` ${key}="${value}"`) : tag.replace(/\s*(\/?)>$/, ` ${key}="${value}"$1>`);
  }
  return xml.replace(found[0], tag);
}

function staticGeom(s, group) {
  const base = { name: s.name, type: s.type, group, contype: STATIC_BITS.contype, conaffinity: STATIC_BITS.conaffinity,
    condim: 3, friction: s.friction ?? [1, .005, .0001], rgba: rgba(s.color) };
  if (s.fromto) return `<geom${attrs({ ...base, fromto: s.fromto, size: s.size })}/>`;
  const quat = s.quat && !(s.quat[0] === 1 && !s.quat[1] && !s.quat[2] && !s.quat[3]) ? s.quat : null;
  return `<geom${attrs({ ...base, pos: s.pos, quat, size: s.size })}/>`;
}

function propBody(p, group) {
  const geom = { name: `${p.name}_geom`, type: p.type, size: p.size, mass: p.mass, group,
    contype: PROP_BITS.contype, conaffinity: PROP_BITS.conaffinity, condim: p.condim, friction: p.friction,
    solref: p.solref, rgba: rgba(p.color) };
  return `<body${attrs({ name: p.name, pos: p.pos, quat: p.quat })}>` +
    `<joint${attrs({ name: `${p.name}_free`, type: 'free', damping: p.damping || null })}/>` +
    `<geom${attrs(geom)}/></body>`;
}

/**
 * @param {string} xml   verified scene MJCF of one robot (robot + floor + options)
 * @param {object} layout world layout (see layout-park.js)
 * @param {object} opts
 *   worldGroup: geom group for world + props (0 = visible to group-0 ray scans)
 *   robotGeoms: { [geomName]: { contype, conaffinity } } collision-bit changes
 *   memory: MuJoCo arena size for contacts/constraints (string, e.g. '48M')
 */
export function injectWorld(xml, layout, { worldGroup = 0, robotGeoms = {}, memory = '48M' } = {}) {
  if (typeof xml !== 'string' || !xml.includes('<worldbody') || !xml.includes('</worldbody>'))
    throw Error('Scene MJCF has no worldbody');
  if (/name="(world_|prop_)/.test(xml)) throw Error('Scene MJCF already contains world_/prop_ objects');
  let out = xml;
  for (const [name, bits] of Object.entries(robotGeoms)) out = setGeomAttributes(out, name, bits);

  // Heightfields: assets + geoms. MJCF `elevation` is listed image-order
  // (first row = +y) while hfield_data row 0 is -y; write rows reversed.
  const fields = layout.hfields.map(hf => {
    const grid = hfieldGrid(hf), max = Math.max(grid.max, 1e-4), rows = [];
    for (let r = grid.nrow - 1; r >= 0; r--)
      for (let c = 0; c < grid.ncol; c++) rows.push((grid.heights[r * grid.ncol + c] / max).toFixed(4));
    const asset = `<hfield${attrs({ name: hf.name, nrow: grid.nrow, ncol: grid.ncol, size: [...grid.halfSize, max, .1] })} elevation="${rows.join(' ')}"/>`;
    // 4 mm below the floor plane so a foot on the flat border touches only the
    // floor, exactly as in training; the bumps rise above it.
    const geom = `<geom${attrs({ name: hf.name, type: 'hfield', hfield: hf.name, group: worldGroup,
      contype: STATIC_BITS.contype, conaffinity: STATIC_BITS.conaffinity, condim: 3, friction: [1, .005, .0001],
      pos: [hf.center[0], hf.center[1], -.004], quat: [Math.cos(hf.yaw / 2), 0, 0, Math.sin(hf.yaw / 2)], rgba: rgba(hf.color) })}/>`;
    return { hf, grid, max, asset, geom, zone: hf.zone };
  });
  const assetXml = fields.map(f => f.asset).join('');
  if (assetXml) {
    if (out.includes('</asset>')) out = out.replace('</asset>', `${assetXml}</asset>`);
    else out = out.replace(/<worldbody\b/, `<asset>${assetXml}</asset><worldbody`);
  }

  // Static world, one static body per zone (bodies without joints are welded
  // to the world and add no degrees of freedom).
  const zones = new Map();
  for (const s of layout.statics) (zones.get(s.zone) ?? zones.set(s.zone, []).get(s.zone)).push(staticGeom(s, worldGroup));
  for (const f of fields) (zones.get(f.zone) ?? zones.set(f.zone, []).get(f.zone)).push(f.geom);
  const staticXml = [...zones].map(([zone, geoms]) => `<body name="world_${zone}">${geoms.join('')}</body>`).join('');
  const propXml = layout.props.map(p => propBody(p, worldGroup)).join('');
  const end = out.lastIndexOf('</worldbody>');
  out = `${out.slice(0, end)}<!-- playground world: ${layout.id} -->${staticXml}${propXml}${out.slice(end)}`;

  // Keyframes must cover every qpos/qvel: append each prop's home pose.
  const propQpos = layout.props.map(p => list([...p.pos, ...p.quat])).join(' ');
  const propQvel = layout.props.map(() => '0 0 0 0 0 0').join(' ');
  out = out.replace(/<key\b[^>]*>/g, tag => tag
    .replace(/\bqpos="([^"]*)"/, (_, q) => `qpos="${q.trim()} ${propQpos}"`)
    .replace(/\bqvel="([^"]*)"/, (_, q) => `qvel="${q.trim()} ${propQvel}"`));

  // Enough arena for props' contacts: a full arena is a MuJoCo warning, and
  // the legacy controllers (rightly) stop on any new warning.
  if (memory) {
    if (/<size\b[^>]*\bmemory="/.test(out)) out = out.replace(/(<size\b[^>]*\bmemory=")[^"]*"/, `$1${memory}"`);
    else if (/<size\b/.test(out)) out = out.replace(/<size\b/, `<size memory="${memory}"`);
    else out = out.replace(/(<mujoco\b[^>]*>)/, `$1<size memory="${memory}"/>`);
  }
  return {
    xml: out,
    props: layout.props.map(p => ({ ...p, joint: `${p.name}_free`, geom: `${p.name}_geom`, home: { pos: [...p.pos], quat: [...p.quat] } })),
    hfields: fields.map(f => ({ name: f.hf.name, grid: f.grid, max: f.max, center: f.hf.center, yaw: f.hf.yaw, zone: f.zone })),
    statics: layout.statics.map(s => s.name),
  };
}
