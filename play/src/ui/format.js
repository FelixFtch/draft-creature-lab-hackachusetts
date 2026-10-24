// Number and text formatting shared by the kit. Defensive: every helper
// accepts missing or non-finite input and returns a placeholder instead of
// "NaN", because engine snapshots can be partial while things load.

export const DASH = "—";

export const isNum = value => typeof value === "number" && Number.isFinite(value);

export function fixed(value, digits = 2, unit = "") {
  if (!isNum(value)) return DASH;
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}

/** 12,345 / 12.3K / 1.2M — for counters and axis ticks. */
export function compact(value) {
  if (!isNum(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

export function grouped(value) {
  if (!isNum(value)) return DASH;
  return Math.round(value).toLocaleString("en-US");
}

/** "7 min", "45 s", "1 h 05 min" for durations in seconds. */
export function duration(seconds) {
  if (!isNum(seconds) || seconds < 0) return DASH;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** "about 12 min" style estimate for copy; rounds to friendly steps. */
export function aboutMinutes(minutes) {
  if (!isNum(minutes) || minutes <= 0) return null;
  if (minutes < 1.5) return "about a minute";
  if (minutes < 10) return `about ${Math.round(minutes)} min`;
  return `about ${Math.round(minutes / 5) * 5} min`;
}

export function percent(value, digits = 0) {
  if (!isNum(value)) return DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

/** First 7 hex chars of a hash, for display next to a copy button. */
export function shortHash(hash, length = 7) {
  if (typeof hash !== "string" || !hash) return DASH;
  return hash.replace(/^sha256:/, "").slice(0, length);
}

export const clamp = (value, low, high) => Math.min(high, Math.max(low, isNum(value) ? value : low));

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

const ROLE_LABEL = { hip_roll: "hip roll", hip_yaw: "hip yaw", hip_pitch: "hip pitch", knee: "knee" };
export const roleLabel = role => ROLE_LABEL[role] || String(role || "joint").replace(/_/g, " ");

const SIDE = { left: "left", right: "right", center: "middle" };
const END = { front: "front", middle: "middle", rear: "back" };
/** Human leg names from body-contract side/end, with the raw name as fallback. */
export function legLabel(leg, index = 0) {
  if (!leg) return `Leg ${index + 1}`;
  const end = END[leg.end];
  const side = SIDE[leg.side];
  if (end && side && side !== "middle") return `${end[0].toUpperCase()}${end.slice(1)} ${side}`;
  if (end) return `${end[0].toUpperCase()}${end.slice(1)} leg`;
  return leg.name ? `Leg ${leg.name}` : `Leg ${index + 1}`;
}

export function radToDeg(rad) {
  return isNum(rad) ? (rad * 180) / Math.PI : NaN;
}
