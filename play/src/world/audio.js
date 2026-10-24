// Procedural WebAudio for the playground. No sound files: every sound is
// synthesised (noise bursts, filtered oscillators). The context is created
// lazily and resumed on the first user gesture (browser autoplay policy).
// Positional cues use a stereo pan + distance gain computed from the camera.
const SURFACE = {
  grass: { f: 900, q: .7, lp: 2200, gain: .5 }, sand: { f: 1400, q: .5, lp: 3600, gain: .55 }, gravel: { f: 2600, q: .8, lp: 6000, gain: .5 },
  stone: { f: 2200, q: 1.4, lp: 7000, gain: .55, click: 1800 }, court: { f: 1200, q: 2.2, lp: 4200, gain: .5, click: 900 },
  wood: { f: 650, q: 2.5, lp: 3000, gain: .7, click: 420 }, plastic: { f: 1600, q: 3, lp: 5000, gain: .6, click: 1100 },
  rubber: { f: 500, q: 1, lp: 1800, gain: .6 }, paint: { f: 1500, q: 2, lp: 5000, gain: .55, click: 1000 }, metal: { f: 3000, q: 6, lp: 9000, gain: .4, click: 2400 },
  floor: { f: 900, q: .7, lp: 2200, gain: .5 },
};

export function createAudio({ muted = false, target = globalThis } = {}) {
  let ctx = null, master = null, sfx = null, amb = null, noise = null, started = false, isMuted = !!muted, disposed = false;
  let wind = null, waves = null, birdTimer = 0, lastStep = 0;
  const listener = { x: 0, y: 0, z: 0, rx: 1, ry: 0, rz: 0, shore: 0 };

  function ensure() {
    if (ctx || disposed) return ctx;
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
    master = ctx.createGain(); master.gain.value = isMuted ? 0 : .85;
    sfx = ctx.createGain(); sfx.gain.value = 1; amb = ctx.createGain(); amb.gain.value = .55;
    sfx.connect(master); amb.connect(master); master.connect(comp); comp.connect(ctx.destination);
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = .97 * b + .03 * w; d[i] = w * .6 + b * 2.2; }
    noise = buf;
    return ctx;
  }
  function unlock() {
    if (disposed || !ensure()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!started) { started = true; startAmbience(); }
  }
  for (const type of ['pointerdown', 'keydown', 'touchstart']) target.addEventListener?.(type, unlock, { passive: true });
  const live = () => ctx && ctx.state === 'running' && !disposed;

  function voice({ pan = 0, gain = 1, bus } = {}) {
    const g = ctx.createGain(); g.gain.value = gain;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(bus ?? sfx); } else g.connect(bus ?? sfx);
    return g;
  }
  function noiseBurst(out, { at = ctx.currentTime, dur = .08, f = 1000, q = 1, lp = 4000, gain = .5, attack = .004 }) {
    const src = ctx.createBufferSource(); src.buffer = noise; src.playbackRate.value = .8 + Math.random() * .4;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const lo = ctx.createBiquadFilter(); lo.type = 'lowpass'; lo.frequency.value = lp;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + attack); g.gain.exponentialRampToValueAtTime(.0008, at + dur);
    src.connect(bp); bp.connect(lo); lo.connect(g); g.connect(out);
    src.start(at, Math.random() * 1.5); src.stop(at + dur + .05);
  }
  function tone(out, { at = ctx.currentTime, f = 440, f1 = null, dur = .2, type = 'sine', gain = .3, attack = .005 }) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, at);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + attack); g.gain.exponentialRampToValueAtTime(.0006, at + dur);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + dur + .05);
  }
  // Spatial helper: world (three) position -> pan/gain from the listener.
  function place(pos, base = 1, range = 6) {
    if (!pos) return { pan: 0, gain: base };
    const dx = pos[0] - listener.x, dy = pos[1] - listener.y, dz = pos[2] - listener.z, d = Math.hypot(dx, dy, dz);
    const pan = d > 1e-3 ? (dx * listener.rx + dy * listener.ry + dz * listener.rz) / d : 0;
    return { pan: pan * .85, gain: base / (1 + (d / range) ** 2) };
  }

  function startAmbience() {
    if (!live() && ctx?.state !== 'suspended') return;
    // Wind: slow-breathing low-passed noise.
    const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = .4;
    const g = ctx.createGain(); g.gain.value = .12;
    const lfo = ctx.createOscillator(); lfo.frequency.value = .07; const lfoGain = ctx.createGain(); lfoGain.gain.value = .07;
    lfo.connect(lfoGain); lfoGain.connect(g.gain); src.connect(lp); lp.connect(g); g.connect(amb); src.start(); lfo.start();
    wind = { src, lfo };
    // Waves: band-passed noise that swells; louder near the shore.
    const ws = ctx.createBufferSource(); ws.buffer = noise; ws.loop = true; ws.playbackRate.value = .5;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = .5;
    const wg = ctx.createGain(); wg.gain.value = 0;
    const wl = ctx.createOscillator(); wl.frequency.value = .16; const wlg = ctx.createGain(); wlg.gain.value = .05;
    wl.connect(wlg); wlg.connect(wg.gain); ws.connect(bp); bp.connect(wg); wg.connect(amb); ws.start(); wl.start();
    waves = { src: ws, lfo: wl, gain: wg };
  }
  function bird() {
    const out = voice({ pan: Math.random() * 1.6 - .8, gain: .07 + Math.random() * .05, bus: amb });
    const t = ctx.currentTime, base = 2600 + Math.random() * 1800, n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) tone(out, { at: t + i * (.09 + Math.random() * .05), f: base * (1 + Math.random() * .2), f1: base * (1.3 + Math.random() * .4), dur: .07 + Math.random() * .05, gain: .5, type: 'sine' });
  }

  return {
    get muted() { return isMuted; },
    get started() { return started && ctx?.state === 'running'; },
    unlock,
    setMuted(value) {
      isMuted = !!value;
      if (ctx) master.gain.setTargetAtTime(isMuted ? 0 : .85, ctx.currentTime, .03);
    },
    // Called every frame with the camera pose (three coords) and shore proximity 0..1.
    setListener(pos, right, shore = 0) {
      Object.assign(listener, { x: pos.x, y: pos.y, z: pos.z, rx: right.x, ry: right.y, rz: right.z, shore });
      if (waves && live()) waves.gain.gain.setTargetAtTime(.02 + .22 * shore, ctx.currentTime, .4);
    },
    update(dt) {
      if (!live()) return;
      birdTimer -= dt;
      if (birdTimer <= 0) { birdTimer = 3 + Math.random() * 7; bird(); }
    },
    footstep(surface, pos, { weight = 1, speed = .3 } = {}) {
      if (!live()) return;
      const now = ctx.currentTime;
      if (now - lastStep < .035) return; // many feet: don't machine-gun
      lastStep = now;
      const s = SURFACE[surface] ?? SURFACE.grass, { pan, gain } = place(pos, .9, 4);
      const out = voice({ pan, gain: gain * Math.min(1.2, .35 + .5 * weight) * (.6 + Math.min(.6, speed)) });
      noiseBurst(out, { dur: .05 + .05 * weight, f: s.f * (.85 + Math.random() * .3) / Math.sqrt(weight), q: s.q, lp: s.lp, gain: s.gain });
      if (s.click) tone(out, { f: s.click * (.9 + Math.random() * .2), f1: s.click * .7, dur: .05, gain: .12, type: 'triangle' });
      if (weight > 1.4) tone(out, { f: 90, f1: 55, dur: .09, gain: .25 * Math.min(1.5, weight - 1) });
    },
    chime(combo = 0, pos) {
      if (!live()) return;
      const out = voice({ ...place(pos, 1, 9) }), t = ctx.currentTime, root = 784 * 2 ** (Math.min(combo, 7) / 12 * 2);
      [1, 1.25, 1.5, 2].forEach((m, i) => { tone(out, { at: t + i * .055, f: root * m, dur: .5 - i * .05, gain: .18, type: 'triangle' }); tone(out, { at: t + i * .055, f: root * m * 2, dur: .25, gain: .05 }); });
    },
    cheer(pos) {
      if (!live()) return;
      const out = voice({ ...place(pos, 1.2, 14) }), t = ctx.currentTime;
      for (let i = 0; i < 6; i++) noiseBurst(out, { at: t + i * .12, dur: .9, f: 900 + i * 220, q: .8, lp: 5000, gain: .22, attack: .08 });
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(out, { at: t + .05 + i * .11, f, dur: .32, gain: .16, type: 'square' }));
      tone(out, { at: t + .75, f: 1319, dur: .9, gain: .12, type: 'triangle' });
    },
    thud(kind, pos, strength = 1) {
      if (!live()) return;
      const out = voice({ ...place(pos, Math.min(1.2, .25 + strength * .35), 6) }), t = ctx.currentTime;
      if (kind === 'ball') { tone(out, { f: 210, f1: 120, dur: .18, gain: .45 }); tone(out, { f: 520, f1: 300, dur: .08, gain: .12, type: 'triangle' }); }
      else if (kind === 'domino' || kind === 'crate') { noiseBurst(out, { dur: .07, f: kind === 'domino' ? 1700 : 650, q: 3, lp: 5000, gain: .55 }); tone(out, { f: kind === 'domino' ? 640 : 180, f1: 120, dur: .09, gain: .22, type: 'triangle' }); }
      else if (kind === 'cone') tone(out, { f: 330, f1: 220, dur: .12, gain: .3, type: 'triangle' });
      else noiseBurst(out, { dur: .1, f: 400, q: 1, lp: 1500, gain: .5 });
      void t;
    },
    whoosh() { if (!live()) return; const out = voice({ gain: .5 }); noiseBurst(out, { dur: .45, f: 1200, q: .6, lp: 6000, gain: .35, attack: .15 }); tone(out, { f: 300, f1: 900, dur: .4, gain: .08 }); },
    oops() { if (!live()) return; const out = voice({ gain: .8 }), t = ctx.currentTime; tone(out, { at: t, f: 660, f1: 640, dur: .18, gain: .2, type: 'triangle' }); tone(out, { at: t + .2, f: 494, f1: 440, dur: .35, gain: .2, type: 'triangle' }); },
    splash(pos) { if (!live()) return; const out = voice({ ...place(pos, 1.1, 10) }); noiseBurst(out, { dur: .6, f: 900, q: .5, lp: 3500, gain: .6, attack: .01 }); noiseBurst(out, { at: ctx.currentTime + .12, dur: .5, f: 2200, q: .7, lp: 7000, gain: .25 }); },
    sticker() { if (!live()) return; const out = voice({ gain: .7 }), t = ctx.currentTime; [1047, 1319, 1568, 2093].forEach((f, i) => tone(out, { at: t + i * .07, f, dur: .4, gain: .13, type: 'triangle' })); },
    click() { if (!live()) return; tone(voice({ gain: .4 }), { f: 1200, f1: 900, dur: .05, gain: .2, type: 'triangle' }); },
    dispose() {
      disposed = true;
      for (const type of ['pointerdown', 'keydown', 'touchstart']) target.removeEventListener?.(type, unlock);
      try { wind?.src.stop(); wind?.lfo.stop(); waves?.src.stop(); waves?.lfo.stop(); } catch { /* already stopped */ }
      ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}
