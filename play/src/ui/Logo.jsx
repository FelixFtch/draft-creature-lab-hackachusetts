// Draft Creature Lab identity.
//
// The glyph is a toy creature standing on a blueprint tile, measured by a
// dimension line: a drawing that is also a toy. The wordmark pairs "Draft"
// in technical lettering (credit to the MIT Draft method, set like a
// dimensioned label) with "Creature Lab" in chunky casual lettering.

export function LogoGlyph({ size = 40, title, className = "", ...rest }) {
  const labelled = typeof title === "string" && title;
  return (
    <svg
      className={`cl-logo-glyph ${className}`.trim()}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : "true"}
      focusable="false"
      {...rest}
    >
      <rect x="2" y="2" width="44" height="44" rx="12" fill="#3a414c" stroke="#1c2440" strokeWidth="2.5" />
      <path d="M13 3v42M24 3v42M35 3v42M3 13h42M3 24h42M3 35h42" stroke="#dce8fb" strokeOpacity=".16" strokeWidth="1" />
      {/* dimension line over the creature */}
      <path d="M9 8.5v4.5M39 8.5v4.5M9 10.75h30" stroke="#dce8fb" strokeOpacity=".9" strokeWidth="1.5" strokeLinecap="round" />
      {/* legs: blueprint linkages, knees back like a real quadruped */}
      <path d="M14.5 27 11 33.5l3.5 6.5M32.5 27 29 33.5l3.5 6.5" fill="none" stroke="#fffcf5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="33.5" r="2.6" fill="#fffcf5" />
      <circle cx="29" cy="33.5" r="2.6" fill="#fffcf5" />
      {/* toy body */}
      <rect x="7.5" y="15.5" width="33" height="13.5" rx="6.75" fill="#d8cdb8" stroke="#1c2440" strokeWidth="2.4" />
      <circle cx="35" cy="21.5" r="2.2" fill="#1c2440" />
    </svg>
  );
}

/**
 * Full lockup. `size`: "sm" (top bar), "md", "lg" (title screen).
 * `compact` drops the wordmark below 900px wide via CSS.
 */
export function Logo({ size = "md", compact = false, className = "", as: Tag = "div", ...rest }) {
  const glyph = { sm: 36, md: 44, lg: 76 }[size] || 44;
  return (
    <Tag className={`cl-logo cl-logo--${size}${compact ? " cl-logo--compact" : ""} ${className}`.trim()} {...rest}>
      <LogoGlyph size={glyph} />
      <span className="cl-logo__words">
        <span className="cl-logo__draft">Draft</span>{" "}
        <span className="cl-logo__name">Creature Lab</span>
      </span>
    </Tag>
  );
}

export default Logo;
