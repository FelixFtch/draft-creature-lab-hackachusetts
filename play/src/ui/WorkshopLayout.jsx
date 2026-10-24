// Workshop layout: Tinker's chat on the left, the creature inspector (tabs)
// on the right, the stage in the middle with the loop stepper, name tag,
// stage tools and the shelf. On phones everything folds into one bottom
// sheet with a single tab row (Tinker / Blueprint / Look / Train / Shelf).
import { useId, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { Badge, IconButton, Segmented, Tabs, tabPanelProps, cx } from "./primitives.jsx";
import { rovingKeyDown, useLayoutSize } from "./hooks.js";

export const LOOP_STEPS = [
  { id: "imagine", label: "Imagine", icon: "chat" },
  { id: "draft", label: "Draft", icon: "blueprint" },
  { id: "dress", label: "Dress up", icon: "palette" },
  { id: "train", label: "Train", icon: "train" },
  { id: "play", label: "Play", icon: "play" },
];

/**
 * The experience loop as a peg rail. It IS a sequence, so it is numbered.
 * status per step: { imagine: "done", draft: "current", ... } with values
 * "done" | "current" | "todo" | "locked". onStep(id) navigates.
 */
export function LoopStepper({ status = {}, onStep, compact = false, labels }) {
  return (
    <nav className={cx("cl-loop", compact && "cl-loop--compact")} aria-label="Creature progress">
      <ol className="cl-loop__rail">
        {LOOP_STEPS.map((step, index) => {
          const state = status[step.id] || "todo";
          const label = labels?.[step.id] || step.label;
          const stateWord = { done: "done", current: "current step", todo: "not started", locked: "locked" }[state];
          return (
            <li key={step.id} className="cl-loop__step" data-state={state}>
              <button
                type="button"
                className="cl-loop__peg"
                onClick={() => onStep?.(step.id)}
                disabled={!onStep || state === "locked"}
                aria-current={state === "current" ? "step" : undefined}
                aria-label={`${index + 1}. ${label}, ${stateWord}`}
              >
                <span className="cl-loop__num" aria-hidden="true">
                  {state === "done" ? <Icon name="check" size={14} strokeWidth={3} /> : state === "locked" ? <Icon name="lock" size={13} strokeWidth={2.4} /> : index + 1}
                </span>
                <span className="cl-loop__label" aria-hidden="true">
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Masking-tape name label on the stage. `drafted` = only a Draft body so far:
 * the lettering stays technical (CASL 0) and morphs to toy marker (CASL 1)
 * once the creature is dressed or trained. One orchestrated moment.
 */
export function NameTag({ name, drafted = false, badges, note, children }) {
  return (
    <div className={cx("cl-nametag", drafted && "is-drafted")}>
      <div className="cl-nametag__tape">
        <h2 className="cl-nametag__name">{name || "Unnamed creature"}</h2>
      </div>
      {(badges || note) && (
        <div className="cl-nametag__meta">
          {badges}
          {note && <span className="cl-nametag__note">{note}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Floating tool tray under the creature. actions:
 * [{ id, label, icon, onClick, disabled?, pressed?, primary? }]
 */
export function StageToolbar({ actions = [], label = "Stage tools", compact = false }) {
  return (
    <div
      className={cx("cl-tray", compact && "cl-tray--compact")}
      role="toolbar"
      aria-label={label}
      onKeyDown={event => rovingKeyDown(event, { selector: "button" })}
    >
      {actions.map(action =>
        compact ? (
          <IconButton key={action.id} icon={action.icon} label={action.label} onClick={action.onClick} disabled={action.disabled} pressed={action.pressed} variant={action.primary ? undefined : "ghost"} size="sm" className={action.primary ? "cl-tray__primary" : undefined} />
        ) : (
          <button
            key={action.id}
            type="button"
            className={cx("cl-tray__btn", action.primary && "cl-tray__btn--primary")}
            onClick={action.onClick}
            disabled={action.disabled}
            aria-pressed={typeof action.pressed === "boolean" ? action.pressed : undefined}
            title={action.hint}
          >
            <Icon name={action.icon} />
            <span>{action.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

/** Toy / Blueprint / X-ray: maps to appearance view.setMode(normal|blueprint|xray). */
export function ViewModeSwitch({ value = "normal", onChange, compact = false }) {
  return (
    <Segmented
      label="View"
      value={value}
      onChange={onChange}
      size={compact ? "sm" : undefined}
      className="cl-viewmode"
      options={[
        { value: "normal", label: compact ? "Toy" : "Toy", icon: "sparkle" },
        { value: "blueprint", label: "Blueprint", icon: "blueprint" },
        { value: "xray", label: "X-ray", icon: "cube" },
      ]}
    />
  );
}

/**
 * WorkshopLayout props:
 *  chat: ReactNode (ChatPanel)
 *  tabs: [{ id, label, icon, badge?, content }]   inspector tabs
 *  activeTab, onTabChange(id)                       (phone adds "chat" and "shelf")
 *  shelf: ReactNode (CreatureShelf); shelfLabel
 *  stepper: ReactNode (LoopStepper)
 *  nameTag: ReactNode (NameTag); stageTools: ReactNode (StageToolbar / ViewModeSwitch)
 *  chatCollapsed, onChatCollapsedChange: desktop/tablet chat drawer
 *  chatBadge: small node shown on the collapsed chat button (e.g. unread dot)
 */
export function WorkshopLayout({
  chat,
  tabs = [],
  activeTab,
  onTabChange,
  shelf,
  shelfLabel = "Shelf",
  stepper,
  nameTag,
  stageTools,
  status,
  chatCollapsed = false,
  onChatCollapsedChange,
  chatTitle = "Tinker",
  phoneStatus,
}) {
  const size = useLayoutSize();
  const idBase = useId().replace(/[^a-zA-Z0-9]/g, "");
  const current = tabs.find(tab => tab.id === activeTab) || tabs[0];

  if (size === "phone") {
    return (
      <PhoneWorkshop
        chat={chat}
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={onTabChange}
        shelf={shelf}
        shelfLabel={shelfLabel}
        stepper={stepper}
        nameTag={nameTag}
        stageTools={stageTools}
        status={status}
        idBase={idBase}
        chatTitle={chatTitle}
        phoneStatus={phoneStatus}
      />
    );
  }

  return (
    <div className={cx("cl-ws", chatCollapsed && "is-chat-collapsed")} data-size={size}>
      {chatCollapsed ? (
        <div className="cl-ws__chat-tab">
          <button type="button" className="cl-ws__chat-open" onClick={() => onChatCollapsedChange?.(false)} aria-label={`Open chat with ${chatTitle}`}>
            <Icon name="chat" />
            <span>{chatTitle}</span>
          </button>
        </div>
      ) : (
        <section className="cl-ws__chat" aria-label={`Chat with ${chatTitle}`}>
          {chat}
        </section>
      )}
      <div className="cl-ws__center">
        <div className="cl-ws__top">
          {stepper}
          {nameTag}
        </div>
        {status && <div className="cl-ws__status">{status}</div>}
        <div className="cl-ws__bottom">
          {stageTools && <div className="cl-ws__tools">{stageTools}</div>}
          {shelf && (
            <section className="cl-ws__shelf" aria-label={shelfLabel}>
              {shelf}
            </section>
          )}
        </div>
      </div>
      <section className="cl-ws__inspector cl-panel" aria-label="Creature inspector">
        <div className="cl-ws__tabs">
          <Tabs tabs={tabs} value={current?.id} onChange={onTabChange} label="Creature inspector" idBase={idBase} />
        </div>
        {current && (
          <div className="cl-ws__panel cl-scroll" {...tabPanelProps(idBase, current.id)}>
            <h2 className="cl-sr-only">{current.label}</h2>
            {current.content}
          </div>
        )}
      </section>
    </div>
  );
}

const SNAP = ["peek", "half", "full"];

function PhoneWorkshop({ chat, tabs, activeTab, onTabChange, shelf, shelfLabel, stepper, nameTag, stageTools, status, idBase, chatTitle, phoneStatus }) {
  const [snap, setSnap] = useState("half");
  const drag = useRef(null);
  const sheetRef = useRef(null);
  const all = [{ id: "chat", label: chatTitle, icon: "chat", content: chat }, ...tabs, ...(shelf ? [{ id: "shelf", label: shelfLabel, icon: "box", content: shelf }] : [])];
  const current = all.find(tab => tab.id === activeTab) || all[0];

  function choose(id) {
    onTabChange?.(id);
    if (snap === "peek") setSnap("half");
  }
  function onHandleDown(event) {
    drag.current = { y: event.clientY, h: sheetRef.current?.getBoundingClientRect().height || 0, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onHandleMove(event) {
    if (!drag.current || !sheetRef.current) return;
    const dy = event.clientY - drag.current.y;
    if (Math.abs(dy) > 4) drag.current.moved = true;
    sheetRef.current.style.height = `${Math.max(120, drag.current.h - dy)}px`;
  }
  function onHandleUp(event) {
    const info = drag.current;
    drag.current = null;
    if (!sheetRef.current || !info) return;
    const height = sheetRef.current.getBoundingClientRect().height;
    sheetRef.current.style.height = "";
    if (!info.moved) {
      setSnap(value => SNAP[(SNAP.indexOf(value) + 1) % SNAP.length]);
      return;
    }
    const vh = window.innerHeight;
    setSnap(height < vh * 0.3 ? "peek" : height < vh * 0.68 ? "half" : "full");
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  return (
    <div className="cl-ws cl-ws--phone" data-snap={snap}>
      <div className="cl-ws__phone-top">
        {stepper}
        {nameTag}
        {status}
      </div>
      {stageTools && <div className="cl-ws__phone-tools">{stageTools}</div>}
      <section ref={sheetRef} className="cl-sheet cl-panel" data-snap={snap} aria-label="Workshop panels">
        <button
          type="button"
          className="cl-sheet__handle"
          aria-label={snap === "full" ? "Shrink panel" : "Expand panel"}
          aria-expanded={snap !== "peek"}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSnap(value => SNAP[(SNAP.indexOf(value) + 1) % SNAP.length]);
            }
          }}
        >
          <span aria-hidden="true" />
        </button>
        <div
          className="cl-sheet__tabs"
          role="tablist"
          aria-label="Workshop panels"
          onKeyDown={event => {
            const next = rovingKeyDown(event, { selector: '[role="tab"]' });
            if (next) choose(next.dataset.tab);
          }}
        >
          {all.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-tab={tab.id}
              id={`${idBase}-tab-${tab.id}`}
              aria-selected={tab.id === current.id}
              aria-controls={`${idBase}-panel-${tab.id}`}
              tabIndex={tab.id === current.id ? 0 : -1}
              className="cl-sheet__tab"
              onClick={() => choose(tab.id)}
            >
              <span className="cl-sheet__tab-icon">
                <Icon name={tab.icon} />
                {tab.badge && <span className="cl-sheet__tab-badge">{tab.badge}</span>}
              </span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        {snap === "peek" && phoneStatus ? <div className="cl-sheet__peek">{phoneStatus}</div> : null}
        <div className={cx("cl-sheet__body", current.id === "chat" ? "is-chat" : "cl-scroll")} {...tabPanelProps(idBase, current.id)} hidden={snap === "peek"}>
          {current.id !== "chat" && current.id !== "shelf" && <h2 className="cl-sr-only">{current.label}</h2>}
          {current.content}
        </div>
      </section>
    </div>
  );
}

/** Tab badge helpers for the inspector. */
export const TabDot = ({ tone = "bubble", label }) => (
  <span className={`cl-tabdot cl-tabdot--${tone}`} role="img" aria-label={label} />
);

export function TabBadge({ children, tone = "neutral" }) {
  return <Badge tone={tone}>{children}</Badge>;
}

export default WorkshopLayout;
