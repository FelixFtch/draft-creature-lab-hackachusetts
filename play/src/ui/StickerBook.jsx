// Stickers: the reward language. Die-cut round stickers with a white border
// and a slight tilt; an album page that shows earned stickers and dashed
// outlines (with hints) for the rest; and the "new sticker" pop, the peak
// moment of a challenge.
import { useEffect, useRef } from "react";
import { Icon } from "./icons.jsx";
import { cx } from "./primitives.jsx";

const TONES = {
  leaf: ["#2bae68", "#1c2440"],
  sun: ["#ffc63a", "#1c2440"],
  sky: ["#49b6f0", "#1c2440"],
  tomato: ["#ec4d37", "#fffcf5"],
  grape: ["#7b5cf5", "#fffcf5"],
  bubble: ["#ff6f95", "#1c2440"],
  bp: ["#1e4e95", "#fffcf5"],
};

// Small art drawn on a 48-unit circle. Inline, so stickers never need assets.
const ART = {
  paw: <><path d="M24 26c5.4 0 10.4 5 10.4 9.6 0 3-2.4 4.8-5.2 4.8-2 0-3.2-1.1-5.2-1.1s-3.2 1.1-5.2 1.1c-2.8 0-5.2-1.8-5.2-4.8C13.6 31 18.6 26 24 26Z" /><circle cx="13" cy="22" r="3.6" /><circle cx="19.5" cy="14.5" r="3.6" /><circle cx="28.5" cy="14.5" r="3.6" /><circle cx="35" cy="22" r="3.6" /></>,
  spark: <path d="m24 7 3.6 13.4L41 24l-13.4 3.6L24 41l-3.6-13.4L7 24l13.4-3.6L24 7Z" />,
  pencil: <><path d="m13 35 3-9 16-16 6 6-16 16-9 3Z" /><path d="m29 13 6 6" fill="none" /></>,
  cap: <><path d="M6 20 24 11l18 9-18 9-18-9Z" /><path d="M13 24v8c0 2.6 5 5 11 5s11-2.4 11-5v-8" fill="none" /></>,
  ramp: <><path d="M8 36h32V18L8 36Z" /><circle cx="17" cy="22" r="3.4" /></>,
  ball: <><circle cx="24" cy="24" r="13" /><path d="M11.5 21c5 2 9 6 10.5 16M36.5 20c-6 .4-11 3.8-14 9.4M18 12c2 4 6.4 7 14 6.4" fill="none" /></>,
  domino: <><rect x="12" y="10" width="11" height="24" rx="2" transform="rotate(-18 17.5 22)" /><rect x="26" y="14" width="11" height="24" rx="2" /></>,
  hoop: <><circle cx="24" cy="24" r="12" fill="none" strokeWidth="5" /><path d="M8 40c6-4 10-10 14-16" fill="none" /></>,
  lily: <><path d="M24 12a13 13 0 1 0 13 13H24V12Z" /><circle cx="35" cy="15" r="3" /></>,
  eye: <><path d="M6 24s7-11 18-11 18 11 18 11-7 11-18 11S6 24 6 24Z" /><circle cx="24" cy="24" r="5" /></>,
  bolt: <path d="M27 7 12 27h11l-2 14 15-20H25l2-14Z" />,
  remix: <><circle cx="15" cy="13" r="4" /><circle cx="33" cy="13" r="4" /><circle cx="24" cy="36" r="4" /><path d="M15 17v2a7 7 0 0 0 7 7h4a7 7 0 0 0 7-7v-2M24 26v6" fill="none" /></>,
  star: <path d="m24 8 4.9 10 11 1.6-8 7.8 1.9 11L24 33.2 14.2 38.4l1.9-11-8-7.8 11-1.6L24 8Z" />,
  flag: <><path d="M15 39V9" fill="none" /><path d="M15 10h20l-4 7 4 7H15" /></>,
};

/** One die-cut sticker. size in px. earned=false draws the dashed outline slot. */
export function Sticker({ art = "star", tone = "sun", size = 88, earned = true, title, tilt, className }) {
  const [fill, ink] = TONES[tone] || TONES.sun;
  const angle = tilt ?? ((art.charCodeAt(0) * 7) % 13) - 6;
  const labelled = typeof title === "string" && title;
  if (!earned) {
    return (
      <svg className={cx("cl-sticker-slot", className)} viewBox="0 0 64 64" width={size} height={size} role={labelled ? "img" : undefined} aria-label={labelled ? `${title}, not earned yet` : undefined} aria-hidden={labelled ? undefined : "true"}>
        <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="5 5" />
        <g transform="translate(8 8)" fill="currentColor" stroke="none" opacity=".18">
          {ART[art] || ART.star}
        </g>
      </svg>
    );
  }
  return (
    <svg className={cx("cl-sticker-art", className)} viewBox="0 0 64 64" width={size} height={size} style={{ transform: `rotate(${angle}deg)` }} role={labelled ? "img" : undefined} aria-label={labelled ? `${title} sticker` : undefined} aria-hidden={labelled ? undefined : "true"}>
      <circle cx="32" cy="32" r="30" fill="#fffcf5" />
      <circle cx="32" cy="32" r="25.5" fill={fill} stroke="#1c2440" strokeWidth="2" />
      <path d="M14 20a22 22 0 0 1 13-11" stroke="#fff" strokeOpacity=".45" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <g transform="translate(8 8)" fill={ink} stroke={ink} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round">
        {ART[art] || ART.star}
      </g>
    </svg>
  );
}

/**
 * StickerBook props:
 *  stickers: [{ id, title, art, tone, earned, hint? }], newId: highlight one
 */
export function StickerBook({ stickers = [], newId }) {
  const earned = stickers.filter(s => s.earned).length;
  return (
    <div className="cl-album">
      <p className="cl-album__count">
        <strong className="cl-mono">
          {earned} of {stickers.length}
        </strong>{" "}
        stickers collected
      </p>
      <ul className="cl-album__grid">
        {stickers.map(s => (
          <li key={s.id} className={cx("cl-album__slot", s.earned ? "is-earned" : "is-empty", s.id === newId && "is-new")}>
            <Sticker art={s.art} tone={s.tone} earned={s.earned} size={84} />
            <strong>{s.title}</strong>
            {!s.earned && s.hint && <span>{s.hint}</span>}
            {s.id === newId && <span className="cl-album__new">New</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * StickerPop: celebration when a sticker is earned. Auto-dismisses.
 * sticker: { id, title, art, tone }; onDone(); duration ms
 */
export function StickerPop({ sticker, onDone, duration = 2800, onOpenBook }) {
  const timer = useRef(0);
  useEffect(() => {
    if (!sticker) return undefined;
    timer.current = window.setTimeout(() => onDone?.(), duration);
    return () => window.clearTimeout(timer.current);
  }, [sticker, duration, onDone]);
  if (!sticker) return null;
  return (
    <div className="cl-pop" role="status" aria-live="polite">
      <div className="cl-pop__burst" aria-hidden="true">
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} style={{ "--a": `${(i * 360) / 14}deg`, "--d": `${(i % 3) * 40}ms` }} />
        ))}
      </div>
      <div className="cl-pop__card">
        <Sticker art={sticker.art} tone={sticker.tone} size={148} tilt={-8} />
        <p className="cl-pop__kicker">New sticker</p>
        <p className="cl-pop__title">{sticker.title}</p>
        {onOpenBook && (
          <button type="button" className="cl-linkbtn cl-pop__link" onClick={onOpenBook}>
            <Icon name="sticker" size={16} /> Open sticker book
          </button>
        )}
      </div>
    </div>
  );
}

export default StickerBook;
