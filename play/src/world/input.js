// Player input: keyboard, gamepad and the UI's touch joystick, merged into one
// normalised command { vx, wz } in [-1, 1] (+vx forward, +wz turn left). The
// engine maps it onto the pilot's trained command bounds. Keys typed into a
// text field (e.g. an AI Explore instruction) are never treated as driving.
const DEADZONE = .16;
const editable = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export function createInput({ target = globalThis, onAction = () => {} } = {}) {
  const keys = new Set();
  let touch = { vx: 0, wz: 0, at: 0 }, padButtons = [], padCamera = { x: 0, y: 0 }, disposed = false;
  const bindings = {
    forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    boost: ['ShiftLeft', 'ShiftRight'],
  };
  const actionKeys = { Space: 'jump', KeyR: 'respawn', KeyC: 'camera', KeyM: 'mute', KeyP: 'pause', Escape: 'escape' };
  function down(e) {
    if (editable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const action = actionKeys[e.code];
    if (Object.values(bindings).some(list => list.includes(e.code)) || action) {
      // Arrow keys / Space would otherwise scroll the page under the canvas.
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (!keys.has(e.code) && action) onAction(action, { source: 'keyboard' });
      keys.add(e.code);
    }
  }
  function up(e) { keys.delete(e.code); }
  function blur() { keys.clear(); }
  target.addEventListener?.('keydown', down);
  target.addEventListener?.('keyup', up);
  target.addEventListener?.('blur', blur);
  const has = list => list.some(code => keys.has(code));
  const shape = v => Math.sign(v) * Math.max(0, (Math.abs(v) - DEADZONE) / (1 - DEADZONE));

  function readPad() {
    const pads = globalThis.navigator?.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const [lx = 0, ly = 0, rx = 0, ry = 0] = pad.axes;
      const mag = Math.hypot(lx, ly), k = mag > DEADZONE ? (mag - DEADZONE) / (1 - DEADZONE) / mag : 0;
      const pressed = pad.buttons.map(b => !!b?.pressed);
      // Edge-triggered actions on the standard mapping: A jump, B respawn, Y camera.
      [[0, 'jump'], [1, 'respawn'], [3, 'camera'], [9, 'pause']].forEach(([i, action]) => { if (pressed[i] && !padButtons[i]) onAction(action, { source: 'gamepad' }); });
      padButtons = pressed;
      padCamera = { x: shape(rx), y: shape(ry) };
      return { vx: -ly * k, wz: -lx * k, boost: !!(pressed[5] || pressed[7] || pressed[4] || pressed[6]), connected: true, id: pad.id };
    }
    padButtons = []; padCamera = { x: 0, y: 0 };
    return { vx: 0, wz: 0, boost: false, connected: false };
  }

  return {
    // Touch joystick from the UI; send {vx:0, wz:0} on release.
    setTouch({ vx = 0, wz = 0 } = {}) {
      if (![vx, wz].every(Number.isFinite)) throw Error('setCommand expects finite vx and wz');
      touch = { vx: Math.max(-1, Math.min(1, vx)), wz: Math.max(-1, Math.min(1, wz)), at: performance.now() };
    },
    read() {
      if (disposed) return { vx: 0, wz: 0, boost: false, active: false, source: null };
      const kb = { vx: (has(bindings.forward) ? 1 : 0) - (has(bindings.back) ? 1 : 0), wz: (has(bindings.left) ? 1 : 0) - (has(bindings.right) ? 1 : 0) };
      const pad = readPad();
      const sources = [['keyboard', kb], ['gamepad', pad], ['touch', touch]];
      const vx = Math.max(-1, Math.min(1, kb.vx + pad.vx + touch.vx)), wz = Math.max(-1, Math.min(1, kb.wz + pad.wz + touch.wz));
      const strongest = sources.reduce((a, b) => (Math.hypot(b[1].vx, b[1].wz) > Math.hypot(a[1].vx, a[1].wz) ? b : a));
      const active = Math.hypot(vx, wz) > 1e-3;
      return { vx, wz, boost: has(bindings.boost) || pad.boost, active, source: active ? strongest[0] : null, gamepad: pad.connected ? pad.id : null, camera: padCamera };
    },
    clear() { keys.clear(); touch = { vx: 0, wz: 0, at: 0 }; },
    dispose() {
      disposed = true;
      target.removeEventListener?.('keydown', down); target.removeEventListener?.('keyup', up); target.removeEventListener?.('blur', blur);
    },
  };
}
