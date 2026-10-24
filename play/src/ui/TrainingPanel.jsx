// TrainingPanel: teach skills (walk, jump) with honest states.
//
//   untrained → queued → training (live chart, steps/s, ETA) → validating
//   → ready (eval passed, hash matched)  |  failed (eval rows show why)
//   stale: the body changed after training; unavailable: trainer not running
//
// Nothing here claims a skill works unless state === "ready", which the main
// agent sets only for a hash-matched bundle whose eval.json passed.
import { useId, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { Badge, Button, Callout, ProgressRing, cx } from "./primitives.jsx";
import { aboutMinutes, compact, duration, fixed, grouped, isNum } from "./format.js";

const SKILL_META = {
  walk: { title: "Walk", icon: "walk", verb: "walk", what: "Follows your joystick: forward, back and turning." },
  jump: { title: "Jump", icon: "jump", verb: "jump", what: "A one-shot hop from standing, then back to walking." },
};

const STATE_BADGE = {
  untrained: { tone: "warn", icon: "alert", label: "Untrained" },
  queued: { tone: "info", icon: "clock", label: "Waiting" },
  training: { tone: "info", icon: "train", label: "Practicing" },
  validating: { tone: "info", icon: "check", label: "Checking" },
  ready: { tone: "good", icon: "check", label: "Verified" },
  failed: { tone: "bad", icon: "close", label: "Failed checks" },
  stale: { tone: "warn", icon: "alert", label: "Out of date" },
  unavailable: { tone: "outline", icon: "lock", label: "Unavailable" },
};

/* ---------- live progress chart (single series: practice score) ---------- */
export function TrainingChart({ curve = [], targetSteps, label = "Practice score" }) {
  const [active, setActive] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const wrap = useRef(null);
  const tableId = useId();
  const W = 340;
  const H = 150;
  const m = { l: 34, r: 14, t: 14, b: 24 };
  const pts = curve.filter(p => isNum(p.step) && isNum(p.reward));
  const last = pts[pts.length - 1];
  const xMax = Math.max(isNum(targetSteps) ? targetSteps : 0, last?.step || 1);
  const yVals = pts.map(p => p.reward);
  const yMin = Math.min(0, ...yVals);
  const yMaxRaw = Math.max(1, ...yVals);
  const yStep = niceStep((yMaxRaw - yMin) / 3);
  const yMax = Math.ceil(yMaxRaw / yStep) * yStep;
  const yLo = Math.floor(yMin / yStep) * yStep;
  const x = s => m.l + (s / xMax) * (W - m.l - m.r);
  const y = r => H - m.b - ((r - yLo) / (yMax - yLo || 1)) * (H - m.t - m.b);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.step).toFixed(1)} ${y(p.reward).toFixed(1)}`).join("");
  const area = pts.length ? `${line}L${x(last.step).toFixed(1)} ${y(yLo)}L${x(pts[0].step).toFixed(1)} ${y(yLo)}Z` : "";
  const yTicks = [];
  for (let v = yLo; v <= yMax + 1e-9; v += yStep) yTicks.push(+v.toFixed(6));
  const xStep = niceStep(xMax / 4);
  const xTicks = [];
  for (let v = 0; v <= xMax + 1e-9; v += xStep) xTicks.push(v);
  const shown = active != null ? pts[active] : null;
  const summary = pts.length ? `${label} went from ${fixed(pts[0].reward, 1)} to ${fixed(last.reward, 1)} over ${compact(last.step)} practice steps${isNum(targetSteps) ? ` of ${compact(targetSteps)}` : ""}.` : "No data yet.";

  function pick(clientX) {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect || !pts.length) return;
    const sx = ((clientX - rect.left) / rect.width) * W;
    const step = ((sx - m.l) / (W - m.l - m.r)) * xMax;
    let best = 0;
    pts.forEach((p, i) => {
      if (Math.abs(p.step - step) < Math.abs(pts[best].step - step)) best = i;
    });
    setActive(best);
  }

  return (
    <figure className="cl-tchart">
      <figcaption className="cl-tchart__cap">
        <span>{label}</span>
        {last && <span className="cl-mono cl-tchart__now">now {fixed(last.reward, 1)}</span>}
      </figcaption>
      <div
        ref={wrap}
        className="cl-tchart__plot"
        tabIndex={0}
        role="img"
        aria-label={summary}
        aria-describedby={showTable ? tableId : undefined}
        onPointerMove={event => pick(event.clientX)}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={event => {
          if (!pts.length) return;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setActive(i => Math.min(pts.length - 1, Math.max(0, (i ?? pts.length - 1) + (event.key === "ArrowRight" ? 1 : -1))));
          }
          if (event.key === "Escape") setActive(null);
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {yTicks.map(v => (
            <g key={`y${v}`}>
              <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} className="cl-tchart__grid" />
              <text x={m.l - 6} y={y(v)} textAnchor="end" dominantBaseline="middle" className="cl-tchart__tick">
                {Math.round(v)}
              </text>
            </g>
          ))}
          {xTicks.map(v => (
            <text key={`x${v}`} x={x(v)} y={H - 6} textAnchor={v === 0 ? "start" : "middle"} className="cl-tchart__tick">
              {compact(v)}
            </text>
          ))}
          {last && last.step < xMax && <rect x={x(last.step)} y={m.t} width={x(xMax) - x(last.step)} height={H - m.t - m.b} className="cl-tchart__todo" />}
          <path d={area} className="cl-tchart__area" />
          <path d={line} className="cl-tchart__line" />
          {last && <circle cx={x(last.step)} cy={y(last.reward)} r="5" className="cl-tchart__end" />}
          {shown && (
            <g>
              <line x1={x(shown.step)} x2={x(shown.step)} y1={m.t} y2={H - m.b} className="cl-tchart__cross" />
              <circle cx={x(shown.step)} cy={y(shown.reward)} r="5" className="cl-tchart__dot" />
            </g>
          )}
        </svg>
        {shown && (
          <div className="cl-tchart__tip" style={{ left: `${(x(shown.step) / W) * 100}%`, top: `${(y(shown.reward) / H) * 100}%` }}>
            <strong className="cl-mono">{fixed(shown.reward, 1)}</strong>
            <span>after {compact(shown.step)} steps</span>
          </div>
        )}
      </div>
      <button type="button" className="cl-linkbtn" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable(v => !v)}>
        {showTable ? "Hide numbers" : "Show numbers"}
      </button>
      {showTable && (
        <table id={tableId} className="cl-tchart__table">
          <caption className="cl-sr-only">{label} by practice steps</caption>
          <thead>
            <tr>
              <th scope="col">Steps</th>
              <th scope="col" className="cl-num">
                Score
              </th>
            </tr>
          </thead>
          <tbody>
            {pts
              .filter((_, i) => i % Math.max(1, Math.round(pts.length / 8)) === 0 || i === pts.length - 1)
              .map(p => (
                <tr key={p.step}>
                  <td className="cl-mono">{grouped(p.step)}</td>
                  <td className="cl-num cl-mono">{fixed(p.reward, 1)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}

function niceStep(raw) {
  if (!isNum(raw) || raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/* ---------- eval rows (shown verbatim from eval.json) ---------- */
function cmdText(c) {
  if (!c || typeof c !== "object") return "—";
  const parts = [];
  if (isNum(c.vx) && c.vx !== 0) parts.push(`${c.vx > 0 ? "forward" : "back"} ${fixed(Math.abs(c.vx), 2, "m/s")}`);
  if (isNum(c.wz) && c.wz !== 0) parts.push(`turn ${fixed(Math.abs(c.wz), 2, "rad/s")}`);
  if (c.jump) parts.push("jump");
  return parts.length ? parts.join(", ") : "stand still";
}

function measuredText(row) {
  const v = row.measured;
  if (row.pending) return "…";
  if (!v || typeof v !== "object") return "—";
  if (isNum(v.apexGainM)) return `${fixed(v.apexGainM, 2, "m")} up`;
  if (typeof v.upright === "boolean") return v.upright ? "upright" : "tipped";
  const parts = [];
  if (isNum(v.vx) && (row.command?.vx || !isNum(v.wz))) parts.push(fixed(v.vx, 2, "m/s"));
  if (isNum(v.wz) && row.command?.wz) parts.push(fixed(v.wz, 2, "rad/s"));
  return parts.join(", ") || "—";
}

export function EvalTable({ rows = [], caption = "Checks" }) {
  return (
    <table className="cl-eval">
      <caption className="cl-eval__cap">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Check</th>
          <th scope="col">Measured</th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => {
          const result = row.pending ? "pending" : row.pass ? "pass" : row.fall ? "fell" : "fail";
          return (
            <tr key={row.id || row.name} className={`is-${result}`}>
              <th scope="row">
                {row.name}
                <span className="cl-eval__asked">asked: {cmdText(row.command)}{row.target ? `, target ${row.target}` : ""}</span>
              </th>
              <td className="cl-mono">{measuredText(row)}</td>
              <td>
                <span className={`cl-eval__result cl-eval__result--${result}`}>
                  {result === "pending" ? <span className="cl-spinner" aria-hidden="true" /> : <Icon name={result === "pass" ? "check" : "close"} size={14} strokeWidth={3} />}
                  {result === "pending" ? "Running" : result === "pass" ? "Pass" : result === "fell" ? "Fell" : "Fail"}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SkillCard({ skill, info = {}, creatureName, onTrain, onStop, onPlay, onAskTinker, trainerOffline, device = "your computer" }) {
  const meta = SKILL_META[skill] || SKILL_META.walk;
  const state = trainerOffline && !["ready", "failed"].includes(info.state) ? "unavailable" : info.state || "untrained";
  const badge = STATE_BADGE[state] || STATE_BADGE.untrained;
  const p = info.progress || {};
  const frac = isNum(p.envSteps) && isNum(p.targetSteps) && p.targetSteps > 0 ? Math.min(1, p.envSteps / p.targetSteps) : null;
  const eta = aboutMinutes(info.estimateMinutes);
  const rows = info.eval?.rows || [];
  const passed = rows.filter(r => r.pass).length;
  return (
    <article className={cx("cl-skill", `is-${state}`)} aria-labelledby={`skill-${skill}`}>
      <header className="cl-skill__head">
        <span className="cl-skill__icon" aria-hidden="true">
          {state === "training" && frac != null ? (
            <ProgressRing value={frac} size={46} stroke={5} color="var(--cl-bp-600)">
              <Icon name={meta.icon} size={20} />
            </ProgressRing>
          ) : (
            <Icon name={meta.icon} size={24} />
          )}
        </span>
        <div className="cl-skill__titles">
          <h3 id={`skill-${skill}`} className="cl-skill__title">
            {meta.title}
          </h3>
          <span className="cl-hint">{meta.what}</span>
        </div>
        <Badge tone={badge.tone} icon={badge.icon}>
          {badge.label}
        </Badge>
      </header>

      {state === "untrained" && (
        <div className="cl-skill__body">
          {info.available === false ? (
            <p className="cl-skill__locked">
              <Icon name="lock" size={16} /> {info.reason || "Not available for this body yet."}
            </p>
          ) : (
            <>
              <p className="cl-skill__lede">
                {creatureName} hasn't learned to {meta.verb} yet. {eta ? `Teaching takes ${eta} on ${device}.` : `Teaching runs on ${device}.`}
              </p>
              <div className="cl-skill__actions">
                <Button variant="go" icon="play" onClick={() => onTrain?.(skill)}>
                  Teach {meta.verb}
                </Button>
                <span className="cl-hint">Runs on your CPU in the background. Keep designing while it practices.</span>
              </div>
            </>
          )}
        </div>
      )}

      {state === "queued" && (
        <div className="cl-skill__body">
          <p className="cl-skill__lede">
            <span className="cl-spinner" aria-hidden="true" /> Waiting for the trainer to finish the current job.
          </p>
          {onStop && (
            <Button size="sm" variant="ghost" icon="close" onClick={() => onStop(skill)}>
              Cancel
            </Button>
          )}
        </div>
      )}

      {(state === "training" || state === "validating") && (
        <div className="cl-skill__body">
          <div className="cl-skill__progress">
            <div className="cl-skill__bar" role="progressbar" aria-label={`${meta.title} practice progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={frac != null ? Math.round(frac * 100) : undefined}>
              <span style={{ width: `${(frac ?? 0) * 100}%` }} />
            </div>
            <span className="cl-mono">
              {compact(p.envSteps)} of {compact(p.targetSteps)} steps
            </span>
          </div>
          <dl className="cl-skill__stats">
            <div>
              <dt>Speed</dt>
              <dd className="cl-mono">{isNum(p.stepsPerSecond) ? `${grouped(p.stepsPerSecond)}/s` : "—"}</dd>
            </div>
            <div>
              <dt>Practiced</dt>
              <dd className="cl-mono">{duration(p.elapsedSeconds)}</dd>
            </div>
            <div>
              <dt>{state === "validating" ? "Now" : "Left"}</dt>
              <dd className="cl-mono">{state === "validating" ? "checks" : isNum(p.etaSeconds) ? `~${duration(p.etaSeconds)}` : "—"}</dd>
            </div>
          </dl>
          {Array.isArray(p.curve) && p.curve.length > 1 && <TrainingChart curve={p.curve} targetSteps={p.targetSteps} />}
          {state === "training" ? (
            <p className="cl-skill__honest">
              <Icon name="info" size={16} /> The score rises as it practices in simulation. Only the checks afterwards decide whether it can {meta.verb}.
            </p>
          ) : (
            <EvalTable rows={rows} caption="Checking its moves in a fresh simulation" />
          )}
          {state === "training" && onStop && (
            <Button size="sm" variant="danger" icon="stop" onClick={() => onStop(skill)}>
              Stop training
            </Button>
          )}
        </div>
      )}

      {state === "ready" && (
        <div className="cl-skill__body">
          <p className="cl-skill__lede">
            Passed {passed} of {rows.length} checks. {info.hashMatched !== false ? "The skill matches this exact body." : ""}
          </p>
          {rows.length > 0 && <EvalTable rows={rows} caption="What it can do" />}
          {info.honesty && <p className="cl-skill__honest"><Icon name="info" size={16} /> {info.honesty}</p>}
          {onPlay && skill === "walk" && (
            <Button variant="go" icon="park" onClick={onPlay}>
              Go to the playground
            </Button>
          )}
        </div>
      )}

      {state === "failed" && (
        <div className="cl-skill__body">
          <p className="cl-skill__lede">
            Passed {passed} of {rows.length} checks, so it stays locked until it passes all of them.
          </p>
          {rows.length > 0 && <EvalTable rows={rows} caption="What went wrong" />}
          <div className="cl-skill__actions">
            {onTrain && (
              <Button variant="primary" icon="retry" onClick={() => onTrain(skill, { longer: true })}>
                Train longer
              </Button>
            )}
            {onAskTinker && (
              <Button variant="ghost" icon="wand" onClick={() => onAskTinker(`It failed the ${meta.verb} checks. Can you adjust the body?`)}>
                Ask Tinker
              </Button>
            )}
          </div>
        </div>
      )}

      {state === "stale" && (
        <div className="cl-skill__body">
          <Callout tone="warn" title="The body changed after training">
            The old skill was learned on a different shape, so it can't drive this one. Teach it again.
          </Callout>
          <Button variant="primary" icon="retry" onClick={() => onTrain?.(skill)}>
            Retrain {meta.verb}
          </Button>
        </div>
      )}

      {state === "unavailable" && (
        <div className="cl-skill__body">
          <p className="cl-skill__locked">
            <Icon name="offline" size={16} /> {info.reason || "The trainer isn't running on this computer."}
          </p>
        </div>
      )}
    </article>
  );
}

/**
 * TrainingPanel props:
 *  creatureName, skills: { walk?: SkillState, jump?: SkillState }, order
 *  onTrain(skill, opts), onStop(skill), onPlay(), onAskTinker(text)
 *  trainerOffline: true when draft-service training is unreachable
 *  machineNote: e.g. "Training uses your Mac's CPU. Plug in to keep it fast."
 *  device: how to name the machine in copy ("your Mac" when known; default "your computer")
 */
export function TrainingPanel({ creatureName = "Your creature", skills = {}, order = ["walk", "jump"], onTrain, onStop, onPlay, onAskTinker, trainerOffline = false, machineNote, device = "your computer" }) {
  const list = order.filter(skill => skills[skill]);
  return (
    <div className="cl-train">
      {trainerOffline && (
        <Callout tone="warn" title="Trainer offline">
          Start the lab with ./start.sh, then come back here. Designing and dressing up still work.
        </Callout>
      )}
      {list.map(skill => (
        <SkillCard key={skill} skill={skill} info={skills[skill]} creatureName={creatureName} onTrain={onTrain} onStop={onStop} onPlay={onPlay} onAskTinker={onAskTinker} trainerOffline={trainerOffline} device={device} />
      ))}
      <p className="cl-train__foot">
        <Icon name="cpu" size={16} />
        {machineNote || "Skills are learned with PPO in MuJoCo on your computer's CPU, then checked in a fresh simulation. Each skill fits one exact body."}
      </p>
    </div>
  );
}

export default TrainingPanel;
