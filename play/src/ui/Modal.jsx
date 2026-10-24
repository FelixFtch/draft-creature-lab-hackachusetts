// Modal built on the native <dialog>: top layer, inert background, focus
// containment and Esc for free. We add: return focus on close, backdrop
// click to close, and three placements (center card, right drawer, bottom
// sheet). The engine keeps running underneath unless the caller pauses it.
import { useEffect, useId, useRef } from "react";
import { Icon } from "./icons.jsx";
import { IconButton, cx } from "./primitives.jsx";

/**
 * Modal props:
 *  open, onClose(), title, icon, description
 *  placement: "center" | "right" | "bottom"; size: "sm" | "md" | "lg"
 *  tone: "paper" | "blueprint" | "toy"; footer: ReactNode
 *  dismissible (default true): Esc / backdrop / close button
 *  initialFocus: CSS selector inside the dialog to focus first
 */
export function Modal({ open, onClose, title, icon, description, placement = "center", size = "md", tone = "paper", footer, dismissible = true, initialFocus, className, children, hideTitle = false }) {
  const ref = useRef(null);
  const returnTo = useRef(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement;
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
      const target = initialFocus ? dialog.querySelector(initialFocus) : null;
      if (target) target.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [open, initialFocus]);

  // Restore focus when the dialog closes for any reason.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const onCloseEvent = () => {
      const target = returnTo.current;
      returnTo.current = null;
      if (target && typeof target.focus === "function" && document.contains(target)) target.focus();
    };
    dialog.addEventListener("close", onCloseEvent);
    return () => dialog.removeEventListener("close", onCloseEvent);
  }, []);

  return (
    <dialog
      ref={ref}
      className={cx("cl-modal", `cl-modal--${placement}`, `cl-modal--${size}`, `cl-modal--${tone}`, tone === "blueprint" && "cl-bp", className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={event => {
        event.preventDefault();
        if (dismissible) onClose?.();
      }}
      onClick={event => {
        if (dismissible && event.target === ref.current) onClose?.();
      }}
    >
      {open && (
        <div className="cl-modal__frame">
          <header className={cx("cl-modal__head", hideTitle && "cl-sr-only")}>
            {icon && (
              <span className="cl-modal__icon" aria-hidden="true">
                {typeof icon === "string" ? <Icon name={icon} /> : icon}
              </span>
            )}
            <div className="cl-modal__titles">
              <h2 id={titleId} className="cl-modal__title">
                {title}
              </h2>
              {description && (
                <p id={descId} className="cl-modal__desc">
                  {description}
                </p>
              )}
            </div>
            {dismissible && <IconButton icon="close" label="Close" variant="ghost" onClick={onClose} className="cl-modal__close" />}
          </header>
          <div className="cl-modal__body cl-scroll">{children}</div>
          {footer && <footer className="cl-modal__foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export default Modal;
