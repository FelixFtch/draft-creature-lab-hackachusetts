// ChallengeBoard: playground challenges as job tickets. Locked ones say
// exactly what unlocks them (a skill to teach, or a vision model).
import { Icon } from "./icons.jsx";
import { Badge, Button, cx } from "./primitives.jsx";
import { Sticker } from "./StickerBook.jsx";

const NEEDS = {
  jump: { label: "Needs Jump", detail: "Teach it to jump in the workshop." },
  walk: { label: "Needs Walk", detail: "Teach it to walk in the workshop." },
  eyes: { label: "Needs AI eyes", detail: "Set up a vision model in Settings." },
};

/**
 * ChallengeBoard props:
 *  challenges: [{ id, title, text, status: "open" | "active" | "done" | "locked",
 *                 progress?: {value,total}, needs?: "jump" | "walk" | "eyes", reward?: { sticker } }]
 *  activeId, onSelect(id), onUnlock(need)  (e.g. go to the Train tab)
 *  stickers: sticker defs to draw reward thumbnails
 */
export function ChallengeBoard({ challenges = [], activeId, onSelect, onUnlock, stickers = [] }) {
  const done = challenges.filter(c => c.status === "done").length;
  return (
    <div className="cl-board">
      <p className="cl-album__count">
        <strong className="cl-mono">
          {done} of {challenges.length}
        </strong>{" "}
        challenges done
      </p>
      <ul className="cl-board__list">
        {challenges.map(c => {
          const active = c.id === activeId || c.status === "active";
          const locked = c.status === "locked";
          const need = locked ? NEEDS[c.needs] : null;
          const reward = stickers.find(s => s.id === c.reward?.sticker);
          const value = c.progress?.value ?? 0;
          const total = c.progress?.total ?? 0;
          return (
            <li key={c.id} className={cx("cl-ticket", `is-${c.status}`, active && "is-active")}>
              <span className="cl-ticket__icon" aria-hidden="true">
                <Icon name={c.status === "done" ? "check" : locked ? "lock" : "flag"} size={22} strokeWidth={2.4} />
              </span>
              <div className="cl-ticket__text">
                <strong>{c.title}</strong>
                <span>{c.text}</span>
                {total > 0 && c.status !== "done" && (
                  <span className="cl-ticket__bar" role="progressbar" aria-label={`${c.title} progress`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
                    <span style={{ width: `${(value / total) * 100}%` }} />
                  </span>
                )}
                {need && <span className="cl-ticket__need">{need.detail}</span>}
              </div>
              {reward && (
                <span className="cl-ticket__reward" title={`Reward: ${reward.title} sticker`}>
                  <Sticker art={reward.art} tone={reward.tone} size={44} earned={c.status === "done" || reward.earned} />
                </span>
              )}
              <div className="cl-ticket__action">
                {c.status === "done" ? (
                  <Badge tone="good" icon="check">
                    Done
                  </Badge>
                ) : locked ? (
                  onUnlock && c.needs ? (
                    <Button size="sm" variant="ghost" icon="lock" onClick={() => onUnlock(c.needs)}>
                      {need?.label || "Locked"}
                    </Button>
                  ) : (
                    <Badge tone="outline" icon="lock">
                      {need?.label || "Locked"}
                    </Badge>
                  )
                ) : active ? (
                  <Badge tone="info" icon="flag">
                    Playing
                  </Badge>
                ) : (
                  <Button size="sm" variant="primary" icon="play" onClick={() => onSelect?.(c.id)}>
                    Play
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ChallengeBoard;
