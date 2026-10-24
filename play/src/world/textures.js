import * as THREE from 'three';

// Small procedural canvas textures for the park. Everything is generated at
// runtime (no image assets), so the world ships as code only.
function canvas(w, h) {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}
function texture(c, { repeat = false, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }

// Wood planks running across u (one plank per texture repeat in u).
export function plankTexture(base = '#d9a066') {
  const c = canvas(128, 128), g = c.getContext('2d'), r = rng(7);
  g.fillStyle = base; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(${r() < .5 ? '120,70,30' : '255,230,190'},${.06 + r() * .08})`; g.fillRect(0, r() * 128, 128, 1 + r() * 2); }
  g.fillStyle = 'rgba(90,50,20,0.55)'; g.fillRect(0, 0, 4, 128); g.fillRect(124, 0, 4, 128);
  g.fillStyle = 'rgba(255,240,210,0.25)'; g.fillRect(4, 0, 3, 128);
  g.fillStyle = 'rgba(80,45,20,0.5)';
  for (const y of [22, 106]) { g.beginPath(); g.arc(64, y, 3, 0, Math.PI * 2); g.fill(); }
  return texture(c, { repeat: true });
}

// Soft stone tiles (one tile per repeat).
export function tileTexture(base = '#efe3c8', joint = 'rgba(140,120,90,0.35)') {
  const c = canvas(128, 128), g = c.getContext('2d'), r = rng(11);
  g.fillStyle = base; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${r() < .5 ? '120,100,70' : '255,255,245'},${.05 + r() * .07})`; g.fillRect(r() * 128, r() * 128, 2, 2); }
  g.strokeStyle = joint; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 125, 125);
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1; g.strokeRect(4, 4, 120, 120);
  return texture(c, { repeat: true });
}

export function crateTexture() {
  const c = canvas(256, 256), g = c.getContext('2d'), r = rng(3);
  g.fillStyle = '#d99c5c'; g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 51) { g.fillStyle = 'rgba(110,60,25,0.35)'; g.fillRect(0, y, 256, 3); }
  for (let i = 0; i < 120; i++) { g.fillStyle = `rgba(${r() < .5 ? '120,70,30' : '255,225,180'},${.06 + r() * .08})`; g.fillRect(0, r() * 256, 256, 1 + r() * 2); }
  g.strokeStyle = '#a8662e'; g.lineWidth = 26; g.strokeRect(13, 13, 230, 230);
  g.lineWidth = 22; g.beginPath(); g.moveTo(26, 26); g.lineTo(230, 230); g.stroke();
  g.strokeStyle = 'rgba(255,230,190,0.35)'; g.lineWidth = 3; g.strokeRect(3, 3, 250, 250);
  g.fillStyle = '#5b3a1c'; for (const [x, y] of [[13, 13], [243, 13], [13, 243], [243, 243]]) { g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill(); }
  return texture(c);
}

// Beach ball gores around u, white caps at the poles.
export function beachBallTexture() {
  const c = canvas(512, 256), g = c.getContext('2d');
  const cols = ['#ff5a4f', '#ffffff', '#ffd23f', '#ffffff', '#3f8ee8', '#ffffff'];
  cols.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * 512 / 6, 0, 512 / 6 + 1, 256); });
  const cap = g.createLinearGradient(0, 0, 0, 256);
  cap.addColorStop(0, '#ffffff'); cap.addColorStop(.09, '#ffffff'); cap.addColorStop(.1, 'rgba(255,255,255,0)');
  cap.addColorStop(.9, 'rgba(255,255,255,0)'); cap.addColorStop(.91, '#ffffff'); cap.addColorStop(1, '#ffffff');
  g.fillStyle = cap; g.fillRect(0, 0, 512, 256);
  return texture(c);
}

export function dominoTexture(color) {
  const c = canvas(64, 128), g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 64, 128);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillRect(6, 62, 52, 4);
  for (const [x, y] of [[20, 24], [44, 40], [32, 32], [20, 92], [44, 92], [32, 108], [32, 76]]) { g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill(); }
  return texture(c);
}

// Radial glow for additive sprites/points.
export function glowTexture() {
  const c = canvas(128, 128), g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(.18, 'rgba(255,255,255,0.85)');
  grad.addColorStop(.45, 'rgba(255,255,255,0.22)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return texture(c, { srgb: false });
}

export function stripeTexture(a = '#ff7eb6', b = '#ffe066', n = 12) {
  const c = canvas(256, 16), g = c.getContext('2d');
  for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? b : a; g.fillRect(i * 256 / n, 0, 256 / n + 1, 16); }
  return texture(c, { repeat: true });
}

const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Trebuchet MS", system-ui, sans-serif';

// Wooden zone sign: name, blurb, and an honest "suited for" chip.
export function signTexture({ name, blurb, accent, chip }) {
  const W = 512, H = 300, c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#e7b977'; g.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 60) { g.fillStyle = 'rgba(120,70,30,0.22)'; g.fillRect(0, y, W, 3); }
  g.strokeStyle = '#9c6430'; g.lineWidth = 14; g.strokeRect(7, 7, W - 14, H - 14);
  g.fillStyle = accent; g.fillRect(28, 30, 16, 92);
  g.fillStyle = '#3d2a17'; g.font = `800 64px ${FONT}`; g.textBaseline = 'alphabetic';
  fit(g, name, 60, 98, W - 90, 64, 800);
  g.fillStyle = '#5a3f22'; g.font = `600 27px ${FONT}`;
  wrapText(g, blurb, 34, 156, W - 68, 32, 2);
  if (chip) {
    g.font = `800 26px ${FONT}`;
    const text = chip.text, w = Math.min(W - 60, g.measureText(text).width + 40);
    g.fillStyle = chip.color; roundRect(g, 30, H - 74, w, 46, 23); g.fill();
    g.fillStyle = '#ffffff'; g.fillText(text, 50, H - 41, w - 40);
  }
  return texture(c);
}
export function welcomeTexture(title, subtitle) {
  const W = 640, H = 220, c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#fff6e4'; roundRect(g, 0, 0, W, H, 40); g.fill();
  g.strokeStyle = '#e07a5f'; g.lineWidth = 12; roundRect(g, 6, 6, W - 12, H - 12, 34); g.stroke();
  g.fillStyle = '#e07a5f'; g.font = `900 78px ${FONT}`; g.textAlign = 'center'; fit(g, title, W / 2, 112, W - 60, 78, 900);
  g.fillStyle = '#6b5a45'; g.font = `700 30px ${FONT}`; g.fillText(subtitle, W / 2, 168, W - 60);
  return texture(c);
}
function fit(g, text, x, y, maxW, size, weight) {
  let s = size; g.font = `${weight} ${s}px ${FONT}`;
  while (g.measureText(text).width > maxW && s > 20) { s -= 2; g.font = `${weight} ${s}px ${FONT}`; }
  g.fillText(text, x, y);
}
function wrapText(g, text, x, y, maxW, lineH, maxLines) {
  const words = text.split(/\s+/); let line = '', n = 0;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) { g.fillText(line, x, y + n * lineH); line = w; if (++n >= maxLines) return; }
    else line = test;
  }
  if (line && n < maxLines) g.fillText(line, x, y + n * lineH);
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
