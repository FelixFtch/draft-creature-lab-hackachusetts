// PauseMenu: a chunky toy menu over the paused playground.
import { Modal } from "./Modal.jsx";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { cx } from "./primitives.jsx";
import { isNum } from "./format.js";

function MenuButton({ icon, label, onClick, primary, detail }) {
  if (!onClick) return null;
  return (
    <button type="button" className={cx("cl-menubtn", primary && "cl-menubtn--primary")} onClick={onClick}>
      <span className="cl-menubtn__icon" aria-hidden="true">
        <Icon name={icon} size={22} strokeWidth={2.3} />
      </span>
      <span className="cl-menubtn__label">{label}</span>
      {detail && <span className="cl-menubtn__detail">{detail}</span>}
    </button>
  );
}

/**
 * PauseMenu props:
 *  open, onResume (also Esc), onRestart, onChallenges, onStickers, onSettings, onWorkshop
 *  creature: { name, design, look }, stats: { sparks: {got,total}, stickers: {got,total}, challenges: {done,total} }
 */
export function PauseMenu({ open, onResume, onRestart, onChallenges, onStickers, onSettings, onWorkshop, creature, stats = {} }) {
  const s = stats;
  return (
    <Modal open={open} onClose={onResume} title="Paused" icon="pause" size="lg" className="cl-pause" initialFocus=".cl-menubtn--primary">
      <div className="cl-pause__grid">
        <nav className="cl-pause__menu" aria-label="Pause menu">
          <MenuButton icon="play" label="Resume" onClick={onResume} primary />
          <MenuButton icon="retry" label="Restart run" detail="Sparks and props reset" onClick={onRestart} />
          <MenuButton icon="flag" label="Challenges" detail={s.challenges ? `${s.challenges.done} of ${s.challenges.total} done` : undefined} onClick={onChallenges} />
          <MenuButton icon="sticker" label="Sticker book" detail={s.stickers ? `${s.stickers.got} of ${s.stickers.total}` : undefined} onClick={onStickers} />
          <MenuButton icon="settings" label="Settings" onClick={onSettings} />
          <MenuButton icon="bench" label="Back to the workshop" onClick={onWorkshop} />
        </nav>
        {creature && (
          <aside className="cl-pause__card" aria-label="This run">
            <span className="cl-pause__art" aria-hidden="true">
              <CreatureGlyph design={creature.design} look={creature.look} />
            </span>
            <strong className="cl-pause__name">{creature.name}</strong>
            <dl className="cl-pause__stats">
              {s.sparks && (
                <div>
                  <dt>
                    <Icon name="spark" size={16} /> Sparks
                  </dt>
                  <dd className="cl-mono">
                    {s.sparks.got}
                    {isNum(s.sparks.total) && <small>/{s.sparks.total}</small>}
                  </dd>
                </div>
              )}
              {s.stickers && (
                <div>
                  <dt>
                    <Icon name="sticker" size={16} /> Stickers
                  </dt>
                  <dd className="cl-mono">
                    {s.stickers.got}
                    <small>/{s.stickers.total}</small>
                  </dd>
                </div>
              )}
              {s.challenges && (
                <div>
                  <dt>
                    <Icon name="flag" size={16} /> Challenges
                  </dt>
                  <dd className="cl-mono">
                    {s.challenges.done}
                    <small>/{s.challenges.total}</small>
                  </dd>
                </div>
              )}
            </dl>
          </aside>
        )}
      </div>
    </Modal>
  );
}

export default PauseMenu;
