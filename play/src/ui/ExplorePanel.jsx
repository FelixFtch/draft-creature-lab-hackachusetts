// ExplorePanel: AI Explore. The vision model looks through the robot's
// camera and picks a direction; the verified walk skill moves the legs.
// States: idle | looking | moving | arrived | gave-up | error | unavailable
import { useId } from "react";
import { Tinker } from "./Tinker.jsx";
import { Icon } from "./icons.jsx";
import { Button, Chip, IconButton, cx } from "./primitives.jsx";

const STATUS = {
  idle: { mood: "idle", text: "Name a landmark and it will try to walk there." },
  looking: { mood: "thinking", text: "Looking through its camera…" },
  moving: { mood: "talking", text: "On its way" },
  arrived: { mood: "happy", text: "Made it!" },
  "gave-up": { mood: "worried", text: "Couldn't find it this time. Try a nearer landmark." },
  error: { mood: "worried", text: "Explore stopped. The vision model didn't answer." },
  unavailable: { mood: "sleeping", text: "Tinker's eyes aren't set up. Add a vision model in Settings." },
};

const MOVE = { forward: "Walking forward", backward: "Backing up", turn_left: "Turning left", turn_right: "Turning right", stand: "Stopping to look" };

/**
 * ExplorePanel props:
 *  state, instruction, onInstructionChange(text), landmarks: string[]
 *  onStart(instruction), onStop(), onClose(), onOpenSettings()
 *  steps: { done, max }, lastDecision: { action, reason? }, frame: data URL
 *  eyes: { model, kind }  (from /health roles.eyes)
 */
export function ExplorePanel({ state = "idle", instruction = "", onInstructionChange, landmarks = [], onStart, onStop, onClose, onOpenSettings, steps, lastDecision, frame, eyes, note }) {
  const inputId = useId();
  const busy = state === "looking" || state === "moving";
  const s = STATUS[state] || STATUS.idle;
  const unavailable = state === "unavailable";
  return (
    <section className={cx("cl-explore cl-panel", `is-${state}`)} aria-label="AI Explore">
      <header className="cl-explore__head">
        <span className="cl-explore__icon" aria-hidden="true">
          <Icon name="eye" />
        </span>
        <div className="cl-explore__titles">
          <h2 className="cl-explore__title">AI Explore</h2>
          <span className="cl-hint">{eyes?.model ? `Eyes: ${eyes.model}` : "Vision model steers, walk skill moves"}</span>
        </div>
        {onClose && <IconButton icon="close" label="Close AI Explore" variant="ghost" size="sm" onClick={onClose} />}
      </header>
      <form
        className="cl-explore__form"
        onSubmit={event => {
          event.preventDefault();
          if (!busy && instruction.trim()) onStart?.(instruction.trim());
        }}
      >
        <label htmlFor={inputId} className="cl-field__label">
          Where should it go?
        </label>
        <div className="cl-explore__row">
          <input id={inputId} className="cl-input" value={instruction} placeholder="Go to the red ball" disabled={busy || unavailable} onChange={event => onInstructionChange?.(event.target.value)} maxLength={200} />
          {busy ? (
            <Button variant="danger" icon="stop" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" icon="play" disabled={unavailable || !instruction.trim()}>
              Go
            </Button>
          )}
        </div>
        {landmarks.length > 0 && (
          <div className="cl-explore__chips" role="group" aria-label="Landmarks">
            {landmarks.map(name => (
              <Chip key={name} icon="pin" disabled={busy || unavailable} onClick={() => onInstructionChange?.(`Go to the ${name}`)}>
                {name}
              </Chip>
            ))}
          </div>
        )}
      </form>
      <div className="cl-explore__status" role="status" aria-live="polite">
        <Tinker mood={s.mood} size={40} />
        <div className="cl-explore__status-text">
          <strong>{state === "moving" && lastDecision?.action ? MOVE[lastDecision.action] || s.text : s.text}</strong>
          {lastDecision?.reason && busy && <span>“{lastDecision.reason}”</span>}
          {steps?.max > 0 && (
            <span className="cl-mono">
              Step {steps.done} of {steps.max}
            </span>
          )}
        </div>
        {frame && (
          <figure className="cl-explore__cam">
            <img src={frame} alt="What the robot's camera sees" width="160" height="100" />
            <figcaption className="cl-sr-only">Latest camera frame</figcaption>
          </figure>
        )}
      </div>
      {unavailable && onOpenSettings && (
        <Button size="sm" icon="settings" onClick={onOpenSettings}>
          Open Settings
        </Button>
      )}
      <p className="cl-explore__note">{note || "The vision model picks a direction; the learned walk skill does the stepping. Press Stop anytime."}</p>
    </section>
  );
}

export default ExplorePanel;
