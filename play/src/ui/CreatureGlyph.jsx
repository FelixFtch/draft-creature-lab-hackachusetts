// CreatureGlyph: a small 2D drawing of a creature built from its DesignSpec
// (creature-design/1) and look (creature-look/1). Used for thumbnails on
// cards, the shelf, look presets, the HUD badge and the title screen, so the
// UI never needs a 3D render to show "which creature is this".
//
//   <CreatureGlyph design={design | "cheetah"} look={look | "#1f8c80"}
//                  mode="toy" | "blueprint" | "ghost" dims title="Hopper" />
//
// Quadrupeds and wheel-legs are drawn from the side (knees back, like Draft's
// template); multileg bodies from above; humanoids from the front.
// Proportions come from the design; anything missing falls back to the base
// preset. It is an illustration, not a measurement: the SpecSheet blueprint
// is the engineering drawing.
import { useId } from "react";

const VB_W = 120;
const VB_H = 84;

export const PRESET_SHAPES = {
  cheetah: { plan: "quadruped", torsoLength: 0.56, torsoHeight: 0.12, upperLeg: 0.24, lowerLeg: 0.26 },
  bear: { plan: "quadruped", torsoLength: 0.5, torsoHeight: 0.2, upperLeg: 0.19, lowerLeg: 0.18 },
  giraffe: { plan: "quadruped", torsoLength: 0.44, torsoHeight: 0.13, upperLeg: 0.42, lowerLeg: 0.45 },
  flower: { plan: "multileg", legCount: 6, arrangement: "radial", bodyRadius: 0.14, bodyAspect: 1, coxa: 0.07, upperLeg: 0.16, lowerLeg: 0.2 },
  spider: { plan: "multileg", legCount: 8, arrangement: "radial", bodyRadius: 0.13, bodyAspect: 1, coxa: 0.06, upperLeg: 0.18, lowerLeg: 0.22 },
  wheel_biped: { plan: "wheeled", bodyLength: 0.3, bodyHeight: 0.12, thigh: 0.15, shin: 0.15, wheelRadius: 0.08 },
  humanoid: { plan: "humanoid", torsoHeight: 0.19, torsoWidth: 0.17, hipWidth: 0.11, upperLeg: 0.15, lowerLeg: 0.15, footLength: 0.1, headSize: 0.085 },
};
PRESET_SHAPES.rollo = PRESET_SHAPES.wheel_biped;
PRESET_SHAPES.octo = PRESET_SHAPES.spider;
PRESET_SHAPES.bipo = PRESET_SHAPES.humanoid;
PRESET_SHAPES.dog = PRESET_SHAPES.cheetah;

export const DEFAULT_PALETTE = { body: "#1f8c80", limbs: "#d9e8e2", joints: "#2a3354", accent: "#ffc63a", feet: "#2a3354" };
const HEX = /^#[0-9a-f]{6}$/i;
const num = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Proportions from a DesignSpec, a preset id, or a body contract's design. */
export function normalizeShape(design) {
  if (typeof design === "string") return { ...(PRESET_SHAPES[design] || PRESET_SHAPES.cheetah) };
  const d = design && typeof design === "object" ? design : {};
  const presetPlan = PRESET_SHAPES[d.basePreset]?.plan;
  const plan = ["multileg", "wheeled", "humanoid", "quadruped"].includes(d.bodyPlan) ? d.bodyPlan : presetPlan || "quadruped";
  const fallback = { multileg: PRESET_SHAPES.flower, wheeled: PRESET_SHAPES.wheel_biped, humanoid: PRESET_SHAPES.humanoid, quadruped: PRESET_SHAPES.cheetah }[plan];
  const base = PRESET_SHAPES[d.basePreset] && presetPlan === plan ? PRESET_SHAPES[d.basePreset] : fallback;
  if (plan === "wheeled") {
    const w = d.wheeled || d.wheelLeg || {};
    return {
      plan,
      bodyLength: clamp(num(w.bodyLength ?? w.torsoLength, base.bodyLength), 0.12, 0.8),
      bodyHeight: clamp(num(w.bodyHeight ?? w.torsoHeight, base.bodyHeight), 0.05, 0.4),
      thigh: clamp(num(w.thigh ?? w.upperLeg, base.thigh), 0.05, 0.5),
      shin: clamp(num(w.shin ?? w.lowerLeg, base.shin), 0.05, 0.5),
      wheelRadius: clamp(num(w.wheelRadius ?? w.wheelRadiusM, base.wheelRadius), 0.03, 0.25),
    };
  }
  if (plan === "humanoid") {
    const h = d.humanoid || {};
    return {
      plan,
      torsoHeight: clamp(num(h.torsoHeight, base.torsoHeight), 0.08, 0.5),
      torsoWidth: clamp(num(h.torsoWidth, base.torsoWidth), 0.08, 0.4),
      hipWidth: clamp(num(h.hipWidth, base.hipWidth), 0.05, 0.3),
      upperLeg: clamp(num(h.upperLeg ?? h.thigh, base.upperLeg), 0.06, 0.5),
      lowerLeg: clamp(num(h.lowerLeg ?? h.shin, base.lowerLeg), 0.06, 0.5),
      footLength: clamp(num(h.footLength, base.footLength), 0.04, 0.25),
      headSize: clamp(num(h.headSize, base.headSize), 0.04, 0.2),
    };
  }
  if (plan === "multileg") {
    const m = d.multileg || {};
    return {
      plan,
      legCount: Math.round(clamp(num(m.legCount, base.legCount), 3, 8)),
      arrangement: m.arrangement === "bilateral" ? "bilateral" : m.arrangement === "radial" ? "radial" : base.arrangement,
      bodyRadius: clamp(num(m.bodyRadius, base.bodyRadius), 0.06, 0.3),
      bodyAspect: clamp(num(m.bodyAspect, m.arrangement === "bilateral" ? 1.6 : base.bodyAspect), 1, 2.4),
      coxa: clamp(num(m.coxa, base.coxa), 0.02, 0.16),
      upperLeg: clamp(num(m.upperLeg, base.upperLeg), 0.06, 0.4),
      lowerLeg: clamp(num(m.lowerLeg, base.lowerLeg), 0.06, 0.45),
    };
  }
  const q = d.quadruped || {};
  return {
    plan,
    torsoLength: clamp(num(q.torsoLength, base.torsoLength), 0.15, 1),
    torsoHeight: clamp(num(q.torsoHeight, base.torsoHeight), 0.05, 0.4),
    upperLeg: clamp(num(q.upperLeg, base.upperLeg), 0.08, 0.8),
    lowerLeg: clamp(num(q.lowerLeg, base.lowerLeg), 0.08, 0.8),
  };
}

/** Just enough of creature-look/1 to draw; unknown fields fall back. */
export function lookForGlyph(look) {
  if (typeof look === "string" && HEX.test(look)) return { palette: { ...DEFAULT_PALETTE, body: look }, eyes: "round", accessories: [] };
  const l = look && typeof look === "object" ? look : {};
  const p = l.palette || {};
  const pick = (key) => (HEX.test(p[key] || "") ? p[key] : DEFAULT_PALETTE[key]);
  const palette = { body: pick("body"), limbs: pick("limbs"), joints: pick("joints"), accent: pick("accent"), feet: pick("feet") };
  const pattern = l.pattern && l.pattern.kind && l.pattern.kind !== "none" ? { kind: l.pattern.kind, color: HEX.test(l.pattern.color || "") ? l.pattern.color : palette.accent, scale: clamp(num(l.pattern.scale, 1), 0.5, 2) } : null;
  const shell = l.shell && l.shell.kind && l.shell.kind !== "none" ? { kind: l.shell.kind, color: HEX.test(l.shell.color || "") ? l.shell.color : palette.accent, size: clamp(num(l.shell.size, 1), 0.8, 1.3) } : null;
  const eyes = l.face?.eyes || "round";
  const eyeColor = HEX.test(l.face?.eyeColor || "") ? l.face.eyeColor : "#1c2440";
  const accessories = Array.isArray(l.accessories) ? l.accessories.slice(0, 4).filter(a => a && a.kind).map(a => ({ kind: a.kind, color: HEX.test(a.color || "") ? a.color : palette.accent, size: clamp(num(a.size, 1), 0.6, 1.6) })) : [];
  return { palette, pattern, shell, eyes, eyeColor, accessories, finish: l.finish || "satin", feet: l.limbs?.feet || "ball", limbStyle: l.limbs?.style || "classic" };
}

const shade = (hex, amount) => {
  if (!HEX.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const f = c => clamp(Math.round(c + (amount < 0 ? c * amount : (255 - c) * amount)), 0, 255);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => f(c).toString(16).padStart(2, "0")).join("")}`;
};

/* ---------------- quadruped (side view) ---------------- */
/**
 * Side-view layout in a vbW×vbH box. `pad` = [left/right, top, bottom] in box
 * units. Exported so the SpecSheet drawing shares the glyph's geometry.
 */
export function quadLayout(shape, vbW = VB_W, vbH = VB_H, pad = [5, 4, 4], tight = false) {
  const { torsoLength: L, torsoHeight: H, upperLeg: U, lowerLeg: W } = shape;
  const reach = (U + W) * 0.86;
  const cosA = clamp((U * U + reach * reach - W * W) / (2 * U * reach), -1, 1);
  const a = Math.acos(cosA);
  const hipY = H * 0.26;
  const groundY = hipY + reach;
  // Toy glyphs reserve room above the torso for shells and accessories;
  // the engineering drawing (tight) does not.
  const minX = tight ? -L / 2 - L * 0.04 : -L / 2 - Math.max(0.05, L * 0.12);
  const maxX = tight ? L / 2 + L * 0.06 : L / 2 + Math.max(0.06, L * 0.14);
  const minY = tight ? -H / 2 - H * 0.1 : -H / 2 - Math.max(0.08, H * 0.8);
  const maxY = groundY + 0.02;
  const s = Math.min((vbW - pad[0] * 2) / (maxX - minX), (vbH - pad[1] - pad[2]) / (maxY - minY));
  const ox = vbW / 2 - ((minX + maxX) / 2) * s;
  const oy = vbH - pad[2] - maxY * s;
  const P = (x, y) => [ox + x * s, oy + y * s];
  const legs = [L / 2 - L * 0.15, -L / 2 + L * 0.15].map(hx => {
    const hip = P(hx, hipY);
    const knee = P(hx - U * Math.sin(a), hipY + U * Math.cos(a));
    const foot = P(hx, groundY);
    return { hip, knee, foot };
  });
  return { L, H, s, P, legs, torso: { x: ox - (L / 2) * s, y: oy - (H / 2) * s, w: L * s, h: H * s }, ground: oy + groundY * s };
}

function Pattern({ id, pattern, u }) {
  if (!pattern) return null;
  const k = clamp(u * 0.55 * pattern.scale, 4, 22);
  const c = pattern.color;
  switch (pattern.kind) {
    case "spots":
      return <pattern id={id} width={k * 2} height={k * 2} patternUnits="userSpaceOnUse"><circle cx={k * 0.6} cy={k * 0.6} r={k * 0.42} fill={c} /><circle cx={k * 1.6} cy={k * 1.55} r={k * 0.32} fill={c} /></pattern>;
    case "stripes":
      return <pattern id={id} width={k * 1.4} height={k * 1.4} patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width={k * 0.55} height={k * 1.4} fill={c} /></pattern>;
    case "bands":
      return <pattern id={id} width={k * 2.2} height={k * 2} patternUnits="userSpaceOnUse"><rect width={k * 0.8} height={k * 2} fill={c} /></pattern>;
    case "checker":
      return <pattern id={id} width={k * 1.6} height={k * 1.6} patternUnits="userSpaceOnUse"><rect width={k * 0.8} height={k * 0.8} fill={c} /><rect x={k * 0.8} y={k * 0.8} width={k * 0.8} height={k * 0.8} fill={c} /></pattern>;
    case "camo":
      return <pattern id={id} width={k * 3} height={k * 2.4} patternUnits="userSpaceOnUse"><path d={`M${k * 0.2} ${k * 0.6}c${k * 0.6}-${k * 0.5} ${k * 1.4}-${k * 0.2} ${k * 1.2} ${k * 0.4}s-${k * 0.9} ${k * 0.7}-${k * 1.2} ${k * 0.2}Z M${k * 1.7} ${k * 1.5}c${k * 0.5}-${k * 0.3} ${k * 1.1} 0 ${k * 1} ${k * 0.4}s-${k * 0.8} ${k * 0.5}-${k * 1} 0Z`} fill={c} /></pattern>;
    case "panels":
      return <pattern id={id} width={k * 2.4} height={k * 1.6} patternUnits="userSpaceOnUse"><path d={`M0 0h${k * 2.4}M0 0v${k * 1.6}`} stroke={c} strokeWidth={1.4} fill="none" /><circle cx={k * 0.3} cy={k * 0.3} r={0.9} fill={c} /></pattern>;
    case "gradient":
      return <linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={c} stopOpacity="0" /><stop offset="1" stopColor={c} stopOpacity="0.95" /></linearGradient>;
    default:
      return null;
  }
}

function Eyes({ kind, x, y, u, color, front = true }) {
  const r = clamp(u * 0.2, 1.8, 5.5);
  const white = "#fffcf5";
  const dir = front ? 1 : 0;
  switch (kind) {
    case "none":
      return null;
    case "visor":
      return <rect x={x - r * 2.6} y={y - r * 0.8} width={r * 3.1} height={r * 1.6} rx={r * 0.8} fill="#1c2440" stroke="#fffcf5" strokeOpacity=".6" strokeWidth={0.8} />;
    case "cyclops":
      return <g><circle cx={x - r * 0.6} cy={y} r={r * 1.35} fill={white} stroke="#1c2440" strokeWidth={1.2} /><circle cx={x - r * 0.4 + dir * 0.4} cy={y} r={r * 0.7} fill={color} /></g>;
    case "sleepy":
      return <path d={`M${x - r * 2.4} ${y}q${r * 0.7} ${r * 0.8} ${r * 1.4} 0M${x - r * 0.5} ${y}q${r * 0.7} ${r * 0.8} ${r * 1.4} 0`} stroke="#1c2440" strokeWidth={1.4} fill="none" strokeLinecap="round" />;
    case "compound":
      return <g fill={color} stroke="#fffcf5" strokeWidth={0.6}><circle cx={x - r * 0.9} cy={y - r * 0.4} r={r * 0.62} /><circle cx={x - r * 0.1} cy={y + r * 0.3} r={r * 0.62} /><circle cx={x - r * 1.5} cy={y + r * 0.5} r={r * 0.62} /></g>;
    case "cute":
      return <g><circle cx={x - r * 1.9} cy={y} r={r * 1.05} fill={color} /><circle cx={x - r * 0.1} cy={y} r={r * 1.05} fill={color} /><circle cx={x - r * 1.6} cy={y - r * 0.4} r={r * 0.36} fill={white} /><circle cx={x + r * 0.2} cy={y - r * 0.4} r={r * 0.36} fill={white} /></g>;
    default:
      return <g><circle cx={x - r * 1.9} cy={y} r={r} fill={white} stroke="#1c2440" strokeWidth={1} /><circle cx={x - r * 0.1} cy={y} r={r} fill={white} stroke="#1c2440" strokeWidth={1} /><circle cx={x - r * 1.7} cy={y} r={r * 0.5} fill={color} /><circle cx={x + r * 0.1} cy={y} r={r * 0.5} fill={color} /></g>;
  }
}

function Shell({ shell, t, u }) {
  if (!shell) return null;
  const { x, y, w, h } = t;
  const k = shell.size;
  const c = shell.color;
  const stroke = { stroke: "#1c2440", strokeWidth: 1.6, strokeLinejoin: "round" };
  const top = y + h * 0.15;
  const x0 = x + w * (0.5 - 0.42 * k);
  const x1 = x + w * (0.5 + 0.42 * k);
  const lift = h * 0.75 * k + 2;
  switch (shell.kind) {
    case "dome":
    case "beetle":
    case "turtle": {
      const d = `M${x0} ${top}C${x0} ${top - lift} ${x1} ${top - lift} ${x1} ${top}Z`;
      return (
        <g>
          <path d={d} fill={c} {...stroke} />
          {shell.kind === "beetle" && <path d={`M${(x0 + x1) / 2} ${top - lift * 0.74}V${top}`} stroke="#1c2440" strokeWidth={1.4} />}
          {shell.kind === "turtle" && <path d={`M${x0 + (x1 - x0) * 0.3} ${top}l${(x1 - x0) * 0.08} -${lift * 0.45}h${(x1 - x0) * 0.24}l${(x1 - x0) * 0.08} ${lift * 0.45}`} stroke="#1c2440" strokeWidth={1.2} fill="none" />}
          <path d={`M${x0 + (x1 - x0) * 0.2} ${top - lift * 0.42}q${(x1 - x0) * 0.12} -${lift * 0.26} ${(x1 - x0) * 0.28} -${lift * 0.3}`} stroke="#fff" strokeOpacity=".55" strokeWidth={1.6} fill="none" strokeLinecap="round" />
        </g>
      );
    }
    case "petals": {
      const n = 5;
      const step = (x1 - x0) / n;
      let d = `M${x0} ${top}`;
      for (let i = 0; i < n; i += 1) d += `q${step / 2} -${lift * 0.9} ${step} 0`;
      return <path d={`${d}Z`} fill={c} {...stroke} />;
    }
    case "armor": {
      const n = 3;
      const step = (x1 - x0) / n;
      return <g>{Array.from({ length: n }, (_, i) => <rect key={i} x={x0 + i * step - 1} y={top - lift * 0.62} width={step + 2} height={lift * 0.7} rx={3} fill={shade(c, -0.05 * i)} {...stroke} />)}</g>;
    }
    case "fluffy": {
      const n = 4;
      const step = (x1 - x0) / n;
      return <g fill={c} {...stroke}>{Array.from({ length: n }, (_, i) => <circle key={i} cx={x0 + step * (i + 0.5)} cy={top - lift * 0.3} r={step * 0.62} />)}</g>;
    }
    case "saddle":
      return <rect x={x + w * 0.32} y={top - lift * 0.45} width={w * 0.36} height={lift * 0.55} rx={4} fill={c} {...stroke} />;
    default:
      return null;
  }
}

function Accessory({ item, t, u, side = true }) {
  const { x, y, w, h } = t;
  const c = item.color;
  const k = item.size;
  const ink = { stroke: "#1c2440", strokeWidth: 1.5, strokeLinejoin: "round", strokeLinecap: "round" };
  const fx = x + w - h * 0.35; // front-top anchor
  const fy = y + 1;
  const sz = clamp(u * 0.55 * k, 5, 18);
  switch (item.kind) {
    case "antennae":
      return <g><path d={`M${fx - sz * 0.6} ${fy}q${sz * 0.2} -${sz * 1.1} ${sz * 0.6} -${sz * 1.5}M${fx - sz * 0.1} ${fy}q${sz * 0.4} -${sz} ${sz * 1} -${sz * 1.3}`} fill="none" {...ink} /><circle cx={fx} cy={fy - sz * 1.5} r={sz * 0.26} fill={c} {...ink} /><circle cx={fx + sz * 0.9} cy={fy - sz * 1.3} r={sz * 0.26} fill={c} {...ink} /></g>;
    case "horns":
      return <g fill={c} {...ink}><path d={`M${fx - sz * 0.8} ${fy + 1}q-${sz * 0.1} -${sz * 0.9} ${sz * 0.25} -${sz * 1.2}q${sz * 0.05} ${sz * 0.6} ${sz * 0.35} ${sz * 1.2}Z`} /><path d={`M${fx - sz * 0.05} ${fy + 1}q${sz * 0.05} -${sz * 0.9} ${sz * 0.45} -${sz * 1.15}q-${sz * 0.05} ${sz * 0.6} ${sz * 0.2} ${sz * 1.15}Z`} /></g>;
    case "ears":
      return <g fill={c} {...ink}><path d={`M${fx - sz * 1.1} ${fy + 1}l${sz * 0.25} -${sz * 0.9}l${sz * 0.45} ${sz * 0.9}Z`} /><path d={`M${fx - sz * 0.3} ${fy + 1}l${sz * 0.25} -${sz * 0.9}l${sz * 0.45} ${sz * 0.9}Z`} /></g>;
    case "tail":
      return <path d={`M${x + 1} ${y + h * 0.35}c-${sz * 0.9} -${sz * 0.1} -${sz * 1.3} -${sz * 0.8} -${sz * 1.1} -${sz * 1.4}`} fill="none" stroke={c} strokeWidth={clamp(u * 0.16, 2, 5)} strokeLinecap="round" />;
    case "spikes": {
      const n = 4;
      const step = (w * 0.6) / n;
      let d = `M${x + w * 0.2} ${y + 1}`;
      for (let i = 0; i < n; i += 1) d += `l${step / 2} -${sz * 0.7}l${step / 2} ${sz * 0.7}`;
      return <path d={d} fill={c} {...ink} />;
    }
    case "fin":
      return <path d={`M${x + w * 0.35} ${y + 1}q${sz * 0.4} -${sz * 1.6} ${sz * 1.5} -${sz * 1.6}q-${sz * 0.3} ${sz * 0.9} ${sz * 0.1} ${sz * 1.6}Z`} fill={c} {...ink} />;
    case "wings":
      return <g fill={c} fillOpacity=".7" {...ink}><ellipse cx={x + w * 0.42} cy={y - sz * 0.6} rx={sz * 1.3} ry={sz * 0.55} transform={`rotate(-18 ${x + w * 0.42} ${y - sz * 0.6})`} /><ellipse cx={x + w * 0.55} cy={y - sz * 0.75} rx={sz * 1.1} ry={sz * 0.45} transform={`rotate(-28 ${x + w * 0.55} ${y - sz * 0.75})`} /></g>;
    case "crown":
      return <path d={`M${fx - sz} ${fy + 1}v-${sz * 0.9}l${sz * 0.35} ${sz * 0.45}l${sz * 0.3} -${sz * 0.6}l${sz * 0.3} ${sz * 0.6}l${sz * 0.35} -${sz * 0.45}v${sz * 0.9}Z`} fill={c} {...ink} />;
    case "hat":
      return <g fill={c} {...ink}><rect x={fx - sz * 1.15} y={fy - sz * 0.15} width={sz * 1.6} height={sz * 0.3} rx={1} /><rect x={fx - sz * 0.85} y={fy - sz * 1.2} width={sz} height={sz * 1.08} rx={1.5} /></g>;
    case "bow":
      return <g fill={c} {...ink}><path d={`M${fx - sz * 0.35} ${fy - sz * 0.25}l-${sz * 0.7} -${sz * 0.45}v${sz * 0.9}Z`} /><path d={`M${fx - sz * 0.35} ${fy - sz * 0.25}l${sz * 0.7} -${sz * 0.45}v${sz * 0.9}Z`} /><circle cx={fx - sz * 0.35} cy={fy - sz * 0.25} r={sz * 0.18} /></g>;
    case "flower":
      return <g {...ink}>{[0, 72, 144, 216, 288].map(deg => <circle key={deg} cx={fx - sz * 0.4 + Math.cos((deg * Math.PI) / 180) * sz * 0.38} cy={fy - sz * 0.55 + Math.sin((deg * Math.PI) / 180) * sz * 0.38} r={sz * 0.28} fill={c} />)}<circle cx={fx - sz * 0.4} cy={fy - sz * 0.55} r={sz * 0.2} fill="#ffc63a" /></g>;
    case "propeller":
      return <g {...ink}><path d={`M${x + w * 0.5} ${y + 1}v-${sz * 0.9}`} fill="none" /><ellipse cx={x + w * 0.5 - sz * 0.55} cy={y - sz * 0.9} rx={sz * 0.6} ry={sz * 0.2} fill={c} /><ellipse cx={x + w * 0.5 + sz * 0.55} cy={y - sz * 0.9} rx={sz * 0.6} ry={sz * 0.2} fill={c} /></g>;
    case "backpack":
      return <rect x={x + w * 0.18} y={y - sz * 0.7} width={sz * 1.2} height={sz * 0.95} rx={sz * 0.25} fill={c} {...ink} />;
    default:
      return side ? null : null;
  }
}

function Quadruped({ shape, look, mode, uid, dims }) {
  const g = quadLayout(shape);
  const bp = mode === "blueprint";
  const ghost = mode === "ghost";
  const t = g.torso;
  const u = t.h;
  const pal = look.palette;
  const ink = bp ? "#dce8fb" : ghost ? "currentColor" : "#1c2440";
  const limbW = bp ? 1.7 : clamp(u * 0.32, 3.4, 6.5);
  const jointR = bp ? 2.4 : clamp(u * 0.24, 2.4, 4.4);
  const footR = bp ? 2.2 : clamp(u * 0.24, 2.6, 4.6);
  const far = 3.2;
  const legPath = ({ hip, knee, foot }, dx = 0, dy = 0) => `M${hip[0] + dx} ${hip[1] + dy}L${knee[0] + dx} ${knee[1] + dy}L${foot[0] + dx} ${foot[1] + dy}`;
  const torsoR = Math.min(t.h / 2, t.w * 0.3);
  const patternId = `cg-p-${uid}`;
  const clipId = `cg-c-${uid}`;
  const fill = ghost ? "none" : bp ? "rgb(220 232 251 / 0.08)" : pal.body;
  return (
    <g>
      <defs>
        {!bp && !ghost && <Pattern id={patternId} pattern={look.pattern} u={u} />}
        <clipPath id={clipId}>
          <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={torsoR} />
        </clipPath>
      </defs>
      {(bp || ghost) && <path d={`M4 ${g.ground + footR}H${VB_W - 4}`} stroke={ink} strokeOpacity=".5" strokeWidth={1} strokeDasharray={bp ? "3 3" : undefined} />}
      {!bp && !ghost && <ellipse cx={VB_W / 2} cy={g.ground + footR + 1.5} rx={t.w * 0.62} ry={2.6} fill="#1c2440" opacity=".14" />}
      {/* far legs */}
      {g.legs.map((leg, i) => (
        <path key={`f${i}`} d={legPath(leg, far, -far * 0.6)} fill="none" stroke={bp ? ink : ghost ? ink : shade(pal.limbs, -0.28)} strokeOpacity={bp || ghost ? 0.45 : 1} strokeWidth={limbW} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {!bp && !ghost && look.accessories.filter(a => a.kind === "wings" || a.kind === "tail").map((a, i) => <Accessory key={`b${i}`} item={a} t={t} u={u} />)}
      {/* torso */}
      <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={torsoR} fill={fill} stroke={ink} strokeWidth={bp ? 1.6 : 2} />
      {!bp && !ghost && look.pattern && (
        <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={torsoR} fill={`url(#${patternId})`} clipPath={`url(#${clipId})`} stroke="none" />
      )}
      {!bp && !ghost && <path d={`M${t.x + torsoR * 0.8} ${t.y + t.h * 0.3}h${t.w * 0.5}`} stroke="#fff" strokeOpacity=".4" strokeWidth={clamp(u * 0.12, 1.2, 2.6)} strokeLinecap="round" />}
      {!bp && !ghost && <Shell shell={look.shell} t={t} u={u} />}
      {/* near legs */}
      {g.legs.map((leg, i) => (
        <g key={`n${i}`}>
          <path d={legPath(leg)} fill="none" stroke={bp || ghost ? ink : "#1c2440"} strokeWidth={bp || ghost ? limbW : limbW + 2.4} strokeLinecap="round" strokeLinejoin="round" />
          {!bp && !ghost && <path d={legPath(leg)} fill="none" stroke={pal.limbs} strokeWidth={limbW} strokeLinecap="round" strokeLinejoin="round" />}
          <circle cx={leg.hip[0]} cy={leg.hip[1]} r={jointR} fill={bp ? "#1e4e95" : ghost ? "none" : pal.joints} stroke={ink} strokeWidth={bp ? 1.4 : 1.5} />
          <circle cx={leg.knee[0]} cy={leg.knee[1]} r={jointR} fill={bp ? "#1e4e95" : ghost ? "none" : pal.joints} stroke={ink} strokeWidth={bp ? 1.4 : 1.5} />
          {bp && <circle cx={leg.knee[0]} cy={leg.knee[1]} r={0.7} fill={ink} />}
          <circle cx={leg.foot[0]} cy={leg.foot[1]} r={footR} fill={bp ? "none" : ghost ? "none" : pal.feet} stroke={ink} strokeWidth={bp ? 1.4 : 1.5} />
        </g>
      ))}
      {!bp && !ghost && <Eyes kind={look.eyes} x={t.x + t.w - torsoR * 0.35} y={t.y + t.h * 0.42} u={u} color={look.eyeColor} />}
      {!bp && !ghost && look.accessories.filter(a => a.kind !== "wings" && a.kind !== "tail").map((a, i) => <Accessory key={`a${i}`} item={a} t={t} u={u} />)}
      {bp && dims && (
        <g className="cl-glyph-dims">
          <path d={`M${t.x} ${t.y - 9}v6M${t.x + t.w} ${t.y - 9}v6M${t.x} ${t.y - 6}H${t.x + t.w}`} stroke={ink} strokeWidth={0.9} />
          <text x={t.x + t.w / 2} y={t.y - 9} textAnchor="middle" fill={ink} fontSize="6.4" fontFamily="var(--cl-font-mono)" style={{ fontVariationSettings: '"MONO" 1, "CASL" 0' }}>
            {`${shape.torsoLength.toFixed(2)} m`}
          </text>
        </g>
      )}
    </g>
  );
}

/* ---------------- multileg (top view) ---------------- */
/** Top-view layout for multileg bodies; exported for the SpecSheet drawing. */
export function multiLayout(shape, vbW = VB_W, vbH = VB_H, pad = [6, 5]) {
  const { legCount: n, arrangement, bodyRadius: R, bodyAspect, coxa, upperLeg: U, lowerLeg: W } = shape;
  const bil = arrangement === "bilateral";
  const rx = R * (bil ? bodyAspect : 1);
  const ry = R;
  const reach = coxa + U * 0.92 + W * 0.7;
  const legs = [];
  // Real mount angles from a body contract win (MuJoCo +y is left, which is
  // up in this top view, hence the sign flip).
  if (Array.isArray(shape.mountAngles) && shape.mountAngles.length === n && shape.mountAngles.every(Number.isFinite)) {
    for (const angle of shape.mountAngles) {
      const th = -angle;
      legs.push({ th, base: [rx * Math.cos(th), ry * Math.sin(th)] });
    }
  } else if (!bil) {
    const offset = Math.PI / n;
    for (let i = 0; i < n; i += 1) {
      const th = offset + (i * 2 * Math.PI) / n;
      legs.push({ th, base: [rx * Math.cos(th), ry * Math.sin(th)] });
    }
  } else {
    const pairs = Math.floor(n / 2);
    for (let k = 0; k < pairs; k += 1) {
      const f = pairs === 1 ? 0 : 0.62 - (1.24 * k) / (pairs - 1);
      const x = rx * f;
      const spread = pairs === 1 ? 0 : (0.55 - (1.1 * k) / (pairs - 1)) * 0.9;
      const yEdge = ry * Math.sqrt(Math.max(0.05, 1 - f * f));
      legs.push({ th: -Math.PI / 2 + spread, base: [x, -yEdge] });
      legs.push({ th: Math.PI / 2 - spread, base: [x, yEdge] });
    }
    if (n % 2 === 1) legs.push({ th: Math.PI, base: [-rx, 0] });
  }
  const extentX = rx + reach;
  const extentY = ry + reach;
  const s = Math.min((vbW / 2 - pad[0]) / extentX, (vbH / 2 - pad[1]) / extentY);
  const cx0 = vbW / 2;
  const cy0 = vbH / 2;
  const P = (x, y) => [cx0 + x * s, cy0 + y * s];
  const out = legs.map(({ th, base }) => {
    const dir = (a, len, from) => [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
    const p1 = dir(th, coxa, base);
    const p2 = dir(th + 0.18, U * 0.92, p1);
    const p3 = dir(th - 0.1, W * 0.7, p2);
    return { base: P(...base), hip: P(...p1), knee: P(...p2), foot: P(...p3) };
  });
  return { s, rx: rx * s, ry: ry * s, cx: cx0, cy: cy0, legs: out };
}

function Multileg({ shape, look, mode, uid }) {
  const g = multiLayout(shape);
  const bp = mode === "blueprint";
  const ghost = mode === "ghost";
  const pal = look.palette;
  const ink = bp ? "#dce8fb" : ghost ? "currentColor" : "#1c2440";
  const u = g.ry * 2;
  const limbW = bp ? 1.6 : clamp(u * 0.11, 3, 5.5);
  const jointR = bp ? 2.2 : clamp(u * 0.075, 2.2, 3.8);
  const patternId = `cg-p-${uid}`;
  const clipId = `cg-c-${uid}`;
  const path = l => `M${l.base[0]} ${l.base[1]}L${l.hip[0]} ${l.hip[1]}L${l.knee[0]} ${l.knee[1]}L${l.foot[0]} ${l.foot[1]}`;
  const shellR = look.shell ? look.shell.size * 0.78 : 0;
  return (
    <g>
      <defs>
        {!bp && !ghost && <Pattern id={patternId} pattern={look.pattern} u={u * 0.45} />}
        <clipPath id={clipId}>
          <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} />
        </clipPath>
      </defs>
      {!bp && !ghost && <ellipse cx={g.cx + 2} cy={g.cy + 3} rx={g.rx + 10} ry={g.ry + 8} fill="#1c2440" opacity=".08" />}
      {g.legs.map((l, i) => (
        <g key={i}>
          <path d={path(l)} fill="none" stroke={bp || ghost ? ink : "#1c2440"} strokeWidth={bp || ghost ? limbW : limbW + 2.4} strokeLinecap="round" strokeLinejoin="round" />
          {!bp && !ghost && <path d={path(l)} fill="none" stroke={pal.limbs} strokeWidth={limbW} strokeLinecap="round" strokeLinejoin="round" />}
          <circle cx={l.knee[0]} cy={l.knee[1]} r={jointR} fill={bp ? "#1e4e95" : ghost ? "none" : pal.joints} stroke={ink} strokeWidth={1.3} />
          <circle cx={l.foot[0]} cy={l.foot[1]} r={jointR * 0.95} fill={bp || ghost ? "none" : pal.feet} stroke={ink} strokeWidth={1.3} />
        </g>
      ))}
      <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} fill={ghost ? "none" : bp ? "rgb(220 232 251 / 0.08)" : pal.body} stroke={ink} strokeWidth={bp ? 1.6 : 2} />
      {!bp && !ghost && look.pattern && <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} fill={`url(#${patternId})`} clipPath={`url(#${clipId})`} />}
      {!bp && !ghost && look.shell && (
        <ellipse cx={g.cx} cy={g.cy} rx={g.rx * shellR} ry={g.ry * shellR} fill={look.shell.color} stroke="#1c2440" strokeWidth={1.5} />
      )}
      {!bp && !ghost && <path d={`M${g.cx - g.rx * 0.5} ${g.cy - g.ry * 0.45}q${g.rx * 0.3} -${g.ry * 0.25} ${g.rx * 0.65} -${g.ry * 0.2}`} stroke="#fff" strokeOpacity=".45" strokeWidth={2} fill="none" strokeLinecap="round" />}
      {bp && <path d={`M${g.cx - 4} ${g.cy}h8M${g.cx} ${g.cy - 4}v8`} stroke={ink} strokeWidth={1} />}
      {!bp && !ghost && look.eyes !== "none" && (
        <g>
          <circle cx={g.cx + g.rx * 0.62} cy={g.cy - g.ry * 0.28} r={clamp(u * 0.09, 2, 4)} fill="#fffcf5" stroke="#1c2440" strokeWidth={1} />
          <circle cx={g.cx + g.rx * 0.62} cy={g.cy + g.ry * 0.28} r={clamp(u * 0.09, 2, 4)} fill="#fffcf5" stroke="#1c2440" strokeWidth={1} />
          <circle cx={g.cx + g.rx * 0.68} cy={g.cy - g.ry * 0.28} r={clamp(u * 0.045, 1, 2)} fill={look.eyeColor} />
          <circle cx={g.cx + g.rx * 0.68} cy={g.cy + g.ry * 0.28} r={clamp(u * 0.045, 1, 2)} fill={look.eyeColor} />
        </g>
      )}
      {/* forward arrow so a top view reads as "facing right" */}
      {(bp || ghost) && <path d={`M${g.cx + g.rx + 3} ${g.cy}h6m-2.5 -2.5 2.5 2.5-2.5 2.5`} stroke={ink} strokeWidth={1.2} fill="none" strokeLinecap="round" />}
    </g>
  );
}

/* ---------------- wheel-leg (side view) ---------------- */
/** Side-view layout for a two-wheel-leg balancer (Ollie / Diablo style). */
export function wheeledLayout(shape, vbW = VB_W, vbH = VB_H, pad = [6, 4, 3], tight = false) {
  const { bodyLength: L, bodyHeight: H, thigh: T, shin: S, wheelRadius: r } = shape;
  const bend = 0.62; // knee angle from vertical (radians), knee pointing forward
  const kneeX = T * Math.sin(bend);
  const kneeY = T * Math.cos(bend);
  const wheelY = kneeY + S * Math.cos(Math.asin(Math.min(1, kneeX / S)));
  const groundY = wheelY + r;
  const minX = Math.min(-L / 2, -r) - (tight ? 0.01 : Math.max(0.04, L * 0.1));
  const maxX = Math.max(L / 2, kneeX + 0.03, r) + (tight ? 0.01 : Math.max(0.05, L * 0.14));
  const minY = -H - (tight ? H * 0.1 : Math.max(0.08, H * 0.9));
  const maxY = groundY + 0.01;
  const s = Math.min((vbW - pad[0] * 2) / (maxX - minX), (vbH - pad[1] - pad[2]) / (maxY - minY));
  const ox = vbW / 2 - ((minX + maxX) / 2) * s;
  const oy = vbH - pad[2] - maxY * s;
  const P = (x, y) => [ox + x * s, oy + y * s];
  return {
    s,
    P,
    body: { x: ox - (L / 2) * s, y: oy - H * s, w: L * s, h: H * s },
    hip: P(0, -H * 0.12),
    knee: P(kneeX, kneeY - H * 0.12),
    wheel: P(0, wheelY - H * 0.12),
    r: r * s,
    ground: oy + (groundY - H * 0.12) * s,
  };
}

function Wheel({ cx, cy, r, tire, hub, spoke, ink, bp, ghost, far = false }) {
  if (bp || ghost) {
    return (
      <g opacity={far ? 0.45 : 1}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={ink} strokeWidth={1.5} />
        <circle cx={cx} cy={cy} r={r * 0.32} fill="none" stroke={ink} strokeWidth={1.1} />
        {!far && <path d={`M${cx - r} ${cy}h${r * 2}M${cx} ${cy - r}v${r * 2}`} stroke={ink} strokeWidth={0.6} strokeDasharray="2 2" />}
      </g>
    );
  }
  const spokes = [0, 60, 120].map(deg => {
    const a = (deg * Math.PI) / 180;
    return `M${cx - Math.cos(a) * r * 0.58} ${cy - Math.sin(a) * r * 0.58}L${cx + Math.cos(a) * r * 0.58} ${cy + Math.sin(a) * r * 0.58}`;
  });
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={far ? shade(tire, -0.25) : tire} stroke="#1c2440" strokeWidth={1.6} />
      <circle cx={cx} cy={cy} r={r * 0.68} fill={far ? shade(hub, -0.25) : hub} stroke="#1c2440" strokeWidth={1.2} />
      {!far && <path d={spokes.join("")} stroke={spoke} strokeWidth={Math.max(1.2, r * 0.14)} strokeLinecap="round" />}
      <circle cx={cx} cy={cy} r={Math.max(1.4, r * 0.18)} fill="#1c2440" />
      {!far && <path d={`M${cx - r * 0.62} ${cy - r * 0.5}a${r * 0.82} ${r * 0.82} 0 0 1 ${r * 0.58} -${r * 0.34}`} stroke="#fff" strokeOpacity=".4" strokeWidth={1.4} fill="none" strokeLinecap="round" />}
    </g>
  );
}

function Wheeled({ shape, look, mode, uid }) {
  const g = wheeledLayout(shape);
  const bp = mode === "blueprint";
  const ghost = mode === "ghost";
  const t = g.body;
  const u = t.h;
  const pal = look.palette;
  const ink = bp ? "#dce8fb" : ghost ? "currentColor" : "#1c2440";
  const limbW = bp ? 1.7 : clamp(u * 0.34, 3.6, 7);
  const jointR = bp ? 2.4 : clamp(u * 0.26, 2.6, 4.8);
  const far = 3.4;
  const rx = Math.min(t.h * 0.45, t.w * 0.22);
  const patternId = `cg-p-${uid}`;
  const clipId = `cg-c-${uid}`;
  const leg = (dx = 0, dy = 0) => `M${g.hip[0] + dx} ${g.hip[1] + dy}L${g.knee[0] + dx} ${g.knee[1] + dy}L${g.wheel[0] + dx} ${g.wheel[1] + dy}`;
  const wheelProps = { r: g.r, tire: pal.feet, hub: pal.joints, spoke: pal.accent, ink, bp, ghost };
  return (
    <g>
      <defs>
        {!bp && !ghost && <Pattern id={patternId} pattern={look.pattern} u={u} />}
        <clipPath id={clipId}>
          <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={rx} />
        </clipPath>
      </defs>
      {(bp || ghost) && <path d={`M4 ${g.ground}H${VB_W - 4}`} stroke={ink} strokeOpacity=".5" strokeWidth={1} strokeDasharray={bp ? "3 3" : undefined} />}
      {!bp && !ghost && <ellipse cx={g.wheel[0]} cy={g.ground + 1.6} rx={Math.max(t.w * 0.42, g.r * 1.6)} ry={2.4} fill="#1c2440" opacity=".14" />}
      {/* far leg + wheel */}
      <path d={leg(far, -far * 0.6)} fill="none" stroke={bp || ghost ? ink : shade(pal.limbs, -0.28)} strokeOpacity={bp || ghost ? 0.45 : 1} strokeWidth={limbW} strokeLinecap="round" strokeLinejoin="round" />
      <Wheel cx={g.wheel[0] + far} cy={g.wheel[1] - far * 0.6} far {...wheelProps} />
      {!bp && !ghost && look.accessories.filter(a => a.kind === "wings" || a.kind === "tail").map((a, i) => <Accessory key={`b${i}`} item={a} t={t} u={u} />)}
      {/* body */}
      <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={rx} fill={ghost ? "none" : bp ? "rgb(220 232 251 / 0.08)" : pal.body} stroke={ink} strokeWidth={bp ? 1.6 : 2} />
      {!bp && !ghost && look.pattern && <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={rx} fill={`url(#${patternId})`} clipPath={`url(#${clipId})`} />}
      {!bp && !ghost && <path d={`M${t.x + rx} ${t.y + t.h * 0.28}h${t.w * 0.46}`} stroke="#fff" strokeOpacity=".4" strokeWidth={clamp(u * 0.12, 1.2, 2.6)} strokeLinecap="round" />}
      {!bp && !ghost && <Shell shell={look.shell} t={t} u={u} />}
      {/* near leg + wheel */}
      <path d={leg()} fill="none" stroke={bp || ghost ? ink : "#1c2440"} strokeWidth={bp || ghost ? limbW : limbW + 2.4} strokeLinecap="round" strokeLinejoin="round" />
      {!bp && !ghost && <path d={leg()} fill="none" stroke={pal.limbs} strokeWidth={limbW} strokeLinecap="round" strokeLinejoin="round" />}
      <circle cx={g.hip[0]} cy={g.hip[1]} r={jointR} fill={bp ? "#1e4e95" : ghost ? "none" : pal.joints} stroke={ink} strokeWidth={1.5} />
      <circle cx={g.knee[0]} cy={g.knee[1]} r={jointR} fill={bp ? "#1e4e95" : ghost ? "none" : pal.joints} stroke={ink} strokeWidth={1.5} />
      <Wheel cx={g.wheel[0]} cy={g.wheel[1]} {...wheelProps} />
      {!bp && !ghost && <Eyes kind={look.eyes} x={t.x + t.w - rx * 0.4} y={t.y + t.h * 0.46} u={u} color={look.eyeColor} />}
      {!bp && !ghost && look.accessories.filter(a => a.kind !== "wings" && a.kind !== "tail").map((a, i) => <Accessory key={`a${i}`} item={a} t={t} u={u} />)}
    </g>
  );
}

/* ---------------- humanoid (front view) ---------------- */
/** Front-view layout for a biped with flat feet (arms locked by design). */
export function humanoidLayout(shape, vbW = VB_W, vbH = VB_H, pad = [6, 4, 3]) {
  const { torsoHeight: TH, torsoWidth: TW, hipWidth: HW, upperLeg: U, lowerLeg: Lw, footLength: F, headSize: HS } = shape;
  const neck = HS * 0.18;
  const footH = Math.max(0.018, F * 0.22);
  const totalH = HS * 1.05 + neck + TH + TH * 0.16 + U + Lw + footH;
  const totalW = Math.max(TW * 1.55, HW + F * 0.9);
  const s = Math.min((vbW - pad[0] * 2) / totalW, (vbH - pad[1] - pad[2]) / (totalH + 0.08 * (totalH > 0 ? 1 : 0)));
  const cx = vbW / 2;
  const groundY = vbH - pad[2];
  const y = m => groundY - m * s; // meters above ground -> svg y
  const ankleZ = footH;
  const kneeZ = ankleZ + Lw;
  const hipZ = kneeZ + U;
  const pelvisTop = hipZ + TH * 0.16;
  const torsoTop = pelvisTop + TH;
  const headBottom = torsoTop + neck;
  const legX = (HW / 2) * s;
  return {
    s,
    cx,
    ground: groundY,
    head: { cx, cy: y(headBottom + HS * 0.52), r: (HS * 0.52) * s },
    torso: { x: cx - (TW / 2) * s, y: y(torsoTop), w: TW * s, h: TH * s },
    pelvis: { x: cx - (HW * 0.75) * s, y: y(pelvisTop), w: HW * 1.5 * s, h: TH * 0.2 * s },
    legs: [-1, 1].map(side => ({
      hip: [cx + side * legX, y(hipZ)],
      knee: [cx + side * legX * 1.08, y(kneeZ)],
      ankle: [cx + side * legX, y(ankleZ)],
      foot: { x: cx + side * legX - (F * 0.42) * s, y: y(footH), w: F * 0.84 * s, h: footH * s },
    })),
    arms: [-1, 1].map(side => ({
      shoulder: [cx + side * (TW / 2 + 0.012) * s, y(torsoTop - TH * 0.12)],
      hand: [cx + side * (TW / 2 + 0.03) * s, y(torsoTop - TH * 1.02)],
    })),
  };
}

function FrontEyes({ kind, cx, cy, r, color }) {
  const white = "#fffcf5";
  const gap = r * 0.95;
  switch (kind) {
    case "none":
      return null;
    case "visor":
      return <rect x={cx - r * 1.7} y={cy - r * 0.55} width={r * 3.4} height={r * 1.1} rx={r * 0.55} fill="#1c2440" stroke={white} strokeOpacity=".6" strokeWidth={0.8} />;
    case "cyclops":
      return <g><circle cx={cx} cy={cy} r={r * 1.05} fill={white} stroke="#1c2440" strokeWidth={1.1} /><circle cx={cx} cy={cy} r={r * 0.55} fill={color} /></g>;
    case "sleepy":
      return <path d={`M${cx - gap - r * 0.6} ${cy}q${r * 0.6} ${r * 0.6} ${r * 1.2} 0M${cx + gap - r * 0.6} ${cy}q${r * 0.6} ${r * 0.6} ${r * 1.2} 0`} stroke="#1c2440" strokeWidth={1.3} fill="none" strokeLinecap="round" />;
    case "cute":
    case "compound":
      return <g>{[-1, 1].map(sd => <g key={sd}><circle cx={cx + sd * gap} cy={cy} r={r * 0.62} fill={color} /><circle cx={cx + sd * gap + r * 0.18} cy={cy - r * 0.22} r={r * 0.2} fill={white} /></g>)}</g>;
    default:
      return <g>{[-1, 1].map(sd => <g key={sd}><circle cx={cx + sd * gap} cy={cy} r={r * 0.6} fill={white} stroke="#1c2440" strokeWidth={0.9} /><circle cx={cx + sd * gap} cy={cy + r * 0.05} r={r * 0.3} fill={color} /></g>)}</g>;
  }
}

function Humanoid({ shape, look, mode, uid }) {
  const g = humanoidLayout(shape);
  const bp = mode === "blueprint";
  const ghost = mode === "ghost";
  const pal = look.palette;
  const ink = bp ? "#dce8fb" : ghost ? "currentColor" : "#1c2440";
  const t = g.torso;
  const u = t.w * 0.55;
  const limbW = bp ? 1.7 : clamp(t.w * 0.2, 3, 6);
  const armW = bp ? 1.3 : clamp(t.w * 0.14, 2.4, 4.4);
  const jointR = bp ? 2.2 : clamp(t.w * 0.13, 2, 3.8);
  const patternId = `cg-p-${uid}`;
  const clipId = `cg-c-${uid}`;
  const rx = Math.min(t.w * 0.3, t.h * 0.25);
  const fill = (c) => (ghost ? "none" : bp ? "rgb(220 232 251 / 0.08)" : c);
  const legPath = l => `M${l.hip[0]} ${l.hip[1]}L${l.knee[0]} ${l.knee[1]}L${l.ankle[0]} ${l.ankle[1]}`;
  const headRect = { x: g.head.cx - g.head.r, y: g.head.cy - g.head.r, w: g.head.r * 2, h: g.head.r * 2 };
  return (
    <g>
      <defs>
        {!bp && !ghost && <Pattern id={patternId} pattern={look.pattern} u={u} />}
        <clipPath id={clipId}>
          <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={rx} />
        </clipPath>
      </defs>
      {(bp || ghost) && <path d={`M4 ${g.ground}H${VB_W - 4}`} stroke={ink} strokeOpacity=".5" strokeWidth={1} strokeDasharray={bp ? "3 3" : undefined} />}
      {!bp && !ghost && <ellipse cx={g.cx} cy={g.ground + 1.2} rx={t.w * 0.95} ry={2.4} fill="#1c2440" opacity=".14" />}
      {/* arms: joints locked by design, drawn hanging */}
      {g.arms.map((a, i) => (
        <g key={`arm${i}`}>
          <path d={`M${a.shoulder[0]} ${a.shoulder[1]}L${a.hand[0]} ${a.hand[1]}`} stroke={bp || ghost ? ink : "#1c2440"} strokeWidth={bp || ghost ? armW : armW + 2.2} strokeLinecap="round" strokeDasharray={bp ? "3 2.4" : undefined} />
          {!bp && !ghost && <path d={`M${a.shoulder[0]} ${a.shoulder[1]}L${a.hand[0]} ${a.hand[1]}`} stroke={shade(pal.limbs, -0.08)} strokeWidth={armW} strokeLinecap="round" />}
        </g>
      ))}
      {/* legs */}
      {g.legs.map((l, i) => (
        <g key={`leg${i}`}>
          <path d={legPath(l)} fill="none" stroke={bp || ghost ? ink : "#1c2440"} strokeWidth={bp || ghost ? limbW : limbW + 2.4} strokeLinecap="round" strokeLinejoin="round" />
          {!bp && !ghost && <path d={legPath(l)} fill="none" stroke={pal.limbs} strokeWidth={limbW} strokeLinecap="round" strokeLinejoin="round" />}
          <rect x={l.foot.x} y={l.foot.y} width={l.foot.w} height={l.foot.h} rx={Math.min(2, l.foot.h / 2)} fill={fill(pal.feet)} stroke={ink} strokeWidth={1.4} />
          <circle cx={l.knee[0]} cy={l.knee[1]} r={jointR} fill={bp ? "#1e4e95" : ghost ? "none" : pal.joints} stroke={ink} strokeWidth={1.3} />
          <circle cx={l.hip[0]} cy={l.hip[1]} r={jointR} fill={bp ? "#1e4e95" : ghost ? "none" : pal.joints} stroke={ink} strokeWidth={1.3} />
          <circle cx={l.ankle[0]} cy={l.ankle[1]} r={jointR * 0.8} fill={bp ? "#1e4e95" : ghost ? "none" : pal.joints} stroke={ink} strokeWidth={1.2} />
        </g>
      ))}
      <rect x={g.pelvis.x} y={g.pelvis.y} width={g.pelvis.w} height={g.pelvis.h} rx={g.pelvis.h / 2} fill={fill(pal.joints)} stroke={ink} strokeWidth={1.4} />
      {/* torso */}
      <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={rx} fill={fill(pal.body)} stroke={ink} strokeWidth={bp ? 1.6 : 2} />
      {!bp && !ghost && look.pattern && <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={rx} fill={`url(#${patternId})`} clipPath={`url(#${clipId})`} />}
      {!bp && !ghost && look.shell && <rect x={t.x + t.w * 0.16} y={t.y + t.h * 0.14} width={t.w * 0.68 * look.shell.size} height={t.h * 0.5} rx={t.w * 0.16} fill={look.shell.color} stroke="#1c2440" strokeWidth={1.3} />}
      {!bp && !ghost && <path d={`M${t.x + t.w * 0.2} ${t.y + t.h * 0.16}v${t.h * 0.42}`} stroke="#fff" strokeOpacity=".4" strokeWidth={clamp(t.w * 0.07, 1.2, 2.4)} strokeLinecap="round" />}
      {/* head */}
      <rect x={headRect.x} y={headRect.y} width={headRect.w} height={headRect.h} rx={g.head.r * 0.62} fill={fill(pal.body)} stroke={ink} strokeWidth={bp ? 1.5 : 1.8} />
      {!bp && !ghost && <FrontEyes kind={look.eyes} cx={g.head.cx} cy={g.head.cy + g.head.r * 0.05} r={g.head.r * 0.42} color={look.eyeColor} />}
      {bp && <path d={`M${g.head.cx - 3} ${g.head.cy}h6M${g.head.cx} ${g.head.cy - 3}v6`} stroke={ink} strokeWidth={0.9} />}
      {!bp && !ghost && look.accessories.filter(a => a.kind !== "wings" && a.kind !== "tail").map((a, i) => <Accessory key={`a${i}`} item={a} t={headRect} u={headRect.h} />)}
    </g>
  );
}

export function CreatureGlyph({ design, look, mode = "toy", dims = false, exact = false, title, className = "", width, height, ...rest }) {
  const real = normalizeShape(design);
  // Toy thumbnails get friendlier proportions (shorter legs, chunkier body)
  // so they read at 60px; blueprint mode (and `exact`) keep the design's.
  const shape = real.plan === "quadruped" && mode !== "blueprint" && !exact ? { ...real, upperLeg: real.upperLeg * 0.74, lowerLeg: real.lowerLeg * 0.74, torsoHeight: real.torsoHeight * 1.4 } : real.plan === "wheeled" && mode !== "blueprint" && !exact ? { ...real, bodyHeight: real.bodyHeight * 1.25, wheelRadius: real.wheelRadius * 1.08 } : real;
  const lk = lookForGlyph(look);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const labelled = typeof title === "string" && title;
  return (
    <svg
      className={`cl-glyph cl-glyph--${mode} ${className}`.trim()}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width={width}
      height={height}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : "true"}
      focusable="false"
      {...rest}
    >
      {shape.plan === "multileg" ? (
        <Multileg shape={shape} look={lk} mode={mode} uid={uid} />
      ) : shape.plan === "wheeled" ? (
        <Wheeled shape={shape} look={lk} mode={mode} uid={uid} />
      ) : shape.plan === "humanoid" ? (
        <Humanoid shape={shape} look={lk} mode={mode} uid={uid} />
      ) : (
        <Quadruped shape={shape} look={lk} mode={mode} uid={uid} dims={dims} />
      )}
    </svg>
  );
}

/** One-line description of a design's body plan, e.g. "6 legs, all around". */
export function describePlan(design) {
  const shape = normalizeShape(design);
  if (shape.plan === "multileg") return `${shape.legCount} legs, ${shape.arrangement === "bilateral" ? "in pairs" : "all around"}`;
  if (shape.plan === "wheeled") return "2 wheel-legs, self-balancing";
  if (shape.plan === "humanoid") return "2 legs, flat feet";
  return "4 legs";
}

export default CreatureGlyph;
