import * as THREE from 'three';

// Reads a compiled MjModel (never mutates it) and describes the creature in
// the robot root body's frame: which geoms are torso / limb / motor / detail /
// foot / wheel / head / eye / hand, how the legs are arranged, the torso's
// point cloud, and where other machinery sits near the torso (so shells and
// faces avoid it).
//
// Body plans: Draft quadrupeds (fl_/fr_/rl_/rr_), the Flower and multileg
// bodies (leg0..legN-1), wheel-bipeds (legs ending in wheels on continuous
// joints) and the Draft humanoid (head_link with eye links, rigid arms,
// legs branching from a pelvis, flat soles). Prefixed scenes ('robot/...')
// work too. A creature-body/1 contract, when given, wins over inference.

const GEOM = { PLANE: 0, HFIELD: 1, SPHERE: 2, CAPSULE: 3, ELLIPSOID: 4, CYLINDER: 5, BOX: 6, MESH: 7 };
const JNT = { FREE: 0, BALL: 1, SLIDE: 2, HINGE: 3 };
const ROLE_FROM_CONTRACT = { feet: 'foot', torso: 'torso', limbs: 'limb', motors: 'motor', details: 'detail', wheels: 'wheel', head: 'head', eyes: 'eye', hands: 'hand' };
const QUAD_ORDER = ['fl', 'fr', 'rl', 'rr'];

export const logicalName = name => String(name ?? '').replace(/^.*\//, '');

function nameOf(mujoco, model, type, id) {
  try { return mujoco.mj_id2name(model, mujoco.mjtObj[type].value, id) ?? ''; } catch { return ''; }
}

/** Role of a geom from its own name and its body's name. */
function roleFromName(logical, bodyLogical, isRootBody) {
  if (/(^|_)eyes?(_|$)/.test(bodyLogical) || /(^|_)eyes?(_|$)/.test(logical)) return 'eye';
  if (/wheel|tire|tyre/.test(logical) || /wheel/.test(bodyLogical)) return /_motor$|_detail$/.test(logical) ? (/_motor$/.test(logical) ? 'motor' : 'detail') : 'wheel';
  if (/(^|_)head(_|$)/.test(bodyLogical) && !isRootBody) return /_sphere$|_head$|_skull$|_mesh$/.test(logical) ? 'head' : /_motor$/.test(logical) ? 'motor' : /_detail$/.test(logical) ? 'detail' : 'limb';
  if (/(^|_)hand(_|$)/.test(bodyLogical)) return /_sphere$|_hand$|_palm$/.test(logical) ? 'hand' : 'limb';
  if (/(^|_)foot(_|$)/.test(bodyLogical)) return /_motor$/.test(logical) ? 'motor' : /_detail$/.test(logical) ? 'detail' : 'foot';
  if (/_sphere$|_foot$|^foot|_toe$|_sole$/.test(logical)) return 'foot';
  if (/_motor$|_actuator$|_servo$/.test(logical)) return 'motor';
  if (/_detail$|_cap$/.test(logical)) return 'detail';
  if (/_mesh$|^torso|_torso|_hub$|_body$/.test(logical) && isRootBody) return 'torso';
  return isRootBody ? 'torso' : 'limb';
}

function jointRole(logical, continuous) {
  if (continuous || /wheel/.test(logical)) return 'wheel';
  if (/ankle/.test(logical)) return 'ankle';
  if (/hip_roll|_roll$/.test(logical)) return 'roll';
  if (/hip_yaw|_yaw$/.test(logical)) return 'yaw';
  if (/knee/.test(logical)) return 'knee';
  if (/hip_pitch|_pitch$/.test(logical)) return 'pitch';
  return 'hinge';
}

const quat = (model, field, i) => new THREE.Quaternion(model[field][i * 4 + 1], model[field][i * 4 + 2], model[field][i * 4 + 3], model[field][i * 4]);
const vec = (model, field, i) => new THREE.Vector3(model[field][i * 3], model[field][i * 3 + 1], model[field][i * 3 + 2]);

// Sample points on a primitive geom surface in its own frame. Enough points to
// bound it for fitting, few enough to keep fitting cheap.
function primitivePoints(type, size, quality = 12) {
  const pts = [];
  const ring = (r, z, n = quality) => { for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z)); } };
  if (type === GEOM.SPHERE || type === GEOM.ELLIPSOID) {
    const [a, b, c] = type === GEOM.SPHERE ? [size[0], size[0], size[0]] : size;
    for (let i = 0; i <= 4; i++) {
      const phi = (i / 4) * Math.PI, z = Math.cos(phi), r = Math.sin(phi);
      const n = i === 0 || i === 4 ? 1 : quality;
      for (let k = 0; k < n; k++) { const t = (k / n) * Math.PI * 2; pts.push(new THREE.Vector3(a * r * Math.cos(t), b * r * Math.sin(t), c * z)); }
    }
  } else if (type === GEOM.CYLINDER) {
    ring(size[0], size[1]); ring(size[0], -size[1]); ring(size[0], 0, 6);
  } else if (type === GEOM.CAPSULE) {
    ring(size[0], size[1]); ring(size[0], -size[1]);
    pts.push(new THREE.Vector3(0, 0, size[1] + size[0]), new THREE.Vector3(0, 0, -size[1] - size[0]));
  } else if (type === GEOM.BOX) {
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) pts.push(new THREE.Vector3(x * size[0], y * size[1], z * size[2]));
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) pts.push(new THREE.Vector3(x * size[0], y * size[1], z * size[2]));
  }
  return pts;
}

export function meshVertices(model, geomId) {
  const mesh = model.geom_dataid[geomId];
  if (mesh < 0) return [];
  const start = model.mesh_vertadr[mesh] * 3, count = model.mesh_vertnum[mesh], out = [];
  for (let i = 0; i < count; i++) out.push(new THREE.Vector3(model.mesh_vert[start + i * 3], model.mesh_vert[start + i * 3 + 1], model.mesh_vert[start + i * 3 + 2]));
  return out;
}

export function geomLocalPoints(model, id) {
  const type = model.geom_type[id];
  if (type === GEOM.MESH) return meshVertices(model, id);
  return primitivePoints(type, Array.from(model.geom_size.slice(id * 3, id * 3 + 3)));
}

/** Render geometry of a MuJoCo geom in its own frame (a port of v1's geometryFor). */
export function geomGeometry(model, id, segments = 32) {
  const t = model.geom_type[id], s = model.geom_size.slice(id * 3, id * 3 + 3);
  const rings = Math.max(8, Math.round(segments * 0.6));
  if (t === GEOM.SPHERE) return new THREE.SphereGeometry(s[0], segments, rings);
  if (t === GEOM.CAPSULE) return new THREE.CapsuleGeometry(s[0], s[1] * 2, Math.max(4, segments / 4), segments).rotateX(Math.PI / 2);
  if (t === GEOM.ELLIPSOID) return new THREE.SphereGeometry(1, segments, rings).scale(s[0], s[1], s[2]);
  if (t === GEOM.CYLINDER) return new THREE.CylinderGeometry(s[0], s[0], s[1] * 2, segments).rotateX(Math.PI / 2);
  if (t === GEOM.BOX) return new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2);
  if (t === GEOM.MESH) {
    const mesh = model.geom_dataid[id], va = model.mesh_vertadr[mesh] * 3, fa = model.mesh_faceadr[mesh] * 3;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(model.mesh_vert.slice(va, va + model.mesh_vertnum[mesh] * 3), 3));
    geometry.setIndex(Array.from(model.mesh_face.slice(fa, fa + model.mesh_facenum[mesh] * 3)));
    return geometry;
  }
  throw Error(`Unsupported geom type ${t}`);
}

export function geomLocalTriangles(model, id) {
  const g = geomGeometry(model, id, 16), pos = g.attributes.position, idx = g.index ? g.index.array : null, out = [];
  const n = idx ? idx.length : pos.count;
  const at = i => new THREE.Vector3().fromBufferAttribute(pos, i);
  for (let i = 0; i < n; i += 3) out.push(idx ? [at(idx[i]), at(idx[i + 1]), at(idx[i + 2])] : [at(i), at(i + 1), at(i + 2)]);
  g.dispose();
  return out;
}

/** Highest torso surface at (x, y) of the given info's frame, or null if the torso is not there. */
export function torsoTopAt(info, x, y) {
  let best = null;
  for (const [a, b, c] of info.torso.triangles) {
    const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(d) < 1e-12) continue;   // vertical face
    const l1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / d, l2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / d, l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const z = l1 * a.z + l2 * b.z + l3 * c.z;
    if (best === null || z > best) best = z;
  }
  return best;
}

// Mount frame. Shells and back-mounted accessories are built in a frame whose
// +z points out of the creature's back: body up for horizontal torsos, body -x
// for upright ones (a humanoid's turtle shell sits on its back like a pack).
// Columns: mount x -> body +z (along the spine), y -> body +y, z -> body -x.
const BACK_MOUNT = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)));

/**
 * The analysis seen from the mount frame (identity for horizontal bodies):
 * torso points/triangles/box and obstacles re-expressed so shell fitting and
 * back anchors can always treat +z as "up out of the back".
 */
export function mountedInfo(info) {
  if (info.mount !== 'back') return info;
  if (info._mounted) return info._mounted;
  const inv = info.mountQuat.clone().invert();
  const tf = p => p.clone().applyQuaternion(inv);
  const points = info.torso.points.map(tf);
  const box = new THREE.Box3().setFromPoints(points);
  const mounted = {
    ...info,
    torso: { ...info.torso, points, triangles: info.torso.triangles.map(t => t.map(tf)), box, center: box.getCenter(new THREE.Vector3()), half: box.getSize(new THREE.Vector3()).multiplyScalar(0.5) },
    obstacles: info.obstacles.map(tf),
    arrangement: 'bilateral',
  };
  info._mounted = mounted;
  return mounted;
}

/**
 * @returns a plain description of the creature; everything is in the root
 * (torso) body frame unless noted. Throws only when no robot body exists.
 */
export function analyzeCreature({ mujoco, model, body = null, rootBody = null } = {}) {
  if (!mujoco || !model) throw Error('analyzeCreature needs mujoco and a compiled model');
  const nbody = model.nbody, ngeom = model.ngeom, njnt = model.njnt;
  const bodyNames = Array.from({ length: nbody }, (_, i) => nameOf(mujoco, model, 'mjOBJ_BODY', i));
  const geomNames = Array.from({ length: ngeom }, (_, i) => nameOf(mujoco, model, 'mjOBJ_GEOM', i));
  const jointNames = Array.from({ length: njnt }, (_, i) => nameOf(mujoco, model, 'mjOBJ_JOINT', i));
  const findBody = name => {
    if (!name) return -1;
    let id = bodyNames.indexOf(name);
    if (id < 0) id = bodyNames.findIndex(n => logicalName(n) === logicalName(name));
    return id;
  };
  const findGeom = name => {
    if (!name) return -1;
    let id = geomNames.indexOf(name);
    if (id < 0) id = geomNames.findIndex(n => logicalName(n) === logicalName(name));
    return id;
  };

  // Root: explicit name, contract, or the free-jointed body with the largest
  // subtree (world props also have free joints but tiny subtrees).
  let root = findBody(rootBody) >= 1 ? findBody(rootBody) : findBody(body?.rootBody);
  const descendants = b => { let n = 0; for (let i = 1; i < nbody; i++) { let p = i; while (p > 0 && p !== b) p = model.body_parentid[p]; if (p === b && i !== b) n++; } return n; };
  if (root < 1) {
    let best = -1, bestCount = -1;
    for (let j = 0; j < njnt; j++) {
      if (model.jnt_type[j] !== JNT.FREE) continue;
      const b = model.jnt_bodyid[j], logical = logicalName(bodyNames[b]);
      if (/^(world_|prop_)/.test(logical)) continue;
      const count = descendants(b);
      if (count > bestCount) { best = b; bestCount = count; }
    }
    root = best;
  }
  if (root < 1) root = nbody > 1 ? 1 : -1;
  if (root < 1) throw Error('No robot body found in the model');

  const depthUnderRoot = new Int32Array(nbody).fill(-1);
  depthUnderRoot[root] = 0;
  for (let i = 1; i < nbody; i++) {
    let p = i, d = 0;
    while (p > 0 && p !== root) { p = model.body_parentid[p]; d++; }
    if (p === root) depthUnderRoot[i] = d;
  }
  const inRobot = b => depthUnderRoot[b] >= 0;

  // Rest-pose frames in the root frame (all joints at zero).
  const restPos = Array.from({ length: nbody }, () => new THREE.Vector3());
  const restQuat = Array.from({ length: nbody }, () => new THREE.Quaternion());
  const order = Array.from({ length: nbody }, (_, i) => i).filter(inRobot).sort((a, b) => depthUnderRoot[a] - depthUnderRoot[b]);
  for (const b of order) {
    if (b === root) continue;
    const parent = model.body_parentid[b];
    restQuat[b].copy(restQuat[parent]).multiply(quat(model, 'body_quat', b));
    restPos[b].copy(vec(model, 'body_pos', b)).applyQuaternion(restQuat[parent]).add(restPos[parent]);
  }

  const contractRoles = new Map();
  for (const [key, names] of Object.entries(body?.geomRoles ?? {})) {
    const role = ROLE_FROM_CONTRACT[key];
    if (role && Array.isArray(names)) for (const n of names) contractRoles.set(logicalName(n), role);
  }
  for (const leg of body?.legs ?? []) if (leg.wheel?.geom) contractRoles.set(logicalName(leg.wheel.geom), 'wheel');

  // Hinge joints (continuous = unlimited, e.g. wheels).
  const joints = [], jointsByBody = new Map();
  for (let j = 0; j < njnt; j++) {
    const b = model.jnt_bodyid[j];
    if (!inRobot(b) || model.jnt_type[j] !== JNT.HINGE) continue;
    const logical = logicalName(jointNames[j]);
    // jnt_limited is a bool array the WASM binding cannot expose; MuJoCo
    // stores range 0 0 for unlimited joints, so read the range instead.
    const lo = model.jnt_range[j * 2], hi = model.jnt_range[j * 2 + 1];
    const continuous = lo === 0 && hi === 0;
    const joint = { id: j, name: jointNames[j], logical, bodyId: b, role: jointRole(logical, continuous), continuous,
      axis: vec(model, 'jnt_axis', j).normalize(), pos: vec(model, 'jnt_pos', j), range: continuous ? [-Math.PI, Math.PI] : [lo, hi], qposAdr: model.jnt_qposadr[j] };
    joints.push(joint);
    if (!jointsByBody.has(b)) jointsByBody.set(b, []);
    jointsByBody.get(b).push(joint);
  }

  // Drop collision duplicates (group 3+) only if the robot has visible groups.
  const robotGeomIds = [];
  for (let i = 0; i < ngeom; i++) {
    const type = model.geom_type[i];
    if (!inRobot(model.geom_bodyid[i]) || type < GEOM.SPHERE || type > GEOM.MESH) continue;
    if (model.geom_rgba[i * 4 + 3] <= 0.001) continue;
    robotGeomIds.push(i);
  }
  const hasVisibleGroup = robotGeomIds.some(i => model.geom_group[i] < 3);
  const geoms = [];
  for (const i of robotGeomIds) {
    if (hasVisibleGroup && model.geom_group[i] >= 3) continue;
    const bodyId = model.geom_bodyid[i], logical = logicalName(geomNames[i]);
    let role = contractRoles.get(logical) ?? roleFromName(logical, logicalName(bodyNames[bodyId]), bodyId === root);
    // A cylinder on a continuously spinning body is a wheel whatever its name.
    if (role !== 'wheel' && model.geom_type[i] === GEOM.CYLINDER && (jointsByBody.get(bodyId) ?? []).some(j => j.continuous) && !/_motor$|_detail$/.test(logical)) role = 'wheel';
    geoms.push({ id: i, name: geomNames[i], logical, bodyId, type: model.geom_type[i], role,
      size: Array.from(model.geom_size.slice(i * 3, i * 3 + 3)) });
  }
  const geomPose = g => {
    const q = restQuat[g.bodyId].clone().multiply(quat(model, 'geom_quat', g.id));
    const p = vec(model, 'geom_pos', g.id).applyQuaternion(restQuat[g.bodyId]).add(restPos[g.bodyId]);
    return { p, q };
  };

  // Legs: a leg is the chain from a foot (or wheel) body up to where it meets
  // another foot's chain. That is the torso for quadrupeds and multilegs, the
  // pelvis for a humanoid; arms and heads carry no foot so they are not legs.
  const footRoles = new Set(['foot', 'wheel']);
  const footBodies = [...new Set(geoms.filter(g => footRoles.has(g.role)).map(g => g.bodyId))];
  const footCount = new Int32Array(nbody);
  for (const fb of footBodies) { let p = fb; while (p >= 0 && inRobot(p)) { footCount[p]++; if (p === root) break; p = model.body_parentid[p]; } }
  const subtree = start => order.filter(b => { let p = b; while (p > 0 && p !== start && p !== root) p = model.body_parentid[p]; return p === start; });
  let legs = [];
  if (Array.isArray(body?.legs) && body.legs.length) {
    legs = body.legs.map((leg, index) => {
      const ids = (leg.bodies ?? []).map(findBody).filter(b => b > 0);
      let start = ids.length ? ids.reduce((a, b) => (depthUnderRoot[a] <= depthUnderRoot[b] ? a : b)) : -1;
      return { name: leg.name ?? `leg${index}`, start, bodies: start > 0 ? subtree(start) : ids,
        footName: leg.footGeom ? logicalName(leg.footGeom) : null, wheelName: leg.wheel?.geom ? logicalName(leg.wheel.geom) : null,
        side: leg.side ?? null, end: leg.end ?? null, mountAngle: Number.isFinite(leg.mountAngle) ? leg.mountAngle : null };
    }).filter(leg => leg.bodies.length);
  }
  if (!legs.length) {
    const starts = new Set();
    for (const fb of footBodies) {
      let b = fb;
      while (b !== root && model.body_parentid[b] !== root && footCount[model.body_parentid[b]] === 1) b = model.body_parentid[b];
      if (b !== root) starts.add(b);
    }
    legs = [...starts].map(start => ({ name: logicalName(bodyNames[start]).split('_')[0] || `leg${start}`, start, bodies: subtree(start) }));
    legs.sort((a, b) => {
      const qa = QUAD_ORDER.indexOf(a.name), qb = QUAD_ORDER.indexOf(b.name);
      if (qa >= 0 && qb >= 0) return qa - qb;
      const na = /\d+/.exec(a.name), nb = /\d+/.exec(b.name);
      if (na && nb) return Number(na[0]) - Number(nb[0]);
      const side = n => (/^(left|l)$/.test(n) ? 0 : /^(right|r)$/.test(n) ? 1 : 2);
      return side(a.name) - side(b.name) || a.name.localeCompare(b.name);
    });
  }
  const legBodySet = new Set(legs.flatMap(l => l.bodies));

  // Torso point cloud, triangles and bounds.
  const torsoGeoms = geoms.filter(g => g.bodyId === root && g.role === 'torso');
  const torsoPoints = [], torsoTriangles = [];
  for (const g of torsoGeoms) {
    const { p, q } = geomPose(g);
    for (const v of geomLocalPoints(model, g.id)) torsoPoints.push(v.applyQuaternion(q).add(p));
    for (const [a, b, c] of geomLocalTriangles(model, g.id)) torsoTriangles.push([a.applyQuaternion(q).add(p), b.applyQuaternion(q).add(p), c.applyQuaternion(q).add(p)]);
  }
  if (!torsoPoints.length) {
    for (const g of geoms.filter(x => x.bodyId === root)) {
      const { p, q } = geomPose(g);
      for (const v of geomLocalPoints(model, g.id)) torsoPoints.push(v.applyQuaternion(q).add(p));
    }
    if (!torsoPoints.length) for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) torsoPoints.push(new THREE.Vector3(0.1 * x, 0.08 * y, 0.05 * z));
  }
  const torsoBox = new THREE.Box3().setFromPoints(torsoPoints);
  const torsoCenter = torsoBox.getCenter(new THREE.Vector3());
  const half = torsoBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);

  // Machinery near the torso, as points. Leg geoms are swept over their first
  // two joints' ranges (wheels and shells must never meet); other bodies
  // (head, rigid arms, a spine) are taken at rest.
  const obstaclePoints = [];
  const legInfo = legs.map((leg, index) => {
    const legBodies = leg.bodies;
    const legGeoms = geoms.filter(g => legBodies.includes(g.bodyId));
    const legJoints = joints.filter(j => legBodies.includes(j.bodyId)).sort((a, b) => depthUnderRoot[a.bodyId] - depthUnderRoot[b.bodyId]);
    const sweep = legJoints.filter(j => !j.continuous).slice(0, 2);
    const samples = n => Array.from({ length: n }, (_, k) => (n === 1 ? 0 : k / (n - 1)));
    const anglesA = sweep[0] ? samples(5).map(t => sweep[0].range[0] + t * (sweep[0].range[1] - sweep[0].range[0])) : [0];
    const anglesB = sweep[1] ? samples(3).map(t => sweep[1].range[0] + t * (sweep[1].range[1] - sweep[1].range[0])) : [0];
    const startDepth = depthUnderRoot[leg.start > 0 ? leg.start : legBodies[0]];
    const nearBodies = legBodies.filter(b => depthUnderRoot[b] - startDepth <= 3);
    for (const a of anglesA) for (const bAngle of anglesB) {
      const angle = new Map(); if (sweep[0]) angle.set(sweep[0].id, a); if (sweep[1]) angle.set(sweep[1].id, bAngle);
      const pos = new Map(), rot = new Map();
      for (const b of order) {
        if (b === root || !legBodies.includes(b)) continue;
        const parent = model.body_parentid[b];
        const pq = rot.get(parent) ?? restQuat[parent], pp = pos.get(parent) ?? restPos[parent];
        let q = pq.clone().multiply(quat(model, 'body_quat', b));
        let p = vec(model, 'body_pos', b).applyQuaternion(pq).add(pp);
        for (const joint of jointsByBody.get(b) ?? []) {
          const value = angle.get(joint.id) ?? 0;
          if (!value) continue;
          // Hinge about jnt_axis through jnt_pos (both in the body frame).
          const axisWorld = joint.axis.clone().applyQuaternion(q);
          const pivot = joint.pos.clone().applyQuaternion(q).add(p);
          const r = new THREE.Quaternion().setFromAxisAngle(axisWorld, value);
          p = p.sub(pivot).applyQuaternion(r).add(pivot);
          q = r.multiply(q);
        }
        pos.set(b, p); rot.set(b, q);
      }
      for (const g of legGeoms) {
        if (!nearBodies.includes(g.bodyId)) continue;
        const q = rot.get(g.bodyId).clone().multiply(quat(model, 'geom_quat', g.id));
        const p = vec(model, 'geom_pos', g.id).applyQuaternion(rot.get(g.bodyId)).add(pos.get(g.bodyId));
        for (const v of geomLocalPoints(model, g.id)) obstaclePoints.push(v.applyQuaternion(q).add(p));
      }
    }
    const wheelGeom = (leg.wheelName ? legGeoms.find(g => g.logical === leg.wheelName) : null) ?? legGeoms.find(g => g.role === 'wheel') ?? null;
    let foot = leg.footName ? legGeoms.find(g => g.logical === leg.footName) : null;
    if (!foot) foot = wheelGeom;
    if (!foot) {
      // Prefer a sole plate (box) over a riser in the same foot body.
      const candidates = legGeoms.filter(g => g.role === 'foot').sort((a, b) => depthUnderRoot[b.bodyId] - depthUnderRoot[a.bodyId] || (b.type === GEOM.BOX) - (a.type === GEOM.BOX));
      foot = candidates[0] ?? null;
    }
    if (!foot && legGeoms.length) foot = legGeoms.map(g => ({ g, d: geomPose(g).p.length() })).sort((a, b) => b.d - a.d)[0].g;
    const mount = restPos[leg.start > 0 ? leg.start : legBodies[0]].clone();
    const mountAngle = leg.mountAngle ?? Math.atan2(mount.y, mount.x);
    const side = leg.side ?? (mount.y > 1e-3 ? 'left' : mount.y < -1e-3 ? 'right' : 'center');
    const end = leg.end ?? (mount.x > 0.25 * half.x ? 'front' : mount.x < -0.25 * half.x ? 'rear' : 'middle');
    const footType = !foot ? 'none' : foot.role === 'wheel' ? 'wheel' : foot.type === GEOM.BOX ? 'flat' : 'point';
    const wheelJoint = wheelGeom ? legJoints.find(j => j.continuous && j.bodyId === wheelGeom.bodyId) : null;
    return { index, name: leg.name, bodies: legBodies, rootBody: leg.start, mount, mountAngle, side, end,
      footGeom: foot?.id ?? -1, footBody: foot?.bodyId ?? -1, footType,
      footRadius: !foot ? 0.02 : foot.type === GEOM.SPHERE ? foot.size[0] : foot.type === GEOM.CYLINDER ? foot.size[0] : Math.max(0.01, Math.min(...foot.size.filter(s => s > 0))),
      wheel: wheelGeom ? { geom: wheelGeom.id, body: wheelGeom.bodyId, radius: wheelGeom.size[0], halfWidth: wheelGeom.size[1], joint: wheelJoint?.id ?? -1 } : null,
      joints: legJoints.map(j => j.id) };
  });
  // Other bodies near the torso (heads, rigid arms, spine): obstacles at rest.
  for (const g of geoms) {
    if (g.bodyId === root || legBodySet.has(g.bodyId)) continue;
    const { p, q } = geomPose(g);
    for (const v of geomLocalPoints(model, g.id)) obstaclePoints.push(v.applyQuaternion(q).add(p));
  }

  // Physical head (the Draft humanoid's head_link): faces go there.
  let headBody = findBody(body?.bodyRoles?.head);
  const headGeom = geoms.find(g => g.role === 'head' && (headBody < 1 || g.bodyId === headBody)) ?? null;
  if ((headBody < 1 || !inRobot(headBody)) && headGeom) headBody = headGeom.bodyId;
  if (headBody < 1 || !inRobot(headBody)) headBody = -1;
  let head = null;
  if (headBody > 0 && headGeom) {
    const { p } = geomPose(headGeom);
    const radius = headGeom.type === GEOM.SPHERE ? headGeom.size[0] : Math.max(...headGeom.size.filter(s => s > 0));
    head = { bodyId: headBody, geomId: headGeom.id, center: p, radius, restPos: restPos[headBody].clone(), restQuat: restQuat[headBody].clone() };
  }

  // Is the torso's front face covered by leg machinery? Draft quadrupeds mount
  // their hip motors right there, so their faces go on top instead.
  const frontRegion = new THREE.Box3(
    new THREE.Vector3(torsoBox.max.x - 0.02, torsoCenter.y - 0.55 * half.y, torsoCenter.z - 0.15 * half.z),
    new THREE.Vector3(torsoBox.max.x + 0.6 * Math.max(half.y, half.z), torsoCenter.y + 0.55 * half.y, torsoBox.max.z));
  const frontBlocked = obstaclePoints.some(p => frontRegion.containsPoint(p));
  let frontMachineryTop = -Infinity;
  for (const p of obstaclePoints) if (p.x > torsoBox.max.x - 0.03 && Math.abs(p.y - torsoCenter.y) < half.y * 1.1) frontMachineryTop = Math.max(frontMachineryTop, p.z);

  // Plan and arrangement.
  const mountAngles = legInfo.map(l => l.mountAngle).sort((a, b) => a - b);
  const aspect = half.x / Math.max(1e-6, half.y);
  let maxGap = 0;
  for (let i = 0; i < mountAngles.length; i++) {
    const next = i + 1 < mountAngles.length ? mountAngles[i + 1] : mountAngles[0] + Math.PI * 2;
    maxGap = Math.max(maxGap, next - mountAngles[i]);
  }
  const wheeled = legInfo.some(l => l.wheel);
  const quadruped = legInfo.length === 4 && legInfo.every((l, i) => l.name === QUAD_ORDER[i]);
  const humanoid = !wheeled && !!head && legInfo.length === 2 && legInfo.every(l => l.footType === 'flat' || /^(left|right)$/.test(l.name));
  const contractPlan = ['quadruped', 'multileg', 'wheeled', 'humanoid'].includes(body?.bodyPlan) ? body.bodyPlan : null;
  const plan = contractPlan ?? (wheeled ? 'wheeled' : humanoid ? 'humanoid' : quadruped ? 'quadruped' : legInfo.length ? 'multileg' : 'unknown');
  const radial = plan === 'multileg' && legInfo.length >= 3 && maxGap <= 1.45 * (Math.PI * 2 / legInfo.length) && aspect < 1.45;
  const arrangement = radial ? 'radial' : 'bilateral';
  // Upright: a tall trunk standing on its legs (humanoid). Shells then go on the back.
  const upright = plan === 'humanoid' || (plan !== 'quadruped' && plan !== 'multileg' && half.z > 1.4 * Math.max(half.x, half.y));
  const unit = upright ? Math.max(0.035, Math.sqrt(half.y * half.z) * 0.5) : Math.max(0.035, Math.sqrt(half.x * half.y) * 0.5);

  // Motor geom for each hinge: nearest motor-role geom whose axis matches.
  for (const joint of joints) {
    const jq = restQuat[joint.bodyId], jp = joint.pos.clone().applyQuaternion(jq).add(restPos[joint.bodyId]);
    const axis = joint.axis.clone().applyQuaternion(jq);
    let best = null, bestScore = Infinity;
    for (const g of geoms) {
      if (g.role !== 'motor') continue;
      const { p, q } = geomPose(g);
      const gAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const align = Math.abs(gAxis.dot(axis));
      const score = p.distanceTo(jp) + (1 - align) * 0.2;
      if (score < bestScore) { best = g; bestScore = score; }
    }
    joint.motorGeom = best && bestScore < 0.25 ? best.id : -1;
    joint.restPosition = jp; joint.restAxis = axis;
  }

  return {
    root, rootName: bodyNames[root], prefix: bodyNames[root].slice(0, bodyNames[root].length - logicalName(bodyNames[root]).length),
    bodyNames, geomNames, depth: depthUnderRoot, robotBodies: order, restPos, restQuat,
    geoms, legs: legInfo, joints, headBody, head,
    torso: { bodyId: root, geomIds: torsoGeoms.map(g => g.id), points: torsoPoints, triangles: torsoTriangles, box: torsoBox, center: torsoCenter, half,
      shape: torsoGeoms.length === 1 && torsoGeoms[0].type === GEOM.MESH ? 'mesh' : 'primitive' },
    obstacles: obstaclePoints, frontBlocked, frontMachineryTop: Number.isFinite(frontMachineryTop) ? frontMachineryTop : torsoBox.min.z,
    plan, arrangement, upright, unit,
    mount: upright ? 'back' : 'top', mountQuat: upright ? BACK_MOUNT.clone() : new THREE.Quaternion(),
    forward: new THREE.Vector3(...(Array.isArray(body?.forwardAxis) && body.forwardAxis.length === 3 ? body.forwardAxis : [1, 0, 0])).normalize(),
  };
}

export { GEOM, JNT };
