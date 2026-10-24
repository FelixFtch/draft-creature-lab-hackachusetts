// Appearance module: how a creature looks. See contracts/appearance-api.md.
// Purely cosmetic: nothing exported here reads or writes physics state other
// than copying body poses out of MjData in view.sync(data).

export { createCreatureView } from './creature-view.js';
export { createStudio } from './studio.js';
export { exportPrintKit, buildPrintKit, toBinaryStl, fromBinaryStl, zipStore } from './print-kit.js';
export { LOOK_PRESETS, LOOK_PRESET_IDS, getLookPreset } from './presets.js';
export {
  LOOK_SCHEMA, DEFAULT_LOOK, normalizeLook, validateLook, classicLook, classicPalette, lookKey,
  FINISHES, PATTERNS, PATTERN_TARGETS, SHELLS, EYES, HEADS, MOUTHS, MARKINGS, ACCESSORIES, LIMB_STYLES, FEET, RANGES, MAX_ACCESSORIES,
} from './schema.js';
export { analyzeCreature } from './analyze.js';
export { meshReport } from './solids.js';
