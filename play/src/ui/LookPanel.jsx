// LookPanel: dress up (creature-look/1). Paint and parts only: a look never
// changes masses, collisions or the compiled model, so trained skills stay
// valid. Presets on top, then palette, finish, pattern, shell, face,
// accessories, limbs, and the printable shell kit.
import { useId, useState } from "react";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { Button, Segmented, Slider, Swatch, cx } from "./primitives.jsx";
import { rovingKeyDown } from "./hooks.js";

export const LOOK_OPTIONS = {
  finish: ["matte", "satin", "gloss", "metal", "toon", "glow"],
  pattern: ["none", "spots", "stripes", "bands", "gradient", "checker", "camo", "panels"],
  shell: ["none", "dome", "beetle", "turtle", "petals", "armor", "fluffy", "saddle"],
  eyes: ["none", "round", "cute", "visor", "cyclops", "sleepy", "compound"],
  accessories: ["antennae", "horns", "ears", "tail", "spikes", "fin", "wings", "crown", "hat", "bow", "flower", "propeller", "backpack"],
  limbStyle: ["classic", "sleek", "chunky", "bones"],
  feet: ["ball", "paw", "hoof", "pad"],
};

export const TOY_COLORS = ["#e23b2e", "#ff8a3d", "#ffc63a", "#43b05c", "#1f8c80", "#49b6f0", "#1e4e95", "#7b5cf5", "#ff6f95", "#fffcf5", "#8a91ad", "#2b2d3a"];

const SLOTS = [
  { key: "body", label: "Body" },
  { key: "limbs", label: "Legs" },
  { key: "joints", label: "Joints" },
  { key: "accent", label: "Accent" },
  { key: "feet", label: "Feet" },
];

const NAMES = {
  matte: "Matte", satin: "Satin", gloss: "Gloss", metal: "Metal", toon: "Toon", glow: "Glow",
  none: "None", spots: "Spots", stripes: "Stripes", bands: "Bands", gradient: "Fade", checker: "Checks", camo: "Camo", panels: "Panels",
  dome: "Dome", beetle: "Beetle", turtle: "Turtle", petals: "Petals", armor: "Armor", fluffy: "Fluffy", saddle: "Saddle",
  round: "Round", cute: "Cute", visor: "Visor", cyclops: "Cyclops", sleepy: "Sleepy", compound: "Bug eyes",
  antennae: "Antennae", horns: "Horns", ears: "Ears", tail: "Tail", spikes: "Spikes", fin: "Fin", wings: "Wings", crown: "Crown", hat: "Hat", bow: "Bow", flower: "Flower", propeller: "Propeller", backpack: "Backpack",
  classic: "Classic", sleek: "Sleek", chunky: "Chunky", bones: "Bones", ball: "Ball", paw: "Paw", hoof: "Hoof", pad: "Pad",
};
export const optionName = value => NAMES[value] || value;

const DEFAULT_LOOK = {
  schema: "creature-look/1",
  palette: { body: "#1f8c80", limbs: "#d9e8e2", joints: "#2a3354", accent: "#ffc63a", feet: "#2a3354" },
  finish: "satin",
  pattern: { kind: "none", color: "#ffc63a", scale: 1 },
  shell: { kind: "none", color: "#ffc63a", size: 1 },
  face: { eyes: "round", eyeColor: "#1c2440" },
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
    accessories: Array.isArray(l.accessories) ? l.accessories.slice(0, 4) : [],
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
 *  presets: [{ id, name, look }], presetId, onPreset(id, look)
 *  design: for preview thumbnails
 *  onExportPrintKit(), exportState: "idle" | "working" | "done" | "error", exportNote
 *  onAskTinker(text): optional suggestion chips ("Make it a ladybug")
 */
export function LookPanel({ look: rawLook, onChange, presets = [], presetId, onPreset, design, onExportPrintKit, exportState = "idle", exportNote, onAskTinker }) {
  const look = lookWithDefaults(rawLook);
  const [slot, setSlot] = useState("body");
  const set = patch => onChange?.({ ...look, ...patch });
  const accKinds = look.accessories.map(a => a.kind);

  function toggleAccessory(kind) {
    const has = accKinds.includes(kind);
    if (has) set({ accessories: look.accessories.filter(a => a.kind !== kind) });
    else if (look.accessories.length < 4) set({ accessories: [...look.accessories, { kind, color: look.palette.accent, size: 1 }] });
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
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  data-id={preset.id}
                  aria-checked={on}
                  tabIndex={stop ? 0 : -1}
                  className={cx("cl-preset", on && "is-on")}
                  onClick={() => onPreset?.(preset.id, preset.look)}
                >
                  <span className="cl-preset__art">
                    <CreatureGlyph design={design} look={preset.look} />
                  </span>
                  <span className="cl-preset__name">{preset.name}</span>
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

      <Group title="Colors and finish" icon="palette" open summary={<span className="cl-look__dots">{SLOTS.map(s => <i key={s.key} style={{ background: look.palette[s.key] }} />)}</span>}>
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
              <span className="cl-slot__chip" style={{ background: look.palette[s.key] }} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <ColorRow label={`${SLOTS.find(s => s.key === slot)?.label} color`} value={look.palette[slot]} onChange={color => set({ palette: { ...look.palette, [slot]: color } })} />
        <div className="cl-look__field">
          <span className="cl-tweaks__group-label">Finish</span>
          <TileGroup label="Finish" options={LOOK_OPTIONS.finish} value={look.finish} onChange={finish => set({ finish })} className="cl-tiles--finish" render={kind => <span className={`cl-finish cl-finish--${kind}`} style={{ "--fc": look.palette.body }} />} />
        </div>
      </Group>

      <Group title="Pattern" icon="grid" summary={optionName(look.pattern.kind)}>
        <TileGroup label="Pattern" options={LOOK_OPTIONS.pattern} value={look.pattern.kind} onChange={kind => set({ pattern: { ...look.pattern, kind } })} render={kind => <span className={`cl-pattern cl-pattern--${kind}`} style={{ "--pb": look.palette.body, "--pc": look.pattern.color }} />} />
        {look.pattern.kind !== "none" && (
          <>
            <ColorRow label="Pattern color" value={look.pattern.color} onChange={color => set({ pattern: { ...look.pattern, color } })} />
            <Slider label="Pattern size" value={look.pattern.scale} min={0.5} max={2} step={0.05} format={v => `${v.toFixed(2)}×`} onChange={scale => set({ pattern: { ...look.pattern, scale } })} />
          </>
        )}
      </Group>

      <Group title="Shell and face" icon="sparkle" summary={`${optionName(look.shell.kind)}, ${optionName(look.face.eyes).toLowerCase()} eyes`}>
        <span className="cl-tweaks__group-label">Shell</span>
        <TileGroup label="Shell" options={LOOK_OPTIONS.shell} value={look.shell.kind} onChange={kind => set({ shell: { ...look.shell, kind } })} render={kind => <Art>{SHELL_ART[kind]}</Art>} />
        {look.shell.kind !== "none" && (
          <>
            <ColorRow label="Shell color" value={look.shell.color} onChange={color => set({ shell: { ...look.shell, color } })} />
            <Slider label="Shell size" value={look.shell.size} min={0.8} max={1.3} step={0.01} format={v => `${Math.round(v * 100)}%`} onChange={size => set({ shell: { ...look.shell, size } })} />
          </>
        )}
        <span className="cl-tweaks__group-label">Eyes</span>
        <TileGroup label="Eyes" options={LOOK_OPTIONS.eyes} value={look.face.eyes} onChange={eyes => set({ face: { ...look.face, eyes } })} render={kind => <Art>{EYES_ART[kind]}</Art>} />
        {look.face.eyes !== "none" && <ColorRow label="Eye color" value={look.face.eyeColor} onChange={eyeColor => set({ face: { ...look.face, eyeColor } })} />}
      </Group>

      <Group title="Accessories" icon="star" summary={`${look.accessories.length} of 4`}>
        <TileGroup label="Accessories, up to 4" options={LOOK_OPTIONS.accessories} value={accKinds} multiple max={4} onChange={toggleAccessory} render={kind => <Art>{ACC_ART[kind]}</Art>} className="cl-tiles--acc" />
        <p className="cl-hint">{look.accessories.length >= 4 ? "That's the max of 4. Remove one to add another." : `Pick up to 4. ${4 - look.accessories.length} left.`}</p>
      </Group>

      <Group title="Legs and feet" icon="leg" summary={`${optionName(look.limbs.style)}, ${optionName(look.limbs.feet).toLowerCase()} feet`}>
        <Segmented label="Leg style" value={look.limbs.style} onChange={style => set({ limbs: { ...look.limbs, style } })} options={LOOK_OPTIONS.limbStyle.map(v => ({ value: v, label: optionName(v) }))} block />
        <Segmented label="Feet" value={look.limbs.feet} onChange={feet => set({ limbs: { ...look.limbs, feet } })} options={LOOK_OPTIONS.feet.map(v => ({ value: v, label: optionName(v) }))} block />
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
