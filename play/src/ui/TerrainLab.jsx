// TerrainLab: how structure meets terrain. A capability matrix (robots ×
// lanes) shows each MEASURED run from qa/terrain-trials.json next to the
// structure-based PREDICTION from body.json terrainProfile; picking a cell
// opens a to-scale diagram with the one-line "why", and a structure card
// explains the numbers that decide it. Surprises (prediction missed) are
// flagged, never hidden.
import { useMemo, useState } from "react";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { Button, cx } from "./primitives.jsx";
import { fixed, isNum } from "./format.js";
import { RESULT_LABEL, TERRAIN_GROUPS, VERDICT_LABEL, cellFor, contactType, groupOf, normalizeTrials, profileStat, stabilityOf, torqueToWeight } from "./terrain.js";

const RESULT_ICON = { pass: "check", fail: "minus", fall: "arrow-down", none: "more" };
const VERDICT_ICON = { pass: "check", fail: "close", close: "help", unknown: "more" };

function cellLabel(c) {
  const time = isNum(c.trial?.seconds) && c.trial.result === "pass" ? ` in ${c.trial.seconds.toFixed(1)} seconds` : "";
  const surprise = c.fit === "worse" || c.fit === "better" ? " Surprise: the prediction missed." : "";
  return `${c.robot.name}, ${c.lane.title}: ${c.phrase}${time}. Structure: ${VERDICT_LABEL[c.prediction.verdict]}.${surprise}`;
}

/* ---------- to-scale "structure meets terrain" diagram ---------- */
function TerrainDiagram({ cell }) {
  const { lane, profile, prediction, trial } = cell;
  const W = 420;
  const H = 190;
  const groundY = 140;
  const ok = trial?.result === "pass";
  const metric = prediction.metric;
  const wheels = contactType(profile) === "wheels";
  const r = profileStat(profile, "wheelRadiusM").value;
  let scene = null;
  if (lane.kind === "gap") {
    const span = Math.max(lane.widthM, metric?.limit || 0) + 0.5;
    const s = (W - 60) / span;
    const x0 = 30 + 0.25 * s;
    const x1 = x0 + lane.widthM * s;
    const reach = isNum(metric?.limit) ? metric.limit * s : 0;
    scene = (
      <>
        <path d={`M14 ${groundY}H${x0}V${H - 8}M${x1} ${H - 8}V${groundY}H${W - 14}`} className="cl-tdraw__terrain" />
        <path d={`M${x0} ${H - 22}l6 -5 6 5 6 -5`} className="cl-tdraw__break" />
        <text x={(x0 + x1) / 2} y={H - 10} textAnchor="middle" className="cl-tdraw__dim">pit {fixed(lane.pitDepthM, 1, "m")} deep</text>
        <path d={`M${x0} ${groundY - 12}H${x1}`} className="cl-tdraw__dimline" />
        <text x={(x0 + x1) / 2} y={groundY - 17} textAnchor="middle" className="cl-tdraw__dim">gap {fixed(lane.widthM, 2, "m")}</text>
        {reach > 0 &&
          (prediction.mechanism === "jump" ? (
            <path d={`M${x0 - 4} ${groundY - 2}Q${x0 - 4 + reach / 2} ${groundY - 2 - Math.min(80, reach * 0.55)} ${x0 - 4 + reach} ${groundY - 2}`} className="cl-tdraw__robot cl-tdraw__robot--dash" />
          ) : (
            <g>
              <path d={`M${x0 - reach * 0.18} ${groundY - 38}h${reach}`} className="cl-tdraw__robot" />
              <circle cx={x0 - reach * 0.18} cy={groundY - 38} r="4" className="cl-tdraw__foot" />
              <circle cx={x0 - reach * 0.18 + reach} cy={groundY - 38} r="4" className="cl-tdraw__foot" />
            </g>
          ))}
        {reach > 0 && (
          <text x={x0 - 4 + reach / 2} y={prediction.mechanism === "jump" ? groundY - 8 - Math.min(80, reach * 0.55) : groundY - 46} textAnchor="middle" className="cl-tdraw__mark">
            {metric.label} {fixed(metric.limit, 2, "m")}
          </text>
        )}
      </>
    );
  } else if (lane.kind === "step" || lane.kind === "rubble") {
    const h = lane.kind === "step" ? lane.heightM : lane.maxM;
    const top = Math.max(h, metric?.limit || 0, wheels && isNum(r) ? r * 2 : 0) + 0.06;
    const s = Math.min(560, (groundY - 30) / top);
    const sx = W * 0.55;
    const limitY = isNum(metric?.limit) ? groundY - metric.limit * s : null;
    scene = (
      <>
        {lane.kind === "step" ? (
          <path d={`M14 ${groundY}H${sx}V${groundY - h * s}H${W - 14}`} className="cl-tdraw__terrain" />
        ) : (
          <>
            <path d={`M14 ${groundY}H${W - 14}`} className="cl-tdraw__terrain" />
            {[0.02, 0.05, 0.03, 0.06, 0.04].map((bh, i) => (
              <rect key={i} x={sx - 60 + i * 34} y={groundY - bh * s} width={22} height={bh * s} className="cl-tdraw__block" />
            ))}
          </>
        )}
        <path d={`M${sx + (lane.kind === "step" ? 18 : 120)} ${groundY}V${groundY - h * s}`} className="cl-tdraw__dimline" />
        <text x={sx + (lane.kind === "step" ? 24 : 126)} y={groundY - (h * s) / 2 + 4} className="cl-tdraw__dim">{lane.kind === "step" ? `step ${Math.round(h * 100)} cm` : `blocks to ${Math.round(h * 100)} cm`}</text>
        {wheels && isNum(r) && <circle cx={sx - (lane.kind === "step" ? r * s : 80)} cy={groundY - r * s} r={r * s} className="cl-tdraw__robot" />}
        {limitY !== null && (
          <>
            <path d={`M28 ${limitY}H${sx + 8}`} className="cl-tdraw__robot cl-tdraw__robot--dash" />
            <text x="30" y={limitY - 6} className="cl-tdraw__mark">
              {metric.label} {fixed(metric.limit, 2, "m")}
            </text>
          </>
        )}
      </>
    );
  } else if (lane.kind === "slope") {
    const rad = (lane.deg * Math.PI) / 180;
    const run = W - 90;
    const lim = isNum(metric?.limit) ? (metric.limit * Math.PI) / 180 : null;
    scene = (
      <>
        <path d={`M30 ${groundY}H${30 + run}V${groundY - Math.tan(rad) * run}Z`} className="cl-tdraw__terrain cl-tdraw__terrain--fill" />
        <text x="96" y={groundY - 6} className="cl-tdraw__dim">ramp {Math.round(lane.deg)}°</text>
        {lim !== null && (
          <>
            <path d={`M30 ${groundY}L${30 + run} ${groundY - Math.tan(lim) * run}`} className="cl-tdraw__robot cl-tdraw__robot--dash" />
            <text x={30 + run - 6} y={groundY - Math.tan(lim) * run - 8} textAnchor="end" className="cl-tdraw__mark">
              {metric.label} {Math.round(metric.limit)}°
            </text>
          </>
        )}
      </>
    );
  } else {
    const s = (W - 60) / lane.lengthM;
    scene = (
      <>
        <path d={`M14 ${groundY}H${W - 14}`} className="cl-tdraw__terrain" />
        <path d={`M30 ${groundY}V${groundY - 46}M${30 + lane.lengthM * s} ${groundY}V${groundY - 46}`} className="cl-tdraw__dimline" />
        <text x={W / 2} y={groundY - 24} textAnchor="middle" className="cl-tdraw__dim">{lane.size} sprint</text>
        {isNum(trial?.seconds) && ok && (
          <text x={W / 2} y={groundY - 54} textAnchor="middle" className="cl-tdraw__mark">
            {(lane.lengthM / trial.seconds).toFixed(2)} m/s average
          </text>
        )}
      </>
    );
  }
  return (
    <svg className="cl-tdraw" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`To-scale sketch of ${lane.title}${metric ? ` against ${cell.robot.name}'s ${metric.label}` : ""}.`}>
      {scene}
    </svg>
  );
}

/* ---------- structure card ---------- */
const STATS = [
  { key: "groundClearanceM", label: "Ground clearance", icon: "clearance", unit: "m", why: "Bumps lower than this pass under the body." },
  { key: "legSpanM", label: "Leg span", icon: "span", unit: "m", why: "Front-to-rear contact distance. Long spans bridge gaps." },
  { key: "strideM", label: "Stride", icon: "walk", unit: "m", why: "How far one step can reach." },
  { key: "comHeightM", label: "Center of mass height", icon: "com", unit: "m", why: "Lower is harder to tip." },
  { key: "wheelRadiusM", label: "Wheel radius", icon: "wheel", unit: "m", why: "Bigger wheels roll over bigger bumps." },
];

function Footprint({ robot }) {
  const p = robot.terrainProfile || {};
  const plan = robot.design?.bodyPlan;
  const span = profileStat(p, "legSpanM").value || 0;
  const width = p.stanceWidthM || p.trackWidthM || (plan === "multileg" ? span : 0.24);
  const margin = profileStat(p, "stabilityMarginM").value || 0;
  const S = 120 / Math.max(0.7, span, width);
  const c = 70;
  let shape;
  if (plan === "multileg") {
    const n = robot.design?.multileg?.legCount || 8;
    const pts = Array.from({ length: n }, (_, i) => {
      const a = Math.PI / n + (i * 2 * Math.PI) / n;
      return [c + Math.cos(a) * (span / 2) * S, c + Math.sin(a) * (span / 2) * S];
    });
    shape = <polygon points={pts.map(q => q.join(",")).join(" ")} className="cl-foot__poly" />;
  } else if (plan === "wheeled") {
    shape = <path d={`M${c} ${c - (width / 2) * S}V${c + (width / 2) * S}`} className="cl-foot__line" />;
  } else {
    const hw = (width / 2) * S;
    const hl = (Math.max(span, 0.04) / 2) * S;
    shape = <rect x={c - hl} y={c - hw} width={hl * 2} height={hw * 2} className="cl-foot__poly" />;
  }
  return (
    <svg className="cl-foot" viewBox="0 0 140 140" role="img" aria-label={`Footprint seen from above. Stability margin ${fixed(margin, 2, "m")}.`}>
      {shape}
      {margin > 0 && <circle cx={c} cy={c} r={margin * S} className="cl-foot__margin" />}
      <circle cx={c} cy={c} r="4.5" className="cl-foot__com" />
      <text x="70" y="134" textAnchor="middle" className="cl-foot__note">
        {margin > 0 ? `margin ${fixed(margin, 2, "m")}` : "a line: must balance"}
      </text>
    </svg>
  );
}

export function StructureCard({ robot }) {
  const p = robot.terrainProfile || robot.body?.terrainProfile;
  if (!p) return <p className="cl-hint">No structure profile for {robot.name} yet.</p>;
  const contact = contactType(p);
  const stability = stabilityOf(p);
  const ttw = torqueToWeight(p);
  const area = profileStat(p, "supportAreaM2");
  return (
    <section className="cl-struct" aria-label={`${robot.name}'s structure`}>
      <header className="cl-struct__head">
        <span className="cl-struct__art" aria-hidden="true">
          <CreatureGlyph design={robot.design} look={robot.look} mode="blueprint" exact />
        </span>
        <div>
          <h3 className="cl-struct__title">{robot.name}'s structure</h3>
          <p className="cl-struct__tags">
            <span>{contact === "wheels" ? "Wheels" : contact === "flat-feet" ? "Flat feet" : "Point feet"}</span>
            {stability && <span>{stability === "static" ? "Statically stable" : "Dynamically balanced"}</span>}
          </p>
        </div>
      </header>
      <div className="cl-struct__grid">
        <Footprint robot={robot} />
        <dl className="cl-struct__stats">
          {STATS.map(s => {
            const st = profileStat(p, s.key);
            if (!isNum(st.value) || (s.key === "wheelRadiusM" && contact !== "wheels")) return null;
            return (
              <div key={s.key} title={st.formula || undefined}>
                <dt>
                  <Icon name={s.icon} size={15} /> {s.label}
                </dt>
                <dd className="cl-mono">{fixed(st.value, 2, s.unit)}</dd>
                <dd className="cl-struct__why">{s.why}</dd>
              </div>
            );
          })}
          {isNum(area.value) && (
            <div title={p.formulas?.supportPolygon || undefined}>
              <dt>
                <Icon name="footprint" size={15} /> Support polygon
              </dt>
              <dd className="cl-mono">{area.value > 0 ? `${area.value.toFixed(3)} m²` : "0 (a line)"}</dd>
              <dd className="cl-struct__why">Area inside the contacts. Bigger and wider is steadier.</dd>
            </div>
          )}
          {ttw.length > 0 && (
            <div title={p.formulas?.torqueToWeight || undefined}>
              <dt>
                <Icon name="bolt" size={15} /> Torque to weight
              </dt>
              <dd className="cl-mono">{ttw.map(t => `${t.joint} ${t.value.toFixed(1)}`).join(" · ")} N·m/kg</dd>
              <dd className="cl-struct__why">Strength per kilo: decides step-ups and jumps.</dd>
            </div>
          )}
        </dl>
      </div>
      {p.formulas && (
        <details className="cl-struct__formulas">
          <summary>How these numbers are computed</summary>
          <ul>
            {Object.entries(p.formulas).map(([k, f]) => (
              <li key={k}>
                <code>{k}</code> {f}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * TerrainLab props:
 *  robots: roster entries (see RobotRoster) with terrainProfile
 *  trials: qa/terrain-trials.json (raw or normalized)
 *  initial: { robotId, laneId }; onTryLane(robotId, laneId)? adds a "Drive it yourself" button
 */
export function TerrainLab({ robots = [], trials, initial, onTryLane }) {
  const t = useMemo(() => normalizeTrials(trials), [trials]);
  const lanes = t.lanes;
  const [sel, setSel] = useState(() => ({ robotId: initial?.robotId || robots[0]?.id, laneId: initial?.laneId || "gap-35" }));
  const robot = robots.find(r => r.id === sel.robotId) || robots[0];
  const lane = lanes.find(l => l.id === sel.laneId) || lanes[0];
  if (!robot || !lane) return <p className="cl-hint">No robots to compare yet.</p>;
  const cell = cellFor({ robot, lane, trials: t });

  function move(event, ri, li) {
    const d = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[event.key];
    if (!d) return;
    event.preventDefault();
    const r = Math.max(0, Math.min(robots.length - 1, ri + d[0]));
    const l = Math.max(0, Math.min(lanes.length - 1, li + d[1]));
    setSel({ robotId: robots[r].id, laneId: lanes[l].id });
    event.currentTarget.closest("table")?.querySelector(`[data-cell="${r}-${l}"]`)?.focus();
  }

  return (
    <div className="cl-tlab">
      <p className="cl-tlab__intro">Same lanes, same start line. Each cell shows what the robot really did, next to what its structure predicts. Pick a cell to see why.</p>
      <ul className="cl-tlab__legend" aria-label="Legend">
        <li><span className="cl-tcell__res is-pass"><Icon name="check" size={13} strokeWidth={3} /></span> Crossed</li>
        <li><span className="cl-tcell__res is-fail"><Icon name="minus" size={13} strokeWidth={3} /></span> Blocked</li>
        <li><span className="cl-tcell__res is-fall"><Icon name="arrow-down" size={13} strokeWidth={3} /></span> Fell</li>
        <li><span className="cl-tcell__pred"><Icon name="check" size={10} strokeWidth={3} /></span> Structure prediction</li>
        <li><span className="cl-tcell__flag">!</span> Surprise</li>
      </ul>
      <div className="cl-tlab__scroll cl-scroll" tabIndex={-1}>
        <table className="cl-tmatrix">
          <caption className="cl-sr-only">Measured terrain trials and structure predictions, robots by lanes</caption>
          <thead>
            <tr>
              <td />
              {TERRAIN_GROUPS.map(g => {
                const n = lanes.filter(l => l.group === g.id).length;
                return n ? (
                  <th key={g.id} scope="colgroup" colSpan={n} className="cl-tmatrix__group" title={g.tests}>
                    <Icon name={g.icon} size={16} /> {g.label}
                  </th>
                ) : null;
              })}
            </tr>
            <tr>
              <td />
              {lanes.map(l => (
                <th key={l.id} scope="col" className="cl-tmatrix__lane cl-mono">
                  <span className="cl-sr-only">{groupOf(l).short} </span>
                  {l.size}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {robots.map((r, ri) => (
              <tr key={r.id}>
                <th scope="row" className="cl-tmatrix__robot">
                  <span className="cl-tmatrix__glyph" aria-hidden="true">
                    <CreatureGlyph design={r.design} look={r.look} />
                  </span>
                  {r.name}
                </th>
                {lanes.map((l, li) => {
                  const c = cellFor({ robot: r, lane: l, trials: t });
                  const res = c.trial?.result || "none";
                  const on = r.id === robot.id && l.id === lane.id;
                  return (
                    <td key={l.id}>
                      <button type="button" data-cell={`${ri}-${li}`} className={cx("cl-tcell", `is-${res}`, on && "is-on")} tabIndex={on ? 0 : -1} aria-current={on ? "true" : undefined} aria-label={cellLabel(c)} onClick={() => setSel({ robotId: r.id, laneId: l.id })} onKeyDown={event => move(event, ri, li)}>
                        <span className={cx("cl-tcell__res", `is-${res}`)}>
                          <Icon name={RESULT_ICON[res]} size={14} strokeWidth={3} />
                        </span>
                        <span className="cl-tcell__time cl-mono">{res === "pass" && isNum(c.trial.seconds) ? `${c.trial.seconds.toFixed(1)}s` : RESULT_LABEL[res]}</span>
                        <span className={cx("cl-tcell__pred", `is-${c.prediction.verdict}`)}>
                          <Icon name={VERDICT_ICON[c.prediction.verdict]} size={10} strokeWidth={3} />
                        </span>
                        {(c.fit === "worse" || c.fit === "better") && <span className="cl-tcell__flag">!</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="cl-tlab__detail">
        <section className="cl-tdetail cl-bp" aria-label={`${robot.name} on ${lane.title}`}>
          <h3 className="cl-tdetail__title">
            <Icon name={groupOf(lane).icon} size={18} /> {robot.name} on {lane.title}
          </h3>
          <TerrainDiagram cell={cell} />
          <p className="cl-tdetail__why">{cell.why}</p>
          <dl className="cl-tdetail__facts">
            <div>
              <dt>Measured</dt>
              <dd>
                {cell.phrase}
                {cell.trial?.result === "pass" && isNum(cell.trial.seconds) ? ` in ${cell.trial.seconds.toFixed(1)} s` : ""}
                {cell.trial?.failedAt && cell.trial.result !== "pass" ? ` (${cell.trial.failedAt})` : ""}
              </dd>
            </div>
            <div>
              <dt>Structure predicts</dt>
              <dd>
                {VERDICT_LABEL[cell.prediction.verdict]}: {cell.prediction.why}
              </dd>
            </div>
            {cell.trial?.note && (
              <div>
                <dt>Run notes</dt>
                <dd>{cell.trial.note}</dd>
              </div>
            )}
          </dl>
          {(cell.fit === "worse" || cell.fit === "better") && (
            <p className="cl-tdetail__surprise">
              <span className="cl-tcell__flag">!</span> {cell.fit === "worse" ? "Did worse than its structure predicts: the trained skill, not the body, is the limit here." : "Did better than predicted: the structure numbers are conservative here."}
            </p>
          )}
          {onTryLane && (
            <Button variant="primary" size="sm" icon="gamepad" onClick={() => onTryLane(robot.id, lane.id)}>
              Drive this lane yourself
            </Button>
          )}
          <p className="cl-tdetail__method">{groupOf(lane).tests}</p>
        </section>
        <StructureCard robot={robot} />
      </div>
      {t.meta.method && <p className="cl-tlab__method">How the runs were made: {t.meta.method}</p>}
    </div>
  );
}

export default TerrainLab;
