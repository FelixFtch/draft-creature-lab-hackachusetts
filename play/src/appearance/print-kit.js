import * as THREE from 'three';
import { analyzeCreature } from './analyze.js';
import { normalizeLook } from './schema.js';
import { buildShell, SHELL_THICKNESS, SHELL_CLEARANCE } from './shells.js';
import { buildHead, makeTopSampler } from './face.js';
import { buildAccessories } from './accessories.js';
import { mergeSolids, meshReport, cutSolid, weld } from './solids.js';

// Print kit: the decorative parts of a look as watertight binary STL files in
// millimetres, sized to the real torso (the same solids the view renders),
// plus look.json and a README, packed in a store-only zip. Nothing structural
// and nothing the simulation knows about: the README says so.

const PLA_DENSITY = 1.24;   // g/cm3
const WALLS_MM = 1.2;       // 3 perimeters x 0.4 mm nozzle
const INFILL = 0.15;

/** Slicer-like estimate in grams: solid walls over the surface, 15 % infill inside. */
export function estimateMass(report) {
  const walls = Math.min(report.volume, report.area * WALLS_MM);
  return Math.round(((walls + Math.max(0, report.volume - walls) * INFILL) / 1000) * PLA_DENSITY);
}

// ---- binary STL -----------------------------------------------------------
export function toBinaryStl(geometry, name = 'part') {
  const pos = geometry.attributes.position, idx = geometry.index ? geometry.index.array : null;
  const count = (idx ? idx.length : pos.count) / 3;
  const buffer = new ArrayBuffer(84 + count * 50), view = new DataView(buffer);
  const header = `Draft Creature Lab print kit: ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i) & 0x7f);
  view.setUint32(80, count, true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let o = 84;
  for (let f = 0; f < count; f++) {
    a.fromBufferAttribute(pos, idx ? idx[f * 3] : f * 3); b.fromBufferAttribute(pos, idx ? idx[f * 3 + 1] : f * 3 + 1); c.fromBufferAttribute(pos, idx ? idx[f * 3 + 2] : f * 3 + 2);
    n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    for (const v of [n, a, b, c]) { view.setFloat32(o, v.x, true); view.setFloat32(o + 4, v.y, true); view.setFloat32(o + 8, v.z, true); o += 12; }
    view.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buffer);
}

/** Parse a binary STL back into a non-indexed geometry (used by the tests). */
export function fromBinaryStl(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(80, true);
  const positions = new Float32Array(count * 9);
  for (let f = 0; f < count; f++) for (let k = 0; k < 9; k++) positions[f * 9 + k] = view.getFloat32(84 + f * 50 + 12 + k * 4, true);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return g;
}

// ---- store-only zip --------------------------------------------------------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zipStore(files, date = new Date()) {
  const enc = new TextEncoder(), chunks = [], central = [];
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name), data = file.bytes, crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

// ---- parts -------------------------------------------------------------------
function toMillimetres(solids, scale) {
  const merged = mergeSolids(solids);
  merged.applyMatrix4(new THREE.Matrix4().makeScale(1000 * scale, 1000 * scale, 1000 * scale));
  return merged;
}

function placeOnBed(geometry) {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox, c = b.getCenter(new THREE.Vector3());
  geometry.translate(-c.x, -c.y, -b.min.z);
  geometry.computeBoundingBox();
  return geometry;
}

function splitToFit(geometry, bed, depth = 0) {
  geometry.computeBoundingBox();
  const s = geometry.boundingBox.getSize(new THREE.Vector3());
  const fits = s.x <= bed[0] && s.y <= bed[1] && s.z <= bed[2];
  if (fits || depth >= 3) return [geometry];
  // Halve along the longest horizontal axis, through the middle.
  const axis = s.x >= s.y ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const mid = geometry.boundingBox.getCenter(new THREE.Vector3()).dot(axis) + 1e-3;
  const a = cutSolid(geometry, axis, mid), b = cutSolid(geometry, axis.clone().negate(), -mid);
  return [...splitToFit(placeOnBed(a), bed, depth + 1), ...splitToFit(placeOnBed(b), bed, depth + 1)];
}

/**
 * Build the kit synchronously (also used by tests).
 * options: { scale = 1, accessories = true, head = true, bed = [256,256,256] mm, split = 'auto' }
 */
export function buildPrintKit({ mujoco, model, look, body = null, rootBody = null, options = {} } = {}) {
  const { scale = 1, accessories: withAccessories = true, head: withHead = true, bed = [256, 256, 256], split = 'auto' } = options;
  const info = analyzeCreature({ mujoco, model, body, rootBody });
  const normalized = normalizeLook(look);
  const groups = [];
  const shell = buildShell(normalized, info, { quality: 'high' });
  if (shell) {
    for (const g of shell.printable()) groups.push({ name: g.name, kind: 'shell', solids: g.solids });
    for (const part of shell.parts) part.solid.dispose();
  }
  const sampler = makeTopSampler(info, shell);
  const head = withHead ? buildHead(normalized, info, sampler, { quality: 'high' }) : null;
  if (head) { for (const g of head.printable()) groups.push({ name: g.name, kind: 'head', solids: g.solids }); for (const p of head.parts) p.solid.dispose(); }
  if (withAccessories && normalized.accessories.length) {
    const acc = buildAccessories(normalized, info, sampler, head, { quality: 'high' });
    acc.group.updateMatrixWorld(true);
    for (const item of acc.printable) {
      const solids = item.specs.map(spec => spec.solid.clone().applyMatrix4(spec.node.matrixWorld));
      if (solids.length) groups.push({ name: item.name, kind: 'accessory', solids });
    }
    for (const spec of acc.specs) spec.solid.dispose();
  }
  const files = [], parts = [];
  for (const group of groups) {
    const mm = placeOnBed(toMillimetres(group.solids, scale));
    for (const s of group.solids) s.dispose();
    const pieces = split === 'auto' ? splitToFit(mm, bed) : [mm];
    pieces.forEach((piece, i) => {
      const welded = weld(piece, 1e-4);   // 0.1 um in mm units
      const name = pieces.length > 1 ? `${group.name}-part${i + 1}of${pieces.length}.stl` : `${group.name}.stl`;
      const report = meshReport(welded, 1e-4);
      const bytes = toBinaryStl(welded, name);
      files.push({ name, bytes });
      parts.push({ name, kind: group.kind, triangles: report.triangles, sizeMm: report.size.map(v => Math.round(v * 10) / 10),
        volumeCm3: Math.round((report.volume / 1000) * 10) / 10, massG: estimateMass(report), watertight: report.watertight,
        components: report.components, report });
      if (welded !== piece) piece.dispose();
      welded.dispose();
    });
  }
  const readme = readmeText({ info, look: normalized, parts, scale, bed, body });
  files.push({ name: 'README.txt', bytes: new TextEncoder().encode(readme) });
  files.push({ name: 'look.json', bytes: new TextEncoder().encode(`${JSON.stringify(normalized, null, 2)}\n`) });
  return { files, parts, readme, zip: () => zipStore(files) };
}

/** Promise<Blob>: a zip by default, or the main shell alone with options.format = 'stl'. */
export async function exportPrintKit({ mujoco, model, look, body = null, rootBody = null, options = {} } = {}) {
  const kit = buildPrintKit({ mujoco, model, look, body, rootBody, options });
  if (options.format === 'stl') {
    const main = kit.files.find(f => f.name.endsWith('.stl'));
    if (!main) throw Error('This look has no printable parts (choose a shell, head or accessory)');
    return new Blob([main.bytes], { type: 'model/stl' });
  }
  return new Blob([kit.zip()], { type: 'application/zip' });
}

function readmeText({ info, look, parts, scale, bed, body }) {
  const lines = [];
  const name = body?.name || info.rootName.replace(/^.*\//, '');
  const totalMass = parts.reduce((s, p) => s + p.massG, 0);
  lines.push('DRAFT CREATURE LAB - PRINT KIT', '==============================', '');
  lines.push(`Look: ${look.theme} (creature-look/1)   Body: ${body?.id ?? name}   Plan: ${info.plan}, ${info.legs.length} legs`);
  lines.push(`Scale: ${scale === 1 ? '1:1 - real robot size, millimetres' : `${scale} x real size (${(1 / scale).toFixed(2)}:1 reduction), millimetres`}`);
  lines.push(`Generated: ${new Date().toISOString()}`, '');
  lines.push('PARTS');
  if (!parts.length) lines.push('  (none - this look has no shell, head or accessories)');
  for (const p of parts) {
    lines.push(`  ${p.name.padEnd(40)} ${p.sizeMm.join(' x ')} mm   ${p.volumeCm3} cm3   ~${p.massG} g PLA   ${p.watertight ? 'watertight' : 'CHECK MESH'}${p.components > 1 ? `   (${p.components} bodies)` : ''}`);
  }
  lines.push('', 'FIT');
  lines.push(`  Shells were fitted to this torso's real geometry: ${SHELL_CLEARANCE * 1000} mm clearance, ${SHELL_THICKNESS * 1000} mm walls,`);
  lines.push('  and a short skirt (the mounting lip) that slips over the torso. The rim rises into arches');
  lines.push("  wherever the hip motors and links move (checked over each leg's first two joint ranges).");
  lines.push('  Fix with double-sided foam tape, hook-and-loop dots or a few dots of hot glue.');
  lines.push('  Heads have a flat back for the torso front face; use standoffs or a small bracket and check');
  lines.push('  clearance with the front legs at full hip roll before you power the robot.');
  lines.push('', 'PRINTING');
  lines.push('  PLA or PETG, 0.2 mm layers, 3 perimeters (shells are 2.4 mm thick), 10-15 % gyroid infill.');
  lines.push('  Shells: print opening-down with tree supports inside, or opening-up for a perfect outer face.');
  lines.push('  One file per colour slot (e.g. beetle wing cases vs. pronotum) makes multi-colour prints easy.');
  lines.push('  Overlapping bodies inside one file (rivets, scutes, puffs) are meant to be merged by the slicer.');
  lines.push(`  Parts bigger than ${bed.join(' x ')} mm were split in halves along their long axis ("partNofM").`);
  lines.push('', 'HONESTY');
  lines.push('  These parts are cosmetic. The simulation and any trained walking/jumping policy never saw them:');
  lines.push(`  the kit would add about ${totalMass} g (PLA, 3 perimeters + 15 % infill estimate) that was not in the model.`);
  lines.push('  Keep them light, check the fit by hand, and re-validate on hardware before relying on a policy.');
  lines.push('', 'LICENSE');
  lines.push('  The generated geometry is yours to print, remix and share.');
  return `${lines.join('\n')}\n`;
}
