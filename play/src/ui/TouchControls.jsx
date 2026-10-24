// TouchControls: virtual joystick + jump button for touch screens.
//
// The stick zone covers the lower-left of the screen; the base re-anchors
// under the thumb so it works without looking. For people who can't drag
// (WCAG 2.5.7), variant="buttons" gives press-and-hold arrow buttons that
// also respond to Space/Enter held down. Keyboard and gamepad driving are
// handled by the world engine, not here.
//
// onCommand({ x, y }) gets a normalised vector (x right, y down, |v| ≤ 1);
// the main agent maps it to game.setCommand({ vx: -y·vMax, wz: -x·wMax }).
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { cx } from "./primitives.jsx";

const DEAD = 0.08;

function useLatestFn(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args) => ref.current?.(...args), []);
}

function Stick({ onCommand, disabled }) {
  const zone = useRef(null);
  const active = useRef(null);
  const [base, setBase] = useState(null);
  const [nub, setNub] = useState({ x: 0, y: 0 });
  const emit = useLatestFn(onCommand);
  const radius = 56;

  const end = useCallback(() => {
    active.current = null;
    setBase(null);
    setNub({ x: 0, y: 0 });
    emit({ x: 0, y: 0 });
  }, [emit]);

  useEffect(() => {
    const onBlur = () => active.current && end();
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    };
  }, [end]);

  function move(event) {
    if (!active.current || active.current.id !== event.pointerId) return;
    const { cx: x0, cy: y0 } = active.current;
    let dx = (event.clientX - x0) / radius;
    let dy = (event.clientY - y0) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    setNub({ x: dx, y: dy });
    emit(Math.hypot(dx, dy) < DEAD ? { x: 0, y: 0 } : { x: dx, y: dy });
  }

  return (
    <div
      ref={zone}
      className={cx("cl-stickzone", disabled && "is-disabled")}
      role="group"
      aria-label="Joystick. Drag to move; keyboard players can use W A S D."
      onPointerDown={event => {
        if (disabled || active.current) return;
        const rect = zone.current.getBoundingClientRect();
        const cx0 = Math.min(Math.max(event.clientX, rect.left + radius + 8), rect.right - radius - 8);
        const cy0 = Math.min(Math.max(event.clientY, rect.top + radius + 8), rect.bottom - radius - 8);
        active.current = { id: event.pointerId, cx: cx0, cy: cy0 };
        setBase({ x: cx0 - rect.left, y: cy0 - rect.top });
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event);
      }}
      onPointerMove={move}
      onPointerUp={event => active.current?.id === event.pointerId && end()}
      onPointerCancel={event => active.current?.id === event.pointerId && end()}
      onContextMenu={event => event.preventDefault()}
    >
      <div className={cx("cl-stick", base && "is-live")} style={base ? { left: base.x, top: base.y } : undefined} aria-hidden="true">
        <span className="cl-stick__ring">
          <i className="cl-stick__chev cl-stick__chev--up" />
          <i className="cl-stick__chev cl-stick__chev--down" />
          <i className="cl-stick__chev cl-stick__chev--left" />
          <i className="cl-stick__chev cl-stick__chev--right" />
        </span>
        <span className="cl-stick__nub" style={{ transform: `translate(${nub.x * radius * 0.62}px, ${nub.y * radius * 0.62}px)` }} />
      </div>
    </div>
  );
}

const ARROWS = [
  { id: "up", icon: "chevron-up", label: "Forward", v: { x: 0, y: -1 } },
  { id: "left", icon: "chevron-left", label: "Turn left", v: { x: -1, y: 0 } },
  { id: "right", icon: "chevron-right", label: "Turn right", v: { x: 1, y: 0 } },
  { id: "down", icon: "chevron-down", label: "Back", v: { x: 0, y: 1 } },
];

function ArrowPad({ onCommand, disabled }) {
  const held = useRef(new Set());
  const emit = useLatestFn(onCommand);
  const [, force] = useState(0);
  const send = useCallback(() => {
    let x = 0;
    let y = 0;
    held.current.forEach(id => {
      const a = ARROWS.find(item => item.id === id);
      x += a.v.x;
      y += a.v.y;
    });
    const len = Math.hypot(x, y) || 1;
    emit(held.current.size ? { x: x / Math.max(1, len), y: y / Math.max(1, len) } : { x: 0, y: 0 });
    force(n => n + 1);
  }, [emit]);
  const press = id => {
    if (disabled) return;
    held.current.add(id);
    send();
  };
  const release = id => {
    if (!held.current.delete(id)) return;
    send();
  };
  useEffect(() => {
    const clear = () => {
      if (!held.current.size) return;
      held.current.clear();
      send();
    };
    window.addEventListener("blur", clear);
    return () => window.removeEventListener("blur", clear);
  }, [send]);
  return (
    <div className="cl-dpad" role="group" aria-label="Move: press and hold an arrow">
      {ARROWS.map(a => (
        <button
          key={a.id}
          type="button"
          className={cx("cl-dpad__btn", `cl-dpad__btn--${a.id}`, held.current.has(a.id) && "is-down")}
          aria-label={a.label}
          disabled={disabled}
          onPointerDown={event => {
            event.currentTarget.setPointerCapture(event.pointerId);
            press(a.id);
          }}
          onPointerUp={() => release(a.id)}
          onPointerCancel={() => release(a.id)}
          onLostPointerCapture={() => release(a.id)}
          onKeyDown={event => {
            if ((event.key === " " || event.key === "Enter") && !event.repeat) {
              event.preventDefault();
              press(a.id);
            }
          }}
          onKeyUp={event => {
            if (event.key === " " || event.key === "Enter") release(a.id);
          }}
          onBlur={() => release(a.id)}
          onContextMenu={event => event.preventDefault()}
        >
          <Icon name={a.icon} size={26} strokeWidth={3} />
        </button>
      ))}
    </div>
  );
}

/**
 * TouchControls props:
 *  variant: "stick" | "buttons"; onCommand({x, y}); disabled
 *  onJump(), canJump, jumpHint (why jump is locked)
 *  extra: ReactNode for more round buttons above Jump (e.g. Explore)
 */
export function TouchControls({ variant = "stick", onCommand, disabled = false, onJump, canJump = false, jumpHint = "Jump isn't learned yet", extra }) {
  // Touch fires on pointerdown (no 300 ms wait); the click that follows a
  // touch is ignored. Mouse and keyboard use the normal click.
  const lastTouch = useRef(0);
  return (
    <div className="cl-touch">
      {variant === "buttons" ? <ArrowPad onCommand={onCommand} disabled={disabled} /> : <Stick onCommand={onCommand} disabled={disabled} />}
      <div className="cl-touch__right">
        {extra}
        {onJump && (
          <button
            type="button"
            className="cl-jumpbtn"
            disabled={disabled || !canJump}
            aria-label={canJump ? "Jump" : `Jump. ${jumpHint}`}
            onPointerDown={event => {
              if (event.pointerType === "mouse") return;
              lastTouch.current = performance.now();
              onJump();
            }}
            onClick={() => {
              if (performance.now() - lastTouch.current < 700) return;
              onJump();
            }}
          >
            <Icon name={canJump ? "jump" : "lock"} size={30} strokeWidth={2.6} />
            <span>Jump</span>
          </button>
        )}
      </div>
    </div>
  );
}

export default TouchControls;
