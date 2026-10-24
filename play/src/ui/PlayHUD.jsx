// PlayHUD: the playground overlay. Reads the world engine's snapshot()
// ({ robot, sparks, challenge, skills, explore }) and sends intents back
// through callbacks. Toy-like pieces in the corners keep the world visible.
import { useEffect, useRef, useState } from "react";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import { Icon } from "./icons.jsx";
import { Button, Keycap, cx } from "./primitives.jsx";
import { useCoarsePointer } from "./hooks.js";
import { fixed, isNum, skillIcon, skillName } from "./format.js";

export const DEFAULT_HINTS = [
  { keys: ["W", "A", "S", "D"], label: "Move" },
  { keys: ["Space"], label: "Jump", action: "jump" },
  { keys: ["R"], label: "Respawn" },
  { keys: ["C"], label: "Camera" },
  { keys: ["Esc"], label: "Pause" },
];

/** Standard-mapping gamepad hints (matches world/input.js: A jump, B respawn, Y camera, Start pause). */
export const GAMEPAD_HINTS = [
  { pad: ["LS"], label: "Move" },
  { pad: ["A"], label: "Jump", action: "jump" },
  { pad: ["B"], label: "Respawn" },
  { pad: ["Y"], label: "Camera" },
  { pad: ["RS"], label: "Look" },
  { pad: ["Start"], label: "Pause" },
];

function PadKey({ name }) {
  const k = name.toLowerCase();
  return <span className={cx("cl-padkey", `cl-padkey--${k}`, name.length > 1 && "cl-padkey--wide")}>{name}</span>;
}

function usePop(value) {
  const [pop, setPop] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (isNum(value) && isNum(prev.current) && value > prev.current) setPop(n => n + 1);
    prev.current = value;
  }, [value]);
  return pop;
}

function SkillChip({ skill, state }) {
  const ready = state === "ready";
  return (
    <span className={cx("cl-skillchip", ready ? "is-ready" : "is-locked")} title={ready ? `${skillName(skill)}: verified` : `${skillName(skill)}: not verified`}>
      <Icon name={ready ? skillIcon(skill) : "lock"} size={14} strokeWidth={2.5} />
      {skillName(skill)}
    </span>
  );
}

/** Top-left creature badge. */
export function CreatureBadge({ creature, speed }) {
  if (!creature) return null;
  const skills = creature.skills || {};
  return (
    <div className="cl-cbadge">
      <span className="cl-cbadge__art" aria-hidden="true">
        <CreatureGlyph design={creature.design} look={creature.look} />
      </span>
      <div className="cl-cbadge__text">
        <strong className="cl-cbadge__name">{creature.name}</strong>
        <span className="cl-cbadge__skills">
          {["walk", "drive", "jump"].map(skill => (skills[skill] ? <SkillChip key={skill} skill={skill} state={skills[skill]} /> : null))}
        </span>
      </div>
      {isNum(speed) && (
        <span className="cl-cbadge__speed" aria-label={`Speed ${fixed(speed, 2)} meters per second`}>
          <span className="cl-mono">{fixed(Math.abs(speed), 2)}</span>
          <small>m/s</small>
        </span>
      )}
    </div>
  );
}

/** Top-center active challenge tracker (opens the board). */
export function ChallengeTracker({ challenge, onOpen }) {
  if (!challenge) {
    return (
      <button type="button" className="cl-quest cl-quest--empty" onClick={onOpen}>
        <Icon name="flag" size={20} />
        <span>Pick a challenge</span>
      </button>
    );
  }
  const value = challenge.progress?.value ?? 0;
  const total = challenge.progress?.total ?? 0;
  const pegs = total > 0 && total <= 8;
  return (
    <button type="button" className={cx("cl-quest", challenge.done && "is-done")} onClick={onOpen} aria-label={`Challenge: ${challenge.title}. ${total ? `${value} of ${total}.` : ""} Open challenges`}>
      <span className="cl-quest__flag" aria-hidden="true">
        <Icon name={challenge.done ? "check" : "flag"} size={18} strokeWidth={2.4} />
      </span>
      <span className="cl-quest__text">
        <strong>{challenge.title}</strong>
        {challenge.text && <span>{challenge.text}</span>}
      </span>
      {total > 0 && (
        <span className="cl-quest__progress" aria-hidden="true">
          {pegs ? (
            <span className="cl-quest__pegs">
              {Array.from({ length: total }, (_, i) => (
                <i key={i} className={i < value ? "is-on" : undefined} />
              ))}
            </span>
          ) : (
            <span className="cl-mono">
              {value}/{total}
            </span>
          )}
        </span>
      )}
      {isNum(challenge.timeLeft) && <span className="cl-quest__time cl-mono">{Math.ceil(challenge.timeLeft)}s</span>}
    </button>
  );
}

/** Sparks counter: pops when a spark is collected. */
export function SparkCounter({ got = 0, total }) {
  const pop = usePop(got);
  return (
    <div className="cl-sparks" role="status" aria-label={`Sparks: ${got}${isNum(total) ? ` of ${total}` : ""}`}>
      <span key={pop} className={cx("cl-sparks__icon", pop && "is-pop")} aria-hidden="true">
        <Icon name="spark" size={24} strokeWidth={2.2} />
      </span>
      <span className="cl-sparks__num cl-mono" aria-hidden="true">
        {got}
        {isNum(total) && <small>/{total}</small>}
      </span>
    </div>
  );
}

function DockButton({ icon, label, keyHint, padHint, onClick, onBlocked, pressed, disabled, tone, hint, showReason = false }) {
  // Locked actions stay focusable (aria-disabled) so keyboard and screen
  // reader users can still find out why; pressing one calls onBlocked.
  return (
    <div className="cl-dock__item">
      <button
        type="button"
        className={cx("cl-dockbtn", tone && `cl-dockbtn--${tone}`, disabled && "is-locked")}
        onClick={disabled ? () => onBlocked?.(hint) : onClick}
        aria-pressed={typeof pressed === "boolean" ? pressed : undefined}
        aria-disabled={disabled || undefined}
        title={disabled ? hint : undefined}
        aria-label={disabled && hint ? `${label}, locked. ${hint}` : label}
      >
        <Icon name={disabled ? "lock" : icon} size={26} strokeWidth={2.4} />
      </button>
      <span className="cl-dock__label">
        {label}
        {keyHint && <Keycap>{keyHint}</Keycap>}
        {padHint && <PadKey name={padHint} />}
      </span>
      {disabled && showReason && hint && (
        <span className="cl-dock__reason" aria-hidden="true">
          {hint}
        </span>
      )}
    </div>
  );
}

/**
 * PlayHUD props:
 *  creature: { name, design, look, skills: { walk, jump } }
 *  snapshot: world snapshot(); onJump, canJump, jumpHint
 *  onExplore, exploreOpen, explorePanel (ReactNode)
 *  cameraMode ("chase" | "orbit"), onCamera
 *  onOpenChallenges, onOpenStickers, stickerCount, onReset (after a fall)
 *  touchControls: ReactNode (TouchControls), shown on coarse pointers or when forceTouch
 *  stickerPop: ReactNode (StickerPop); keyHints: [{ keys, label }]
 */
export function PlayHUD({
  creature,
  snapshot = {},
  onJump,
  canJump = false,
  jumpHint = "Teach it to jump in the workshop",
  onExplore,
  exploreOpen = false,
  explorePanel,
  exploreAvailable = true,
  cameraMode = "chase",
  onCamera,
  onOpenChallenges,
  onOpenStickers,
  stickerCount,
  onReset,
  touchControls,
  forceTouch = false,
  stickerPop,
  keyHints = DEFAULT_HINTS,
  gamepad,
  onJumpBlocked,
}) {
  const coarse = useCoarsePointer();
  const touch = forceTouch || coarse;
  const robot = snapshot.robot || {};
  const sparks = snapshot.sparks || {};
  // world snapshot().command.gamepad is the pad id while one is connected.
  const pad = gamepad ?? snapshot.command?.gamepad ?? null;
  const hints = pad ? GAMEPAD_HINTS : keyHints;
  return (
    <div className={cx("cl-hud", touch && "is-touch")}>
      <h2 className="cl-sr-only">Playground{creature?.name ? ` with ${creature.name}` : ""}</h2>
      <div className="cl-hud__tl">
        <CreatureBadge creature={creature} speed={robot.speed} />
      </div>
      <div className="cl-hud__tc">
        <ChallengeTracker challenge={snapshot.challenge} onOpen={onOpenChallenges} />
      </div>
      <div className="cl-hud__tr">
        <SparkCounter got={sparks.got} total={sparks.total} />
        {onOpenStickers && (
          <button type="button" className="cl-hudbtn" onClick={onOpenStickers} aria-label={`Sticker book${isNum(stickerCount) ? `, ${stickerCount} stickers` : ""}`}>
            <Icon name="sticker" size={22} />
            {isNum(stickerCount) && <span className="cl-hudbtn__count cl-mono">{stickerCount}</span>}
          </button>
        )}
      </div>

      {robot.fall && (
        <div className="cl-hud__center">
          <div className="cl-fall" role="alert">
            <strong>Tipped over!</strong>
            <span>Stand it back up and try again.</span>
            {onReset && (
              <Button variant="primary" icon="retry" onClick={onReset}>
                Stand up
              </Button>
            )}
          </div>
        </div>
      )}

      {exploreOpen && explorePanel && <div className="cl-hud__explore">{explorePanel}</div>}

      {touch ? (
        <div className="cl-hud__touch">{touchControls}</div>
      ) : (
        <>
          {hints?.length > 0 && !exploreOpen && (
            <ul className="cl-hud__keys" aria-label={pad ? "Gamepad controls" : "Keyboard controls"}>
              {pad && (
                <li className="cl-hud__pad" title={pad}>
                  <Icon name="gamepad" size={18} />
                  <span>Gamepad</span>
                </li>
              )}
              {hints.map(hint => {
                const locked = hint.action === "jump" && !canJump;
                return (
                  <li key={hint.label} className={cx(locked && "is-locked")}>
                    {(hint.pad || []).map(k => (
                      <PadKey key={k} name={k} />
                    ))}
                    {(hint.keys || []).map(k => (
                      <Keycap key={k}>{k}</Keycap>
                    ))}
                    {locked && <Icon name="lock" size={13} strokeWidth={2.6} />}
                    <span>{locked ? `${hint.label} (locked)` : hint.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="cl-dock" role="toolbar" aria-label="Actions">
            {onCamera && <DockButton icon="camera" label={cameraMode === "chase" ? "Chase cam" : "Orbit cam"} onClick={onCamera} />}
            {onExplore && <DockButton icon="eye" label="Explore" pressed={exploreOpen} onClick={onExplore} disabled={!exploreAvailable} hint="Set up Tinker's eyes in Settings" tone="bp" />}
            {onJump && <DockButton icon="jump" label="Jump" keyHint={pad ? null : "Space"} padHint={pad ? "A" : null} onClick={onJump} onBlocked={onJumpBlocked} disabled={!canJump} hint={jumpHint} tone="sun" showReason />}
          </div>
        </>
      )}
      {stickerPop}
    </div>
  );
}

export default PlayHUD;
