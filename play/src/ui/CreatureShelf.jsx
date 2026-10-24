// CreatureShelf: starters (Draft presets, showcase creatures) and the
// player's own creatures as toys on a shelf, with skill badges and remix
// lineage. Saved creatures live in this browser (the main agent persists).
import { useState } from "react";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { IconButton, cx } from "./primitives.jsx";
import { rovingKeyDown } from "./hooks.js";
import { skillName } from "./format.js";

const SKILL_ICON = { walk: "walk", drive: "wheel", jump: "jump" };

function SkillPips({ skills = {} }) {
  const entries = Object.entries(skills).filter(([skill]) => SKILL_ICON[skill]);
  if (!entries.length) return null;
  const label = entries.map(([skill, state]) => `${skillName(skill)}: ${state === "ready" ? "verified" : state === "training" ? "learning" : "untrained"}`).join(", ");
  return (
    <span className="cl-pips" role="img" aria-label={label} title={label}>
      {entries.map(([skill, state]) => (
        <span key={skill} className={cx("cl-pip", `is-${state === "ready" ? "ready" : state === "training" ? "training" : "none"}`)}>
          <Icon name={SKILL_ICON[skill]} size={13} strokeWidth={2.4} />
        </span>
      ))}
    </span>
  );
}

function skillSummary(skills = {}) {
  const parts = Object.entries(skills)
    .filter(([skill]) => SKILL_ICON[skill])
    .map(([skill, state]) => `${skillName(skill).toLowerCase()} ${state === "ready" ? "verified" : state === "training" ? "learning" : "untrained"}`);
  return parts.length ? `: ${parts.join(", ")}` : "";
}

function ShelfCard({ item, current, onOpen, onRemix, onDelete, mine }) {
  const label = `${item.name}${item.parent ? `, remix of ${item.parent.name}` : item.note ? `, ${item.note}` : ""}${skillSummary(item.skills)}${current ? ". On stage" : ""}`;
  return (
    <li className={cx("cl-toy", current && "is-current")}>
      <button type="button" className="cl-toy__open" onClick={() => onOpen?.(item.id)} aria-current={current ? "true" : undefined} aria-label={`Open ${label}`} data-roving>
        <span className="cl-toy__art">
          {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <CreatureGlyph design={item.design} look={item.look} />}
        </span>
        <span className="cl-toy__name">{item.name}</span>
        <span className="cl-toy__meta">
          <SkillPips skills={item.skills} />
          {item.parent ? <span className="cl-toy__from">from {item.parent.name}</span> : item.note ? <span className="cl-toy__from">{item.note}</span> : null}
        </span>
        <span className="cl-sr-only">{current ? ", on stage" : ""}</span>
      </button>
      {current && (
        <span className="cl-toy__ribbon" aria-hidden="true">
          On stage
        </span>
      )}
      {(onRemix || (mine && onDelete)) && (
        <span className="cl-toy__tools">
          {onRemix && <IconButton icon="remix" label={`Remix ${item.name}`} size="sm" variant="ghost" onClick={() => onRemix(item.id)} />}
          {mine && onDelete && !current && <IconButton icon="trash" label={`Remove ${item.name}`} size="sm" variant="ghost" onClick={() => onDelete(item.id)} />}
        </span>
      )}
    </li>
  );
}

/**
 * CreatureShelf props:
 *  starters, mine: [{ id, name, design, look, skills, parent?, note?, thumbnail? }]
 *  currentId; onOpen(id), onRemix(id), onDelete(id), onNew(), onImport()
 *  defaultTab: "starters" | "mine"; collapsed, onCollapsedChange
 */
export function CreatureShelf({ starters = [], mine = [], currentId, onOpen, onRemix, onDelete, onNew, onImport, defaultTab, collapsed = false, onCollapsedChange, layout = "row" }) {
  const [tab, setTab] = useState(defaultTab || (mine.length ? "mine" : "starters"));
  const list = tab === "mine" ? mine : starters;
  return (
    <div className={cx("cl-shelf", collapsed && "is-collapsed", layout === "grid" && "cl-shelf--grid")}>
      <div className="cl-shelf__head">
        <h2 className="cl-shelf__title">
          <Icon name="box" size={20} />
          Shelf
        </h2>
        <div
          className="cl-shelf__tabs"
          role="radiogroup"
          aria-label="Which creatures"
          onKeyDown={event => {
            const next = rovingKeyDown(event, { selector: '[role="radio"]' });
            if (next) setTab(next.dataset.tab);
          }}
        >
          {[
            ["starters", "Starters", starters.length],
            ["mine", "Mine", mine.length],
          ].map(([id, label, count]) => (
            <button key={id} type="button" role="radio" data-tab={id} aria-checked={tab === id} tabIndex={tab === id ? 0 : -1} aria-label={`${label}, ${count}`} className="cl-shelf__tab" onClick={() => setTab(id)}>
              {label}
              <span className="cl-shelf__count" aria-hidden="true">
                {count}
              </span>
            </button>
          ))}
        </div>
        <span className="cl-shelf__spacer" />
        {onImport && <IconButton icon="upload" label="Import a recipe" size="sm" variant="ghost" onClick={onImport} />}
        {onCollapsedChange && <IconButton icon={collapsed ? "chevron-up" : "chevron-down"} label={collapsed ? "Show shelf" : "Hide shelf"} size="sm" variant="ghost" onClick={() => onCollapsedChange(!collapsed)} />}
      </div>
      {!collapsed && (
        <div className="cl-shelf__body">
          <ul className="cl-shelf__row" aria-label={tab === "mine" ? "My creatures" : "Starter creatures"} onKeyDown={event => rovingKeyDown(event, { selector: "[data-roving]" })}>
            {tab === "mine" && onNew && (
              <li className="cl-toy cl-toy--new">
                <button type="button" className="cl-toy__open" onClick={onNew} data-roving>
                  <span className="cl-toy__art cl-toy__art--new">
                    <Icon name="plus" size={30} strokeWidth={2.6} />
                  </span>
                  <span className="cl-toy__name">New</span>
                  <span className="cl-toy__meta">
                    <span className="cl-toy__from">Ask Tinker</span>
                  </span>
                </button>
              </li>
            )}
            {list.map(item => (
              <ShelfCard key={item.id} item={item} current={item.id === currentId || item.current} onOpen={onOpen} onRemix={onRemix} onDelete={onDelete} mine={tab === "mine"} />
            ))}
            {tab === "mine" && mine.length === 0 && (
              <li className="cl-shelf__empty">
                <strong>Your shelf is empty</strong>
                <span>Build a creature with Tinker, then save it here. Saved creatures stay in this browser.</span>
              </li>
            )}
          </ul>
          <div className="cl-shelf__plank" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

export default CreatureShelf;
