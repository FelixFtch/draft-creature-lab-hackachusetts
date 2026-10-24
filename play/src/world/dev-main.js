// Dev harness for the playground engine (play/world-dev.html). API-free: the
// legacy controller assets are served from play/public/controller/* and the
// Flower readiness endpoint (draft-service) is skipped and labelled as such.
// URL params: pilot=legacy-cheetah|legacy-flower, quality=high|low, intro=0,
// muted=1, hud=0 (clean captures), challenge=<id>, look=%23hex.
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { createPlayground } from './playground.js';
import { createLegacyCheetahPilot, createLegacyFlowerPilot } from './pilots.js';

const params = new URLSearchParams(location.search);
const kind = params.get('pilot') === 'legacy-flower' ? 'legacy-flower' : 'legacy-cheetah';
const $ = id => document.getElementById(id);
if (params.get('hud') === '0') for (const id of ['who', 'stats', 'tools', 'challenge', 'explore']) $(id).classList.add('hidden');
for (const b of document.querySelectorAll('[data-pilot]')) {
  b.classList.toggle('on', b.dataset.pilot === kind);
  b.onclick = () => { params.set('pilot', b.dataset.pilot); location.search = params.toString(); };
}
function toast(text) {
  const el = document.createElement('div'); el.className = 'toast card'; el.textContent = text; $('toasts').append(el);
  setTimeout(() => el.remove(), 2600);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}
const fmt = ms => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const events = [];
window.parkEvents = events;

try {
  const mujoco = await loadMujoco({ locateFile: p => (p.endsWith('.wasm') ? wasmUrl : p) });
  const pilot = kind === 'legacy-flower' ? createLegacyFlowerPilot({ readinessUrl: null }) : createLegacyCheetahPilot();
  const game = await createPlayground($('park'), {
    mujoco, pilot, quality: params.get('quality') === 'low' ? 'low' : 'high', intro: params.get('intro') !== '0', muted: params.get('muted') === '1',
    look: params.get('look') ?? (kind === 'legacy-flower' ? '#e5728a' : '#3f9e8f'),
    onEvent(e) {
      events.push(e); if (events.length > 200) events.shift();
      if (e.type === 'spark') toast(`✦ Spark ${e.got}/${e.total}${e.combo ? ` · combo ×${e.combo + 1}` : ''}`);
      else if (e.type === 'goal') toast('GOAL!');
      else if (e.type === 'sticker') toast(`Sticker: ${e.title}`);
      else if (e.type === 'zone') toast(e.name);
      else if (e.type === 'challenge' && e.status === 'complete') toast(`${e.title} done in ${fmt(e.timeMs)}${e.best ? ' · best!' : ''}`);
      else if (e.type === 'skill-unavailable') toast(e.message);
      else if (e.type === 'topple' && e.count === e.total) toast('All dominoes down!');
    },
  });
  window.creaturePark = game;
  $('status').classList.add('hidden');
  const snap0 = game.snapshot();
  $('who-name').textContent = `${snap0.pilot.label} · ${snap0.pilot.skills.join(' + ')}`;
  $('who-note').textContent = `${snap0.pilot.honesty}${kind === 'legacy-flower' ? ' Dev harness: the draft-service readiness gate is skipped.' : ''}`;
  for (const c of snap0.challenges) { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.title}${c.locked ? ' (locked)' : ''}`; $('challenge-select').append(o); }
  $('challenge-select').onchange = e => { game.setChallenge(e.target.value || null); e.target.blur(); };
  if (params.get('challenge')) { game.setChallenge(params.get('challenge')); $('challenge-select').value = params.get('challenge'); }
  for (const l of snap0.landmarks) {
    const b = document.createElement('button'); b.textContent = l.name; b.style.borderColor = l.color;
    b.onclick = () => { const text = `go to the ${l.name}`; $('explore-text').value = text; game.startExplore(text, { landmark: l.id }).catch(err => toast(err.message)); };
    $('explore-chips').append(b);
  }
  $('explore-text').onkeydown = e => { if (e.key === 'Enter' && e.target.value.trim()) { game.startExplore(e.target.value).catch(err => toast(err.message)); e.target.blur(); } };
  $('cam').onclick = () => game.setCameraMode(game.snapshot().camera.mode === 'chase' ? 'overview' : 'chase');
  $('mute').onclick = () => game.setMuted(!game.snapshot().muted);
  $('respawn').onclick = () => game.respawn();
  $('reset').onclick = () => game.reset();
  $('jump').onclick = () => game.trigger('jump');
  setInterval(() => {
    const s = game.snapshot();
    $('stats').innerHTML = [
      ['Zone', s.zone?.name ?? '—'], ['Sparks', `${s.sparks.got}/${s.sparks.total}`], ['Goals', s.goals], ['Dominoes', `${s.dominoes.down}/${s.dominoes.total}`],
      ['Speed', `${s.robot.forwardSpeed.toFixed(2)} m/s`], ['Command', s.command.actual.map(v => v.toFixed(2)).join(' ')], ['Camera', s.camera.mode], ['FPS', s.fps],
      ['Stickers', `${s.stickers.filter(x => x.earned).length}/${s.stickers.length}`],
      ['Here', s.zone && s.zones.find(z => z.id === s.zone.id) ? s.zones.find(z => z.id === s.zone.id).suitability.level : '—'],
    ].map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
    const c = s.challenge;
    $('challenge-goal').textContent = c ? (c.lockedReason ?? c.goal) : 'Collect sparks, push the ball, explore the zones.';
    $('challenge-prog').textContent = c && c.status !== 'locked' ? `${c.status} · ${c.progress}/${c.target} · ${fmt(c.timeMs)} · best ${fmt(c.bestMs)}` : '';
    $('oops').style.display = s.robot.oops ? 'block' : 'none';
    if (s.robot.oops) $('oops').textContent = s.robot.oops.message;
    const x = s.explore;
    $('explore-status').textContent = x.phase === 'idle' ? 'Needs the local vision service (/vlm/decide).'
      : `${x.phase}${x.landmark ? ` → ${x.landmark.name}` : ''} · ${x.completedSteps}/${x.maxSteps}${x.model ? ` · ${x.provider}/${x.model}` : ''}${x.error ? ` · ${x.error}` : ''}`;
  }, 200);
} catch (error) {
  console.error(error);
  $('status').textContent = `Could not start the park: ${error.message}`;
}
