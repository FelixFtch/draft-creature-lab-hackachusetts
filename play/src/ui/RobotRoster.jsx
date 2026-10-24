// RobotRoster: the four showcase robots (Rollo, Dog, Octo, Bipo) as big pick
// cards. Skill badges are honest: only a validated policy reads "verified".
// "Best at" chips come from measured terrain trials when given, otherwise
// from robot.bestAt (marked as predicted).
import { CreatureGlyph, describePlan } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { cx } from "./primitives.jsx";
import { rovingKeyDown } from "./hooks.js";
import { fixed, isNum, skillIcon, skillName } from "./format.js";
import { bestAtFromTrials, groupOf, laneById, normalizeTrials } from "./terrain.js";

const SKILL_STATE = {
  ready: { tone: "good", word: "verified", icon: "check" },
  training: { tone: "info", word: "learning", icon: "train" },
  validating: { tone: "info", word: "checking", icon: "clock" },
  queued: { tone: "info", word: "queued", icon: "clock" },
  failed: { tone: "bad", word: "didn't pass", icon: "close" },
  untrained: { tone: "none", word: "not trained", icon: "lock" },
};

/** Skill badges: locomotion (walk or drive) first, then jump. */
export function SkillBadges({ skills = {}, notes = {} }) {
  const order = ["walk", "drive", "jump"].filter(s => s in skills);
  return (
    <ul className="cl-skillbadges" aria-label="Skills">
      {order.map(skill => {
        const meta = SKILL_STATE[skills[skill]] || SKILL_STATE.untrained;
        return (
          <li key={skill} className={cx("cl-skillbadge", `is-${meta.tone}`)} title={notes[skill] || undefined}>
            <Icon name={skillIcon(skill)} size={16} strokeWidth={2.3} />
            <span className="cl-skillbadge__name">{skillName(skill)}</span>
            <span className="cl-skillbadge__state">
              <Icon name={meta.icon} size={12} strokeWidth={3} />
              {meta.word}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function sizeLine(robot) {
  const d = robot.dimensions || robot.body?.dimensions || {};
  const mass = robot.massKg ?? robot.body?.massKg;
  const parts = [];
  if (isNum(d.heightM)) parts.push(`${Math.round(d.heightM * 100)} cm tall`);
  if (isNum(d.lengthM)) parts.push(`${Math.round(d.lengthM * 100)} cm long`);
  if (isNum(mass)) parts.push(fixed(mass, 1, "kg"));
  return parts;
}

/**
 * RobotRoster props:
 *  robots: [{ id, name, kind, tagline, design, look, skills: { walk|drive|jump: state },
 *            skillNotes?, massKg, dimensions, bestAt?: laneId[], terrainProfile? }]
 *  selectedId, onSelect(id), onOpenTerrain(id)?: "Terrain report" link per card
 *  trials: qa/terrain-trials.json (raw or normalized) for measured "best at"
 */
export function RobotRoster({ robots = [], selectedId, onSelect, onOpenTerrain, trials, label = "Pick a robot" }) {
  const t = trials ? normalizeTrials(trials) : null;
  return (
    <div className="cl-roster">
      <ul
        className="cl-roster__grid"
        role="radiogroup"
        aria-label={label}
        onKeyDown={event => {
          const next = rovingKeyDown(event, { selector: '[role="radio"]' });
          if (next) onSelect?.(next.dataset.id);
        }}
      >
        {robots.map((robot, index) => {
          const on = robot.id === selectedId;
          const stop = on || (!robots.some(r => r.id === selectedId) && index === 0);
          const measured = t ? bestAtFromTrials(t, robot.id) : [];
          const best = measured.length ? measured : robot.bestAt || [];
          const source = measured.length ? "measured" : "predicted";
          const accent = robot.look?.palette?.body || "#1f8c80";
          return (
            <li key={robot.id} className={cx("cl-rcard", on && "is-on")} style={{ "--rc": accent }}>
              <button type="button" role="radio" aria-checked={on} tabIndex={stop ? 0 : -1} data-id={robot.id} className="cl-rcard__pick" onClick={() => onSelect?.(robot.id)}>
                <span className="cl-rcard__stage" aria-hidden="true">
                  <CreatureGlyph design={robot.design} look={robot.look} />
                </span>
                <span className="cl-rcard__kind">{robot.kind || describePlan(robot.design)}</span>
                {on && (
                  <span className="cl-rcard__picked">
                    <Icon name="check" size={14} strokeWidth={3} /> Picked
                  </span>
                )}
                <span className="cl-rcard__body">
                  <span className="cl-rcard__name">{robot.name}</span>
                  {robot.tagline && <span className="cl-rcard__tagline">{robot.tagline}</span>}
                  <SkillBadges skills={robot.skills} notes={robot.skillNotes} />
                  <span className="cl-rcard__size cl-mono">{sizeLine(robot).join("  ·  ")}</span>
                  {best.length > 0 && (
                    <span className="cl-rcard__best">
                      <span className="cl-rcard__best-label">{source === "measured" ? "Best at" : "Built for"}</span>
                      {best.map(id => {
                        const lane = laneById(t?.lanes, id);
                        return (
                          <span key={id} className="cl-terrainchip">
                            <Icon name={groupOf(lane).icon} size={14} />
                            {lane.title}
                          </span>
                        );
                      })}
                    </span>
                  )}
                </span>
              </button>
              {onOpenTerrain && (
                <button type="button" className="cl-rcard__more" onClick={() => onOpenTerrain(robot.id)}>
                  <Icon name="terrain-step" size={16} /> Terrain report <span className="cl-sr-only">for {robot.name}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default RobotRoster;
