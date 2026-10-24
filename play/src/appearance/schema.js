// creature-look/1 in code: enums, defaults, a lenient normaliser (never throws,
// always returns a complete schema-valid look) and a strict validator (lists
// every problem, coerces nothing). contracts/look.schema.json is the single
// source of truth; qa/look-schema.mjs checks this file against it.
//
// Looks are cosmetic only. Nothing here may read or change physics.

export const LOOK_SCHEMA = 'creature-look/1';

export const FINISHES = ['matte', 'satin', 'gloss', 'metal', 'toon', 'glow'];
export const PATTERNS = ['none', 'spots', 'dots', 'stripes', 'bands', 'gradient', 'checker', 'camo', 'panels', 'cracks', 'scales', 'hex'];
export const PATTERN_TARGETS = ['auto', 'body', 'shell', 'limbs', 'all'];
export const SHELLS = ['none', 'dome', 'beetle', 'turtle', 'petals', 'armor', 'fluffy', 'saddle'];
export const EYES = ['none', 'round', 'cute', 'visor', 'cyclops', 'sleepy', 'compound'];
export const HEADS = ['none', 'round', 'boxy', 'snout'];
export const MOUTHS = ['none', 'smile', 'grin', 'beak', 'fangs', 'whiskers', 'grill'];
export const MARKINGS = ['none', 'patches', 'mask'];
export const ACCESSORIES = ['antennae', 'horns', 'ears', 'tail', 'spikes', 'fin', 'wings', 'crown', 'hat', 'bow', 'flower',
  'propeller', 'backpack', 'sprout', 'mushroom', 'halo', 'goggles', 'scarf'];
export const LIMB_STYLES = ['classic', 'sleek', 'chunky', 'bones'];
export const FEET = ['ball', 'paw', 'hoof', 'pad'];
export const MAX_ACCESSORIES = 6;

export const RANGES = {
  patternScale: [0.5, 2],
  shellSize: [0.8, 1.3],
  faceSize: [0.7, 1.4],
  accessorySize: [0.6, 1.6],
};

// The legacy lab default colour. Old recipes carry their own colour.
export const DEFAULT_BODY = '#60a894';
export const LEGACY_FOOT = '#394944';

const HEX = /^#[0-9a-f]{6}$/i;
const SHORT_HEX = /^#[0-9a-f]{3}$/i;

// Friendly spellings an LLM (or a person) might use. Only unambiguous ones.
const ALIASES = {
  finish: { glossy: 'gloss', shiny: 'gloss', metallic: 'metal', chrome: 'metal', plastic: 'satin', pla: 'satin',
    flat: 'matte', mat: 'matte', cel: 'toon', cartoon: 'toon', neon: 'glow', emissive: 'glow' },
  pattern: { spot: 'spots', dot: 'dots', polka: 'dots', stripe: 'stripes', tiger: 'stripes', zebra: 'stripes',
    band: 'bands', checkers: 'checker', checkered: 'checker', camouflage: 'camo', panel: 'panels', crack: 'cracks',
    veins: 'cracks', scale: 'scales', honeycomb: 'hex', hexagon: 'hex' },
  shell: { ladybug: 'beetle', bug: 'beetle', helmet: 'dome', flower: 'petals', petal: 'petals', fur: 'fluffy',
    fluff: 'fluffy', cloud: 'fluffy', plates: 'armor', armour: 'armor' },
  eyes: { normal: 'round', big: 'cute', kawaii: 'cute', goggle: 'visor', single: 'cyclops', tired: 'sleepy', bug: 'compound', insect: 'compound' },
  head: { ball: 'round', box: 'boxy', robot: 'boxy', muzzle: 'snout', animal: 'snout' },
  mouth: { happy: 'smile', teeth: 'grin', bill: 'beak', vampire: 'fangs', whisker: 'whiskers', grille: 'grill', vent: 'grill' },
  markings: { panda: 'patches', patch: 'patches', bandit: 'mask', raccoon: 'mask' },
  accessory: { antenna: 'antennae', horn: 'horns', ear: 'ears', spike: 'spikes', wing: 'wings', 'top hat': 'hat',
    ribbon: 'bow', blossom: 'flower', rotor: 'propeller', pack: 'backpack', leaf: 'sprout', seedling: 'sprout',
    toadstool: 'mushroom', ring: 'halo', glasses: 'goggles', bandana: 'scarf' },
  style: { normal: 'classic', default: 'classic', slim: 'sleek', thin: 'sleek', thick: 'chunky', toy: 'chunky', bone: 'bones', skeleton: 'bones' },
  feet: { sphere: 'ball', round: 'ball', paws: 'paw', hooves: 'hoof', pads: 'pad', boot: 'pad' },
};

const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value));

export function isHexColor(value) { return typeof value === 'string' && HEX.test(value); }

export function toHex(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim().toLowerCase();
  if (HEX.test(text)) return text;
  if (SHORT_HEX.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  return fallback;
}

function pick(value, options, fallback, aliases) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim().toLowerCase();
  if (options.includes(text)) return text;
  const alias = aliases?.[text];
  return alias && options.includes(alias) ? alias : fallback;
}

function number(value, range, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? clamp(n, range) : fallback;
}

// sRGB hex <-> linear helpers without THREE so this file stays dependency
// free (the AI service and Node tests import it). The legacy lab multiplied
// THREE colours in linear space, so the classic rules do the same.
const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
export function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => toLinear(v / 255));
}
export function linearToHex(rgb) {
  return `#${rgb.map(v => Math.round(Math.min(1, Math.max(0, toSrgb(Math.max(0, v)))) * 255).toString(16).padStart(2, '0')).join('')}`;
}
export function scaleHex(hex, factor) { return linearToHex(hexToLinear(hex).map(v => v * factor)); }
export function mixHex(a, b, t) {
  const x = hexToLinear(a), y = hexToLinear(b);
  return linearToHex(x.map((v, i) => v + (y[i] - v) * t));
}

// The v1 colour rules, verbatim: `_sphere` feet fixed dark green-grey,
// `_motor` x0.52, `_detail` x0.33, `_link` lerped 20% to white.
export function classicPalette(body = DEFAULT_BODY) {
  const hex = toHex(body, DEFAULT_BODY), detail = scaleHex(hex, 0.33);
  return { body: hex, limbs: mixHex(hex, '#ffffff', 0.2), joints: scaleHex(hex, 0.52), accent: detail, feet: LEGACY_FOOT, caps: detail };
}

export function classicLook(body = DEFAULT_BODY) {
  const palette = classicPalette(body);
  return {
    schema: LOOK_SCHEMA,
    theme: 'classic',
    palette,
    finish: 'satin',
    pattern: { kind: 'none', color: scaleHex(palette.body, 0.25), scale: 1, target: 'auto' },
    shell: { kind: 'none', color: palette.body, size: 1 },
    face: { eyes: 'none', eyeColor: '#1b1f24', size: 1, head: 'none', mouth: 'none', cheeks: false, markings: 'none' },
    accessories: [],
    limbs: { style: 'classic', feet: 'ball' },
  };
}

export const DEFAULT_LOOK = Object.freeze(classicLook());

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

/**
 * Lenient: accepts a creature-look/1 object (partial is fine), a legacy single
 * hex colour ('#1f8c80'), a legacy v1 recipe ({schema:1, color}) or a JSON
 * string of either. Returns a complete, schema-valid look; never throws.
 */
export function normalizeLook(input) {
  let source = input;
  if (typeof source === 'string') {
    const text = source.trim();
    const hex = toHex(text, null);
    if (hex) return classicLook(hex);
    if (text.startsWith('{')) { try { source = JSON.parse(text); } catch { source = null; } }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return classicLook();
  // v1 recipe or any object that only carries a colour: the classic look.
  if (source.schema !== LOOK_SCHEMA && !source.palette && toHex(source.color, null)) return classicLook(source.color);

  const palIn = object(source.palette);
  const body = toHex(palIn.body, DEFAULT_BODY);
  const base = classicPalette(body);
  const palette = {
    body,
    limbs: toHex(palIn.limbs, base.limbs),
    joints: toHex(palIn.joints, base.joints),
    accent: toHex(palIn.accent, base.accent),
    feet: toHex(palIn.feet, base.feet),
  };
  // Motor face caps follow the accent unless the look says otherwise.
  palette.caps = toHex(palIn.caps, palette.accent);
  const patIn = object(source.pattern), shellIn = object(source.shell), faceIn = object(source.face), limbsIn = object(source.limbs);
  const theme = typeof source.theme === 'string' ? source.theme.trim().slice(0, 40) : 'custom';
  const accessories = [];
  for (const item of Array.isArray(source.accessories) ? source.accessories : []) {
    const entry = typeof item === 'string' ? { kind: item } : object(item);
    const kind = pick(entry.kind, ACCESSORIES, null, ALIASES.accessory);
    if (!kind || accessories.some(a => a.kind === kind)) continue;
    accessories.push({ kind, color: toHex(entry.color, palette.accent), size: number(entry.size, RANGES.accessorySize, 1) });
    if (accessories.length === MAX_ACCESSORIES) break;
  }
  return {
    schema: LOOK_SCHEMA,
    theme: theme || 'custom',
    palette,
    finish: pick(source.finish, FINISHES, 'satin', ALIASES.finish),
    pattern: {
      kind: pick(patIn.kind, PATTERNS, 'none', ALIASES.pattern),
      color: toHex(patIn.color, scaleHex(body, 0.25)),
      scale: number(patIn.scale, RANGES.patternScale, 1),
      target: pick(patIn.target, PATTERN_TARGETS, 'auto'),
    },
    shell: {
      kind: pick(shellIn.kind, SHELLS, 'none', ALIASES.shell),
      color: toHex(shellIn.color, body),
      size: number(shellIn.size, RANGES.shellSize, 1),
    },
    face: {
      eyes: pick(faceIn.eyes, EYES, 'none', ALIASES.eyes),
      eyeColor: toHex(faceIn.eyeColor, '#1b1f24'),
      size: number(faceIn.size, RANGES.faceSize, 1),
      head: pick(faceIn.head, HEADS, 'none', ALIASES.head),
      mouth: pick(faceIn.mouth, MOUTHS, 'none', ALIASES.mouth),
      cheeks: faceIn.cheeks === true || faceIn.cheeks === 'true',
      markings: pick(faceIn.markings, MARKINGS, 'none', ALIASES.markings),
    },
    accessories,
    limbs: {
      style: pick(limbsIn.style, LIMB_STYLES, 'classic', ALIASES.style),
      feet: pick(limbsIn.feet, FEET, 'ball', ALIASES.feet),
    },
  };
}

/** Strict: reports every deviation from creature-look/1 without coercing. */
export function validateLook(look) {
  const errors = [];
  const err = (path, message) => errors.push(`${path}: ${message}`);
  const allowOnly = (value, keys, path) => {
    for (const key of Object.keys(value)) if (!keys.includes(key)) err(`${path}.${key}`, 'unknown property');
  };
  const color = (value, path) => { if (value !== undefined && !isHexColor(value)) err(path, 'expected #rrggbb'); };
  const oneOf = (value, options, path) => { if (value !== undefined && !options.includes(value)) err(path, `expected one of ${options.join(', ')}`); };
  const inRange = (value, range, path) => {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1])) err(path, `expected a number in [${range[0]}, ${range[1]}]`);
  };
  const section = (value, path) => {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { err(path, 'expected an object'); return null; }
    return value;
  };
  if (!look || typeof look !== 'object' || Array.isArray(look)) return { valid: false, errors: ['$: expected an object'] };
  allowOnly(look, ['schema', 'theme', 'palette', 'finish', 'pattern', 'shell', 'face', 'accessories', 'limbs'], '$');
  if (look.schema !== LOOK_SCHEMA) err('$.schema', `expected "${LOOK_SCHEMA}"`);
  if (look.theme !== undefined && (typeof look.theme !== 'string' || look.theme.length > 40)) err('$.theme', 'expected a string of at most 40 characters');
  const palette = section(look.palette, '$.palette');
  if (palette) {
    allowOnly(palette, ['body', 'limbs', 'joints', 'accent', 'feet', 'caps'], '$.palette');
    for (const key of Object.keys(palette)) color(palette[key], `$.palette.${key}`);
  }
  oneOf(look.finish, FINISHES, '$.finish');
  const pattern = section(look.pattern, '$.pattern');
  if (pattern) {
    allowOnly(pattern, ['kind', 'color', 'scale', 'target'], '$.pattern');
    oneOf(pattern.kind, PATTERNS, '$.pattern.kind'); color(pattern.color, '$.pattern.color');
    inRange(pattern.scale, RANGES.patternScale, '$.pattern.scale'); oneOf(pattern.target, PATTERN_TARGETS, '$.pattern.target');
  }
  const shell = section(look.shell, '$.shell');
  if (shell) {
    allowOnly(shell, ['kind', 'color', 'size'], '$.shell');
    oneOf(shell.kind, SHELLS, '$.shell.kind'); color(shell.color, '$.shell.color'); inRange(shell.size, RANGES.shellSize, '$.shell.size');
  }
  const face = section(look.face, '$.face');
  if (face) {
    allowOnly(face, ['eyes', 'eyeColor', 'size', 'head', 'mouth', 'cheeks', 'markings'], '$.face');
    oneOf(face.eyes, EYES, '$.face.eyes'); color(face.eyeColor, '$.face.eyeColor'); inRange(face.size, RANGES.faceSize, '$.face.size');
    oneOf(face.head, HEADS, '$.face.head'); oneOf(face.mouth, MOUTHS, '$.face.mouth'); oneOf(face.markings, MARKINGS, '$.face.markings');
    if (face.cheeks !== undefined && typeof face.cheeks !== 'boolean') err('$.face.cheeks', 'expected a boolean');
  }
  if (look.accessories !== undefined) {
    if (!Array.isArray(look.accessories)) err('$.accessories', 'expected an array');
    else {
      if (look.accessories.length > MAX_ACCESSORIES) err('$.accessories', `at most ${MAX_ACCESSORIES} items`);
      look.accessories.forEach((item, i) => {
        const path = `$.accessories[${i}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) { err(path, 'expected an object'); return; }
        allowOnly(item, ['kind', 'color', 'size'], path);
        if (item.kind === undefined) err(`${path}.kind`, 'required');
        oneOf(item.kind, ACCESSORIES, `${path}.kind`); color(item.color, `${path}.color`); inRange(item.size, RANGES.accessorySize, `${path}.size`);
      });
    }
  }
  const limbs = section(look.limbs, '$.limbs');
  if (limbs) {
    allowOnly(limbs, ['style', 'feet'], '$.limbs');
    oneOf(limbs.style, LIMB_STYLES, '$.limbs.style'); oneOf(limbs.feet, FEET, '$.limbs.feet');
  }
  return { valid: errors.length === 0, errors };
}

/** Stable key for "did anything structural change" checks. */
export function lookKey(look) { return JSON.stringify(normalizeLook(look)); }
