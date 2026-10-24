// SpecSheet: the creature's Draft body (creature-body/1) as a cyanotype
// engineering sheet: drawing with dimension lines and a title block, key
// numbers, feasibility, trainability, joint tree with range "protractors",
// motor table with torque/speed bars, and Draft provenance.
//
// It only shows what the body contract says. The drawing is a sketch from
// the design's proportions ("Not to scale"); the numbers are Draft's.
import { useId } from "react";
import { normalizeShape, quadLayout, multiLayout } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { Button, CopyButton, cx } from "./primitives.jsx";
import { ACTUATORS } from "./DesignCard.jsx";
import { DASH, fixed, isNum, legLabel, plural, radToDeg, roleLabel, shortHash, aboutMinutes } from "./format.js";

const INK = "#dce8fb";
const DIM = "#b9d0f2";
const MARK = "#ffc63a";

function DimLine({ x1, y1, x2, y2, label, side = -1, offset = 0 }) {
  // Dimension line with arrowheads and extension ticks, label centred.
  const horizontal = Math.abs(y2 - y1) < Math.abs(x2 - x1);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const a = 4;
  return (
    <g className="cl-bpdraw__dim">
      <path d={`M${x1} ${y1}L${x2} ${y2}`} stroke={DIM} strokeWidth="1" />
      {horizontal ? (
        <path d={`M${x1 + a} ${y1 - a * 0.6}L${x1} ${y1}L${x1 + a} ${y1 + a * 0.6}M${x2 - a} ${y2 - a * 0.6}L${x2} ${y2}L${x2 - a} ${y2 + a * 0.6}M${x1} ${y1 - 6}v12M${x2} ${y2 - 6}v12`} stroke={DIM} strokeWidth="1" fill="none" />
      ) : (
        <path d={`M${x1 - a * 0.6} ${y1 + a}L${x1} ${y1}L${x1 + a * 0.6} ${y1 + a}M${x2 - a * 0.6} ${y2 - a}L${x2} ${y2}L${x2 + a * 0.6} ${y2 - a}M${x1 - 6} ${y1}h12M${x2 - 6} ${y2}h12`} stroke={DIM} strokeWidth="1" fill="none" />
      )}
      {label &&
        (horizontal ? (
          <text x={mx} y={my + side * (6 + offset) + (side > 0 ? 7 : 0)} textAnchor="middle" className="cl-bpdraw__label">
            {label}
          </text>
        ) : (
          // Vertical dimensions read bottom-to-top, like on a real drawing.
          <text x={mx + side * (6 + offset)} y={my} textAnchor="middle" transform={`rotate(-90 ${mx + side * (6 + offset)} ${my})`} className="cl-bpdraw__label">
            {label}
          </text>
        ))}
    </g>
  );
}

/** Engineering sketch from the body contract (+ design proportions). */
export function BlueprintDrawing({ body, design }) {
  const d = body?.design || design;
  const shape = normalizeShape(d);
  const dims = body?.dimensions || {};
  const W = 360;
  const H = shape.plan === "multileg" ? 214 : 196;
  if (shape.plan === "multileg") {
    const mountAngles = Array.isArray(body?.legs) ? body.legs.map(l => l.mountAngle) : undefined;
    const g = multiLayout({ ...shape, mountAngles }, W, H, [70, 34]);
    const left = g.cx - g.rx;
    const right = g.cx + g.rx;
    const span = Math.max(...g.legs.map(l => Math.abs(l.foot[1] - g.cy)));
    return (
      <svg className="cl-bpdraw" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Top view sketch: ${shape.legCount} legs, ${shape.arrangement}. Width ${fixed(dims.widthM, 2, "m")}.`}>
        <path d={`M${g.cx} 14V${H - 14}M18 ${g.cy}H${W - 18}`} stroke={DIM} strokeOpacity=".35" strokeDasharray="10 4 2 4" strokeWidth="1" />
        {g.legs.map((l, i) => (
          <g key={i}>
            <path d={`M${l.base[0]} ${l.base[1]}L${l.hip[0]} ${l.hip[1]}L${l.knee[0]} ${l.knee[1]}L${l.foot[0]} ${l.foot[1]}`} fill="none" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={l.hip[0]} cy={l.hip[1]} r="3.2" fill="#1e4e95" stroke={MARK} strokeWidth="1.4" />
            <circle cx={l.knee[0]} cy={l.knee[1]} r="3.2" fill="#1e4e95" stroke={INK} strokeWidth="1.3" />
            <circle cx={l.foot[0]} cy={l.foot[1]} r="2.6" fill="none" stroke={INK} strokeWidth="1.2" />
            <text x={l.foot[0] + (l.foot[0] >= g.cx ? 6 : -6)} y={l.foot[1] + (l.foot[1] >= g.cy ? 10 : -6)} textAnchor={l.foot[0] >= g.cx ? "start" : "end"} className="cl-bpdraw__tag">
              {body?.legs?.[i]?.name?.toUpperCase?.() || `L${i + 1}`}
            </text>
          </g>
        ))}
        <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} fill="rgb(220 232 251 / 0.08)" stroke={INK} strokeWidth="1.8" />
        <path d={`M${g.cx + g.rx + 6} ${g.cy}h16m-5 -4 5 4-5 4`} stroke={MARK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
        <text x={g.cx + g.rx + 26} y={g.cy + 4} className="cl-bpdraw__tag">front</text>
        <DimLine x1={left} y1={H - 16} x2={right} y2={H - 16} label={isNum(dims.lengthM) ? `body ${fixed(dims.lengthM, 2, "m")}` : null} side={-1} />
        {isNum(dims.widthM) && <DimLine x1={26} y1={g.cy - span} x2={26} y2={g.cy + span} label={`${fixed(dims.widthM, 2, "m")}`} side={1} />}
      </svg>
    );
  }
  const g = quadLayout(shape, W, H, [60, 40, 30], true);
  const t = g.torso;
  const ground = g.ground + 3.6;
  const top = t.y;
  const [front, rear] = g.legs;
  // Balloon callouts (numbered circles + leaders), placed in the open space
  // between the legs: 1 = hip, 2 = knee.
  const bx = t.x + t.w * 0.5;
  const b1 = [bx + 10, t.y + t.h + 22];
  const b2 = [bx - 14, Math.min(ground - 16, front.knee[1] + 8)];
  return (
    <svg className="cl-bpdraw" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Side view sketch: length ${fixed(dims.lengthM, 2, "m")}, height ${fixed(dims.heightM, 2, "m")}, leg ${fixed(dims.legLengthM, 2, "m")}.`}>
      <path d={`M14 ${ground}H${W - 14}`} stroke={DIM} strokeWidth="1" />
      <path d={`M14 ${ground + 5}H${W - 14}`} stroke={DIM} strokeOpacity=".35" strokeDasharray="2 5" strokeWidth="1" />
      {g.legs.map((leg, i) => (
        <path key={`far${i}`} d={`M${leg.hip[0] + 7} ${leg.hip[1] - 5}L${leg.knee[0] + 7} ${leg.knee[1] - 5}L${leg.foot[0] + 7} ${leg.foot[1] - 4}`} fill="none" stroke={INK} strokeOpacity=".35" strokeWidth="1.6" strokeDasharray="4 3" strokeLinejoin="round" />
      ))}
      <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={Math.min(t.h / 2, t.w * 0.3)} fill="rgb(220 232 251 / 0.08)" stroke={INK} strokeWidth="1.8" />
      <path d={`M${t.x + t.w / 2} ${t.y - 8}V${t.y + t.h + 8}M${t.x - 8} ${t.y + t.h / 2}H${t.x + t.w + 8}`} stroke={DIM} strokeOpacity=".4" strokeDasharray="10 4 2 4" strokeWidth="1" />
      {g.legs.map((leg, i) => (
        <g key={i}>
          <path d={`M${leg.hip[0]} ${leg.hip[1]}L${leg.knee[0]} ${leg.knee[1]}L${leg.foot[0]} ${leg.foot[1]}`} fill="none" stroke={INK} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={leg.hip[0]} cy={leg.hip[1]} r="4.2" fill="#1e4e95" stroke={MARK} strokeWidth="1.6" />
          <circle cx={leg.knee[0]} cy={leg.knee[1]} r="4.2" fill="#1e4e95" stroke={INK} strokeWidth="1.5" />
          <circle cx={leg.knee[0]} cy={leg.knee[1]} r="1" fill={INK} />
          <circle cx={leg.foot[0]} cy={leg.foot[1]} r="3.6" fill="none" stroke={INK} strokeWidth="1.4" />
        </g>
      ))}
      <g className="cl-bpdraw__balloons">
        <path d={`M${front.hip[0] - 3} ${front.hip[1] + 3}L${b1[0] + 7} ${b1[1] - 5}`} stroke={MARK} strokeWidth="1" />
        <path d={`M${front.knee[0] - 4} ${front.knee[1] + 1}L${b2[0] + 7} ${b2[1]}`} stroke={MARK} strokeWidth="1" />
        {[b1, b2].map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r="8" fill="#1e4e95" stroke={MARK} strokeWidth="1.3" />
            <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="middle" className="cl-bpdraw__balloon">
              {i + 1}
            </text>
          </g>
        ))}
        <text x="16" y={H - 9} className="cl-bpdraw__tag">
          <tspan>1 hip</tspan>
          <tspan dx="12">2 knee</tspan>
        </text>
      </g>
      <path d={`M${t.x + t.w + 6} ${top - 18}h20m-5 -4 5 4-5 4`} stroke={MARK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <text x={t.x + t.w + 16} y={top - 27} textAnchor="middle" className="cl-bpdraw__tag">
        front
      </text>
      <DimLine x1={t.x} y1={top - 18} x2={t.x + t.w} y2={top - 18} label={isNum(dims.lengthM) ? fixed(dims.lengthM, 2, "m") : null} side={-1} />
      <DimLine x1={t.x + t.w + 26} y1={top} x2={t.x + t.w + 26} y2={ground} label={isNum(dims.heightM) ? `height ${fixed(dims.heightM, 2, "m")}` : null} side={1} offset={4} />
      {isNum(dims.legLengthM) && <DimLine x1={rear.knee[0] - 16} y1={rear.hip[1]} x2={rear.knee[0] - 16} y2={ground} label={`leg ${fixed(dims.legLengthM, 2, "m")}`} side={-1} offset={4} />}
    </svg>
  );
}

/** Joint range as a protractor: faint full circle, bright allowed arc. */
export function RangeArc({ range, size = 30 }) {
  if (!Array.isArray(range) || !range.every(isNum)) return <span className="cl-rangearc cl-rangearc--na" aria-hidden="true" />;
  const r = size / 2 - 3;
  const c = size / 2;
  const [lo, hi] = range[0] <= range[1] ? range : [range[1], range[0]];
  const span = Math.min(hi - lo, Math.PI * 2 - 0.001);
  // 0 rad points down (a straight leg); positive turns counter-clockwise.
  const p = a => [c + r * Math.sin(a), c + r * Math.cos(a)];
  const [x1, y1] = p(lo);
  const [x2, y2] = p(lo + span);
  const large = span > Math.PI ? 1 : 0;
  return (
    <svg className="cl-rangearc" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={c} cy={c} r={r} fill="none" stroke={DIM} strokeOpacity=".3" strokeWidth="1.2" />
      <path d={`M${c} ${c}L${x1} ${y1}A${r} ${r} 0 ${large} 0 ${x2} ${y2}Z`} fill={MARK} fillOpacity=".22" stroke={MARK} strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx={c} cy={c} r="1.6" fill={INK} />
    </svg>
  );
}

const SKILL_STATE = {
  untrained: { tone: "warn", icon: "alert", label: "Untrained" },
  queued: { tone: "info", icon: "clock", label: "Waiting to train" },
  training: { tone: "info", icon: "train", label: "Training now" },
  validating: { tone: "info", icon: "check", label: "Running checks" },
  ready: { tone: "good", icon: "check", label: "Learned and verified" },
  failed: { tone: "bad", icon: "close", label: "Didn't pass its checks" },
  stale: { tone: "warn", icon: "alert", label: "Body changed, retrain" },
  unavailable: { tone: "neutral", icon: "lock", label: "Not available" },
};

function SkillRow({ skill, info, onTrain, device = "your computer" }) {
  const state = info?.state || "untrained";
  const meta = SKILL_STATE[state] || SKILL_STATE.untrained;
  const name = skill === "jump" ? "Jump" : "Walk";
  const detail =
    state === "untrained"
      ? info?.reason || `Teach it to ${skill}${aboutMinutes(info?.estimateMinutes) ? `, ${aboutMinutes(info.estimateMinutes)} on ${device}` : ""}`
      : state === "ready"
        ? info?.hashMatched === false
          ? "Policy hash doesn't match this body"
          : "Policy matches this exact body"
        : info?.reason || null;
  return (
    <li className={cx("cl-spec__skill", `is-${meta.tone}`)}>
      <Icon name={skill === "jump" ? "jump" : "walk"} size={20} />
      <div className="cl-spec__skill-text">
        <strong>
          {name}: {meta.label}
        </strong>
        {detail && <span>{detail}</span>}
      </div>
      {onTrain && (state === "untrained" || state === "failed" || state === "stale") && info?.available !== false && (
        <Button size="sm" variant="primary" onClick={() => onTrain(skill)}>
          {state === "untrained" ? "Teach" : "Retrain"}
        </Button>
      )}
    </li>
  );
}

function Section({ title, icon, children, aside }) {
  const id = useId();
  return (
    <section className="cl-spec__section" aria-labelledby={id}>
      <div className="cl-spec__section-head">
        <h3 id={id} className="cl-spec__h">
          {icon && <Icon name={icon} size={18} />}
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * SpecSheet props:
 *  body: creature-body/1 (required to show numbers)
 *  design: fallback for name/proportions
 *  policies: { walk?: {state, estimateMinutes, hashMatched, reason, available}, jump?: {...} }
 *  skills: which skills to list (default: design.skills or ["walk"])
 *  onTrain(skill), onOpenLabNotes(), onTweak()
 *  loading: show a drafting placeholder while draft-service works
 *  tweaks: optional node (e.g. <ShapeTweaks/>) shown after Skills
 *  device: "your Mac" when known (copy only)
 */
export function SpecSheet({ body, design, policies = {}, skills, onTrain, onOpenLabNotes, onTweak, loading = false, tweaks, device = "your computer" }) {
  const d = body?.design || design || {};
  if (loading || !body) {
    return (
      <div className="cl-spec cl-bp is-empty" aria-busy={loading || undefined}>
        <div className="cl-spec__empty">
          {loading ? <span className="cl-spinner" aria-hidden="true" /> : <Icon name="blueprint" size={34} />}
          <p className="cl-spec__empty-title cl-tech">{loading ? "Drafting the body…" : "No blueprint yet"}</p>
          <p>{loading ? "Draft is sizing joints and motors and running its feasibility check." : "Ask Tinker for a creature or pick one from the shelf. Draft turns it into a real robot body."}</p>
        </div>
      </div>
    );
  }
  const joints = Array.isArray(body.joints) ? body.joints : [];
  const jointByName = Object.fromEntries(joints.map(j => [j.name, j]));
  const legs = Array.isArray(body.legs) ? body.legs : [];
  const motors = Array.isArray(body.motors) ? body.motors : [];
  const maxEffort = Math.max(1, ...motors.map(m => (isNum(m.effortNm) ? m.effortNm : 0)));
  const maxSpeed = Math.max(1, ...motors.map(m => (isNum(m.velocityRadS) ? m.velocityRadS : 0)));
  const feas = body.feasibility || {};
  const warnings = Array.isArray(feas.warnings) ? feas.warnings : [];
  const overridden = Array.isArray(feas.overridden) ? feas.overridden : [];
  const prov = body.provenance || {};
  const dims = body.dimensions || {};
  const skillList = skills || (Array.isArray(d.skills) && d.skills.length ? d.skills : ["walk"]);
  const params = (body.bodyPlan === "multileg" ? d.multileg : d.quadruped) || {};
  const actuator = ACTUATORS[params.actuator] || ACTUATORS[motors[0]?.family];
  const assets = prov.assetSha256 && typeof prov.assetSha256 === "object" ? Object.entries(prov.assetSha256) : [];

  return (
    <div className="cl-spec cl-bp">
      <div className="cl-spec__drawing">
        <span className="cl-spec__corner cl-spec__corner--tl" aria-hidden="true" />
        <span className="cl-spec__corner cl-spec__corner--tr" aria-hidden="true" />
        <span className="cl-spec__corner cl-spec__corner--bl" aria-hidden="true" />
        <span className="cl-spec__corner cl-spec__corner--br" aria-hidden="true" />
        <BlueprintDrawing body={body} design={d} />
        <dl className="cl-spec__titleblock">
          <div className="cl-spec__tb-name">
            <dt className="cl-sr-only">Name</dt>
            <dd>{body.name || d.name || "Creature"}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{body.bodyPlan === "multileg" ? `${legs.length || d.multileg?.legCount || "?"}-leg` : "quadruped"}</dd>
          </div>
          <div>
            <dt>Draft rev</dt>
            <dd className="cl-mono">{shortHash(prov.draftRevision)}</dd>
          </div>
          <div>
            <dt>Scale</dt>
            <dd>not to scale</dd>
          </div>
        </dl>
      </div>

      <dl className="cl-spec__stats">
        <div>
          <dt>
            <Icon name="weight" size={16} /> Mass
          </dt>
          <dd className="cl-mono">{fixed(body.massKg, 1, "kg")}</dd>
        </div>
        <div title={isNum(dims.lengthM) ? `${Math.round(dims.lengthM * 100)} × ${Math.round((dims.widthM || 0) * 100)} × ${Math.round((dims.heightM || 0) * 100)} cm (L × W × H)` : undefined}>
          <dt>
            <Icon name="ruler" size={16} /> Length
          </dt>
          <dd className="cl-mono">{isNum(dims.lengthM) ? `${Math.round(dims.lengthM * 100)} cm` : DASH}</dd>
        </div>
        <div>
          <dt>
            <Icon name="joint" size={16} /> Joints
          </dt>
          <dd className="cl-mono">{joints.length || body.jointNames?.length || DASH}</dd>
        </div>
        <div>
          <dt>
            <Icon name="motor" size={16} /> Motors
          </dt>
          <dd className="cl-mono">{actuator?.short || motors[0]?.family || DASH}</dd>
        </div>
      </dl>

      <Section title="Feasibility" icon={feas.passed ? "check" : "alert"}>
        <div className={cx("cl-spec__feas", feas.passed ? "is-pass" : "is-fail")} role="status">
          <strong>{feas.passed ? "Passed Draft's feasibility check" : "Failed Draft's feasibility check"}</strong>
          <span>{feas.passed ? "Draft checked the motor sizes against this body and found no blockers." : feas.reason || "Draft found a part it can't size safely."}</span>
        </div>
        {warnings.length > 0 && (
          <ul className="cl-spec__warn">
            {warnings.map(w => (
              <li key={w}>
                <Icon name="alert" size={15} />
                {w}
              </li>
            ))}
          </ul>
        )}
        {overridden.length > 0 && (
          <p className="cl-spec__note">
            Overridden on purpose: {overridden.join(", ")}
          </p>
        )}
      </Section>

      <Section title="Skills" icon="train">
        <ul className="cl-spec__skills">
          {skillList.map(skill => (
            <SkillRow key={skill} skill={skill} info={policies[skill]} onTrain={onTrain} device={device} />
          ))}
        </ul>
      </Section>

      {tweaks}

      <Section title="Joints" icon="joint" aside={<span className="cl-spec__aside">{plural(legs.length, "leg")}</span>}>
        <div className="cl-spec__legs">
          {legs.map((leg, index) => (
            <details key={leg.name || index} className="cl-spec__leg" open={index === 0}>
              <summary>
                <span className="cl-spec__leg-name">{legLabel(leg, index)}</span>
                <span className="cl-spec__leg-chain" aria-hidden="true">
                  {(leg.joints || []).map(name => (
                    <i key={name} />
                  ))}
                </span>
                <Icon name="chevron-down" size={16} className="cl-spec__chev" />
              </summary>
              <div className="cl-spec__scroll">
              <table className="cl-spec__table">
                <caption className="cl-sr-only">{legLabel(leg, index)} joints</caption>
                <thead>
                  <tr>
                    <th scope="col">Joint</th>
                    <th scope="col">Range</th>
                    <th scope="col" className="cl-num">Torque</th>
                    <th scope="col" className="cl-num">Speed</th>
                  </tr>
                </thead>
                <tbody>
                  {(leg.joints || []).map(name => {
                    const j = jointByName[name] || { name };
                    const lo = radToDeg(j.range?.[0]);
                    const hi = radToDeg(j.range?.[1]);
                    return (
                      <tr key={name}>
                        <th scope="row">
                          <span className="cl-spec__joint">{roleLabel(j.role)}</span>
                          <span className="cl-spec__jname cl-mono">{name}</span>
                        </th>
                        <td>
                          <span className="cl-spec__range">
                            <RangeArc range={j.range} />
                            <span className="cl-mono">{isNum(lo) && isNum(hi) ? `${Math.round(lo)}° to ${Math.round(hi)}°` : DASH}</span>
                          </span>
                        </td>
                        <td className="cl-num cl-mono">{fixed(j.effort, 0, "N·m")}</td>
                        <td className="cl-num cl-mono">{fixed(j.velocity, 0, "rad/s")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </details>
          ))}
        </div>
      </Section>

      <Section title="Motors" icon="motor" aside={actuator && <span className="cl-spec__aside">{actuator.label}</span>}>
        {actuator && <p className="cl-spec__note">{actuator.hint}</p>}
        <div className="cl-spec__scroll">
        <table className="cl-spec__motors">
          <caption className="cl-sr-only">Motor classes sized by Draft</caption>
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Torque</th>
              <th scope="col">Speed</th>
              <th scope="col" className="cl-num">Gear</th>
              <th scope="col" className="cl-num">Mass</th>
            </tr>
          </thead>
          <tbody>
            {motors.map((m, i) => (
              <tr key={`${m.class}-${i}`}>
                <th scope="row">
                  <span className="cl-spec__mclass">{m.class || i + 1}</span>
                  {m.catalogAnchor && <span className="cl-spec__anchor">like {m.catalogAnchor}</span>}
                </th>
                <td>
                  <span className="cl-spec__bar" aria-hidden="true">
                    <span style={{ width: `${(isNum(m.effortNm) ? m.effortNm / maxEffort : 0) * 100}%` }} />
                  </span>
                  <span className="cl-mono">{fixed(m.effortNm, 0, "N·m")}</span>
                </td>
                <td>
                  <span className="cl-spec__bar cl-spec__bar--speed" aria-hidden="true">
                    <span style={{ width: `${(isNum(m.velocityRadS) ? m.velocityRadS / maxSpeed : 0) * 100}%` }} />
                  </span>
                  <span className="cl-mono">{fixed(m.velocityRadS, 0, "rad/s")}</span>
                </td>
                <td className="cl-num cl-mono">{isNum(m.gear) ? `${m.gear}:1` : DASH}</td>
                <td className="cl-num cl-mono">{isNum(m.massKg) ? `${Math.round(m.massKg * 1000)} g` : DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Section>

      <Section title="Made with Draft" icon="hash">
        <dl className="cl-spec__prov">
          <div>
            <dt>Generator</dt>
            <dd>{prov.generator || DASH}</dd>
          </div>
          <div>
            <dt>Template</dt>
            <dd>{prov.template || body.bodyPlan || DASH}</dd>
          </div>
          <div>
            <dt>Draft revision</dt>
            <dd className="cl-spec__hash">
              <span className="cl-mono">{shortHash(prov.draftRevision, 10)}</span>
              {prov.draftRevision && <CopyButton text={prov.draftRevision} label="Copy Draft revision" />}
            </dd>
          </div>
          <div>
            <dt>Body id</dt>
            <dd className="cl-spec__hash">
              <span className="cl-mono">{body.id ? body.id.replace(/^(\w+-)(.{8}).*$/, "$1$2…") : DASH}</span>
              {body.id && <CopyButton text={body.id} label="Copy body id" />}
            </dd>
          </div>
          {assets.slice(0, 2).map(([file, hash]) => (
            <div key={file}>
              <dt>{file}</dt>
              <dd className="cl-spec__hash">
                <span className="cl-mono">{shortHash(hash, 10)}</span>
              </dd>
            </div>
          ))}
        </dl>
        <div className="cl-spec__actions">
          {onOpenLabNotes && (
            <Button size="sm" variant="blueprint" icon="note" onClick={onOpenLabNotes}>
              Open lab notes
            </Button>
          )}
          {onTweak && (
            <Button size="sm" variant="blueprint" icon="ruler" onClick={onTweak}>
              Adjust shape
            </Button>
          )}
        </div>
      </Section>
    </div>
  );
}

export default SpecSheet;
