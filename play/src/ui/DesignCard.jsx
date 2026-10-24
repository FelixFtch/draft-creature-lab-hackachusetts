// DesignCard: Tinker's proposal (creature-design/1) as a mini blueprint
// sheet with a toy label. It says what will be built, never that it has been
// built: "built" only appears when draft-service returned a body.
//
// status: "proposed" | "building" | "built" | "infeasible" | "superseded"
import { CreatureGlyph, normalizeShape } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { Badge, Button, cx } from "./primitives.jsx";
import { fixed, isNum } from "./format.js";

export const ACTUATORS = {
  micro: { label: "Micro servos", short: "Micro", hint: "Small hobby servos for small, light robots." },
  qdd: { label: "Springy QDD", short: "QDD", hint: "Quasi-direct-drive: fast and springy. Best for jumping." },
  geared: { label: "Strong geared", short: "Geared", hint: "Planetary gears: strong, a bit slower." },
  harmonic: { label: "Mighty harmonic", short: "Harmonic", hint: "Harmonic drives: very strong, very slow." },
};

const SKILL_LABEL = { walk: "Walk", jump: "Jump" };

export function designFacts(design, body) {
  const shape = normalizeShape(design);
  const params = (shape.plan === "multileg" ? design?.multileg : design?.quadruped) || {};
  const facts = [];
  facts.push({ icon: "leg", text: shape.plan === "multileg" ? `${shape.legCount} legs, ${shape.arrangement === "bilateral" ? "in pairs" : "all around"}` : "4 legs" });
  const act = ACTUATORS[params.actuator];
  if (act) facts.push({ icon: "motor", text: act.label, hint: act.hint });
  const length = isNum(body?.dimensions?.lengthM) ? body.dimensions.lengthM : shape.plan === "quadruped" ? shape.torsoLength : null;
  if (isNum(length)) facts.push({ icon: "ruler", text: `${Math.round(length * 100)} cm long` });
  if (isNum(body?.massKg)) facts.push({ icon: "weight", text: fixed(body.massKg, 1, "kg") });
  return facts;
}

const STATUS = {
  proposed: null,
  building: { tone: "info", label: "Drafting joints and motors…", icon: null },
  built: { tone: "good", label: "Built with Draft", icon: "check" },
  infeasible: { tone: "bad", label: "Didn't pass Draft's check", icon: "alert" },
  superseded: { tone: "outline", label: "Earlier idea", icon: "undo" },
};

export function DesignCard({ design, body, status = "proposed", onBuild, onTweak, onOpen, compact = false, className }) {
  if (!design) return null;
  const facts = designFacts(design, body);
  const s = STATUS[status];
  const palette = design.look?.palette;
  const skills = Array.isArray(design.skills) ? design.skills : [];
  return (
    <article className={cx("cl-design", `is-${status}`, compact && "cl-design--compact", className)} aria-label={`Design: ${design.name}`}>
      <div className="cl-design__sheet cl-bp">
        <CreatureGlyph design={design} mode="blueprint" dims className="cl-design__glyph" />
        <span className="cl-design__sheet-label cl-tech">Design sketch</span>
        {s && (
          <span className={cx("cl-design__stamp", `cl-design__stamp--${s.tone}`)}>
            {status === "building" ? <span className="cl-spinner" aria-hidden="true" /> : s.icon && <Icon name={s.icon} size={15} strokeWidth={2.6} />}
            {s.label}
          </span>
        )}
      </div>
      <div className="cl-design__body">
        <div className="cl-design__head">
          <h3 className="cl-design__name">{design.name}</h3>
          {palette && (
            <span className="cl-design__palette" aria-hidden="true">
              {["body", "limbs", "accent"].map(key => palette[key] && <span key={key} style={{ background: palette[key] }} />)}
            </span>
          )}
        </div>
        {design.concept && !compact && <p className="cl-design__concept">{design.concept}</p>}
        <ul className="cl-design__facts" aria-label="Key facts">
          {facts.map(fact => (
            <li key={fact.text} title={fact.hint}>
              <Icon name={fact.icon} size={16} />
              {fact.text}
            </li>
          ))}
        </ul>
        {skills.length > 0 && (
          <div className="cl-design__skills">
            <span className="cl-design__skills-label">Wants to learn</span>
            {skills.map(skill => (
              <Badge key={skill} tone="outline" icon={skill === "jump" ? "jump" : "walk"}>
                {SKILL_LABEL[skill] || skill}
              </Badge>
            ))}
          </div>
        )}
        {(onBuild || onTweak || onOpen) && status !== "superseded" && (
          <div className="cl-design__actions">
            {onBuild && status !== "built" && (
              <Button variant="primary" size="sm" icon="blueprint" onClick={onBuild} busy={status === "building"} disabled={status === "building"}>
                {status === "infeasible" ? "Try again" : status === "building" ? "Drafting" : "Build with Draft"}
              </Button>
            )}
            {onOpen && status === "built" && (
              <Button size="sm" icon="blueprint" onClick={onOpen}>
                See blueprint
              </Button>
            )}
            {onTweak && (
              <Button variant="ghost" size="sm" icon="ruler" onClick={onTweak} disabled={status === "building"}>
                Adjust
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default DesignCard;
