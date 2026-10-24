// LookPanel: dress up (creature-look/1). Paint and parts only: a look never
// changes masses, collisions or the compiled model, so trained skills stay
// valid. Presets on top, then palette, finish, pattern, shell, face,
// accessories, limbs, and the printable shell kit.
import { useId, useState } from "react";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { Button, Segmented, Slider, Swatch, Switch, cx } from "./primitives.jsx";
import { rovingKeyDown } from "./hooks.js";

// Mirrors contracts/look.schema.json as extended by the look agent
// (appearance/schema.js exports the same lists; pass them via `options`
// to stay in lockstep). Unknown values are simply not offered.
export const LOOK_OPTIONS = {
  finish: ["matte", "satin", "gloss", "metal", "toon", "glow"],
  pattern: ["none", "spots", "dots", "stripes", "bands", "gradient", "checker", "camo", "panels", "cracks", "scales", "hex"],
  patternTarget: ["auto", "body", "shell", "limbs", "all"],
  shell: ["none", "dome", "beetle", "turtle", "petals", "armor", "fluffy", "saddle"],
  eyes: ["none", "round", "cute", "visor", "cyclops", "sleepy", "compound"],
  head: ["none", "round", "boxy", "snout"],
  mouth: ["none", "smile", "grin", "beak", "fangs", "whiskers", "grill"],
  markings: ["none", "patches", "mask"],
  accessories: ["antennae", "horns", "ears", "tail", "spikes", "fin", "wings", "crown", "hat", "bow", "flower", "propeller", "backpack", "sprout", "mushroom", "halo", "goggles", "scarf"],
  limbStyle: ["classic", "sleek", "chunky", "bones"],
  feet: ["ball", "paw", "hoof", "pad"],
  maxAccessories: 6,
};

export const TOY_COLORS = ["#e23b2e", "#ff8a3d", "#ffc63a", "#43b05c", "#1f8c80", "#49b6f0", "#1e4e95", "#7b5cf5", "#ff6f95", "#fffcf5", "#8a91ad", "#2b2d3a"];

const SLOTS = [
  { key: "body", label: "Body" },
  { key: "limbs", label: "Legs" },
  { key: "joints", label: "Joints" },
  { key: "accent", label: "Accent" },
  { key: "feet", label: "Feet" },
  { key: "caps", label: "Caps" },
];

const NAMES = {
  matte: "Matte", satin: "Satin", gloss: "Gloss", metal: "Metal", toon: "Toon", glow: "Glow",
  none: "None", spots: "Spots", dots: "Dots", stripes: "Stripes", bands: "Bands", gradient: "Fade", checker: "Checks", camo: "Camo", panels: "Panels", cracks: "Cracks", scales: "Scales", hex: "Honeycomb",
  auto: "Auto", body: "Body", shell: "Shell", limbs: "Legs", all: "All over",
  dome: "Dome", beetle: "Beetle", turtle: "Turtle", petals: "Petals", armor: "Armor", fluffy: "Fluffy", saddle: "Saddle",
  round: "Round", cute: "Cute", visor: "Visor", cyclops: "Cyclops", sleepy: "Sleepy", compound: "Bug eyes",
  boxy: "Boxy", snout: "Snout", smile: "Smile", grin: "Grin", beak: "Beak", fangs: "Fangs", whiskers: "Whiskers", grill: "Grill", patches: "Patches", mask: "Mask",
  antennae: "Antennae", horns: "Horns", ears: "Ears", tail: "Tail", spikes: "Spikes", fin: "Fin", wings: "Wings", crown: "Crown", hat: "Hat", bow: "Bow", flower: "Flower", propeller: "Propeller", backpack: "Backpack", sprout: "Sprout", mushroom: "Mushroom", halo: "Halo", goggles: "Goggles", scarf: "Scarf",
  classic: "Classic", sleek: "Sleek", chunky: "Chunky", bones: "Bones", ball: "Ball", paw: "Paw", hoof: "Hoof", pad: "Pad",
};
export const optionName = value => NAMES[value] || String(value || "").replace(/^\w/, c => c.toUpperCase());

const DEFAULT_LOOK = {
  schema: "creature-look/1",
  palette: { body: "#1f8c80", limbs: "#d9e8e2", joints: "#2a3354", accent: "#ffc63a", feet: "#2a3354" },
  finish: "satin",
  pattern: { kind: "none", color: "#ffc63a", scale: 1, target: "auto" },
  shell: { kind: "none", color: "#ffc63a", size: 1 },
  face: { eyes: "round", eyeColor: "#1c2440", size: 1, head: "none", mouth: "none", cheeks: false, markings: "none" },
  accessories: [],
  limbs: { style: "classic", feet: "ball" },
};

/** Fill missing fields so the controls always have a value (does not mutate). */
export function lookWithDefaults(look) {
  const l = look && typeof look === "object" ? look : {};
  return {
    ...DEFAULT_LOOK,
    ...l,
    schema: "creature-look/1",
    palette: { ...DEFAULT_LOOK.palette, ...(l.palette || {}) },
    pattern: { ...DEFAULT_LOOK.pattern, ...(l.pattern || {}) },
    shell: { ...DEFAULT_LOOK.shell, ...(l.shell || {}) },
    face: { ...DEFAULT_LOOK.face, ...(l.face || {}) },
    accessories: Array.isArray(l.accessories) ? l.accessories.slice(0, LOOK_OPTIONS.maxAccessories) : [],
    limbs: { ...DEFAULT_LOOK.limbs, ...(l.limbs || {}) },
  };
}

/* ---------- small option illustrations (24×24) ---------- */
const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
const SHELL_ART = {
  none: <path d="M5 19 19 5M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z" {...S} />,
  dome: <><path d="M4 17h16" {...S} /><path d="M5 17C5 9 19 9 19 17" {...S} fill="currentColor" fillOpacity=".25" /></>,
  beetle: <><path d="M4 17h16" {...S} /><path d="M5 17C5 8.5 19 8.5 19 17" {...S} fill="currentColor" fillOpacity=".25" /><path d="M12 10.6V17" {...S} /></>,
  turtle: <><path d="M4 17h16" {...S} /><path d="M5 17C5 9 19 9 19 17" {...S} fill="currentColor" fillOpacity=".25" /><path d="m9 17 1.2-4h3.6l1.2 4" {...S} /></>,
  petals: <><path d="M4 17h16" {...S} /><path d="M4.5 17c0-4 3.5-4 3.5 0 0-4.5 4-4.5 4 0 0-4.5 4-4.5 4 0 0-4 3.5-4 3.5 0" {...S} fill="currentColor" fillOpacity=".25" /></>,
  armor: <><path d="M4 17h16" {...S} /><rect x="4.5" y="11" width="5" height="6" rx="1" {...S} /><rect x="9.5" y="10" width="5" height="7" rx="1" {...S} fill="currentColor" fillOpacity=".25" /><rect x="14.5" y="11" width="5" height="6" rx="1" {...S} /></>,
  fluffy: <><path d="M4 17h16" {...S} /><path d="M5 17a2.6 2.6 0 0 1 2-4.6 3 3 0 0 1 5-1.6 3 3 0 0 1 5 1.6 2.6 2.6 0 0 1 2 4.6" {...S} fill="currentColor" fillOpacity=".25" /></>,
  saddle: <><path d="M4 17h16" {...S} /><rect x="8" y="12.5" width="8" height="4.5" rx="1.5" {...S} fill="currentColor" fillOpacity=".25" /></>,
};
const EYES_ART = {
  none: <path d="M5 19 19 5M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z" {...S} />,
  round: <><circle cx="8" cy="12" r="3.6" {...S} /><circle cx="16" cy="12" r="3.6" {...S} /><circle cx="8.6" cy="12" r="1.4" fill="currentColor" /><circle cx="16.6" cy="12" r="1.4" fill="currentColor" /></>,
  cute: <><circle cx="8" cy="12" r="3.8" fill="currentColor" /><circle cx="16" cy="12" r="3.8" fill="currentColor" /><circle cx="9.2" cy="10.6" r="1.2" fill="#fffcf5" /><circle cx="17.2" cy="10.6" r="1.2" fill="#fffcf5" /></>,
  visor: <rect x="3.5" y="9" width="17" height="6" rx="3" {...S} fill="currentColor" fillOpacity=".35" />,
  cyclops: <><circle cx="12" cy="12" r="6" {...S} /><circle cx="12.8" cy="12" r="2.6" fill="currentColor" /></>,
  sleepy: <path d="M4.5 12.5c1.5 2 4.5 2 6 0M13.5 12.5c1.5 2 4.5 2 6 0" {...S} />,
  compound: <g fill="currentColor"><circle cx="6.5" cy="10.5" r="2" /><circle cx="9.5" cy="13.5" r="2" /><circle cx="5.8" cy="14.6" r="1.6" /><circle cx="17.5" cy="10.5" r="2" /><circle cx="14.5" cy="13.5" r="2" /><circle cx="18.2" cy="14.6" r="1.6" /></g>,
};
const ACC_ART = {
  antennae: <><path d="M9 20c0-5-2-9-4-12M15 20c0-5 2-9 4-12" {...S} /><circle cx="5" cy="6.5" r="1.8" fill="currentColor" /><circle cx="19" cy="6.5" r="1.8" fill="currentColor" /></>,
  horns: <path d="M7 19c-2-5-1-10 2-13 0 4 1 8 3 13M17 19c2-5 1-10-2-13 0 4-1 8-3 13" {...S} />,
  ears: <path d="M4 19 7 6l5 13M12 19l5-13 3 13" {...S} />,
  tail: <path d="M4 17c4 0 6-2 7-5s4-6 9-5" {...S} />,
  spikes: <path d="M3 18 6 10l3 8 3-8 3 8 3-8 3 8" {...S} />,
  fin: <path d="M4 19c3-1 4-9 13-13-2 5-3 9-1 13H4Z" {...S} />,
  wings: <><path d="M12 13C9 6 3 5 3 9s5 6 9 4Z" {...S} /><path d="M12 13c3-7 9-8 9-4s-5 6-9 4Z" {...S} /></>,
  crown: <path d="M4 18V8l4 4 4-6 4 6 4-4v10H4Z" {...S} />,
  hat: <><path d="M3.5 17.5h17" {...S} /><rect x="7" y="6" width="10" height="11.5" rx="1.5" {...S} /></>,
  bow: <><path d="M12 12 4 7v10l8-5Zm0 0 8-5v10l-8-5Z" {...S} /><circle cx="12" cy="12" r="1.6" fill="currentColor" /></>,
  flower: <><circle cx="12" cy="7" r="2.6" {...S} /><circle cx="7.2" cy="10.5" r="2.6" {...S} /><circle cx="16.8" cy="10.5" r="2.6" {...S} /><circle cx="9" cy="16" r="2.6" {...S} /><circle cx="15" cy="16" r="2.6" {...S} /><circle cx="12" cy="11.5" r="1.8" fill="currentColor" /></>,
  propeller: <><path d="M12 13v7" {...S} /><ellipse cx="7" cy="9" rx="5" ry="2" {...S} /><ellipse cx="17" cy="9" rx="5" ry="2" {...S} /><circle cx="12" cy="9" r="1.4" fill="currentColor" /></>,
  backpack: <><rect x="6" y="7" width="12" height="13" rx="3" {...S} /><path d="M9 7V5.5a3 3 0 0 1 6 0V7M9 13h6" {...S} /></>,
  sprout: <><path d="M12 20v-8" {...S} /><path d="M12 12C12 8 9 6 5 6c0 4 3 6 7 6ZM12 12c0-3 2.5-5.5 6.5-5.5 0 3.5-2.5 5.5-6.5 5.5Z" {...S} fill="currentColor" fillOpacity=".25" /></>,
  mushroom: <><path d="M4 12a8 7 0 0 1 16 0H4Z" {...S} fill="currentColor" fillOpacity=".25" /><path d="M9 12v6a3 3 0 0 0 6 0v-6" {...S} /><circle cx="9" cy="8.5" r="1.2" fill="currentColor" /><circle cx="14.5" cy="7.5" r="1.2" fill="currentColor" /></>,
  halo: <><ellipse cx="12" cy="8" rx="8" ry="3" {...S} /><path d="M7 17c1.5 2 8.5 2 10 0" {...S} /></>,
  goggles: <><circle cx="7.5" cy="12" r="4" {...S} /><circle cx="16.5" cy="12" r="4" {...S} /><path d="M11.5 12h1M2 11h1.5M20.5 11H22" {...S} /></>,
  scarf: <><path d="M4 9c5 3 11 3 16 0v4c-5 3-11 3-16 0V9Z" {...S} fill="currentColor" fillOpacity=".25" /><path d="M15 14l1 7 3-1-1-6.5" {...S} /></>,
};
const HEAD_ART = {
  none: SHELL_ART.none,
  round: <><circle cx="12" cy="11" r="7" {...S} /><circle cx="9.5" cy="10.5" r="1.3" fill="currentColor" /><circle cx="14.5" cy="10.5" r="1.3" fill="currentColor" /></>,
  boxy: <><rect x="5" y="5" width="14" height="12" rx="2.5" {...S} /><rect x="8" y="8.5" width="8" height="3.5" rx="1.5" fill="currentColor" /><path d="M12 5V2.5" {...S} /></>,
  snout: <><circle cx="10" cy="11" r="6.5" {...S} /><path d="M14 10.5h4.5a2.5 2.5 0 0 1 0 5H14" {...S} /><circle cx="19" cy="12.4" r="1" fill="currentColor" /><circle cx="9" cy="9.5" r="1.2" fill="currentColor" /></>,
};
const MOUTH_ART = {
  none: SHELL_ART.none,
  smile: <path d="M6 11c3 4.5 9 4.5 12 0" {...S} />,
  grin: <><path d="M5 10h14c0 5-3.5 7-7 7s-7-2-7-7Z" {...S} /><path d="M8 10v2.5M12 10v3M16 10v2.5" {...S} /></>,
  beak: <path d="M5 9h10l5 3-5 3H5l3-3-3-3Z" {...S} fill="currentColor" fillOpacity=".25" />,
  fangs: <><path d="M5 10c3 3 11 3 14 0" {...S} /><path d="M8.5 11.5 9.5 15l1-3.3M15.5 11.5 14.5 15l-1-3.3" {...S} /></>,
  whiskers: <><circle cx="12" cy="11" r="1.6" fill="currentColor" /><path d="M10 12 3 10M10 13l-7 2M14 12l7-2M14 13l7 2" {...S} /></>,
  grill: <><rect x="5" y="8" width="14" height="8" rx="2" {...S} /><path d="M9 8v8M12 8v8M15 8v8" {...S} /></>,
};

function Art({ children }) {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** A grid of square picture tiles behaving like a radio group (or toggles). */
function TileGroup({ label, options, value, onChange, render, multiple = false, max, className }) {
  const name = useId();
  const selected = new Set(multiple ? value : [value]);
  return (
    <div className={cx("cl-tiles", className)} role={multiple ? "group" : "radiogroup"} aria-label={label}>
      {options.map(option => {
        const on = selected.has(option);
        const full = multiple && !on && max && selected.size >= max;
        return (
          <label key={option} className={cx("cl-tile", on && "is-on", full && "is-full")} title={full ? `Up to ${max}. Remove one first.` : undefined}>
            <input
              type={multiple ? "checkbox" : "radio"}
              name={name}
              checked={on}
              disabled={full}
              onChange={() => onChange(option)}
            />
            <span className="cl-tile__face">
              {render(option)}
              <span className="cl-tile__label">{optionName(option)}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ColorRow({ label, value, onChange }) {
  const id = useId();
  return (
    <div className="cl-colorrow" role="group" aria-label={label}>
      {TOY_COLORS.map(color => (
        <Swatch key={color} color={color} label={`${label}: ${color}`} selected={value?.toLowerCase() === color} onClick={() => onChange(color)} />
      ))}
      <label className="cl-colorrow__custom" htmlFor={id} title="Pick any color">
        <input id={id} type="color" value={value || "#000000"} onChange={event => onChange(event.target.value)} aria-label={`${label}: custom color`} />
        <Icon name="plus" size={16} strokeWidth={2.6} />
      </label>
    </div>
  );
}

function Group({ title, icon, open = false, children, summary }) {
  return (
    <details className="cl-lookgroup" open={open}>
      <summary>
        <span className="cl-section-title">
          <Icon name={icon} />
          {title}
        </span>
        {summary && <span className="cl-lookgroup__summary">{summary}</span>}
        <Icon name="chevron-down" size={18} className="cl-lookgroup__chev" />
      </summary>
      <div className="cl-lookgroup__body">{children}</div>
    </details>
  );
}

/**
 * LookPanel props:
 *  look (creature-look/1), onChange(nextLook)
 *  presets: [{ id, name | label, look, blurb? }] (appearance LOOK_PRESETS work as-is),
 *  presetId, onPreset(id, look)
 *  design: for preview thumbnails
 *  options: override LOOK_OPTIONS lists (e.g. from appearance/schema.js)
 *  onExportPrintKit(), exportState: "idle" | "working" | "done" | "error", exportNote
 *  onAskTinker(text): optional suggestion chips ("Make it a ladybug")
 */
export function LookPanel({ look: rawLook, onChange, presets = [], presetId, onPreset, design, options, onExportPrintKit, exportState = "idle", exportNote, onAskTinker }) {
  const opt = { ...LOOK_OPTIONS, ...(options || {}) };
  const max = opt.maxAccessories || 6;
  const look = lookWithDefaults(rawLook);
  const [slot, setSlot] = useState("body");
  const set = patch => onChange?.({ ...look, ...patch });
  const setFace = patch => set({ face: { ...look.face, ...patch } });
  const accKinds = look.accessories.map(a => a.kind);
  const slotColor = key => (key === "caps" ? look.palette.caps || look.palette.accent : look.palette[key]);

  function toggleAccessory(kind) {
    const has = accKinds.includes(kind);
    if (has) set({ accessories: look.accessories.filter(a => a.kind !== kind) });
    else if (look.accessories.length < max) set({ accessories: [...look.accessories, { kind, color: look.palette.accent, size: 1 }] });
  }

  return (
    <div className="cl-look">
      <p className="cl-look__promise">
        <Icon name="palette" size={18} />
        <span>Paint and parts only. Its body, motors and skills stay exactly the same.</span>
      </p>

      {presets.length > 0 && (
        <section className="cl-look__presets" aria-label="Ready-made looks">
          <div
            className="cl-presets"
            role="radiogroup"
            aria-label="Ready-made looks"
            onKeyDown={event => {
              const next = rovingKeyDown(event, { selector: '[role="radio"]' });
              const preset = next && presets.find(p => p.id === next.dataset.id);
              if (preset) onPreset?.(preset.id, preset.look);
            }}
          >
            {presets.map((preset, index) => {
              const on = preset.id === presetId;
              const stop = on || (!presets.some(p => p.id === presetId) && index === 0);
              const name = preset.name || preset.label || preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  data-id={preset.id}
                  aria-checked={on}
                  tabIndex={stop ? 0 : -1}
                  title={preset.blurb}
                  className={cx("cl-preset", on && "is-on")}
                  onClick={() => onPreset?.(preset.id, preset.look)}
                >
                  <span className="cl-preset__art">
                    <CreatureGlyph design={design} look={preset.look} />
                  </span>
                  <span className="cl-preset__name">{name}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {onAskTinker && (
        <div className="cl-look__ask">
          {["Make it a ladybug", "Surprise me", "Shiny robot chrome"].map(text => (
            <button key={text} type="button" className="cl-chip" onClick={() => onAskTinker(text)}>
              <Icon name="wand" size={16} />
              <span>{text}</span>
            </button>
          ))}
        </div>
      )}

      <Group title="Colors and finish" icon="palette" open summary={<span className="cl-look__dots">{SLOTS.slice(0, 5).map(s => <i key={s.key} style={{ background: slotColor(s.key) }} />)}</span>}>
        <div
          className="cl-slots"
          role="radiogroup"
          aria-label="Color slot"
          onKeyDown={event => {
            const next = rovingKeyDown(event, { selector: '[role="radio"]' });
            if (next) setSlot(next.dataset.slot);
          }}
        >
          {SLOTS.map(s => (
            <button key={s.key} type="button" role="radio" data-slot={s.key} aria-checked={slot === s.key} tabIndex={slot === s.key ? 0 : -1} className={cx("cl-slot", slot === s.key && "is-on")} onClick={() => setSlot(s.key)}>
              <span className="cl-slot__chip" style={{ background: slotColor(s.key) }} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <ColorRow label={`${SLOTS.find(s => s.key === slot)?.label} color`} value={slotColor(slot)} onChange={color => set({ palette: { ...look.palette, [slot]: color } })} />
        {slot === "caps" && !look.palette.caps && <p className="cl-hint">Motor caps follow the accent color until you pick one.</p>}
        <div className="cl-look__field">
          <span className="cl-tweaks__group-label">Finish</span>
          <TileGroup label="Finish" options={opt.finish} value={look.finish} onChange={finish => set({ finish })} className="cl-tiles--finish" render={kind => <span className={`cl-finish cl-finish--${kind}`} style={{ "--fc": look.palette.body }} />} />
        </div>
      </Group>

      <Group title="Pattern" icon="grid" summary={optionName(look.pattern.kind)}>
        <TileGroup label="Pattern" options={opt.pattern} value={look.pattern.kind} onChange={kind => set({ pattern: { ...look.pattern, kind } })} render={kind => <span className={`cl-pattern cl-pattern--${kind}`} style={{ "--pb": look.palette.body, "--pc": look.pattern.color }} />} />
        {look.pattern.kind !== "none" && (
          <>
            <ColorRow label="Pattern color" value={look.pattern.color} onChange={color => set({ pattern: { ...look.pattern, color } })} />
            <Slider label="Pattern size" value={look.pattern.scale} min={0.5} max={2} step={0.05} format={v => `${v.toFixed(2)}×`} onChange={scale => set({ pattern: { ...look.pattern, scale } })} />
            {opt.patternTarget?.length > 0 && (
              <div className="cl-look__field">
                <span className="cl-tweaks__group-label">Where</span>
                <Segmented label="Pattern goes on" value={look.pattern.target || "auto"} onChange={target => set({ pattern: { ...look.pattern, target } })} options={opt.patternTarget.map(v => ({ value: v, label: optionName(v) }))} size="sm" block />
              </div>
            )}
          </>
        )}
      </Group>

      <Group title="Shell" icon="sparkle" summary={optionName(look.shell.kind)}>
        <TileGroup label="Shell" options={opt.shell} value={look.shell.kind} onChange={kind => set({ shell: { ...look.shell, kind } })} render={kind => <Art>{SHELL_ART[kind]}</Art>} />
        {look.shell.kind !== "none" && (
          <>
            <ColorRow label="Shell color" value={look.shell.color} onChange={color => set({ shell: { ...look.shell, color } })} />
            <Slider label="Shell size" value={look.shell.size} min={0.8} max={1.3} step={0.01} format={v => `${Math.round(v * 100)}%`} onChange={size => set({ shell: { ...look.shell, size } })} />
          </>
        )}
      </Group>

      <Group title="Face" icon="eye" summary={`${optionName(look.face.eyes)} eyes${look.face.head && look.face.head !== "none" ? `, ${optionName(look.face.head).toLowerCase()} head` : ""}`}>
        {opt.head?.length > 0 && (
          <>
            <span className="cl-tweaks__group-label">Head</span>
            <TileGroup label="Head" options={opt.head} value={look.face.head || "none"} onChange={head => setFace({ head })} render={kind => <Art>{HEAD_ART[kind] || HEAD_ART.none}</Art>} />
          </>
        )}
        <span className="cl-tweaks__group-label">Eyes</span>
        <TileGroup label="Eyes" options={opt.eyes} value={look.face.eyes} onChange={eyes => setFace({ eyes })} render={kind => <Art>{EYES_ART[kind]}</Art>} />
        {look.face.eyes !== "none" && (
          <>
            <ColorRow label="Eye color" value={look.face.eyeColor} onChange={eyeColor => setFace({ eyeColor })} />
            <Slider label="Eye size" value={look.face.size ?? 1} min={0.7} max={1.4} step={0.05} format={v => `${Math.round(v * 100)}%`} onChange={size => setFace({ size })} />
          </>
        )}
        {opt.mouth?.length > 0 && (
          <>
            <span className="cl-tweaks__group-label">Mouth</span>
            <TileGroup label="Mouth" options={opt.mouth} value={look.face.mouth || "none"} onChange={mouth => setFace({ mouth })} render={kind => <Art>{MOUTH_ART[kind] || MOUTH_ART.none}</Art>} />
          </>
        )}
        {opt.markings?.length > 0 && (
          <div className="cl-look__field">
            <span className="cl-tweaks__group-label">Markings</span>
            <Segmented label="Markings" value={look.face.markings || "none"} onChange={markings => setFace({ markings })} options={opt.markings.map(v => ({ value: v, label: optionName(v) }))} size="sm" block />
          </div>
        )}
        <Switch label="Rosy cheeks" checked={!!look.face.cheeks} onChange={cheeks => setFace({ cheeks })} />
      </Group>

      <Group title="Accessories" icon="star" summary={`${look.accessories.length} of ${max}`}>
        <TileGroup label={`Accessories, up to ${max}`} options={opt.accessories} value={accKinds} multiple max={max} onChange={toggleAccessory} render={kind => <Art>{ACC_ART[kind] || ACC_ART.flower}</Art>} className="cl-tiles--acc" />
        <p className="cl-hint">{look.accessories.length >= max ? `That's the max of ${max}. Remove one to add another.` : `Pick up to ${max}. ${max - look.accessories.length} left.`}</p>
      </Group>

      <Group title="Legs and feet" icon="leg" summary={`${optionName(look.limbs.style)}, ${optionName(look.limbs.feet).toLowerCase()} feet`}>
        <Segmented label="Leg style" value={look.limbs.style} onChange={style => set({ limbs: { ...look.limbs, style } })} options={opt.limbStyle.map(v => ({ value: v, label: optionName(v) }))} block />
        <Segmented label="Feet" value={look.limbs.feet} onChange={feet => set({ limbs: { ...look.limbs, feet } })} options={opt.feet.map(v => ({ value: v, label: optionName(v) }))} block />
        <p className="cl-hint">Leg covers are cosmetic. The collision shapes Draft generated don't change.</p>
      </Group>

      {onExportPrintKit && (
        <section className="cl-printkit" aria-label="Print kit">
          <span className="cl-printkit__icon" aria-hidden="true">
            <Icon name="printer" size={26} />
          </span>
          <div className="cl-printkit__text">
            <h3 className="cl-section-title">Print kit</h3>
            <p className="cl-hint">{exportNote || "Download the decorative shell as STL files for a 3D printer. The robot's frame and motors aren't included."}</p>
          </div>
          <Button variant="primary" size="sm" icon={exportState === "done" ? "check" : "download"} busy={exportState === "working"} disabled={exportState === "working"} onClick={onExportPrintKit}>
            {exportState === "working" ? "Preparing" : exportState === "done" ? "Downloaded" : "Export STL"}
          </Button>
          {exportState === "error" && (
            <p className="cl-printkit__error" role="alert">
              Couldn't build the print kit. Try again after the model finishes loading.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

export default LookPanel;
