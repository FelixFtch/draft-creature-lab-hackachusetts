// Toasts: short, non-blocking confirmations ("Saved to shelf", "+1 spark").
// Two persistent live regions (polite + assertive) so screen readers hear
// new toasts reliably. Errors stay until dismissed; others time out.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { cx } from "./primitives.jsx";

const ICON = { info: "info", good: "check", warn: "alert", bad: "alert", spark: "spark", sticker: "sticker", train: "train" };

/** Toast state helper. push({ title, text?, tone?, icon?, action?, duration? }) → id */
export function useToasts(limit = 4) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const dismiss = useCallback(id => {
    setToasts(list => list.filter(t => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);
  const push = useCallback(
    toast => {
      const id = toast.id || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const duration = toast.duration ?? (toast.tone === "bad" ? 0 : 4200);
      setToasts(list => [...list.filter(t => t.id !== id), { ...toast, id }].slice(-limit));
      if (duration > 0) timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss, limit],
  );
  useEffect(() => {
    const map = timers.current;
    return () => map.forEach(timer => window.clearTimeout(timer));
  }, []);
  return { toasts, push, dismiss };
}

function Toast({ toast, onDismiss }) {
  const tone = toast.tone || "info";
  return (
    <div className={cx("cl-toast", `cl-toast--${tone}`)}>
      <span className="cl-toast__icon" aria-hidden="true">
        <Icon name={toast.icon || ICON[tone] || "info"} size={20} strokeWidth={2.3} />
      </span>
      <div className="cl-toast__text">
        <strong>{toast.title}</strong>
        {toast.text && <span>{toast.text}</span>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="cl-toast__action"
          onClick={() => {
            toast.action.onClick?.();
            onDismiss?.(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="cl-toast__close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

/** Toast stack. placement: "top" (workshop) | "hud" (playground, under the challenge tracker) | "bottom". */
export function Toasts({ toasts = [], onDismiss, placement = "top" }) {
  const polite = toasts.filter(t => t.tone !== "bad");
  const urgent = toasts.filter(t => t.tone === "bad");
  return (
    <section className={cx("cl-toasts", `cl-toasts--${placement}`)} aria-label="Notifications">
      <div aria-live="polite" aria-atomic="false" className="cl-toasts__stack">
        {polite.map(t => (
          <Toast key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="cl-toasts__stack">
        {urgent.map(t => (
          <Toast key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
    </section>
  );
}

export default Toasts;
