// Honest per-zone "suited for" metadata. Levels come only from measured,
// deterministic headless rollouts (qa/world-park-validation.mjs writes
// capability-map.json); a creature without measurements is "untested".
import map from './capability-map.json';

export const LEVELS = {
  great: { color: '#2f9e6e', label: 'Great', chip: s => `Great for ${s}` },
  ok: { color: '#c98a1f', label: 'Partly', chip: s => `Partly OK for ${s}` },
  hard: { color: '#cf5a4f', label: 'Too tough', chip: s => `Too tough for ${s}` },
  'needs-jump': { color: '#8a6fd6', label: 'Needs jump', chip: () => 'Needs a jump skill' },
  untested: { color: '#8b8b85', label: 'Untested', chip: s => `Untested for ${s}` },
};

export function capabilityFor(kind, layoutId = 'park') {
  if (map?.layout !== layoutId) return null;
  return map.pilots?.[kind] ?? null;
}

// zone id -> { level, note, lanes, measured }
export function zoneSuitability(kind, layout, { skills = [] } = {}) {
  const measured = capabilityFor(kind, layout.id);
  const out = {};
  for (const z of layout.zones) {
    const m = measured?.zones?.[z.id];
    if (m) out[z.id] = { level: m.level, note: m.note, lanes: m.lanes ?? [], measured: true };
    else if (z.id === 'jump' && !skills.includes('jump')) out[z.id] = { level: 'needs-jump', note: 'Stones, gap and hoops are built for a trained jump skill.', lanes: [], measured: false };
    else out[z.id] = { level: 'untested', note: 'No measured rollouts for this creature in this zone yet.', lanes: [], measured: false };
  }
  return out;
}

export function signChips(suitability, shortName) {
  return Object.fromEntries(Object.entries(suitability).map(([zone, s]) => {
    const level = LEVELS[s.level] ?? LEVELS.untested;
    return [zone, { text: level.chip(shortName), color: level.color }];
  }));
}

export const capabilityMeta = { generatedAt: map?.generatedAt ?? null, source: map?.source ?? null, method: map?.method ?? null };
