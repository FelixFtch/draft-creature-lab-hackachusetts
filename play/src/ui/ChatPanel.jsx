// ChatPanel: the conversation with Tinker. Streaming-friendly (a message can
// grow while status === "streaming"), with typed cards for designs, looks,
// feasibility problems, training offers and play offers.
//
// Message shape (UI-side; the main agent maps ai-service replies into it):
//  { id, role: "user" | "tinker" | "system", kind: "text" | "design" | "look"
//    | "problem" | "training" | "play" | "note", text?, status?: "streaming"
//    | "done" | "error", design?, designStatus?, body?, look?, lookName?,
//    lookApplied?, problem?, training?, creatureName? }
import { useEffect, useId, useRef, useState } from "react";
import { Tinker } from "./Tinker.jsx";
import { Icon } from "./icons.jsx";
import { Badge, Button, Chip, IconButton, cx } from "./primitives.jsx";
import { DesignCard } from "./DesignCard.jsx";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import { aboutMinutes, fixed, isNum } from "./format.js";

/** Who is designing: offline rules, a model on this Mac, or a cloud model. */
export function ProviderBadge({ provider, compact = false }) {
  if (!provider) return null;
  const kind = provider.offline ? "offline" : provider.kind === "cloud" ? "cloud" : provider.kind === "local" ? "local" : provider.kind || "offline";
  const label = kind === "offline" ? "Offline designer" : kind === "local" ? "On this computer" : "Cloud model";
  const detail = kind === "offline" ? "Rule-based, no AI model" : provider.model || provider.name || "";
  return (
    <span className={cx("cl-provider", `cl-provider--${kind}`)} title={detail ? `${label}: ${detail}` : label}>
      <Icon name={kind === "offline" ? "offline" : kind === "local" ? "laptop" : "cloud"} size={15} strokeWidth={2.2} />
      <span className="cl-provider__label">{label}</span>
      {!compact && detail && kind !== "offline" && <span className="cl-provider__model">{detail}</span>}
    </span>
  );
}

/** Draft's feasibility gate said no: show the reason like red pen on a blueprint. */
export function ProblemCard({ problem, onRevise, onTweak }) {
  if (!problem) return null;
  const rows = Array.isArray(problem.numbers) ? problem.numbers : [];
  return (
    <article className="cl-problem" aria-label="Feasibility problem">
      <div className="cl-problem__sheet cl-bp">
        <span className="cl-problem__mark" aria-hidden="true" />
        <p className="cl-problem__title">{problem.title || "Draft can't build this one yet"}</p>
        {problem.reason && <p className="cl-problem__reason">{problem.reason}</p>}
      </div>
      {rows.length > 0 && (
        <dl className="cl-problem__numbers">
          {rows.map(row => {
            const short = isNum(row.need) && isNum(row.have) && row.have < row.need;
            const max = Math.max(row.need || 0, row.have || 0) || 1;
            return (
              <div key={row.label} className="cl-problem__row">
                <dt>{row.label}</dt>
                <dd>
                  <span className="cl-problem__bar" aria-hidden="true">
                    <span className="cl-problem__need" style={{ width: `${((row.need || 0) / max) * 100}%` }} />
                    <span className={cx("cl-problem__have", short && "is-short")} style={{ width: `${((row.have || 0) / max) * 100}%` }} />
                  </span>
                  <span className="cl-mono">
                    needs {fixed(row.need, 1, row.unit)}, has {fixed(row.have, 1, row.unit)}
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {Array.isArray(problem.warnings) && problem.warnings.length > 0 && (
        <ul className="cl-problem__warnings">
          {problem.warnings.map(w => (
            <li key={w}>
              <Icon name="alert" size={15} />
              {w}
            </li>
          ))}
        </ul>
      )}
      {(onRevise || onTweak) && (
        <div className="cl-card-actions">
          {onRevise && (
            <Button variant="primary" size="sm" icon="wand" onClick={onRevise}>
              Ask Tinker to fix it
            </Button>
          )}
          {onTweak && (
            <Button variant="ghost" size="sm" onClick={onTweak}>
              Adjust it myself
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

/** "Teach it to walk?" Honest estimate, explicit that it runs locally. */
export function TrainingOfferCard({ training, creatureName = "your creature", onTrain, onLater }) {
  const skills = Array.isArray(training?.skills) ? training.skills : [];
  return (
    <article className="cl-offer" aria-label="Training offer">
      <div className="cl-offer__head">
        <span className="cl-offer__icon" aria-hidden="true">
          <Icon name="train" />
        </span>
        <div>
          <h3 className="cl-offer__title">Teach {creatureName} to move?</h3>
          <p className="cl-hint">It has a body but no skills yet. Practice runs on your computer's CPU; keep designing while it learns.</p>
        </div>
      </div>
      <ul className="cl-offer__skills">
        {skills.map(item => (
          <li key={item.skill} className={cx(item.available === false && "is-unavailable")}>
            <Icon name={item.skill === "jump" ? "jump" : "walk"} size={18} />
            <span className="cl-offer__skill">{item.skill === "jump" ? "Jump" : "Walk"}</span>
            <span className="cl-offer__eta">{item.available === false ? item.reason || "Not yet" : aboutMinutes(item.minutes) || "time unknown"}</span>
          </li>
        ))}
      </ul>
      {(onTrain || onLater) && (
        <div className="cl-card-actions">
          {onTrain && (
            <Button variant="go" size="sm" icon="play" onClick={() => onTrain(skills.filter(s => s.available !== false).map(s => s.skill))} disabled={!skills.some(s => s.available !== false)}>
              Start training
            </Button>
          )}
          {onLater && (
            <Button variant="ghost" size="sm" onClick={onLater}>
              Later
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

export function LookCard({ look, name, design, applied = false, onApply, onKeep }) {
  if (!look) return null;
  const p = look.palette || {};
  return (
    <article className="cl-lookcard" aria-label={`Look: ${name || look.theme || "new look"}`}>
      <div className="cl-lookcard__art">
        <CreatureGlyph design={design} look={look} />
      </div>
      <div className="cl-lookcard__body">
        <h3 className="cl-lookcard__name">{name || look.theme || "New look"}</h3>
        <span className="cl-lookcard__swatches" aria-hidden="true">
          {["body", "limbs", "joints", "accent", "feet"].map(k => p[k] && <span key={k} style={{ background: p[k] }} />)}
        </span>
        <p className="cl-hint">Looks only change paint and parts. Physics and training stay the same.</p>
        {(onApply || onKeep) && (
          <div className="cl-card-actions">
            {applied ? (
              <Badge tone="good" icon="check">
                Applied
              </Badge>
            ) : (
              onApply && (
                <Button variant="primary" size="sm" icon="palette" onClick={onApply}>
                  Try this look
                </Button>
              )
            )}
            {onKeep && !applied && (
              <Button variant="ghost" size="sm" onClick={onKeep}>
                Keep mine
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function PlayOfferCard({ creatureName = "Your creature", skills = ["walk"], onPlay }) {
  return (
    <article className="cl-offer cl-offer--play" aria-label="Ready to play">
      <div className="cl-offer__head">
        <span className="cl-offer__icon cl-offer__icon--go" aria-hidden="true">
          <Icon name="park" />
        </span>
        <div>
          <h3 className="cl-offer__title">{creatureName} passed its checks</h3>
          <p className="cl-hint">Learned and verified: {skills.map(s => (s === "jump" ? "jump" : "walk")).join(" and ")}. Time for the playground.</p>
        </div>
      </div>
      {onPlay && (
        <div className="cl-card-actions">
          <Button variant="go" size="sm" icon="play" onClick={onPlay}>
            Go to the playground
          </Button>
        </div>
      )}
    </article>
  );
}

function Message({ message, onAction, showAvatar, mood }) {
  const role = message.role === "user" ? "user" : message.role === "system" ? "system" : "tinker";
  const streaming = message.status === "streaming";
  if (role === "system" || message.kind === "note") {
    return (
      <li className="cl-msg cl-msg--note">
        <span>{message.text}</span>
      </li>
    );
  }
  const act = (type, extra) => () => onAction?.({ type, ...extra }, message);
  let card = null;
  switch (message.kind) {
    case "design":
      card = <DesignCard design={message.design} body={message.body} status={message.designStatus || "proposed"} onBuild={act("build", { design: message.design })} onTweak={act("tweak", { design: message.design })} onOpen={act("open-blueprint")} />;
      break;
    case "look":
      card = <LookCard look={message.look} name={message.lookName} design={message.design} applied={message.lookApplied} onApply={act("apply-look", { look: message.look })} onKeep={act("keep-look")} />;
      break;
    case "problem":
      card = <ProblemCard problem={message.problem} onRevise={act("revise", { problem: message.problem })} onTweak={act("tweak")} />;
      break;
    case "training":
      card = <TrainingOfferCard training={message.training} creatureName={message.creatureName} onTrain={skills => onAction?.({ type: "train", skills }, message)} onLater={act("later")} />;
      break;
    case "play":
      card = <PlayOfferCard creatureName={message.creatureName} skills={message.skills} onPlay={act("play")} />;
      break;
    default:
      card = null;
  }
  return (
    <li className={cx("cl-msg", `cl-msg--${role}`, message.status === "error" && "is-error")}>
      {role === "tinker" && (
        <span className="cl-msg__avatar" aria-hidden="true">
          {showAvatar ? <Tinker mood={streaming ? "talking" : mood || "idle"} size={34} /> : null}
        </span>
      )}
      <div className="cl-msg__stack">
        <span className="cl-sr-only">{role === "user" ? "You:" : "Tinker:"}</span>
        {message.text && (
          <div className="cl-msg__bubble">
            <p>
              {message.text}
              {streaming && <span className="cl-msg__caret" aria-hidden="true" />}
            </p>
          </div>
        )}
        {card}
        {message.status === "error" && (
          <span className="cl-msg__error">
            <Icon name="alert" size={15} /> {message.error || "Tinker didn't get that. Try sending it again."}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * ChatPanel props:
 *  messages, suggestions: string[], provider: {kind, name, model, offline}
 *  busy: waiting for the first token; mood: Tinker's face (auto when omitted)
 *  onSend(text), onAction(action, message), onStop(), onCollapse()
 *  disabled + disabledReason: e.g. ai-service offline and no fallback
 */
export function ChatPanel({
  messages = [],
  suggestions = [],
  provider,
  busy = false,
  mood,
  onSend,
  onSuggestion,
  onAction,
  onStop,
  onCollapse,
  disabled = false,
  disabledReason,
  placeholder = "Describe a creature or a change",
  title = "Tinker",
  className,
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const stick = useRef(true);
  const inputId = useId();
  const streaming = messages.some(m => m.status === "streaming");
  const last = messages[messages.length - 1];
  const autoMood = busy ? "thinking" : streaming ? "talking" : last?.kind === "problem" ? "worried" : last?.kind === "play" || last?.designStatus === "built" ? "happy" : "idle";
  const face = mood || autoMood;
  const lastText = last ? `${last.id}:${(last.text || "").length}:${last.kind}:${last.designStatus || ""}` : "";

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastText, busy, messages.length]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function send(text) {
    const value = (text ?? draft).trim();
    if (!value || disabled) return;
    onSend?.(value);
    if (text === undefined) setDraft("");
    stick.current = true;
    inputRef.current?.focus();
  }

  return (
    <div className={cx("cl-chat cl-panel", className)}>
      <header className="cl-chat__head">
        <Tinker mood={face} size={48} />
        <div className="cl-chat__who">
          <h2 className="cl-chat__title">{title}</h2>
          <span className="cl-chat__role">Robot designer</span>
        </div>
        <ProviderBadge provider={provider} compact />
        {onCollapse && <IconButton icon="chevron-left" label="Hide chat" variant="ghost" size="sm" onClick={onCollapse} />}
      </header>
      <div ref={listRef} className="cl-chat__log cl-scroll" role="log" tabIndex={0} aria-label={`Conversation with ${title}`} aria-busy={streaming || busy || undefined} onScroll={onScroll}>
        <ol className="cl-chat__list">
        {messages.map((message, index) => {
          const prev = messages[index - 1];
          const showAvatar = message.role !== "user" && (!prev || prev.role !== message.role);
          const isLast = index === messages.length - 1;
          return <Message key={message.id || index} message={message} onAction={onAction} showAvatar={showAvatar} mood={isLast ? face : "idle"} />;
        })}
        {busy && !streaming && (
          <li className="cl-msg cl-msg--tinker cl-msg--typing">
            <span className="cl-msg__avatar" aria-hidden="true">
              <Tinker mood="thinking" size={34} />
            </span>
            <div className="cl-msg__bubble">
              <span className="cl-typing" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="cl-sr-only">Tinker is thinking</span>
            </div>
          </li>
        )}
        </ol>
      </div>
      <div className="cl-chat__foot">
        {suggestions.length > 0 && (
          <div className="cl-chat__chips" role="group" aria-label="Suggestions">
            {suggestions.map(text => (
              <Chip key={text} onClick={() => (onSuggestion ? onSuggestion(text) : send(text))} disabled={disabled || busy}>
                {text}
              </Chip>
            ))}
          </div>
        )}
        {disabled && disabledReason && (
          <p className="cl-chat__disabled" role="status">
            <Icon name="offline" size={16} /> {disabledReason}
          </p>
        )}
        <form
          className="cl-composer"
          onSubmit={event => {
            event.preventDefault();
            send();
          }}
        >
          <label htmlFor={inputId} className="cl-sr-only">
            Message Tinker
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            className="cl-composer__input"
            rows={1}
            maxLength={600}
            value={draft}
            placeholder={placeholder}
            disabled={disabled}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          {streaming && onStop ? (
            <IconButton icon="stop" label="Stop Tinker" onClick={onStop} variant="ink" />
          ) : (
            <IconButton type="submit" icon="send" label="Send" disabled={disabled || busy || !draft.trim()} className="cl-composer__send" />
          )}
        </form>
      </div>
    </div>
  );
}

export default ChatPanel;
