// Toy-part primitives: Button, IconButton, Badge, Chip, Segmented, Slider,
// Switch, Keycap, Tabs, ProgressRing, Meter, Callout, Swatch.
// All are plain controlled components; no internal data fetching.
import { forwardRef, useId, useRef } from "react";
import { Icon } from "./icons.jsx";
import { rovingKeyDown } from "./hooks.js";
import { clamp, isNum } from "./format.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

/**
 * Button. variant: "default" | "primary" | "go" | "blueprint" | "danger" | "ghost";
 * size: "sm" | "md" | "lg". `busy` keeps the label, adds a spinner and aria-busy.
 */
export const Button = forwardRef(function Button(
  { variant = "default", size = "md", icon, iconRight, busy = false, block = false, className, children, type = "button", disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "cl-btn",
        variant !== "default" && `cl-btn--${variant}`,
        size !== "md" && `cl-btn--${size}`,
        block && "cl-btn--block",
        className,
      )}
      aria-busy={busy || undefined}
      disabled={disabled}
      {...rest}
    >
      {busy ? <span className="cl-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      <span className="cl-btn__label">{children}</span>
      {iconRight && <Icon name={iconRight} />}
    </button>
  );
});

/** Square/round icon-only button. `label` is required: it becomes aria-label and the tooltip. */
export const IconButton = forwardRef(function IconButton(
  { icon, label, variant = "default", size = "md", round = false, pressed, count, className, type = "button", tooltip = true, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "cl-iconbtn",
        variant !== "default" && `cl-iconbtn--${variant}`,
        size !== "md" && `cl-iconbtn--${size}`,
        round && "cl-iconbtn--round",
        className,
      )}
      aria-label={label}
      title={tooltip ? label : undefined}
      aria-pressed={typeof pressed === "boolean" ? pressed : undefined}
      {...rest}
    >
      <Icon name={icon} />
      {isNum(count) && count > 0 && (
        <span className="cl-iconbtn__dot" aria-hidden="true">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
});

/** Status pill. tone: neutral | good | warn | bad | info | grape | bubble | ink | outline; `stamp` = blueprint stamp. */
export function Badge({ tone = "neutral", icon, stamp = false, className, children, ...rest }) {
  return (
    <span className={cx("cl-badge", tone !== "neutral" && `cl-badge--${tone}`, stamp && "cl-badge--stamp", className)} {...rest}>
      {icon && <Icon name={icon} size={14} strokeWidth={2.4} />}
      {children}
    </span>
  );
}

/** Suggestion / filter chip. Pass `pressed` to make it a toggle. */
export function Chip({ icon, pressed, blueprint = false, className, children, type = "button", ...rest }) {
  return (
    <button
      type={type}
      className={cx("cl-chip", blueprint && "cl-chip--blueprint", className)}
      aria-pressed={typeof pressed === "boolean" ? pressed : undefined}
      {...rest}
    >
      {icon && <Icon name={icon} size={16} />}
      <span>{children}</span>
    </button>
  );
}

/**
 * Segmented control built on native radios (arrow keys work for free).
 * options: [{ value, label, icon?, disabled?, hint? }]
 */
export function Segmented({ label, options, value, onChange, name, tone, block = false, hideLabel = true, disabled, className, size }) {
  const autoName = useId();
  const groupName = name || autoName;
  // A div radiogroup instead of fieldset/legend: same semantics for assistive
  // tech, without fieldset's legend layout quirks inside flex rows.
  return (
    <div
      role="radiogroup"
      aria-label={hideLabel ? label : undefined}
      aria-disabled={disabled || undefined}
      className={cx("cl-seg", tone === "sun" && "cl-seg--sun", tone === "bp" && "cl-seg--bp", block && "cl-seg--block", size === "sm" && "cl-seg--sm", className)}
    >
      {!hideLabel && <span className="cl-seg__legend">{label}</span>}
      {options.map(option => (
        <label key={option.value} className="cl-seg__opt" title={option.hint}>
          <input
            type="radio"
            name={groupName}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => onChange?.(option.value)}
          />
          <span className="cl-seg__face">
            {option.icon && (typeof option.icon === "string" ? <Icon name={option.icon} /> : option.icon)}
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}

/** Range slider with a visible label, live value and optional end labels. */
export function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, onCommit, format, ends, hint, disabled, id, className }) {
  const autoId = useId();
  const inputId = id || autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const pct = `${((clamp(value, min, max) - min) / (max - min || 1)) * 100}%`;
  const shown = format ? format(value) : String(value);
  return (
    <div className={cx("cl-slider", className)}>
      <div className="cl-slider__head">
        <label className="cl-slider__label" htmlFor={inputId}>
          {label}
        </label>
        <output className="cl-slider__value cl-mono" htmlFor={inputId}>
          {shown}
        </output>
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={isNum(value) ? value : min}
        disabled={disabled}
        style={{ "--pct": pct }}
        aria-valuetext={shown}
        aria-describedby={hintId}
        onChange={event => onChange?.(Number(event.target.value))}
        onPointerUp={event => onCommit?.(Number(event.currentTarget.value))}
        onKeyUp={event => onCommit?.(Number(event.currentTarget.value))}
      />
      {ends && (
        <div className="cl-slider__ends" aria-hidden="true">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
      {hint && (
        <p className="cl-slider__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function Switch({ label, checked, onChange, disabled, className, describedBy }) {
  return (
    <label className={cx("cl-switch", className)}>
      <input type="checkbox" role="switch" checked={!!checked} disabled={disabled} aria-describedby={describedBy} onChange={event => onChange?.(event.target.checked)} />
      <span className="cl-switch__track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Keycap({ children, label }) {
  return (
    <kbd className="cl-key" aria-label={label}>
      {children}
    </kbd>
  );
}

/**
 * Tabs with roving focus. tabs: [{ id, label, icon?, badge? }].
 * Renders only the tablist; panels use tabPanelProps(id) for wiring.
 */
export function Tabs({ tabs, value, onChange, label, idBase, className }) {
  const auto = useId();
  const base = idBase || auto;
  return (
    <div
      className={cx("cl-tabs", className)}
      role="tablist"
      aria-label={label}
      onKeyDown={event => {
        const next = rovingKeyDown(event, { selector: '[role="tab"]' });
        if (next) onChange?.(next.dataset.tab);
      }}
    >
      {tabs.map(tab => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            data-tab={tab.id}
            aria-selected={selected}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className="cl-tab"
            onClick={() => onChange?.(tab.id)}
          >
            {tab.icon && <Icon name={tab.icon} />}
            <span className="cl-tab__text">{tab.label}</span>
            {tab.badge && <span className="cl-tab__badge">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export const tabPanelProps = (base, id) => ({
  role: "tabpanel",
  id: `${base}-panel-${id}`,
  "aria-labelledby": `${base}-tab-${id}`,
  tabIndex: 0,
});

/**
 * Circular progress. `value` 0..1 or null for indeterminate.
 * `label` (string) is announced; `children` render in the middle.
 */
export function ProgressRing({ value = null, size = 44, stroke = 5, color, track, label, children, className }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const determinate = isNum(value);
  const v = determinate ? clamp(value, 0, 1) : 0.28;
  return (
    <span
      className={cx("cl-ring", !determinate && "cl-ring--spin", className)}
      style={{ width: size, height: size, "--ring-color": color, "--ring-track": track }}
      role={label ? "progressbar" : undefined}
      aria-label={label}
      aria-valuemin={label && determinate ? 0 : undefined}
      aria-valuemax={label && determinate ? 100 : undefined}
      aria-valuenow={label && determinate ? Math.round(v * 100) : undefined}
      aria-hidden={label ? undefined : "true"}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="cl-ring__track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          className="cl-ring__value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
        />
      </svg>
      {children != null && <span className="cl-ring__label">{children}</span>}
    </span>
  );
}

/** Single-hue horizontal meter. value/max; color = CSS color; label for a11y. */
export function Meter({ value, max = 1, color, track, label, className, height }) {
  const pct = isNum(value) && max > 0 ? clamp(value / max, 0, 1) * 100 : 0;
  return (
    <span
      className={cx("cl-meter", className)}
      style={{ "--meter-fill": color, "--meter-track": track, height }}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={isNum(value) ? value : undefined}
    >
      <span className="cl-meter__fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

const CALLOUT_ICON = { info: "info", good: "check", warn: "alert", bad: "alert", plain: "note" };
export function Callout({ tone = "info", icon, title, children, className, role }) {
  return (
    <div className={cx("cl-callout", tone !== "info" && `cl-callout--${tone}`, className)} role={role}>
      <Icon name={icon || CALLOUT_ICON[tone] || "info"} />
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

/** Color swatch toggle. */
export function Swatch({ color, label, selected, onClick, className, ...rest }) {
  return (
    <button
      type="button"
      className={cx("cl-swatch", className)}
      style={{ "--swatch": color, "--swatch-ink": inkFor(color) }}
      aria-label={label}
      title={label}
      aria-pressed={!!selected}
      onClick={onClick}
      {...rest}
    >
      {selected && <Icon name="check" strokeWidth={3} />}
    </button>
  );
}

/** Ink or paper text for a given background hex (simple luminance split). */
export function inkFor(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return "#1c2440";
  const n = parseInt(hex.slice(1), 16);
  const lin = c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.22 ? "#1c2440" : "#fffcf5";
}

/** Copy-to-clipboard helper button with a short confirmation. */
export function CopyButton({ text, label = "Copy", copiedLabel = "Copied", className, onCopied, size = "sm" }) {
  const ref = useRef(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (ref.current) {
        ref.current.dataset.copied = "true";
        ref.current.setAttribute("aria-label", copiedLabel);
        window.setTimeout(() => {
          if (!ref.current) return;
          delete ref.current.dataset.copied;
          ref.current.setAttribute("aria-label", label);
        }, 1400);
      }
      onCopied?.(true);
    } catch {
      onCopied?.(false);
    }
  }
  return <IconButton ref={ref} icon="copy" label={label} size={size} variant="ghost" className={cx("cl-copy", className)} onClick={copy} />;
}

export { cx };
