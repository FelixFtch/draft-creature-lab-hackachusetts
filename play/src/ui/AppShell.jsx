// AppShell: the persistent frame. The 3D stage is a full-bleed slot that is
// never unmounted when the mode changes (engines keep their WebGL context);
// UI sits in overlay layers above it.
//
// Layers (bottom to top): stage, mode overlay (WorkshopLayout or PlayHUD),
// top bar, toasts, modals, title screen.
import { useId } from "react";
import { Icon } from "./icons.jsx";
import { IconButton } from "./primitives.jsx";
import { Logo } from "./Logo.jsx";

export function ModeSwitch({ mode, onChange, playgroundLocked = false, playgroundHint, compact = false }) {
  const name = useId();
  const hintId = `${name}-hint`;
  const options = [
    { value: "workshop", label: "Workshop", icon: "bench" },
    { value: "playground", label: "Playground", icon: "park", locked: playgroundLocked },
  ];
  return (
    <div className={`cl-modeswitch${compact ? " cl-modeswitch--compact" : ""}`} role="radiogroup" aria-label="Mode" data-mode={mode}>
      <span className="cl-modeswitch__thumb" aria-hidden="true" />
      {options.map(option => (
        <label key={option.value} className="cl-modeswitch__opt" title={option.locked ? playgroundHint : undefined}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={mode === option.value}
            disabled={option.locked}
            aria-describedby={option.locked && playgroundHint ? hintId : undefined}
            onChange={() => onChange?.(option.value)}
          />
          <span className="cl-modeswitch__face">
            <Icon name={option.locked ? "lock" : option.icon} />
            <span className="cl-modeswitch__label">{option.label}</span>
          </span>
        </label>
      ))}
      {playgroundLocked && playgroundHint && (
        <span id={hintId} className="cl-sr-only">
          {playgroundHint}
        </span>
      )}
    </div>
  );
}

/**
 * Props:
 *  mode: "workshop" | "playground"; onModeChange(mode)
 *  playgroundLocked, playgroundHint: lock the Playground tab with a reason
 *  stage: ReactNode for the full-bleed 3D slot (persistent)
 *  children: the mode overlay (WorkshopLayout / PlayHUD)
 *  muted, onToggleMute, onOpenSettings, topActions (extra IconButtons)
 *  toasts, modals: rendered above everything; titleScreen: first-run cover
 *  motion: "auto" | "reduce" | "full" (Settings override of OS preference)
 *  onBrandClick: optional (e.g. reopen the title screen)
 */
export function AppShell({
  mode = "workshop",
  onModeChange,
  playgroundLocked = false,
  playgroundHint = "Teach a creature to walk to unlock the playground",
  stage,
  children,
  muted = false,
  onToggleMute,
  onOpenSettings,
  topActions,
  toasts,
  modals,
  titleScreen,
  motion = "auto",
  onBrandClick,
  stageLabel,
  className = "",
}) {
  const covered = !!titleScreen;
  return (
    <div className={`cl-root cl-shell ${className}`.trim()} data-mode={mode} data-motion={motion === "auto" ? undefined : motion}>
      <a className="cl-skip" href="#cl-main">
        Skip to controls
      </a>
      <div className="cl-shell__stage" role="region" aria-label={stageLabel || (mode === "playground" ? "Playground world" : "Workshop stage")} inert={covered || undefined}>
        {stage}
      </div>
      <div className="cl-shell__vignette" aria-hidden="true" />
      <header className="cl-topbar" inert={covered || undefined}>
        <h1 className="cl-topbar__start">
          {onBrandClick ? (
            <button type="button" className="cl-topbar__brand" onClick={onBrandClick} aria-label="Draft Creature Lab home">
              <Logo size="sm" compact as="span" />
            </button>
          ) : (
            <span className="cl-topbar__brand">
              <Logo size="sm" compact as="span" />
            </span>
          )}
        </h1>
        <ModeSwitch mode={mode} onChange={onModeChange} playgroundLocked={playgroundLocked} playgroundHint={playgroundHint} />
        <div className="cl-topbar__end">
          {topActions}
          {onToggleMute && <IconButton icon={muted ? "mute" : "sound"} label="Sound" pressed={!muted} onClick={onToggleMute} />}
          {onOpenSettings && <IconButton icon="settings" label="Settings" onClick={onOpenSettings} />}
        </div>
      </header>
      <main id="cl-main" className="cl-shell__layer" tabIndex={-1} inert={covered || undefined}>
        {children}
      </main>
      {toasts}
      {modals}
      {titleScreen}
    </div>
  );
}

/** Small floating status line for the stage (loading, errors). */
export function StageStatus({ tone = "info", busy = false, children }) {
  if (!children) return null;
  return (
    <div className={`cl-stage-status cl-stage-status--${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {busy ? <span className="cl-spinner" aria-hidden="true" /> : <Icon name={tone === "bad" ? "alert" : tone === "good" ? "check" : "info"} size={18} />}
      <span>{children}</span>
    </div>
  );
}

export default AppShell;
