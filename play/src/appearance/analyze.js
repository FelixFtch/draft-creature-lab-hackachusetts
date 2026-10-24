import * as THREE from 'three';

// Reads a compiled MjModel (never mutates it) and describes the creature in
// the robot root body's frame: which geoms are torso / limb / motor / detail /
// foot, how the legs are arranged, the torso's point cloud, and where leg
// machinery sits near the torso (so shells and faces avoid it).
//
// Works with Draft quadrupeds (fl_/fr_/rl_/rr_), the Flower and new multileg
// bodies (leg0..legN-1), and prefixed scenes ('robot/torso_link'). A
// creature-body/1 contract, when given, wins over name inference.

const GEOM = { PLANE: 0, HFIELD: 1, SPHERE: 2, CAPSULE: 3, ELLIPSOID: 4, CYLINDER: 5, BOX: 6, MESH: 7 };
const JNT = { FREE: 0, BALL: 1, SLIDE: 2, HINGE: 3 };
const ROLE_FROM_CONTRACT = { feet: 'foot', torso: 'torso', limbs: 'limb', motors: 'motor', details: 'detail' };
const QUAD_ORDER = ['fl', 'fr', 'rl', 'rr'];

export const logicalName = name => String(name ?? '').replace(/^.*\//, '');

function nameOf(mujoco, model, type, id) {
  try { return mujoco.mj_id2name(model, mujoco.mjtObj[type].value, id) ?? ''; } catch { return ''; }
}

function roleFromName(logical, isRootBody) {
  if (/_sphere$|_foot$|^foot|_toe$/.test(logical)) return 'foot';
  if (/_motor$|_actuator$|_servo$/.test(logical)) return 'motor';
  if (/_detail$|_cap$/.test(logical)) return 'detail';
  if (/_mesh$|^torso|_torso|_hub$|_body$/.test(logical) && isRootBody) return 'torso';
  if (/_link$|_leg$|_shin$|_thigh$|_coxa$/.test(logical)) return isRootBody ? 'torso' : 'limb';
  return isRootBody ? 'torso' : 'limb';
}

function jointRole(logical) {
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
    const role = contractRoles.get(logical) ?? roleFromName(logical, bodyId === root);
    geoms.push({ id: i, name: geomNames[i], logical, bodyId, type: model.geom_type[i], role,
      size: Array.from(model.geom_size.slice(i * 3, i * 3 + 3)) });
  }
  const geomPose = g => {
    const q = restQuat[g.bodyId].clone().multiply(quat(model, 'geom_quat', g.id));
    const p = vec(model, 'geom_pos', g.id).applyQuaternion(restQuat[g.bodyId]).add(restPos[g.bodyId]);
    return { p, q };
  };

  // Legs: contract order when present, else one leg per direct child subtree
  // of the root, ordered fl/fr/rl/rr or by leg number.
  const children = order.filter(b => model.body_parentid[b] === root);
  const subtree = start => order.filter(b => { let p = b; while (p > 0 && p !== start && p !== root) p = model.body_parentid[p]; return p === start; });
  let legs = [];
  if (Array.isArray(body?.legs) && body.legs.length) {
    legs = body.legs.map((leg, index) => {
      const ids = (leg.bodies ?? []).map(findBody).filter(b => b > 0);
      const first = ids.length ? ids.reduce((a, b) => (depthUnderRoot[a] <= depthUnderRoot[b] ? a : b)) : -1;
      let start = first;
      while (start > 0 && model.body_parentid[start] !== root) start = model.body_parentid[start];
      return { name: leg.name ?? `leg${index}`, start, bodies: start > 0 ? subtree(start) : ids, footName: leg.footGeom ? logicalName(leg.footGeom) : null,
        side: leg.side ?? null, end: leg.end ?? null, mountAngle: Number.isFinite(leg.mountAngle) ? leg.mountAngle : null };
    }).filter(leg => leg.bodies.length);
  }
  if (!legs.length) {
    legs = children.map(start => ({ name: logicalName(bodyNames[start]).split('_')[0] || `leg${start}`, start, bodies: subtree(start) }));
    // Two sibling chains with one prefix would be odd; keep them apart anyway.
    legs.sort((a, b) => {
      const qa = QUAD_ORDER.indexOf(a.name), qb = QUAD_ORDER.indexOf(b.name);
      if (qa >= 0 && qb >= 0) return qa - qb;
      const na = /\d+/.exec(a.name), nb = /\d+/.exec(b.name);
      if (na && nb) return Number(na[0]) - Number(nb[0]);
      return a.name.localeCompare(b.name);
    });
  }

  // Torso point cloud and bounds.
  const torsoGeoms = geoms.filter(g => g.bodyId === root && g.role === 'torso');
  const torsoPoints = [];
  for (const g of torsoGeoms) {
    const { p, q } = geomPose(g);
    for (const v of geomLocalPoints(model, g.id)) torsoPoints.push(v.applyQuaternion(q).add(p));
  }
  if (!torsoPoints.length) {
    // No torso geom (unusual): bound the root's own geoms or fall back to a small box.
    for (const g of geoms.filter(x => x.bodyId === root)) {
      const { p, q } = geomPose(g);
      for (const v of geomLocalPoints(model, g.id)) torsoPoints.push(v.applyQuaternion(q).add(p));
    }
    if (!torsoPoints.length) for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) torsoPoints.push(new THREE.Vector3(0.1 * x, 0.08 * y, 0.05 * z));
  }
  const torsoBox = new THREE.Box3().setFromPoints(torsoPoints);
  const torsoCenter = torsoBox.getCenter(new THREE.Vector3());
  const half = torsoBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);

  // Leg geometry near the torso across the first two joints' ranges, so the
  // cosmetic shell and face clear moving machinery, not only the rest pose.
  const jointsByBody = new Map();
  const joints = [];
  for (let j = 0; j < njnt; j++) {
    const b = model.jnt_bodyid[j];
    if (!inRobot(b) || model.jnt_type[j] !== JNT.HINGE) continue;
    const logical = logicalName(jointNames[j]);
    // jnt_limited is a bool array the WASM binding cannot expose; MuJoCo
    // stores range 0 0 for unlimited joints, so read the range instead.
    const lo = model.jnt_range[j * 2], hi = model.jnt_range[j * 2 + 1];
    const range = lo === 0 && hi === 0 ? [-Math.PI, Math.PI] : [lo, hi];
    const joint = { id: j, name: jointNames[j], logical, bodyId: b, role: jointRole(logical), axis: vec(model, 'jnt_axis', j).normalize(),
      pos: vec(model, 'jnt_pos', j), range, qposAdr: model.jnt_qposadr[j] };
    joints.push(joint);
    if (!jointsByBody.has(b)) jointsByBody.set(b, []);
    jointsByBody.get(b).push(joint);
  }

  const obstaclePoints = [];
  const legInfo = legs.map((leg, index) => {
    const legBodies = leg.bodies;
    const legGeoms = geoms.filter(g => legBodies.includes(g.bodyId));
    const legJoints = joints.filter(j => legBodies.includes(j.bodyId)).sort((a, b) => depthUnderRoot[a.bodyId] - depthUnderRoot[b.bodyId]);
    const sweep = legJoints.slice(0, 2);
    const samples = n => Array.from({ length: n }, (_, k) => (n === 1 ? 0 : k / (n - 1)));
    const anglesA = sweep[0] ? samples(5).map(t => sweep[0].range[0] + t * (sweep[0].range[1] - sweep[0].range[0])) : [0];
    const anglesB = sweep[1] ? samples(3).map(t => sweep[1].range[0] + t * (sweep[1].range[1] - sweep[1].range[0])) : [0];
    const nearBodies = legBodies.filter(b => depthUnderRoot[b] <= 3);
    for (const a of anglesA) for (const bAngle of anglesB) {
      const angle = new Map(); if (sweep[0]) angle.set(sweep[0].id, a); if (sweep[1]) angle.set(sweep[1].id, bAngle);
      const pos = new Map([[root, new THREE.Vector3()]]), rot = new Map([[root, new THREE.Quaternion()]]);
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
    const footCandidates = legGeoms.filter(g => g.role === 'foot');
    let foot = leg.footName ? legGeoms.find(g => g.logical === leg.footName) : null;
    if (!foot) foot = footCandidates.sort((a, b) => depthUnderRoot[b.bodyId] - depthUnderRoot[a.bodyId])[0] ?? null;
    if (!foot && legGeoms.length) {
      // Farthest geom from the root at rest stands in for a foot.
      foot = legGeoms.map(g => ({ g, d: geomPose(g).p.length() })).sort((a, b) => b.d - a.d)[0].g;
    }
    const mount = restPos[leg.start > 0 ? leg.start : legBodies[0]].clone();
    const mountAngle = leg.mountAngle ?? Math.atan2(mount.y, mount.x);
    const side = leg.side ?? (mount.y > 1e-3 ? 'left' : mount.y < -1e-3 ? 'right' : 'center');
    const end = leg.end ?? (mount.x > 0.25 * half.x ? 'front' : mount.x < -0.25 * half.x ? 'rear' : 'middle');
    return { index, name: leg.name, bodies: legBodies, rootBody: leg.start, mount, mountAngle, side, end,
      footGeom: foot?.id ?? -1, footBody: foot?.bodyId ?? -1, footRadius: foot ? (foot.type === GEOM.SPHERE ? foot.size[0] : Math.max(0.01, Math.min(...foot.size.filter(s => s > 0)))) : 0.02,
      joints: legJoints.map(j => j.id) };
  });

  // Is the torso's front face covered by leg machinery? Draft quadrupeds mount
  // their hip motors right there, so their faces go on top instead.
  const frontRegion = new THREE.Box3(
    new THREE.Vector3(torsoBox.max.x - 0.02, torsoCenter.y - 0.55 * half.y, torsoCenter.z - 0.15 * half.z),
    new THREE.Vector3(torsoBox.max.x + 0.6 * Math.max(half.y, half.z), torsoCenter.y + 0.55 * half.y, torsoBox.max.z));
  const frontBlocked = obstaclePoints.some(p => frontRegion.containsPoint(p));
  let frontMachineryTop = -Infinity;
  for (const p of obstaclePoints) if (p.x > torsoBox.max.x - 0.03 && Math.abs(p.y - torsoCenter.y) < half.y * 1.1) frontMachineryTop = Math.max(frontMachineryTop, p.z);

  // Radial = legs spread evenly around a roundish hub (Flower, starfish);
  // bilateral = left/right rows (Draft quadrupeds, insects, crabs).
  const mountAngles = legInfo.map(l => l.mountAngle).sort((a, b) => a - b);
  const aspect = half.x / Math.max(1e-6, half.y);
  let maxGap = 0;
  for (let i = 0; i < mountAngles.length; i++) {
    const next = i + 1 < mountAngles.length ? mountAngles[i + 1] : mountAngles[0] + Math.PI * 2;
    maxGap = Math.max(maxGap, next - mountAngles[i]);
  }
  const quadruped = legInfo.length === 4 && legInfo.every((l, i) => l.name === QUAD_ORDER[i]);
  const arrangement = !quadruped && legInfo.length >= 3 && maxGap <= 1.45 * (Math.PI * 2 / legInfo.length) && aspect < 1.45 ? 'radial' : 'bilateral';
  const unit = Math.max(0.035, Math.sqrt(half.x * half.y) * 0.5);

  let headBody = findBody(body?.bodyRoles?.head);
  if (headBody < 1 || !inRobot(headBody)) headBody = -1;

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
    geoms, legs: legInfo, joints, headBody,
    torso: { bodyId: root, geomIds: torsoGeoms.map(g => g.id), points: torsoPoints, box: torsoBox, center: torsoCenter, half,
      shape: torsoGeoms.length === 1 && torsoGeoms[0].type === GEOM.MESH ? 'mesh' : 'primitive' },
    obstacles: obstaclePoints, frontBlocked, frontMachineryTop: Number.isFinite(frontMachineryTop) ? frontMachineryTop : torsoBox.min.z,
    plan: quadruped ? 'quadruped' : legInfo.length ? 'multileg' : 'unknown', arrangement, unit,
    forward: new THREE.Vector3(...(Array.isArray(body?.forwardAxis) && body.forwardAxis.length === 3 ? body.forwardAxis : [1, 0, 0])).normalize(),
  };
}

export { GEOM, JNT };
