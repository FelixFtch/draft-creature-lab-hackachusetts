import * as THREE from 'three';
import { patchLookMaterial, createOutlineMaterial } from './shader.js';
import { mixHex, scaleHex } from './schema.js';

// Semantic material slots, Microduck-style: every part of every body plan is
// tagged with a slot (body, limbs, joints, details, feet, shell, eyes, ...)
// and a look fills the slots. Materials are shared per slot within one view.
//
// Colour management: palette hexes are sRGB; THREE converts them to linear.
// The renderer tone-maps with ACES, which desaturates mid-tones, so colours
// get a small saturation lift (as Microduck's variants do with x1.12).

export const FINISH_SPECS = {
  matte: { cls: 'standard', roughness: 0.82, metalness: 0.0, layer: 0.42 },
  satin: { cls: 'standard', roughness: 0.38, metalness: 0.12, layer: 0.26 },   // v1 lab material + layer lines
  gloss: { cls: 'physical', roughness: 0.24, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.06, layer: 0 },
  metal: { cls: 'standard', roughness: 0.3, metalness: 0.9, layer: 0 },
  toon: { cls: 'toon', layer: 0, outline: true },
  glow: { cls: 'standard', roughness: 0.34, metalness: 0.18, layer: 0.12, glow: true },
};

// Pattern cells across one torso length at scale 1.
const BASE_FREQ = { spots: 3.3, dots: 8.5, stripes: 4.6, bands: 5.2, gradient: 1, checker: 6, camo: 2.3, panels: 5, cracks: 3, scales: 11, hex: 10 };
const SATURATION_LIFT = 1.08;
const LAYER_PITCH = 0.0022;   // exaggerated vs a real 0.2 mm layer so close-ups read; fades out at distance

export function linearColor(hex, lift = SATURATION_LIFT) {
  const c = new THREE.Color(hex);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.r = Math.max(0, l + (c.r - l) * lift); c.g = Math.max(0, l + (c.g - l) * lift); c.b = Math.max(0, l + (c.b - l) * lift);
  return c;
}

function toonGradient() {
  // 4-step ramp, nearest-filtered: soft-but-graphic cel shading.
  const data = new Uint8Array([90, 90, 90, 255, 160, 160, 160, 255, 222, 222, 222, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  return tex;
}

/** Which parts carry the pattern. 'auto' = the shell when there is one, else the body. */
export function patternTargets(look) {
  const { kind, target } = look.pattern;
  if (kind === 'none') return { body: false, shell: false, limbs: false };
  const hasShell = look.shell.kind !== 'none';
  if (target === 'all') return { body: true, shell: true, limbs: true };
  if (target === 'limbs') return { body: false, shell: false, limbs: true };
  if (target === 'body') return { body: true, shell: false, limbs: false };
  if (target === 'shell') return hasShell ? { body: false, shell: true, limbs: false } : { body: true, shell: false, limbs: false };
  return hasShell ? { body: false, shell: true, limbs: false } : { body: true, shell: false, limbs: false };
}

/**
 * @param look normalised creature-look/1
 * @param ctx { refSize (m), zRange [z0,z1] in body frame, shared uniforms, quality }
 */
export function createMaterialKit(look, ctx) {
  const finish = FINISH_SPECS[look.finish] ?? FINISH_SPECS.satin;
  const materials = new Map(), textures = new Set();
  const targets = patternTargets(look);
  const freqFor = kind => (BASE_FREQ[kind] ?? 4) / (Math.max(0.12, ctx.refSize) * look.pattern.scale);
  const glowPattern = finish.glow;
  const p = look.palette;
  let ramp = null;
  const rampTexture = () => { if (!ramp) { ramp = toonGradient(); textures.add(ramp); } return ramp; };

  function patternFor(frame) {
    const kind = look.pattern.kind;
    const base = frame === 'limb' ? p.limbs : frame === 'shell' ? look.shell.color : p.body;
    return {
      kind, color: linearColor(look.pattern.color), color2: linearColor(mixHex(mixHex(base, look.pattern.color, 0.45), '#ffffff', 0.12)),
      freq: freqFor(kind), axis: frame === 'limb' ? [0, 0, 1] : [1, 0, 0], range: ctx.zRange ?? [-0.1, 0.1], glow: glowPattern ? 2.4 : 0,
    };
  }

  function build(role, hex, { pattern = null, emissive = 0, layer = true } = {}) {
    const color = linearColor(hex);
    let material;
    const toon = finish.cls === 'toon';
    if (toon) {
      material = new THREE.MeshToonMaterial({ color, gradientMap: rampTexture() });
    } else if (role === 'eye' || role === 'pupil' || role === 'glass' || (finish.cls === 'physical' && role !== 'rubber' && role !== 'ink')) {
      material = new THREE.MeshPhysicalMaterial({ color, roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 });
    } else {
      material = new THREE.MeshStandardMaterial({ color, roughness: finish.roughness, metalness: finish.metalness });
    }
    if (!toon) {
      if (role === 'joint') { material.roughness = Math.min(material.roughness, finish.roughness * 0.8 + 0.05); material.metalness = Math.max(material.metalness, finish.cls === 'standard' && look.finish === 'metal' ? 0.8 : 0.35); }
      if (role === 'rubber') { material.roughness = 0.88; material.metalness = 0; }
      if (role === 'eye') { material.roughness = 0.18; }
      if (role === 'pupil') { material.roughness = 0.06; }
      if (role === 'glass') { material.roughness = 0.04; material.metalness = 0.25; }
      if (role === 'gold') { material.roughness = 0.24; material.metalness = 1; }
      if (role === 'ink') { material.roughness = 0.6; material.metalness = 0; }
      if (role === 'soft') { material.roughness = Math.max(0.55, material.roughness); material.metalness = 0; }
    }
    if (role === 'wing') {
      // Thin printed membranes: a little see-through, both faces visible.
      material.transparent = true; material.opacity = 0.62; material.depthWrite = false; material.side = THREE.DoubleSide;
      if (!toon) { material.roughness = 0.2; material.metalness = 0; }
    }
    if (emissive > 0) { material.emissive = color.clone(); material.emissiveIntensity = emissive; }
    patchLookMaterial(material, { pattern, layer: layer && finish.layer > 0 ? { amp: finish.layer, pitch: LAYER_PITCH } : null, shared: ctx.shared });
    material.userData.lookRole = role;
    return material;
  }

  const eyeGlow = look.face.eyes === 'visor' || look.finish === 'glow';
  const slotSpecs = {
    body: () => build('plastic', p.body, { pattern: targets.body ? patternFor('body') : null }),
    shell: () => build('plastic', look.shell.color, { pattern: targets.shell ? patternFor('shell') : null }),
    shellAccent: () => build('plastic', shellAccent(look)),
    shellTrim: () => build('plastic', mixHex(look.shell.color, look.pattern.kind !== 'none' ? look.pattern.color : p.joints, 0.55)),
    limbs: () => build('plastic', p.limbs, { pattern: targets.limbs ? patternFor('limb') : null }),
    joints: () => build('joint', p.joints),
    details: () => build('plastic', p.caps ?? p.accent, { emissive: glowPattern ? 1.6 : 0 }),
    feet: () => build('rubber', p.feet, { layer: false }),
    accent: () => build('plastic', p.accent, { emissive: glowPattern ? 1.2 : 0 }),
    muzzle: () => build('soft', mixHex(p.accent, p.body, 0.2)),   // pink cow nose, white tiger muzzle
    eyeWhite: () => build('eye', '#f7f5ef', { layer: false }),
    eyeIris: () => build('eye', look.face.eyeColor, { layer: false, emissive: eyeGlow ? 1.4 : 0 }),
    eyePupil: () => build('pupil', '#0d0f14', { layer: false }),
    eyeShine: () => build('plastic', '#ffffff', { layer: false, emissive: 1.4 }),
    eyeGlass: () => build('glass', mixHex('#10141c', look.face.eyeColor, 0.12), { layer: false }),
    eyeGlow: () => build('plastic', look.face.eyeColor, { layer: false, emissive: 2.4 }),
    lid: () => build('plastic', p.body),
    blush: () => build('soft', '#ff8a9a', { layer: false }),
    ink: () => build('ink', '#1c1a1d', { layer: false }),
    teeth: () => build('eye', '#fbf8f0', { layer: false }),
    beak: () => build('plastic', p.accent),
    marking: () => build('soft', markingColor(look)),
    nose: () => build('pupil', '#211d22', { layer: false }),
    gold: () => build('gold', '#e8b54a', { layer: false }),
    jewel: () => build('glass', '#e2385b', { layer: false, emissive: glowPattern ? 1.2 : 0.25 }),
    petalInner: () => build('plastic', mixHex(look.shell.color, '#ffffff', 0.35)),
    leaf: () => build('plastic', '#5fae4f'),
  };

  function get(slot) {
    let material = materials.get(slot);
    if (!material) {
      const make = slotSpecs[slot];
      if (!make) throw Error(`Unknown material slot ${slot}`);
      material = make(); material.userData.slot = slot;
      materials.set(slot, material);
    }
    return material;
  }

  /** Per-accessory colours (and derived shades) share materials by key. */
  function colored(hex, role = 'plastic') {
    const key = `color:${role}:${hex}`;
    let material = materials.get(key);
    if (!material) {
      material = build(role, hex, { emissive: role === 'glowing' ? 2.2 : glowPattern && role === 'plastic' ? 0.5 : 0 });
      material.userData.slot = key;
      materials.set(key, material);
    }
    return material;
  }

  let outline = null;
  if (finish.outline) { outline = createOutlineMaterial('#24202a', Math.max(0.0022, ctx.refSize * 0.006)); materials.set('outline', outline); }

  return {
    finish: look.finish, spec: finish, get, colored, outline,
    all: () => [...materials.values()],
    dispose() {
      for (const m of materials.values()) m.dispose();
      for (const t of textures) t.dispose();
      materials.clear(); textures.clear();
    },
  };
}

export function shellAccent(look) {
  // Contrast piece of a shell (beetle pronotum, turtle scutes, armour rivets).
  if (look.pattern.kind !== 'none') return look.pattern.color;
  return scaleHex(look.shell.color, 0.55);
}

export function markingColor(look) {
  // Panda patches / bandit mask: the darker of limbs and joints reads best.
  return look.pattern.kind !== 'none' ? look.pattern.color : look.palette.joints;
}
