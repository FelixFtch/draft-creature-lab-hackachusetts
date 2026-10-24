// Paints the island ground (grass grain, paths, plaza, zone floors, court
// markings, beach, baked contact shadows) into one canvas. Purely visual.
// The canvas is cached per layout + resolution: it is static, and painting
// ~2k x 2k pixels is the slowest part of starting a playground.
const cache = new Map();

export const GROUND_EXTENT = 12.8; // metres from the centre to the texture edge

function mulberry32(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function paintGround(layout, { size = 2048, shadows = [], decor = [] } = {}) {
  const key = `${layout.id}:${size}`;
  if (cache.has(key)) return cache.get(key);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  const S = GROUND_EXTENT, k = size / (2 * S), rand = mulberry32(20261024);
  const world = () => ctx.setTransform(k, 0, 0, -k, size / 2, size / 2);
  const zone = angleDeg => { world(); ctx.rotate(angleDeg * Math.PI / 180); };
  const R = layout.islandRadius;

  // 1. Grass base and broad tonal patches.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#8cc267'; ctx.fillRect(0, 0, size, size);
  world();
  const greens = ['#83bb5f', '#97cb70', '#a2d27a', '#7fb65c', '#8fc56a'];
  for (let i = 0; i < 160; i++) {
    const r = .7 + rand() * 2.4, a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * R;
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, greens[i % greens.length] + '55'); g.addColorStop(1, greens[i % greens.length] + '00');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Mowing stripes, very subtle.
  for (let x = -S; x < S; x += 1.6) { ctx.fillStyle = 'rgba(255,255,240,0.035)'; ctx.fillRect(x, -S, .8, 2 * S); }
  // Grain: tiny light/dark specks read as grass up close.
  const specks = Math.round(size * size / 160);
  for (let i = 0; i < specks; i++) {
    const x = (rand() * 2 - 1) * S, y = (rand() * 2 - 1) * S, s = (.6 + rand() * 1.4) / k;
    ctx.fillStyle = rand() < .5 ? 'rgba(60,110,40,0.20)' : 'rgba(210,240,160,0.18)';
    ctx.fillRect(x, y, s, s * (1 + rand()));
  }

  // 2. Beach ring and wet edge.
  {
    const g = ctx.createRadialGradient(0, 0, R - 1.1, 0, 0, R);
    g.addColorStop(0, 'rgba(240,222,176,0)'); g.addColorStop(.38, 'rgba(240,222,176,0.9)'); g.addColorStop(.86, '#efd9a8'); g.addColorStop(1, '#d9bf8a');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R + .2, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 2500; i++) {
      const a = rand() * Math.PI * 2, d = R - .05 - rand() * .9;
      ctx.fillStyle = rand() < .5 ? 'rgba(180,150,100,0.25)' : 'rgba(255,248,225,0.35)';
      ctx.fillRect(Math.cos(a) * d, Math.sin(a) * d, 1.2 / k, 1.2 / k);
    }
  }

  // 3. Zone floors.
  // Ball court: teal floor, white markings.
  {
    const c = layout.court;
    zone(0);
    roundRect(ctx, c.u0 - .05, -c.halfWidth - .05, c.u1 - c.u0 + c.goalDepth + .1, 2 * c.halfWidth + .1, .25);
    ctx.fillStyle = '#5db3a3'; ctx.fill();
    for (let u = c.u0; u < c.u1; u += .5) { ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(u, -c.halfWidth, .25, 2 * c.halfWidth); }
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = .06;
    roundRect(ctx, c.u0 + .15, -c.halfWidth + .15, c.u1 - c.u0 - .3, 2 * c.halfWidth - .3, .12); ctx.stroke();
    const mid = (c.u0 + c.u1) / 2;
    ctx.beginPath(); ctx.moveTo(mid, -c.halfWidth + .15); ctx.lineTo(mid, c.halfWidth - .15); ctx.stroke();
    ctx.beginPath(); ctx.arc(mid, 0, .8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(c.u1, 0, 1.45, Math.PI / 2, Math.PI * 1.5); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.beginPath(); ctx.arc(mid, 0, .07, 0, Math.PI * 2); ctx.fill();
    // goal mouth stripe
    ctx.fillStyle = '#ffffff'; ctx.fillRect(c.u1 - .03, -c.goalHalfWidth, .06, 2 * c.goalHalfWidth);
  }
  // Hills: lusher, darker grass with clover specks.
  softPatch(ctx, rand, 60, layout.hills.center[0], 0, layout.hills.halfSize[0] + .5, layout.hills.halfSize[1] + .5, '#7bb85a', 90, ['#ffffff', '#f6e27a']);
  // Plateau: warm dirt apron around the ramps.
  softPatch(ctx, rand, 120, 6.2, .8, 3.4, 2.6, '#d6c08f', 0, []);
  // Steps: plain stone plaza (no joints, so the low risers stay readable)
  // with a painted label in front of each lane, readable from the hub.
  {
    zone(180); roundRect(ctx, 3.75, -2.3, 6.1, 4.8, .35); ctx.fillStyle = '#e9e3d6'; ctx.fill();
    ctx.strokeStyle = 'rgba(150,135,110,0.35)'; ctx.lineWidth = .04; roundRect(ctx, 3.8, -2.25, 6.0, 4.7, .3); ctx.stroke();
    for (const s of Object.values(layout.steps)) {
      zone(180); ctx.fillStyle = s.palette[s.palette.length - 1]; roundRect(ctx, 3.86, s.v - s.width / 2 + .08, .34, s.width - .16, .08); ctx.fill();
      groundText(ctx, 180, 4.03, s.v, `${s.label} · ${+(s.riser * 100).toFixed(1)} cm`, .13, '#ffffff', 900);
    }
  }
  // Jump garden: soft sand with confetti dots.
  softPatch(ctx, rand, 240, 6.2, -.2, 2.9, 2.8, '#f0e2c4', 0, []);
  { zone(240); const cols = ['#f7a8c4', '#ffd36e', '#9ad7f0', '#c7b6f2', '#9be3b4'];
    for (let i = 0; i < 260; i++) { const u = 3.6 + rand() * 5.2, v = -2.6 + rand() * 5.0; ctx.fillStyle = cols[i % cols.length] + 'aa'; ctx.beginPath(); ctx.arc(u, v, .025 + rand() * .03, 0, Math.PI * 2); ctx.fill(); } }
  // Block yard: gravel with a painted start line.
  softPatch(ctx, rand, 300, 6.0, -.6, 2.5, 2.6, '#d9ccb2', 0, []);
  { zone(300); for (let i = 0; i < 1600; i++) { const u = 3.7 + rand() * 4.7, v = -3.0 + rand() * 4.8; ctx.fillStyle = rand() < .5 ? 'rgba(120,105,80,0.35)' : 'rgba(255,250,235,0.45)'; ctx.fillRect(u, v, .025, .025); }
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(4.25, .45, .06, .9); }
  // Meadow: drifts of tiny wildflowers.
  { zone(0); const cols = ['#ffffff', '#fff3a6', '#ffc6dd', '#d8c8ff'];
    for (let i = 0; i < 900; i++) { const u = 1.2 + rand() * 4.9, v = (rand() * 2 - 1) * 2.7; if (Math.abs(v) < .55 && u < 6) continue; ctx.fillStyle = cols[i % cols.length]; ctx.beginPath(); ctx.arc(u, v, .018 + rand() * .022, 0, Math.PI * 2); ctx.fill(); } }

  // 4. Paths: sand spokes to every zone and dotted trails to the landmarks.
  for (const p of layout.paths) {
    zone(p.angle);
    if (p.kind === 'spoke') {
      ctx.fillStyle = 'rgba(214,188,128,0.45)'; roundRect(ctx, p.r0, -p.width / 2 - .08, p.r1 - p.r0, p.width + .16, p.width / 2 + .08); ctx.fill();
      ctx.fillStyle = '#ead5a4'; roundRect(ctx, p.r0, -p.width / 2, p.r1 - p.r0, p.width, p.width / 2); ctx.fill();
      for (let i = 0; i < 160; i++) { const u = p.r0 + rand() * (p.r1 - p.r0), v = (rand() - .5) * p.width * .9; ctx.fillStyle = rand() < .5 ? 'rgba(170,140,90,0.35)' : 'rgba(255,250,230,0.55)'; ctx.beginPath(); ctx.arc(u, v, .015 + rand() * .02, 0, Math.PI * 2); ctx.fill(); }
    } else {
      for (let u = p.r0 + .3; u < p.r1; u += .55) {
        const v = Math.sin(u * 1.7) * .08, w = .34 + rand() * .08;
        ctx.fillStyle = 'rgba(120,100,70,0.18)'; ellipse(ctx, u + .02, v - .03, w / 2 + .02, w / 2.6 + .02);
        ctx.fillStyle = rand() < .5 ? '#eadcc0' : '#e3d3b2'; ellipse(ctx, u, v, w / 2, w / 2.6);
      }
    }
  }

  // 5. Spawn plaza: warm stone disc, terracotta ring, compass star.
  {
    world();
    const r = layout.hubRadius;
    ctx.fillStyle = 'rgba(120,100,70,0.18)'; ctx.beginPath(); ctx.arc(.03, -.05, r + .12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f3e8d0'; ctx.beginPath(); ctx.arc(0, 0, r + .05, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#e07a5f'; ctx.lineWidth = .1; ctx.beginPath(); ctx.arc(0, 0, r - .12, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(224,122,95,0.45)'; ctx.lineWidth = .03; ctx.beginPath(); ctx.arc(0, 0, r - .32, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 36; i++) { const a = i / 36 * Math.PI * 2; ctx.fillStyle = i % 2 ? '#e8d7b5' : '#dcc59a'; ctx.beginPath(); ctx.arc(Math.cos(a) * (r - .01), Math.sin(a) * (r - .01), .055, 0, Math.PI * 2); ctx.fill(); }
    // Eight-point star pointing at the zones' axes (+X first).
    ctx.save();
    for (let i = 0; i < 8; i++) {
      const long = i % 2 === 0, len = long ? .95 : .55, w = long ? .16 : .11;
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = i === 7 ? '#e07a5f' : long ? '#f2b38a' : '#f6cfa8';
      ctx.beginPath(); ctx.moveTo(len, 0); ctx.lineTo(0, w); ctx.lineTo(-.02, 0); ctx.lineTo(0, -w); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#fff8ea'; ctx.beginPath(); ctx.arc(0, 0, .12, 0, Math.PI * 2); ctx.fill();
  }

  // 6. Baked soft contact shadows under static objects and decoration.
  world();
  for (const s of [...shadows, ...decor]) {
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
    g.addColorStop(0, `rgba(40,55,30,${s.strength ?? .28})`); g.addColorStop(1, 'rgba(40,55,30,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  }
  cache.set(key, canvas);
  return canvas;
}

// Text painted flat on the ground in a zone frame, upright for a viewer at
// the hub looking outward (+u away, -v to the right).
function groundText(ctx, angleDeg, u, v, text, sizeM, color, weight = 800) {
  zoneTransform(ctx, angleDeg);
  ctx.save(); ctx.translate(u, v); ctx.transform(0, -1, -1, 0, 0, 0); ctx.scale(.01, .01);
  ctx.font = `${weight} ${Math.round(sizeM * 100)}px ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, 0, 0);
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function ellipse(ctx, x, y, rx, ry) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
// A soft-edged tinted patch in a zone frame (u centre, v centre, half sizes).
function softPatch(ctx, rand, angle, u, v, hu, hv, color, specks, speckColors) {
  zoneTransform(ctx, angle);
  // An elliptical radial gradient (non-uniform scale) gives a soft border.
  ctx.save();
  ctx.translate(u, v);
  ctx.scale(hu, hv);
  const g = ctx.createRadialGradient(0, 0, .55, 0, 0, 1);
  g.addColorStop(0, color + 'ff'); g.addColorStop(.75, color + 'd0'); g.addColorStop(1, color + '00');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  for (let i = 0; i < specks; i++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * .85;
    ctx.fillStyle = speckColors[i % speckColors.length];
    ctx.beginPath(); ctx.arc(u + Math.cos(a) * d * hu, v + Math.sin(a) * d * hv, .02 + rand() * .015, 0, Math.PI * 2); ctx.fill();
  }
}
function zoneTransform(ctx, angleDeg) {
  const size = ctx.canvas.width, k = size / (2 * GROUND_EXTENT);
  ctx.setTransform(k, 0, 0, -k, size / 2, size / 2); ctx.rotate(angleDeg * Math.PI / 180);
}
