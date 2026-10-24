// Draft Creature Lab v2: Imagine (Tinker) -> Draft (real body) -> Dress up ->
// Train -> Play. Engines: workshop (draft-lab.js) and playground (world/).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles/index.css';
import './styles/premium.css';
import './app/app.css';
import {
  AppShell, TitleScreen, WorkshopLayout, LoopStepper, NameTag, StageToolbar, ViewModeSwitch, TabDot,
  ChatPanel, SpecSheet, LookPanel, TrainingPanel, CreatureShelf, LabNotes, PlayHUD, TouchControls, ExplorePanel,
  PauseMenu, RobotRoster, TerrainLab, Modal, Toasts, useToasts, SettingsPanel, Badge, IconButton, ProgressRing, Icon,
  useLayoutSize,
} from './ui/index.js';
import { createDraftLab } from './draft-lab.js';
import { getMujoco } from './app/mujoco.js';
import { normalizeLook, exportPrintKit } from './appearance/index.js';
import { createPlayground } from './world/playground.js';
import { createLegacyCheetahPilot, createLegacyFlowerPilot, createCreaturePilot as wrapCreaturePilot } from './world/pilots.js';
import { createCreaturePilot } from './creature-controller.js';
import terrainResults from './world/terrain-results.json';
import { aiApi, draftApi, fetchJson, ApiError } from './app/api.js';
import { createWhiteboxStudio } from './app/whitebox.js';

// The robot keeps the original Draft lab style: one body colour with derived
// motor, detail and foot shades. These are the original lab's colours.
const classic = (id, name, body) => ({ id, name, look: { schema: 'creature-look/1', theme: 'classic', palette: { body } } });
const PRODUCT_LOOKS = [
  classic('teal', 'Sage Teal', '#7fa39d'), classic('sand', 'Sand', '#c4ad94'), classic('slate-blue', 'Slate', '#8794aa'),
  classic('dusty-rose', 'Dusty Rose', '#b9969a'), classic('olive', 'Olive', '#a6a68a'), classic('graphite', 'Graphite', '#5b5f66'), classic('cloud', 'Cloud', '#d9dcd6'),
];
const DEFAULT_LOOK = PRODUCT_LOOKS[0].look;

// The roster the user asked for. Bodies appear as soon as Draft has built them;
// a skill is only offered when its bundle passed validation for that exact body.
const ROSTER = [
  { id: 'rollo', name: 'Rollo', kind: 'Wheel-leg', plan: 'wheeled', tagline: 'Balances on two wheels like a segway and springs into the air.' },
  { id: 'dog', name: 'Dog', kind: 'Robot dog', bodyId: 'quadruped-329a735927fa8b37', tagline: "Draft's Cheetah: trots, turns and jumps gaps." },
  { id: 'spider', name: 'Flower', kind: 'Six-legged crawler', legacy: 'flower', tagline: 'Pretrained six-legged crawler: always three feet down.' },
  { id: 'octo', name: 'Octo', kind: 'Spider', bodyId: 'multileg-cfeadbfbef98a249', tagline: 'Eight long legs: wide stance, bridges small gaps by walking.' },
  { id: 'bipo', name: 'Bipo', kind: 'Humanoid', plan: 'humanoid', tagline: "Draft's humanoid: narrow footprint, steps over obstacles." },
];
const LEGACY_PRESETS = ['cheetah', 'bear', 'giraffe', 'flower'];
const GREETING = { id: 'hello', role: 'tinker', kind: 'text', text: "Hi, I'm Tinker! Tell me about a robot — a wheel-leg jumper, a robot dog, a spider, a humanoid, anything. I'll draft a real body for it with Draft: joints, motors and all." };
const STARTER_CHIPS = ['A wheel-leg robot that jumps', 'A robot dog', 'An eight-legged spider', 'A small humanoid'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uid = prefix => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function skillState(entry) {
  if (!entry) return { state: 'untrained' };
  const p = entry.progress;
  const progress = p ? { envSteps: p.envSteps, targetSteps: p.envStepsTarget, iteration: p.iteration, stepsPerSecond: p.stepsPerSecond,
    elapsedSeconds: p.wallSeconds, etaSeconds: p.etaSeconds, meanReward: p.meanReward } : undefined;
  if (entry.ready) return { state: 'ready', hashMatched: true, progress };
  if (p?.running) return { state: p.phase === 'evaluating' || p.phase === 'exporting' ? 'validating' : 'training', progress };
  if (entry.present) return { state: 'failed', progress, reason: (entry.reasons || []).join('; ') };
  return { state: 'untrained' };
}

function evalRows(evaluation) {
  return (evaluation?.rows || []).map(row => ({
    id: row.name, name: row.name.replace(/_/g, ' '),
    command: row.command ? { vx: row.command[0], wz: row.command[2] } : {},
    measured: row.meanVelocity ? { vx: +row.meanVelocity[0].toFixed(2), wz: +row.meanVelocity[2].toFixed(2) } : {},
    fall: !!row.fell, pass: !!row.pass,
  }));
}

export default function App() {
  const size = useLayoutSize(), phone = size === 'phone';
  const workshopEl = useRef(null), playEl = useRef(null), fileInput = useRef(null);
  const lab = useRef(null), game = useRef(null), mujoco = useRef(null);
  const { toasts, push, dismiss } = useToasts();
  const [mode, setMode] = useState('workshop');
  const [titleOpen, setTitleOpen] = useState(false);
  const [tab, setTab] = useState('blueprint');
  const [modal, setModal] = useState(null);
  const [muted, setMuted] = useState(false);
  const [viewMode, setViewMode] = useState('normal');
  const [bodies, setBodies] = useState([]);
  const [current, setCurrent] = useState(null); // { kind: 'body'|'legacy', id, name, body?, design?, preset?, rosterId? }
  const [look, setLook] = useState(() => normalizeLook(DEFAULT_LOOK));
  const [presetId, setPresetId] = useState('teal');
  const [policies, setPolicies] = useState({});
  const [evals, setEvals] = useState({});
  const [job, setJob] = useState(null);
  const [messages, setMessages] = useState([GREETING]);
  const [suggestions, setSuggestions] = useState(STARTER_CHIPS);
  const [provider, setProvider] = useState({ kind: 'offline', offline: true, name: 'offline' });
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [health, setHealth] = useState(null);
  const [flowerReady, setFlowerReady] = useState(false);
  const [exportState, setExportState] = useState('idle');
  const [snapshot, setSnapshot] = useState(null);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [exploreText, setExploreText] = useState('Go to the red ball');
  const [playLoading, setPlayLoading] = useState(false);
  const lastBuild = useRef(null);
  const chatAbort = useRef(null);

  // ---------- engines ----------
  useEffect(() => {
    let cancelled = false, created = null;
    (async () => {
      try {
        mujoco.current = await getMujoco();
        created = await createDraftLab(workshopEl.current, { createStudio: createWhiteboxStudio });
        if (cancelled) { created.dispose(); return; }
        lab.current = created;
        created.setLook(lookRef.current);
        await openRoster('dog', { quiet: true });
      } catch (error) { if (!cancelled) push({ tone: 'bad', title: 'The workshop could not start', text: String(error.message || error) }); }
    })();
    return () => { cancelled = true; created?.dispose(); lab.current = null; game.current?.dispose(); game.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshBodies = useCallback(async () => {
    try { const value = await fetchJson('/api/bodies', { timeoutMs: 20000 }); setBodies(Array.isArray(value.bodies) ? value.bodies : []); }
    catch { /* shelf stays as it is */ }
  }, []);
  useEffect(() => {
    refreshBodies();
    aiApi.health().then(setHealth).catch(() => setHealth(null));
    draftApi.flowerStatus().then(s => setFlowerReady(s?.browserReady === true)).catch(() => setFlowerReady(false));
  }, [refreshBodies]);

  const loadPolicies = useCallback(async bodyId => {
    if (!bodyId) return;
    try {
      const value = await fetchJson(`/api/creatures/${bodyId}/policies`, { timeoutMs: 8000 });
      setPolicies(previous => ({ ...previous, [bodyId]: value.skills || {} }));
      for (const skill of ['walk', 'jump']) {
        if (value.skills?.[skill]?.present && !evals[`${bodyId}/${skill}`]) {
          fetchJson(`/creatures/${bodyId}/policies/${skill}/eval.json`).then(e => setEvals(prev => ({ ...prev, [`${bodyId}/${skill}`]: e }))).catch(() => {});
        }
      }
      if (value.activeJob) setJob(value.activeJob);
    } catch { /* offline: keep previous */ }
  }, [evals]);

  // ---------- creature loading ----------
  async function loadBodyById(bodyId, extra = {}) {
    const body = await fetchJson(`/creatures/${bodyId}/body.json`, { timeoutMs: 20000 });
    await lab.current?.loadBody(body, `/creatures/${bodyId}`);
    setCurrent({ kind: 'body', id: bodyId, name: extra.name || body.name, body, design: extra.design || body.design || null, rosterId: extra.rosterId || null });
    loadPolicies(bodyId);
    return body;
  }
  async function loadLegacy(preset, extra = {}) {
    const manifest = await draftApi.generatePreset({ preset });
    await lab.current?.loadModel(manifest);
    setCurrent({ kind: 'legacy', id: manifest.id, name: extra.name || preset[0].toUpperCase() + preset.slice(1), preset, manifest, rosterId: extra.rosterId || null });
  }
  async function openRoster(rosterId, { quiet = false } = {}) {
    const robot = ROSTER.find(r => r.id === rosterId);
    if (!robot) return;
    try {
      if (robot.legacy) await loadLegacy(robot.legacy, { name: robot.name, rosterId });
      else if (robot.bodyId) await loadBodyById(robot.bodyId, { name: robot.name, rosterId });
      else { push({ tone: 'info', title: `${robot.name} is still being drafted`, text: 'Its Draft body is on the way. Ask Tinker for one in the meantime.' }); return; }
      if (!quiet) push({ tone: 'good', title: `${robot.name} is on the bench`, text: robot.tagline });
      setModal(null);
    } catch (error) { push({ tone: 'bad', title: `Could not open ${robot.name}`, text: String(error.message || error) }); }
  }

  const lookRef = useRef(look);
  lookRef.current = look;
  useEffect(() => { lab.current?.setLook(look); }, [look]);
  useEffect(() => { lab.current?.setViewMode(viewMode); }, [viewMode]);

  // ---------- skills ----------
  const bodyId = current?.kind === 'body' ? current.id : null;
  const skillEntries = bodyId ? policies[bodyId] || {} : {};
  const walkState = current?.kind === 'legacy'
    ? (current.preset === 'cheetah' || (current.preset === 'flower' && flowerReady) ? { state: 'ready', hashMatched: true, honesty: 'Pretrained policy from the original lab (validated for this exact original-size body).' } : { state: 'untrained', reason: 'Legacy preset without a policy' })
    : skillState(skillEntries.walk);
  const jumpState = current?.kind === 'legacy' ? { state: 'untrained', available: false, reason: 'No jump trained for this legacy body' } : skillState(skillEntries.jump);
  const training = {
    walk: { ...walkState, eval: evals[`${bodyId}/walk`] ? { pass: evals[`${bodyId}/walk`].pass, rows: evalRows(evals[`${bodyId}/walk`]) } : undefined },
    jump: { ...jumpState, available: walkState.state === 'ready', reason: walkState.state === 'ready' ? undefined : 'Learn to walk first',
      eval: evals[`${bodyId}/jump`] ? { pass: evals[`${bodyId}/jump`].pass, rows: evalRows(evals[`${bodyId}/jump`]) } : undefined },
  };
  const canPlay = walkState.state === 'ready';
  const canJump = jumpState.state === 'ready';

  useEffect(() => {
    if (!job?.id) return undefined;
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const value = await fetchJson(`/api/training/jobs/${job.id}`, { timeoutMs: 6000 });
          if (bodyId) loadPolicies(bodyId);
          if (value?.job && !value.job.running && value.job.state !== 'running') { setJob(null); push({ tone: value.job.state === 'done' ? 'good' : 'info', title: 'Training finished', text: value.job.message || '' }); break; }
        } catch { /* keep polling */ }
        await sleep(2000);
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  async function startTraining(skill, opts = {}) {
    if (!bodyId) { push({ tone: 'info', title: 'Pick a Draft body first', text: 'Legacy presets keep their original policies.' }); return; }
    try {
      const value = await fetchJson('/api/training/jobs', { method: 'POST', body: { bodyId, skill, budget: opts.budget || 'quick' }, timeoutMs: 15000 });
      setJob(value.job || value); push({ tone: 'info', title: `Training ${skill}`, text: 'Running on this computer’s CPU. You can keep designing meanwhile.' });
      loadPolicies(bodyId);
    } catch (error) { push({ tone: 'bad', title: 'Training did not start', text: error.message }); }
  }
  async function stopTraining() {
    if (!job?.id) return;
    try { await fetchJson(`/api/training/jobs/${job.id}/cancel`, { method: 'POST', timeoutMs: 15000 }); } catch (error) { push({ tone: 'bad', title: 'Could not stop training', text: error.message }); }
  }

  // ---------- Tinker ----------
  function stateForTinker(extra = {}) {
    const now = extra.current || current;
    const body = now?.kind === 'body' ? { id: now.body.id, massKg: now.body.massKg, design: now.design || now.body.design,
      feasibility: now.body.feasibility, trainability: now.body.trainability, terrainProfile: now.body.terrainProfile } : undefined;
    delete extra.current;
    return { design: now?.design || undefined, look, body: lastBuild.current?.error ? lastBuild.current.error : body,
      policies: { walk: walkState.state === 'ready', jump: jumpState.state === 'ready' }, ...extra };
  }
  async function askTinker(text, override = {}) {
    const userMessage = text ? { id: uid('u'), role: 'user', kind: 'text', text } : null;
    const history = userMessage ? [...messages, userMessage] : messages;
    if (userMessage) setMessages(history);
    setBusy(true);
    chatAbort.current?.abort(); const abort = new AbortController(); chatAbort.current = abort;
    try {
      const apiMessages = history.filter(m => (m.role === 'user' || m.role === 'tinker') && m.text).slice(-24)
        .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text).slice(0, 3900) }));
      const value = await aiApi.chat(apiMessages, stateForTinker({ ...override }), abort.signal);
      if (value.provider) setProvider(value.provider);
      setSuggestions(Array.isArray(value.suggestions) ? value.suggestions : []);
      const next = [];
      let replied = false;
      for (const action of value.actions || []) {
        if (action.type === 'design') { next.push({ id: uid('d'), role: 'tinker', kind: 'design', text: replied ? '' : value.reply, design: action.design, designStatus: 'proposed' }); replied = true; }
        else if (action.type === 'look') next.push({ id: uid('l'), role: 'tinker', kind: 'look', look: normalizeLook(action.look), lookName: action.look?.theme, design: current?.design });
        else if (action.type === 'train') next.push({ id: uid('t'), role: 'tinker', kind: 'training', training: { skills: action.skills, estimateMinutes: 8 }, creatureName: current?.name });
        else if (action.type === 'play' && canPlay) next.push({ id: uid('p'), role: 'tinker', kind: 'play', creatureName: current?.name, skills: canJump ? ['walk', 'jump'] : ['walk'] });
      }
      if (!replied && value.reply) next.unshift({ id: uid('m'), role: 'tinker', kind: 'text', text: value.reply });
      setMessages(list => [...list, ...next]);
    } catch (error) {
      if (error?.message !== 'Cancelled') setMessages(list => [...list, { id: uid('e'), role: 'system', kind: 'note', text: `Tinker is unavailable: ${error.message}` }]);
    } finally { if (chatAbort.current === abort) { chatAbort.current = null; setBusy(false); } }
  }

  async function buildDesign(design, message) {
    setBuilding(true); setTab('blueprint');
    setMessages(list => list.map(m => (m === message ? { ...m, designStatus: 'building' } : m)));
    try {
      const value = await fetchJson('/api/design', { method: 'POST', body: design, timeoutMs: 180000 });
      lastBuild.current = { body: value.body };
      await lab.current?.loadBody(value.body, `/creatures/${value.body.id}`);
      const built = { kind: 'body', id: value.body.id, name: design.name, body: value.body, design };
      setCurrent(built);
      if (design.look) setLook(normalizeLook(design.look));
      loadPolicies(value.body.id); refreshBodies();
      setMessages(list => [...list.map(m => (m === message || m.id === message?.id ? { ...m, designStatus: 'built', body: value.body } : m)),
        { id: uid('n'), role: 'system', kind: 'note', text: `Draft built ${design.name}: ${value.body.massKg?.toFixed?.(1) ?? '?'} kg, ${value.body.jointNames?.length ?? '?'} joints, feasibility ${value.body.feasibility?.passed === false ? 'needs work' : 'passed'}${value.cached ? ' (cached)' : ''}.` }]);
      await askTinker(null, { current: built });
    } catch (error) {
      const problem = error instanceof ApiError ? error.body : { error: 'design-failed', message: String(error.message || error) };
      lastBuild.current = { error: problem };
      setMessages(list => [...list.map(m => (m === message || m.id === message?.id ? { ...m, designStatus: 'failed' } : m)),
        { id: uid('x'), role: 'tinker', kind: 'problem', problem }]);
      await askTinker(null);
      lastBuild.current = null;
    } finally { setBuilding(false); }
  }

  function onChatAction(action, message) {
    if (action.type === 'build') buildDesign(action.design, message);
    else if (action.type === 'tweak') setTab('blueprint');
    else if (action.type === 'open-blueprint') setTab('blueprint');
    else if (action.type === 'apply-look') { setLook(normalizeLook(action.look)); setPresetId(null); setMessages(list => list.map(m => (m.id === message.id ? { ...m, lookApplied: true } : m))); }
    else if (action.type === 'revise') askTinker('Please revise the design so Draft can build it.');
    else if (action.type === 'train') { setTab('train'); startTraining(action.skills?.[0] || 'walk'); }
    else if (action.type === 'play') enterPlayground();
  }

  // ---------- playground ----------
  function pilotFor() {
    if (current?.kind === 'legacy') return current.preset === 'flower' ? createLegacyFlowerPilot() : createLegacyCheetahPilot();
    const base = `/creatures/${current.id}/policies`;
    return wrapCreaturePilot(`${base}/walk/`, {
      loadModule: async () => ({ createCreaturePilot: () => createCreaturePilot({ walkUrl: `${base}/walk/`, jumpUrl: canJump ? `${base}/jump/` : null, bodyUrl: `/creatures/${current.id}/body.json` }) }),
    });
  }
  async function enterPlayground() {
    if (!canPlay) { push({ tone: 'info', title: 'Teach it to walk first', text: 'The playground needs a validated walking skill for this exact body.' }); return; }
    setMode('playground'); setPlayLoading(true); setTitleOpen(false);
    try {
      game.current?.dispose(); game.current = null;
      game.current = await createPlayground(playEl.current, {
        mujoco: mujoco.current, pilot: pilotFor(), look, muted,
        onEvent: event => {
          if (event?.type === 'spark') return;
          if (event?.title || event?.text) push({ tone: event.type === 'fall' ? 'bad' : 'good', title: event.title || event.type, text: event.text || '' });
        },
      });
    } catch (error) {
      push({ tone: 'bad', title: 'The playground could not start', text: String(error.message || error) }); setMode('workshop');
    } finally { setPlayLoading(false); }
  }
  function leavePlayground() { game.current?.dispose(); game.current = null; setSnapshot(null); setMode('workshop'); setModal(null); }
  useEffect(() => {
    if (mode !== 'playground') return undefined;
    const timer = setInterval(() => { try { if (game.current) setSnapshot(game.current.snapshot()); } catch { /* engine restarting */ } }, 200);
    return () => clearInterval(timer);
  }, [mode]);
  useEffect(() => { game.current?.setMuted?.(muted); }, [muted]);

  // ---------- look + print kit ----------
  async function printKit() {
    setExportState('working');
    try {
      const result = await lab.current.printKit(args => exportPrintKit(args));
      const blob = result instanceof Blob ? result : result?.blob;
      if (blob) {
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = result?.filename || `${(current?.name || 'creature').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-print-kit.zip`;
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
      }
      setExportState('done');
    } catch (error) { setExportState('error'); push({ tone: 'bad', title: 'Print kit failed', text: error.message }); }
  }

  // ---------- derived UI data ----------
  const rosterEntries = useMemo(() => ROSTER.map(robot => {
    const listed = robot.bodyId ? bodies.find(b => b.id === robot.bodyId) : null;
    const entries = robot.bodyId ? policies[robot.bodyId] : null;
    const walk = robot.legacy ? (flowerReady ? 'ready' : 'untrained') : entries ? skillState(entries.walk).state : robot.bodyId ? 'untrained' : 'drafting';
    const jump = robot.legacy ? 'untrained' : entries ? skillState(entries.jump).state : 'untrained';
    return { id: robot.id, name: robot.name, kind: robot.kind, tagline: robot.tagline, design: listed?.design || { schema: 'creature-design/1', name: robot.name, bodyPlan: robot.plan || (robot.legacy ? 'multileg' : listed?.bodyPlan || 'quadruped') },
      look, skills: robot.plan === 'wheeled' ? { drive: walk, jump } : { walk, jump }, massKg: listed?.massKg, dimensions: listed?.dimensions, terrainProfile: listed?.terrainProfile };
  }), [bodies, policies, flowerReady, look]);
  useEffect(() => { for (const robot of ROSTER) if (robot.bodyId) loadPolicies(robot.bodyId); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const starters = useMemo(() => bodies.map(b => ({ id: b.id, name: b.name, design: b.design || { schema: 'creature-design/1', name: b.name, bodyPlan: b.bodyPlan }, look, note: b.bodyPlan })), [bodies, look]);
  const creature = { name: current?.name || 'Creature', design: current?.design, look, skills: { walk: walkState.state, jump: jumpState.state } };
  const steps = { imagine: 'done', draft: current ? 'done' : 'active', dress: current ? 'active' : 'todo', train: canPlay ? 'done' : current ? 'active' : 'todo', play: canPlay ? 'active' : 'locked' };
  const nameBadges = canPlay
    ? <><Badge tone="good" icon="check">Walks</Badge>{canJump && <Badge tone="good" icon="check">Jumps</Badge>}</>
    : walkState.state === 'training' || walkState.state === 'validating' ? <Badge tone="info" icon="train">Learning to walk</Badge>
      : building ? <Badge tone="info" icon="blueprint">Drafting</Badge>
        : current ? <Badge tone="warn" icon="alert">Untrained</Badge> : <Badge tone="outline" icon="blueprint">Not built yet</Badge>;

  const spec = <SpecSheet body={current?.kind === 'body' ? current.body : null} design={current?.design} loading={building} policies={training}
    onTrain={skill => { setTab('train'); startTraining(skill); }} onOpenLabNotes={() => setModal('notes')} onTweak={() => askTinker('Can we tweak the proportions?')} device="your Mac" />;
  const tabs = [
    { id: 'blueprint', label: 'Blueprint', icon: 'blueprint', content: spec },
    { id: 'look', label: 'Look', icon: 'palette', content: <LookPanel look={look} onChange={next => { setLook(normalizeLook(next)); setPresetId(null); }}
      presets={PRODUCT_LOOKS} presetId={presetId} onPreset={(id, next) => { setPresetId(id); setLook(normalizeLook(next)); }} design={current?.design}
      onExportPrintKit={printKit} exportState={exportState} onAskTinker={askTinker} /> },
    { id: 'train', label: 'Train', icon: 'train',
      badge: walkState.state === 'training' ? <ProgressRing value={walkState.progress?.envSteps && walkState.progress?.targetSteps ? walkState.progress.envSteps / walkState.progress.targetSteps : 0.1} size={20} stroke={3.5} label="Training" /> : canPlay ? <TabDot tone="good" label="Skills verified" /> : null,
      content: <TrainingPanel creatureName={current?.name} skills={training} onTrain={(skill, opts) => startTraining(skill, opts)} onStop={stopTraining}
        onPlay={enterPlayground} onAskTinker={askTinker} device="your Mac" machineNote="Training runs on this computer's CPU with MuJoCo; no GPU needed." /> },
  ];

  const stageActions = [
    { id: 'roster', label: 'Robots', icon: 'gamepad', hint: 'Pick from the roster', onClick: () => setModal('roster') },
    { id: 'home', label: 'Center', icon: 'home', onClick: () => lab.current?.home() },
    { id: 'drop', label: 'Drop test', icon: 'download', hint: 'Motors off: see how gravity takes it', onClick: () => lab.current?.drop() },
    { id: 'reset', label: 'Reset', icon: 'undo', onClick: () => lab.current?.reset() },
    { id: 'play', label: canPlay ? 'Play' : 'Play (train first)', icon: 'park', primary: true, onClick: enterPlayground },
  ];

  const playHud = (
    <PlayHUD creature={creature} snapshot={snapshot || {}} canJump={canJump} jumpHint={canJump ? undefined : 'This robot has no validated jump yet'}
      onJump={() => game.current?.trigger?.('jump')} onJumpBlocked={hint => push({ tone: 'info', title: 'Jump is locked', text: hint })}
      onExplore={() => setExploreOpen(open => !open)} exploreOpen={exploreOpen}
      explorePanel={<ExplorePanel state={snapshot?.explore?.phase || 'idle'} instruction={exploreText} onInstructionChange={setExploreText}
        landmarks={['red ball', 'goal', 'yellow flag', 'blue tower', 'jump pad']} onStart={() => game.current?.startExplore?.(exploreText)}
        onStop={() => game.current?.stopExplore?.()} onClose={() => setExploreOpen(false)} lastDecision={snapshot?.explore?.lastDecision}
        eyes={health?.roles?.eyes?.configured ? { model: health.roles.eyes.model, kind: health.roles.eyes.kind } : undefined} />}
      cameraMode={snapshot?.camera?.mode === 'intro' ? 'chase' : snapshot?.camera?.mode || 'chase'}
      onCamera={() => game.current?.setCameraMode?.(snapshot?.camera?.mode === 'chase' ? 'overview' : 'chase')}
      onOpenChallenges={() => setModal('terrain')} onOpenStickers={() => {}} onReset={() => game.current?.reset?.()}
      touchControls={<TouchControls onCommand={({ x = 0, y = 0 }) => game.current?.setCommand?.({ vx: -y, wz: -x, normalized: true })} onJump={() => game.current?.trigger?.('jump')} canJump={canJump} />} />
  );

  return (
    <AppShell
      mode={mode}
      onModeChange={next => (next === 'playground' ? enterPlayground() : leavePlayground())}
      playgroundLocked={!canPlay}
      playgroundHint="Teach it to walk first. The playground needs a verified walking skill."
      stage={<div className="app-stage"><div ref={workshopEl} className="app-stage__layer" hidden={mode !== 'workshop'} /><div ref={playEl} className="app-stage__layer" hidden={mode !== 'playground'} />{playLoading && <div className="app-stage__loading">Loading the playground…</div>}</div>}
      muted={muted}
      onToggleMute={() => setMuted(m => !m)}
      onOpenSettings={() => setModal('settings')}
      topActions={mode === 'playground' ? <IconButton icon="pause" label="Pause" onClick={() => setModal('pause')} /> : <IconButton icon="terrain-step" label="Terrain Lab" onClick={() => setModal('terrain')} />}
      toasts={<Toasts toasts={toasts} onDismiss={dismiss} placement={mode === 'playground' ? 'hud' : 'top'} />}
      titleScreen={titleOpen ? <TitleScreen onStart={() => setTitleOpen(false)} onStarter={id => { setTitleOpen(false); openRoster(ROSTER.some(r => r.id === id) ? id : 'dog'); }}
        starters={rosterEntries.filter(r => r.skills.walk === 'ready' || r.skills.drive === 'ready').map(r => ({ id: r.id, name: r.name, design: r.design, look: r.look, blurb: r.tagline }))}
        hero={{ design: 'cheetah', look: '#1f8c80' }} /> : null}
      modals={<>
        <Modal open={modal === 'settings'} onClose={() => setModal(null)} title="Settings" icon="settings" size="lg" placement={phone ? 'bottom' : 'center'}>
          <SettingsPanel health={health} onRefreshHealth={() => aiApi.health().then(setHealth).catch(() => setHealth(null))} muted={muted} onMutedChange={setMuted} />
        </Modal>
        <Modal open={modal === 'notes'} onClose={() => setModal(null)} title="Lab notes" icon="note" description="Where every number on this creature comes from" placement={phone ? 'bottom' : 'right'}>
          <LabNotes body={current?.kind === 'body' ? current.body : null} look={look} policies={training} />
        </Modal>
        <PauseMenu open={modal === 'pause'} onResume={() => setModal(null)} onRestart={() => { game.current?.reset?.(); setModal(null); }}
          onChallenges={() => setModal('terrain')} onStickers={() => setModal(null)} onSettings={() => setModal('settings')} onWorkshop={leavePlayground} creature={creature} stats={{}} />
        <Modal open={modal === 'roster'} onClose={() => setModal(null)} title="Pick a robot" icon="gamepad" description="Real Draft bodies. Badges show only what passed its checks." size="xl" placement={phone ? 'bottom' : 'center'}>
          <RobotRoster robots={rosterEntries} selectedId={current?.rosterId} onSelect={id => openRoster(id)} trials={terrainResults} onOpenTerrain={() => setModal('terrain')} />
        </Modal>
        <Modal open={modal === 'terrain'} onClose={() => setModal(null)} title="Terrain Lab" icon="terrain-step" description="How each robot's structure meets the terrain" size="xl" placement={phone ? 'bottom' : 'center'}>
          <TerrainLab robots={rosterEntries} trials={terrainResults} initial={{ robotId: current?.rosterId || 'dog', laneId: 'gap-35' }} onTryLane={() => { setModal(null); enterPlayground(); }} />
        </Modal>
      </>}
    >
      {mode === 'workshop' ? (
        <WorkshopLayout
          chat={<ChatPanel messages={messages} suggestions={suggestions} provider={provider} busy={busy} onSend={askTinker} onAction={onChatAction} onStop={() => chatAbort.current?.abort()} />}
          tabs={tabs} activeTab={tab} onTabChange={setTab}
          stepper={<LoopStepper status={steps} onStep={step => (step === 'play' ? enterPlayground() : setTab(step === 'dress' ? 'look' : step === 'train' ? 'train' : 'blueprint'))} compact={phone} />}
          nameTag={<NameTag name={current?.name || 'Your creature'} drafted={current?.kind === 'body'} badges={nameBadges} />}
          stageTools={<><StageToolbar actions={stageActions} />{!phone && <ViewModeSwitch value={viewMode} onChange={setViewMode} />}</>}
          shelf={<CreatureShelf starters={starters} mine={[]} currentId={current?.id} onOpen={id => (LEGACY_PRESETS.includes(id) ? loadLegacy(id) : loadBodyById(id).catch(error => push({ tone: 'bad', title: 'Could not open it', text: error.message })))}
            onRemix={() => askTinker('Remix this creature')} onDelete={() => {}} onNew={() => askTinker(null)} onImport={() => fileInput.current?.click()} defaultTab="starters" layout={phone ? 'grid' : 'row'} />}
          phoneStatus={<span className="cl-hint">Tap a tab to open it.</span>}
        />
      ) : playHud}
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={() => push({ tone: 'info', title: 'Recipes', text: 'Recipe import arrives with the next update.' })} />
    </AppShell>
  );
}
