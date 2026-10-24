// Inline SVG icon set. 24px grid, 2px round strokes, slightly chunky so the
// icons sit well inside toy keycaps. Decorative by default (aria-hidden); pass
// `title` only when the icon is the sole label of something.

const F = { fill: "currentColor", stroke: "none" };

const PATHS = {
  send: <><path d="M21 3 3 10.4l7.2 2.6L12.8 20 21 3Z" /><path d="m10.2 13 4.8-4.8" /></>,
  sparkle: <><path d="M11 3.5c.7 4.4 2.6 6.4 7 7.2-4.4.8-6.3 2.8-7 7.3-.7-4.5-2.6-6.5-7-7.3 4.4-.8 6.3-2.8 7-7.2Z" /><path d="M19 2.5v4M17 4.5h4" /></>,
  chat: <><path d="M5 4.5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7.5L6.5 21v-4H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" /><path d="M8 9.5h8M8 13h5" /></>,
  blueprint: <><path d="M4 20V4l16 16H4Z" /><path d="M8 16v-4l4 4H8Z" /><path d="M4 8h2M4 12h2" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1-.9-1.5-.9-2.5 0-1.1.9-1.9 2-1.9h1.9A4.2 4.2 0 0 0 21 10.7C21 6.4 17 3 12 3Z" /><circle cx="7.5" cy="11.5" r="1.4" {...F} /><circle cx="10" cy="7.3" r="1.4" {...F} /><circle cx="15" cy="7.6" r="1.4" {...F} /></>,
  train: <><path d="M2 9.5 12 4.5l10 5-10 5-10-5Z" /><path d="M6 11.6V16c0 1.6 2.7 3.2 6 3.2s6-1.6 6-3.2v-4.4" /><path d="M22 9.5v6" /></>,
  walk: <><path d="M12 12.2c2.9 0 5.6 2.7 5.6 5.2 0 1.6-1.3 2.6-2.8 2.6-1.1 0-1.8-.6-2.8-.6s-1.7.6-2.8.6c-1.5 0-2.8-1-2.8-2.6 0-2.5 2.7-5.2 5.6-5.2Z" /><circle cx="5.6" cy="10" r="1.9" /><circle cx="9.4" cy="5.6" r="1.9" /><circle cx="14.6" cy="5.6" r="1.9" /><circle cx="18.4" cy="10" r="1.9" /></>,
  jump: <><path d="m8 7 4-4 4 4M12 3v8" /><path d="M6 21h12" /><path d="m7.5 18.2 9-2.2M7.5 15l9-2.2" /></>,
  play: <path d="M7.5 4.6v14.8L19.3 12 7.5 4.6Z" />,
  pause: <><path d="M8.5 5v14M15.5 5v14" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" /><circle cx="12" cy="12" r="6.6" /></>,
  sound: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z" /><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.3 6.5a8 8 0 0 1 0 11" /></>,
  mute: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-up": <path d="m6 15 6-6 6 6" />,
  "chevron-left": <path d="m15 6-6 6 6 6" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  "arrow-left": <path d="M20 12H5M11 5l-7 7 7 7" />,
  alert: <><path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4.5" /><circle cx="12" cy="17.2" r="1.2" {...F} /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><circle cx="12" cy="7.8" r="1.2" {...F} /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.6" /><circle cx="12" cy="17.2" r="1.2" {...F} /></>,
  retry: <><path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5" /><path d="M4 4v5h5" /></>,
  printer: <><path d="M7 9V3.5h10V9" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v6.5H7z" /><path d="M17.5 12h.01" /></>,
  box: <><path d="M3.5 9.5h17v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-10Z" /><path d="M2.5 5h19v4.5h-19z" /><path d="M10 13.5h4" /></>,
  remix: <><circle cx="6" cy="5" r="2.2" /><circle cx="18" cy="5" r="2.2" /><circle cx="12" cy="19" r="2.2" /><path d="M6 7.2v1.3a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7.2M12 12.5v4.3" /></>,
  trash: <><path d="M4 7h16M10 3.5h4M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  spark: <path d="M12 2.5 14 10l7.5 2-7.5 2-2 7.5-2-7.5-7.5-2L10 10l2-7.5Z" />,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  sticker: <><path d="M4 4h16v9.5L13.5 20H4V4Z" /><path d="M13.5 20v-4.5a2 2 0 0 1 2-2H20" /></>,
  flag: <><path d="M5.5 21V3.5" /><path d="M5.5 4h12.5l-2.4 4.2 2.4 4.3H5.5" /></>,
  trophy: <><path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" /><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3.5M8 21h8M9 17.5h6" /></>,
  camera: <><path d="M4 7.5h3l1.8-3h6.4l1.8 3h3v12H4z" /><circle cx="12" cy="13.2" r="3.5" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.8 8.2-2.1 5.5-5.5 2.1 2.1-5.5 5.5-2.1Z" /></>,
  hash: <path d="M9.5 3.5 7.5 20.5M16.5 3.5l-2 17M4.5 8.5h16M3.5 15.5h16" />,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" /></>,
  bolt: <path d="M13.5 2.5 4.5 14h7l-1 7.5 9-11.5h-7l1-7.5Z" />,
  gauge: <><path d="M3.5 17a8.5 8.5 0 1 1 17 0" /><path d="m12 17 4.2-6" /><circle cx="12" cy="17" r="1.6" {...F} /></>,
  ruler: <><path d="M3 16.5 16.5 3 21 7.5 7.5 21 3 16.5Z" /><path d="m7 12.5 2 2M10 9.5l2 2M13 6.5l2 2" /></>,
  weight: <><path d="M8.5 8.5a3.5 3.5 0 1 1 7 0" /><path d="M6.2 8.5h11.6l2.2 12H4l2.2-12Z" /></>,
  joint: <><circle cx="12" cy="12" r="3.6" /><circle cx="12" cy="12" r="0.9" {...F} /><path d="M3.5 20.5 9.3 14.7M14.7 9.3l5.8-5.8" /></>,
  leg: <><circle cx="7" cy="4.5" r="2" /><circle cx="15" cy="12" r="2" /><path d="M8.5 6 13.5 10.5M14.6 14 12 20.5M9.5 20.5h5" /></>,
  cloud: <path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6 3.8 3.8 0 0 1-.4 7.4H7Z" />,
  laptop: <><rect x="4.5" y="5" width="15" height="10.5" rx="1.5" /><path d="M2.5 19h19" /></>,
  offline: <><path d="M7 18.5a4.5 4.5 0 0 1-.6-9M10 5.6A6 6 0 0 1 17.9 11a3.8 3.8 0 0 1 1.6 6.4" /><path d="m3.5 3.5 17 17" /></>,
  key: <><circle cx="8" cy="15.5" r="4" /><path d="m11 12.5 9-9M16.5 7l2.5 2.5M14 9.5l2 2" /></>,
  terminal: <><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5" /></>,
  copy: <><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></>,
  download: <><path d="M12 3.5v12M7.5 11l4.5 4.5 4.5-4.5" /><path d="M4 16.5v4h16v-4" /></>,
  upload: <><path d="M12 15.5v-12M7.5 8 12 3.5 16.5 8" /><path d="M4 16.5v4h16v-4" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3.6-3.6a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3.6 3.6a4 4 0 0 0 5.7 5.7l1-1" /></>,
  home: <><path d="m3.5 11 8.5-7 8.5 7" /><path d="M6 9.5V20h12V9.5" /><path d="M10 20v-6h4v6" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  wand: <><path d="m4 20 11-11" /><path d="m13 7 4 4" /><path d="M17 3v3M15.5 4.5h3M20.5 8.5v2.5M19.3 9.7h2.5" /></>,
  shuffle: <><path d="M3.5 7h3.6c4.8 0 5 10 9.8 10h3.6" /><path d="M3.5 17h3.6c1.7 0 2.7-1.2 3.6-2.8M20.5 7h-3.6c-1.7 0-2.7 1.2-3.6 2.8" /><path d="m18 4.5 2.5 2.5L18 9.5M18 14.5l2.5 2.5-2.5 2.5" /></>,
  more: <><circle cx="5.5" cy="12" r="1.6" {...F} /><circle cx="12" cy="12" r="1.6" {...F} /><circle cx="18.5" cy="12" r="1.6" {...F} /></>,
  cube: <><path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Z" /><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12.5 9 5 9-5M3 16.5l9 5 9-5" /></>,
  gamepad: <><path d="M7 7h10a5 5 0 0 1 4.7 6.6l-1 2.9A2.5 2.5 0 0 1 16.4 17L14.8 15H9.2l-1.6 2a2.5 2.5 0 0 1-4.3-.5l-1-2.9A5 5 0 0 1 7 7Z" /><path d="M8 10v3M6.5 11.5h3" /><circle cx="15.5" cy="10.5" r="1" {...F} /><circle cx="17.5" cy="12.5" r="1" {...F} /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9" /></>,
  hand: <><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13" /><path d="M17 11a1.5 1.5 0 0 1 3 0v3a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L4 15.6a1.6 1.6 0 0 1 2.4-2.1L8 15" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.3" {...F} /></>,
  ball: <><circle cx="12" cy="12" r="8.8" /><path d="M3.5 10c3.4 1.4 6 4.2 7.2 10.7M20.3 9.2c-4 .3-7.6 2.6-9.6 6.3M9 3.7c1.3 2.7 4.2 4.8 9.6 4.4" /></>,
  bench: <><path d="M3 10.5h18v3H3z" /><path d="M5 13.5v6M19 13.5v6M8 10.5 9 5h6l1 5.5" /></>,
  park: <><path d="M12 3.5 6.5 12h3L5 18.5h14L14.5 12h3L12 3.5Z" /><path d="M12 18.5v3" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></>,
  grid: <><path d="M4 4h16v16H4z" /><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" /></>,
  motor: <><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.6" /><path d="M12 4.5v2.4M12 17.1v2.4M4.5 12h2.4M17.1 12h2.4" /></>,
  scale: <><path d="M12 4v16M5 8h14" /><path d="m5 8-2.5 6a2.8 2.8 0 0 0 5 0L5 8ZM19 8l-2.5 6a2.8 2.8 0 0 0 5 0L19 8Z" /><path d="M8 20h8" /></>,
  note: <><path d="M6 3.5h9l4 4v13H6v-17Z" /><path d="M14.5 3.5V8h4.5M9 12.5h6.5M9 16h4.5" /></>,
  door: <><path d="M5 21V4.5a1 1 0 0 1 1-1h9.5V21" /><path d="M15.5 6 19 7v14" /><circle cx="12.5" cy="12.5" r="1" {...F} /><path d="M3 21h18" /></>,
  pin: <><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.4" /></>,
};

export const ICON_NAMES = Object.keys(PATHS);

export function Icon({ name, size = 22, strokeWidth = 2, title, className, ...rest }) {
  const content = PATHS[name] || PATHS.sparkle;
  const labelled = typeof title === "string" && title.length > 0;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={labelled ? undefined : "true"}
      role={labelled ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {labelled && <title>{title}</title>}
      {content}
    </svg>
  );
}
