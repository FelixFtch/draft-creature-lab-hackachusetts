// Recipes describe a creature without its generated files: where its body
// comes from (a Draft preset at a scale, or a Tinker design), how it looks and
// how it was posed. Schema 1 recipes from the first release still import.
export const LEGACY_PRESETS = ['cheetah', 'bear', 'giraffe', 'flower'];
export const RECIPE_SCHEMA = 2;
const MAX_RECIPE_TEXT = 32768;
const FAMILY_KEY = 'draft-creature-lab-family-v2';
const LEGACY_FAMILY_KEY = 'draft-creature-lab-remixes-v1';
const HEX = /^#[0-9a-f]{6}$/i;

const finiteIn = (value, lo, hi) => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clip = (text, max) => (typeof text === 'string' ? text.slice(0, max) : '');

export function classicLook(color = '#1f8c80') {
  return { schema: 'creature-look/1', theme: 'classic', palette: { body: HEX.test(color) ? color.toLowerCase() : '#1f8c80' } };
}

function normalizePose(pose) {
  const value = plainObject(pose) ? pose : {};
  return { crouch: finiteIn(value.crouch, 0, 1) ? value.crouch : 0, wave: finiteIn(value.wave, 0, 1) ? value.wave : 0 };
}

function normalizeSource(source) {
  if (!plainObject(source)) throw Error('badRecipe');
  if (source.kind === 'preset') {
    if (!LEGACY_PRESETS.includes(source.preset) || !finiteIn(source.lengthScale, .8, 1.2) || !finiteIn(source.legScale, .8, 1.2)) throw Error('badRecipe');
    return { kind: 'preset', preset: source.preset, lengthScale: source.lengthScale, legScale: source.legScale };
  }
  if (source.kind === 'design') {
    // Deep validation happens in draft-service before anything is generated.
    if (!plainObject(source.design) || source.design.schema !== 'creature-design/1') throw Error('badRecipe');
    const bodyId = typeof source.bodyId === 'string' && /^[a-z]+-[a-f0-9]{16}$/.test(source.bodyId) ? source.bodyId : null;
    return { kind: 'design', design: source.design, bodyId };
  }
  throw Error('badRecipe');
}

// Accepts schema 1 ({preset, lengthScale, legScale, color, pose}) and schema 2.
export function normalizeRecipe(value) {
  if (!plainObject(value)) throw Error('badRecipe');
  if (value.schema === 1) {
    if (!HEX.test(value.color || '')) throw Error('badRecipe');
    return {
      schema: RECIPE_SCHEMA, name: '',
      source: normalizeSource({ kind: 'preset', preset: value.preset, lengthScale: value.lengthScale, legScale: value.legScale }),
      look: classicLook(value.color), pose: normalizePose(value.pose),
    };
  }
  if (value.schema !== RECIPE_SCHEMA) throw Error('badRecipe');
  const look = plainObject(value.look) && value.look.schema === 'creature-look/1' ? value.look : classicLook();
  return { schema: RECIPE_SCHEMA, name: clip(value.name, 40), source: normalizeSource(value.source), look, pose: normalizePose(value.pose) };
}

export function parseRecipe(text) {
  if (typeof text !== 'string' || text.length > MAX_RECIPE_TEXT) throw Error('badRecipe');
  try { return normalizeRecipe(JSON.parse(text)); } catch { throw Error('badRecipe'); }
}

export function recipeFromHash(hash = location.hash) {
  if (!hash || !hash.startsWith('#recipe=')) return null;
  if (hash.length > MAX_RECIPE_TEXT * 3) throw Error('badRecipe');
  return parseRecipe(new URLSearchParams(hash.slice(1)).get('recipe'));
}

export function recipeLink(recipe, href = location.href) {
  const url = new URL(href);
  url.hash = `recipe=${encodeURIComponent(JSON.stringify(normalizeRecipe(recipe)))}`;
  return url.href;
}

export function recipeTitle(recipe) {
  if (recipe.name) return recipe.name;
  if (recipe.source.kind === 'design') return recipe.source.design.name || 'Creature';
  return recipe.source.preset[0].toUpperCase() + recipe.source.preset.slice(1);
}

// The family is a small local history of saved creatures with lineage. It is
// best-effort browser storage: every access is guarded, and failure is not fatal.
const ID = /^remix-[a-z0-9-]{1,80}$/i;
export function readFamily() {
  try {
    const raw = localStorage.getItem(FAMILY_KEY) ?? localStorage.getItem(LEGACY_FAMILY_KEY);
    if (!raw || raw.length > 400000) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    return items.slice(0, 48).flatMap(item => {
      try {
        if (!ID.test(item.id || '')) return [];
        return [{ id: item.id, parentId: ID.test(item.parentId || '') ? item.parentId : null,
          createdAt: clip(item.createdAt, 40), recipe: normalizeRecipe(item.recipe) }];
      } catch { return []; }
    });
  } catch { return []; }
}

export function saveToFamily(family, recipe, parentId = null) {
  const id = `remix-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`}`;
  const entry = { id, parentId: ID.test(parentId || '') ? parentId : null, createdAt: new Date().toISOString(), recipe: normalizeRecipe(recipe) };
  const next = [entry, ...family].slice(0, 48);
  localStorage.setItem(FAMILY_KEY, JSON.stringify(next)); // throws when storage is unavailable; caller reports it
  return { entry, family: next };
}

export function downloadRecipe(recipe) {
  const normalized = normalizeRecipe(recipe);
  const blob = new Blob([JSON.stringify(normalized, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  const slug = recipeTitle(normalized).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'creature';
  link.href = url; link.download = `${slug}-recipe.json`;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
