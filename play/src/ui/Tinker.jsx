// Tinker, the AI robot designer. A toy-yellow head with a blueprint screen
// for a face: the toy half and the engineering half of the lab in one
// character. Moods are drawn on the screen so they stay readable at 28px.
//
//   <Tinker mood="idle" | "thinking" | "talking" | "happy" | "worried" | "sleeping"
//           pose="head" | "full"  wave size={56} title="Tinker is thinking" />
import { useId } from "react";

const MOODS = new Set(["idle", "thinking", "talking", "happy", "worried", "sleeping"]);

function Face({ mood }) {
  switch (mood) {
    case "thinking":
      return (
        <g className="cl-tinker__face">
          <rect className="cl-tinker__eye cl-tinker__eye--look" x="38" y="42" width="9" height="13" rx="4.5" />
          <rect className="cl-tinker__eye cl-tinker__eye--look" x="58" y="42" width="9" height="13" rx="4.5" />
          <g className="cl-tinker__dots">
            <circle cx="42" cy="66" r="2.6" />
            <circle cx="50" cy="66" r="2.6" />
            <circle cx="58" cy="66" r="2.6" />
          </g>
        </g>
      );
    case "talking":
      return (
        <g className="cl-tinker__face">
          <rect className="cl-tinker__eye cl-tinker__eye--blink" x="35" y="44" width="9" height="15" rx="4.5" />
          <rect className="cl-tinker__eye cl-tinker__eye--blink" x="56" y="44" width="9" height="15" rx="4.5" />
          <rect className="cl-tinker__mouth cl-tinker__mouth--talk" x="44" y="63" width="12" height="5" rx="2.5" />
        </g>
      );
    case "happy":
      return (
        <g className="cl-tinker__face">
          <path className="cl-tinker__line" d="M33.5 56c2.2-6.6 9-6.6 11.2 0M55.3 56c2.2-6.6 9-6.6 11.2 0" />
          <path className="cl-tinker__line" d="M42.5 63.5c4 4.2 11 4.2 15 0" />
        </g>
      );
    case "worried":
      return (
        <g className="cl-tinker__face">
          <circle className="cl-tinker__eye" cx="40" cy="56" r="4.2" />
          <circle className="cl-tinker__eye" cx="60" cy="56" r="4.2" />
          <path className="cl-tinker__line cl-tinker__line--thin" d="M33 49.5 44.5 45M67 49.5 55.5 45" />
          <path className="cl-tinker__line cl-tinker__line--thin" d="M41 67.5c2-2.6 4-2.6 6 0s4 2.6 6 0 4-2.6 6 0" />
        </g>
      );
    case "sleeping":
      return (
        <g className="cl-tinker__face">
          <path className="cl-tinker__line" d="M34 55.5h11M55 55.5h11" />
          <path className="cl-tinker__line cl-tinker__line--thin" d="M45.5 64.5h9" />
        </g>
      );
    default:
      return (
        <g className="cl-tinker__face">
          <rect className="cl-tinker__eye cl-tinker__eye--blink" x="35" y="44" width="9" height="15" rx="4.5" />
          <rect className="cl-tinker__eye cl-tinker__eye--blink" x="56" y="44" width="9" height="15" rx="4.5" />
          <path className="cl-tinker__line cl-tinker__line--thin" d="M45 65.5c3.2 2 6.8 2 10 0" />
        </g>
      );
  }
}

/** Head in a 100×100 box; reused by both poses. */
function Head({ mood, clipId }) {
  return (
    <g className="cl-tinker__head">
      {/* antenna */}
      <path className="cl-tinker__ink-line" d="M50 21V11" />
      <circle className="cl-tinker__bulb" cx="50" cy="8.5" r="6" />
      {mood === "thinking" && <circle className="cl-tinker__bulb-ring" cx="50" cy="8.5" r="6" />}
      {/* ear bolts */}
      <rect className="cl-tinker__ear" x="7" y="45" width="10" height="17" rx="3.5" />
      <rect className="cl-tinker__ear" x="83" y="45" width="10" height="17" rx="3.5" />
      <path className="cl-tinker__ink-line cl-tinker__ink-line--thin" d="M9.8 53.5h4.4M85.8 53.5h4.4" />
      {/* shell */}
      <rect className="cl-tinker__shell" x="14" y="20" width="72" height="65" rx="21" />
      <path className="cl-tinker__shine" d="M25.5 30.5c5-3.6 12.5-5 20-4.4" />
      {/* screen */}
      <rect className="cl-tinker__screen" x="22" y="32" width="56" height="43" rx="12.5" />
      <g clipPath={`url(#${clipId})`} className="cl-tinker__grid">
        <path d="M22 42.5h56M22 53.5h56M22 64.5h56M36 32v43M50 32v43M64 32v43" />
      </g>
      <path className="cl-tinker__glare" d="M66.5 36.5c3.2.4 5.5 2.6 6 5.8" />
      <Face mood={mood} />
      {mood === "happy" && (
        <g className="cl-tinker__cheeks">
          <ellipse cx="25.5" cy="80" rx="4.6" ry="2.6" />
          <ellipse cx="74.5" cy="80" rx="4.6" ry="2.6" />
        </g>
      )}
      {mood === "worried" && <path className="cl-tinker__drop" d="M89.5 22.5c3.4 4.4 3.6 7.6.2 8.8-3.6-1.1-3.6-4.3-.2-8.8Z" />}
      {mood === "sleeping" && (
        <path className="cl-tinker__ink-line cl-tinker__ink-line--thin cl-tinker__zz" d="M63 9h6l-6 6.5h6M73.5 2.5h4.5l-4.5 5h4.5" />
      )}
    </g>
  );
}

export function Tinker({ mood = "idle", pose = "head", wave = false, size, title, className = "", ...rest }) {
  const safeMood = MOODS.has(mood) ? mood : "idle";
  const uid = useId().replace(/:/g, "");
  const clipId = `cl-tinker-screen-${uid}`;
  const full = pose === "full";
  const width = size ?? (full ? 150 : 48);
  const height = full ? Math.round(width * 1.32) : width;
  const labelled = typeof title === "string" && title;
  return (
    <svg
      className={`cl-tinker cl-tinker--${safeMood}${full ? " cl-tinker--full" : ""}${wave ? " cl-tinker--wave" : ""} ${className}`.trim()}
      viewBox={full ? "0 0 120 158" : "0 0 100 100"}
      width={width}
      height={height}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : "true"}
      focusable="false"
      {...rest}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="22" y="32" width="56" height="43" rx="12.5" />
        </clipPath>
        {full && (
          <clipPath id={`${clipId}-body`}>
            <rect x="35" y="92" width="50" height="40" rx="14" />
          </clipPath>
        )}
      </defs>
      {full ? (
        <>
          {/* legs: little linkages, the same joint language as the creatures */}
          <g className="cl-tinker__limbs">
            <path d="M51 128 46 141 51 150M69 128l5 13-5 9" />
          </g>
          <circle className="cl-tinker__joint" cx="46" cy="141" r="3.6" />
          <circle className="cl-tinker__joint" cx="74" cy="141" r="3.6" />
          <rect className="cl-tinker__foot" x="40" y="148.5" width="17" height="7" rx="3.5" />
          <rect className="cl-tinker__foot" x="63" y="148.5" width="17" height="7" rx="3.5" />
          {/* body */}
          <rect className="cl-tinker__body" x="35" y="92" width="50" height="40" rx="14" />
          <g clipPath={`url(#${clipId}-body)`}>
            <path className="cl-tinker__body-grid" d="M35 105h50M35 118h50M51.5 92v40M68.5 92v40" />
          </g>
          <circle className="cl-tinker__chest" cx="60" cy="111.5" r="7.5" />
          <circle className="cl-tinker__chest-dot" cx="60" cy="111.5" r="2.2" />
          {/* left arm (viewer's left) holding a pencil */}
          <g className="cl-tinker__limbs">
            <path d="M36 100 25 113l5 12" />
          </g>
          <circle className="cl-tinker__joint" cx="25" cy="113" r="3.6" />
          <g className="cl-tinker__pencil">
            <path className="cl-tinker__pencil-body" d="M24 136.5 34.5 117" />
            <path className="cl-tinker__pencil-tip" d="m34.4 117.3 1.7-5.6-4.6 3.9Z" />
          </g>
          <circle className="cl-tinker__hand" cx="30" cy="125" r="4.6" />
          {/* right arm: rests, or waves hello */}
          {wave ? (
            <g className="cl-tinker__arm-r">
              <g className="cl-tinker__limbs">
                <path d="M84 100 96 88" />
              </g>
              <g className="cl-tinker__forearm">
                <g className="cl-tinker__limbs">
                  <path d="M96 88 101 73" />
                </g>
                <circle className="cl-tinker__hand" cx="101" cy="72" r="4.8" />
              </g>
              <circle className="cl-tinker__joint" cx="96" cy="88" r="3.6" />
            </g>
          ) : (
            <g className="cl-tinker__arm-r">
              <g className="cl-tinker__limbs">
                <path d="M84 100 95 113l-5 12" />
              </g>
              <circle className="cl-tinker__joint" cx="95" cy="113" r="3.6" />
              <circle className="cl-tinker__hand" cx="90" cy="125" r="4.6" />
            </g>
          )}
          <g transform="translate(10 6) scale(1)">
            <Head mood={safeMood} clipId={clipId} />
          </g>
        </>
      ) : (
        <Head mood={safeMood} clipId={clipId} />
      )}
    </svg>
  );
}

export default Tinker;
