// Terrain Lab data helpers (pure, no React).
//
// Three inputs meet here:
//   lanes      the Terrain Lab course (flat, rubble, step 6/12/18 cm,
//              gap 0.20/0.35/0.50 m, slope 12°/20°)
//   trials     qa/terrain-trials.json: what each robot actually did
//   profile    body.json terrainProfile: what its structure predicts
//
// Readers are lenient about field names because the trial runner and the
// morphology contract are written in parallel; see contracts/ui-kit.md for
// the shapes the kit expects. Measured results always come from trials;
// predictions only from the profile. Nothing here invents a measurement.
import { isNum } from "./format.js";

export const TERRAIN_GROUPS = [
  { id: "flat", label: "Flat sprint", short: "Flat", icon: "terrain-flat", tests: "Top speed on level ground." },
  { id: "rubble", label: "Rubble", short: "Rubble", icon: "terrain-rubble", tests: "Scattered blocks 2–6 cm high: ground clearance, foot placement and wheel size." },
  { id: "step", label: "Step-up", short: "Step", icon: "terrain-step", tests: "One step up: how high a foot can lift, how big the wheel is, or whether it can jump." },
  { id: "gap", label: "Gap", short: "Gap", icon: "terrain-gap", tests: "A pit 0.6 m deep: bridge it with a long leg span or clear it with a jump. Falling in ends the run." },
  { id: "slope", label: "Slope", short: "Slope", icon: "terrain-slope", tests: "A ramp: grip (friction) and tipping (how high the center of mass sits over the footprint)." },
];
const GROUP = Object.fromEntries(TERRAIN_GROUPS.map(g => [g.id, g]));

const KINDS = ["flat", "rubble", "step", "gap", "slope"];
const num = v => (isNum(v) ? v : null);
const str = v => (typeof v === "string" && v.trim() ? v.trim() : null);
const fmtM = v => `${v.toFixed(2)} m`;
const fmtCm = v => `${Math.round(v * 100)} cm`;

function inferKind(raw) {
  const text = String(raw.kind || raw.type || raw.id || "").toLowerCase();
  const kind = KINDS.find(k => text.includes(k));
  if (kind) return kind;
  if (text.includes("ramp")) return "slope";
  if (text.includes("pit")) return "gap";
  return "flat";
}

function numberInId(id) {
  const m = String(id || "").match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

/** Lane from the trials file (or an id like "step-12" / "gap_0.35") with sizes in SI units. */
export function normalizeLane(raw) {
  const r = typeof raw === "string" ? { id: raw } : raw || {};
  const kind = inferKind(r);
  const n = numberInId(r.id);
  const lane = { id: String(r.id || kind), kind, group: kind, label: str(r.label) || GROUP[kind].short };
  if (kind === "step") {
    lane.heightM = num(r.heightM) ?? num(r.height) ?? (isNum(n) ? (n > 1 ? n / 100 : n) : 0.06);
    lane.demand = lane.heightM;
    lane.size = fmtCm(lane.heightM);
  } else if (kind === "gap") {
    lane.widthM = num(r.widthM) ?? num(r.width) ?? (isNum(n) ? (n > 2 ? n / 100 : n) : 0.2);
    lane.pitDepthM = num(r.pitDepthM) ?? num(r.depthM) ?? 0.6;
    lane.demand = lane.widthM;
    lane.size = fmtM(lane.widthM);
  } else if (kind === "slope") {
    lane.deg = num(r.deg) ?? num(r.slopeDeg) ?? num(r.angleDeg) ?? (isNum(n) ? n : 12);
    lane.demand = lane.deg;
    lane.size = `${Math.round(lane.deg)}°`;
  } else if (kind === "rubble") {
    lane.minM = num(r.minM) ?? num(r.minHeightM) ?? 0.02;
    lane.maxM = num(r.maxM) ?? num(r.maxHeightM) ?? 0.06;
    lane.demand = lane.maxM;
    lane.size = `${Math.round(lane.minM * 100)}–${Math.round(lane.maxM * 100)} cm`;
  } else {
    lane.lengthM = num(r.lengthM) ?? num(r.length) ?? 5;
    lane.demand = null;
    lane.size = `${lane.lengthM % 1 ? lane.lengthM.toFixed(1) : lane.lengthM} m`;
  }
  lane.key = `${kind}:${isNum(lane.demand) ? +lane.demand.toFixed(3) : "-"}`;
  lane.title = `${GROUP[kind].short} ${lane.size}`;
  return lane;
}

export const TERRAIN_LANES = [
  { id: "flat", kind: "flat", lengthM: 5 },
  { id: "rubble", kind: "rubble", minM: 0.02, maxM: 0.06 },
  { id: "step-6", kind: "step", heightM: 0.06 },
  { id: "step-12", kind: "step", heightM: 0.12 },
  { id: "step-18", kind: "step", heightM: 0.18 },
  { id: "gap-20", kind: "gap", widthM: 0.2 },
  { id: "gap-35", kind: "gap", widthM: 0.35 },
  { id: "gap-50", kind: "gap", widthM: 0.5 },
  { id: "slope-12", kind: "slope", deg: 12 },
  { id: "slope-20", kind: "slope", deg: 20 },
].map(normalizeLane);

const RESULT_WORDS = [
  ["pass", /^(pass|passed|success|succeeded|ok|crossed|arrived|goal|finished|true)$/],
  ["fall", /(fall|fell|tip|pit|flip|overturn)/],
  ["fail", /(fail|stuck|block|stall|timeout|timed|slid|slip|false|stopp)/],
];
function resultOf(value) {
  const v = String(value ?? "").toLowerCase();
  for (const [result, re] of RESULT_WORDS) if (re.test(v)) return result;
  return "none";
}

/** One trial run: { result: pass | fail | fall | none, seconds, progress, failedAt, usedJump, why, note }. */
export function normalizeTrial(t = {}) {
  const raw = t.result ?? t.outcome ?? t.status ?? (t.pass === true ? "pass" : t.pass === false ? (t.fell ? "fall" : "fail") : null);
  return {
    result: resultOf(raw),
    seconds: num(t.seconds) ?? num(t.timeS) ?? num(t.time),
    progress: num(t.progress),
    failedAt: str(t.failedAt) ?? str(t.where) ?? str(t.location),
    usedJump: !!(t.usedJump ?? t.jumped ?? t.jump),
    reason: str(t.reason),
    why: str(t.why) ?? str(t.explanation),
    note: str(t.note),
  };
}

/**
 * Reads qa/terrain-trials.json. Accepts
 *   { lanes?, robots: { <robotId>: { trials: { <laneId>: trial } } } }
 *   { lanes?, robots: { <robotId>: { <laneId>: trial } } }
 *   { lanes?, trials | results: [ { robot, lane | terrain, ...trial } ] }
 * and returns { lanes, robots: { <robotId>: { <laneId>: trial } }, meta }.
 */
export function normalizeTrials(file) {
  if (file && file.__normalized) return file;
  const src = file && typeof file === "object" ? file : {};
  const lanes = Array.isArray(src.lanes) && src.lanes.length ? src.lanes.map(normalizeLane) : TERRAIN_LANES;
  const byId = new Map(lanes.map(l => [l.id, l]));
  const byKey = new Map(lanes.map(l => [l.key, l]));
  const resolve = id => byId.get(String(id)) || byKey.get(normalizeLane({ id: String(id) }).key) || null;
  const robots = {};
  const put = (robotId, laneId, raw) => {
    const lane = resolve(laneId);
    if (!lane || !robotId || !raw || typeof raw !== "object") return;
    (robots[robotId] ||= {})[lane.id] = normalizeTrial(raw);
  };
  const list = Array.isArray(src.trials) ? src.trials : Array.isArray(src.results) ? src.results : [];
  list.forEach(t => put(t.robot ?? t.robotId ?? t.pilot, t.lane ?? t.laneId ?? t.terrain, t));
  if (src.robots && typeof src.robots === "object") {
    for (const [robotId, entry] of Object.entries(src.robots)) {
      const trials = entry?.trials ?? entry?.lanes ?? entry;
      if (Array.isArray(trials)) trials.forEach(t => put(robotId, t.lane ?? t.laneId ?? t.terrain ?? t.id, t));
      else if (trials && typeof trials === "object") Object.entries(trials).forEach(([laneId, t]) => put(robotId, laneId, t));
    }
  }
  return { __normalized: true, lanes, robots, meta: { schema: src.schema ?? null, generatedAt: src.generatedAt ?? null, method: str(src.method), source: str(src.source) } };
}

/* ---------------- structure profile ---------------- */

const ALIASES = {
  groundClearanceM: ["groundClearanceM", "groundClearance", "clearanceM"],
  legSpanM: ["legSpanM", "legSpan", "footSpanM"],
  strideM: ["strideM", "maxStrideM", "maxFootReachM", "footReachM", "stride"],
  comHeightM: ["comHeightM", "comHeight", "centerOfMassHeightM"],
  wheelRadiusM: ["wheelRadiusM", "wheelRadius", "wheel.radiusM"],
  supportAreaM2: ["supportPolygon.areaM2", "supportAreaM2", "supportPolygonAreaM2"],
  stabilityMarginM: ["supportPolygon.marginM", "supportPolygon.stabilityMarginM", "stabilityMarginM"],
  maxStepUpM: ["predicted.maxStepUpM", "limits.maxStepUpM", "maxStepUpM"],
  jumpApexM: ["predicted.jumpApexM", "limits.jumpApexM", "jumpApexM"],
  maxGapWalkM: ["predicted.maxGapWalkM", "predicted.maxGapByWalkingM", "limits.maxGapWalkM", "maxGapWalkM"],
  maxGapJumpM: ["predicted.maxGapJumpM", "predicted.maxGapByJumpingM", "limits.maxGapJumpM", "maxGapJumpM"],
  maxSlopeDeg: ["predicted.maxSlopeDeg", "limits.maxSlopeDeg", "maxSlopeDeg"],
  maxRubbleM: ["predicted.maxRubbleM", "predicted.maxObstacleM", "limits.maxRubbleM", "maxRubbleM"],
  frictionMu: ["predicted.frictionMu", "frictionMu", "mu"],
};

const dig = (obj, path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

/** { value, formula } for a canonical profile key; values may be numbers or { value, formula }. */
export function profileStat(profile, key) {
  const formulas = profile?.formulas || {};
  for (const path of ALIASES[key] || [key]) {
    const v = dig(profile, path);
    if (isNum(v)) return { value: v, formula: str(formulas[key]) ?? str(formulas[path]) };
    if (v && typeof v === "object" && isNum(v.value)) return { value: v.value, formula: str(v.formula) ?? str(formulas[key]) };
  }
  return { value: null, formula: str(formulas[key]) };
}
export const pv = (profile, key) => profileStat(profile, key).value;

export function contactType(profile) {
  const c = String(profile?.contactType || "").toLowerCase();
  if (c.includes("wheel")) return "wheels";
  if (c.includes("flat")) return "flat-feet";
  if (c) return "point-feet";
  return isNum(pv(profile, "wheelRadiusM")) ? "wheels" : null;
}

export function stabilityOf(profile) {
  const s = profile?.stability ?? profile?.stabilityType;
  if (typeof s === "string") return s.toLowerCase().includes("static") ? "static" : "dynamic";
  if (typeof profile?.staticallyStable === "boolean") return profile.staticallyStable ? "static" : "dynamic";
  return null;
}

/** Torque-to-weight per joint class: [{ joint, value }] (N·m per kg). */
export function torqueToWeight(profile) {
  const t = profile?.torqueToWeight ?? profile?.torqueToWeightNmPerKg;
  if (isNum(t)) return [{ joint: "all", value: t }];
  if (t && typeof t === "object") return Object.entries(t).flatMap(([joint, v]) => (isNum(v) ? [{ joint, value: v }] : isNum(v?.value) ? [{ joint, value: v.value }] : []));
  return [];
}

/* ---------------- predictions vs measurements ---------------- */

function verdictFor(demand, limit, { label, demandLabel, unit, mechanism }) {
  if (!isNum(limit) || !isNum(demand)) return { verdict: "unknown", why: "The structure profile has no number for this yet.", metric: null, mechanism };
  const ratio = demand / Math.max(limit, 1e-6);
  const verdict = ratio <= 0.92 ? "pass" : ratio >= 1.08 ? "fail" : "close";
  const f = v => (unit === "°" ? `${Math.round(v)}°` : fmtM(v));
  const cmp = verdict === "pass" ? ">" : verdict === "fail" ? "<" : "≈";
  return { verdict, mechanism, metric: { label, limit, demand, unit, demandLabel }, why: `${label} ${f(limit)} ${cmp} ${demandLabel} ${f(demand)}` };
}

/**
 * Structure-based prediction for one lane. Uses the jump numbers only when the
 * profile has them (the design asked for a jump); whether the jump policy
 * validated is a measurement question, answered by the trials.
 */
export function predictCell(profile, lane) {
  if (!profile || !lane) return { verdict: "unknown", why: "No structure profile yet.", metric: null };
  const wheels = contactType(profile) === "wheels";
  switch (lane.kind) {
    case "flat":
      return { verdict: "pass", why: "Level ground: any working gait crosses it.", metric: null, mechanism: wheels ? "drive" : "walk" };
    case "rubble": {
      let limit = pv(profile, "maxRubbleM");
      let label = "handles bumps up to";
      if (!isNum(limit) && wheels && isNum(pv(profile, "wheelRadiusM"))) {
        limit = pv(profile, "wheelRadiusM") * 0.5;
        label = "half its wheel radius";
      } else if (!isNum(limit)) {
        limit = pv(profile, "maxStepUpM");
        label = "step-up limit";
      }
      return verdictFor(lane.maxM, limit, { label, demandLabel: "blocks", unit: "m", mechanism: wheels ? "drive" : "walk" });
    }
    case "step": {
      const climb = pv(profile, "maxStepUpM");
      const apex = pv(profile, "jumpApexM");
      const jump = isNum(apex) && (!isNum(climb) || apex > climb);
      return verdictFor(lane.heightM, jump ? apex : climb, { label: jump ? "jump apex" : "step-up limit", demandLabel: "step", unit: "m", mechanism: jump ? "jump" : wheels ? "drive" : "walk" });
    }
    case "gap": {
      const bridge = pv(profile, "maxGapWalkM");
      const leap = pv(profile, "maxGapJumpM");
      const jump = isNum(leap) && (!isNum(bridge) || leap > bridge);
      return verdictFor(lane.widthM, jump ? leap : bridge, { label: jump ? "jump clears" : wheels ? "wheels bridge" : "legs bridge", demandLabel: "gap", unit: "m", mechanism: jump ? "jump" : wheels ? "drive" : "walk" });
    }
    case "slope":
      return verdictFor(lane.deg, pv(profile, "maxSlopeDeg"), { label: "max slope", demandLabel: "ramp", unit: "°", mechanism: wheels ? "drive" : "walk" });
    default:
      return { verdict: "unknown", why: "Unknown lane.", metric: null };
  }
}

/** Short, plain description of what happened in a run. */
export function measuredPhrase(trial, lane, profile) {
  if (!trial || trial.result === "none") return "Not run yet";
  const wheels = contactType(profile) === "wheels";
  if (trial.result === "pass") {
    if (trial.usedJump) return lane.kind === "gap" ? "Jumped across" : lane.kind === "step" ? "Jumped up" : "Made it, with a jump";
    switch (lane.kind) {
      case "gap":
        return wheels ? "Rolled across" : "Walked across";
      case "step":
        return wheels ? "Rolled up" : "Stepped up";
      case "slope":
        return wheels ? "Drove up" : "Climbed it";
      case "rubble":
        return wheels ? "Bumped through" : "Picked through";
      default:
        return "Crossed";
    }
  }
  if (trial.result === "fall") return lane.kind === "gap" ? "Fell into the pit" : lane.kind === "slope" ? "Tipped on the ramp" : "Tipped over";
  const at = isNum(trial.progress) ? ` at ${Math.round(trial.progress * 100)}%` : "";
  switch (lane.kind) {
    case "step":
      return "Blocked at the step";
    case "gap":
      return "Stopped at the edge";
    case "slope":
      return `Slid back${at}`;
    case "rubble":
      return `Stuck${at}`;
    default:
      return `Stalled${at}`;
  }
}

/** agree | better | worse | close | n/a: how the run compares with the prediction. */
export function agreement(trial, prediction) {
  if (!trial || trial.result === "none" || !prediction || prediction.verdict === "unknown") return "n/a";
  if (prediction.verdict === "close") return "close";
  const passed = trial.result === "pass";
  if (passed === (prediction.verdict === "pass")) return "agree";
  return passed ? "better" : "worse";
}

const lowerFirst = s => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** One-line "why" for a cell, e.g. "Octo: walked across — legs bridge 0.40 m > gap 0.35 m". */
export function whyLine(name, trial, prediction, lane, profile) {
  if (trial?.why) return trial.why.includes(":") || !name ? trial.why : `${name}: ${trial.why}`;
  const phrase = measuredPhrase(trial, lane, profile);
  const lead = name ? `${name}: ${lowerFirst(phrase)}` : phrase;
  if (!prediction || prediction.verdict === "unknown") return lead;
  const fit = agreement(trial, prediction);
  if (fit === "worse") return `${lead}, though its structure says it should (${prediction.why})`;
  if (fit === "better") return `${lead}, beating its structure's prediction (${prediction.why})`;
  if (fit === "n/a") return `${lead}. Structure predicts ${prediction.verdict === "pass" ? "a pass" : prediction.verdict === "fail" ? "no pass" : "a close call"}: ${prediction.why}`;
  return `${lead} — ${prediction.why}`;
}

export const RESULT_LABEL = { pass: "Crossed", fail: "Blocked", fall: "Fell", none: "Not run" };
export const VERDICT_LABEL = { pass: "should cross", fail: "shouldn't cross", close: "close call", unknown: "no prediction" };

/** Everything one matrix cell needs. */
export function cellFor({ robot, lane, trials }) {
  const t = normalizeTrials(trials);
  const trial = t.robots?.[robot.id]?.[lane.id] || null;
  const profile = robot.terrainProfile || robot.body?.terrainProfile || null;
  const prediction = predictCell(profile, lane);
  const fit = agreement(trial, prediction);
  return { robot, lane, trial, profile, prediction, fit, phrase: measuredPhrase(trial, lane, profile), why: whyLine(robot.name, trial, prediction, lane, profile) };
}

/**
 * Up to `max` lane ids a robot is best at, from measured trials: lanes it
 * passes that few others pass, preferring the hardest grade of each group,
 * then the fastest time.
 */
export function bestAtFromTrials(trials, robotId, max = 3) {
  const t = normalizeTrials(trials);
  const mine = t.robots?.[robotId];
  if (!mine) return [];
  const others = Object.keys(t.robots).filter(id => id !== robotId);
  const scored = [];
  for (const group of TERRAIN_GROUPS) {
    const lanes = t.lanes.filter(l => l.group === group.id && mine[l.id]?.result === "pass");
    if (!lanes.length) continue;
    const lane = lanes.reduce((a, b) => ((b.demand ?? 0) > (a.demand ?? 0) ? b : a));
    const passers = others.filter(id => t.robots[id]?.[lane.id]?.result === "pass");
    const mySec = mine[lane.id].seconds;
    const fastest = isNum(mySec) && passers.every(id => !isNum(t.robots[id][lane.id].seconds) || t.robots[id][lane.id].seconds >= mySec);
    scored.push({ id: lane.id, score: others.length - passers.length + (fastest ? 0.75 : 0) + (lane.demand ? 0.01 : 0) });
  }
  return scored
    .filter(s => s.score >= 0.75)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(s => s.id);
}

export const laneById = (lanes, id) => (lanes || TERRAIN_LANES).find(l => l.id === id) || normalizeLane({ id });
export const groupOf = lane => GROUP[lane?.group] || GROUP.flat;
