// AI Explore: a vision model looks through the creature's own camera and
// proposes ONE bounded move at a time; the learned gait executes it.
//
// Ported from play/src/vlm-control.js with the same strict validation: the
// decision must answer this exact observation (id + image SHA-256), use one of
// five fixed operations with their fixed velocities and a 0.1-2 s duration,
// and the whole run is capped in decisions and simulated seconds. Manual input
// cancels it immediately. New here: landmark goals (success = the creature
// reaches the named landmark, checked by the engine, never sent to the model)
// and provenance from local OR cloud vision providers, reported honestly.
export const COMMANDS = Object.freeze({ forward: [.35, 0, 0], backward: [-.2, 0, 0], turn_left: [0, 0, .5], turn_right: [0, 0, -.5], stand: [0, 0, 0] });
export const EXPLORE_MAX_DECISIONS = 30;
export const EXPLORE_MAX_SIM_SECONDS = 90;
const SOURCES = new Set(['local_vlm', 'cloud_vlm']);
const activePhase = phase => phase === 'thinking' || phase === 'moving';

export function validateExploreDecision(value, observationId) {
  if (!value || value.ok !== true || value.executesMotion !== false || value.observationId !== observationId ||
      typeof value.decisionId !== 'string' || !value.decisionId || value.decisionId.length > 160 ||
      !SOURCES.has(value.provenance?.source) || typeof value.provenance.model !== 'string' || !value.provenance.model || value.provenance.model.length > 160 ||
      (value.provenance.provider !== undefined && (typeof value.provenance.provider !== 'string' || value.provenance.provider.length > 80)) ||
      !/^[a-f0-9]{64}$/.test(value.provenance.imageSha256 ?? '')) throw Error('Invalid or stale visual decision');
  const a = value.action, expected = Object.hasOwn(COMMANDS, a?.operation) ? COMMANDS[a.operation] : null;
  if (!a || Object.keys(a).sort().join(',') !== 'durationSeconds,operation,vx,vy,wz' || !expected ||
      typeof a.durationSeconds !== 'number' || !Number.isFinite(a.durationSeconds) ||
      (a.operation === 'stand' ? a.durationSeconds !== 0 : a.durationSeconds < .1 || a.durationSeconds > 2) ||
      !['vx', 'vy', 'wz'].every((key, i) => a[key] === expected[i])) throw Error('Visual action exceeds the movement contract');
  const provenance = { source: value.provenance.source, model: value.provenance.model, imageSha256: value.provenance.imageSha256,
    provider: value.provenance.provider ?? (value.provenance.source === 'local_vlm' ? 'local' : 'cloud') };
  return { action: { ...a }, decisionId: value.decisionId, observationId, provenance };
}

// Match "go to the red ball" etc. against landmark names/aliases (longest first).
export function findLandmark(instruction, landmarks) {
  const text = ` ${instruction.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  let best = null;
  for (const l of landmarks) for (const alias of [l.name, ...(l.aliases ?? [])]) {
    if (text.includes(` ${alias.toLowerCase()} `) && (!best || alias.length > best.alias.length)) best = { landmark: l, alias };
  }
  return best?.landmark ?? null;
}

export function createExplore({ capture, apply, freeze, context, getSimTime, getPosition, isReady = () => true, landmarks = [],
  onChange = () => {}, onReached = () => {},
  request = async (body, signal) => {
    const response = await fetch('/vlm/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const value = await response.json().catch(() => { throw Error('Vision service returned an unreadable response'); });
    if (!response.ok) throw Error(value?.error?.message || value?.message || `Vision service unavailable (${response.status})`);
    return value;
  }, timeoutMs = 125000 } = {}) {
  let generation = 0, abort = null, timer = null, image = null, sessionContext = null, instruction = '', startPosition = [], goal = null;
  const fresh = () => ({ phase: 'idle', active: false, instruction: '', landmark: null, action: null, remainingSeconds: 0, completedSteps: 0,
    maxSteps: 12, elapsedSeconds: 0, lastDecision: null, provider: null, model: null, error: null, reason: null, history: [], frame: null, reached: null });
  let state = fresh();
  const current = token => token === generation && activePhase(state.phase);
  function clearRequest() { if (timer !== null) clearTimeout(timer); timer = null; abort?.abort(); abort = null; }
  function finish(phase, reason, error = null) {
    ++generation; clearRequest(); freeze();
    state = { ...state, phase, active: false, remainingSeconds: 0, action: null, reason, error }; onChange(state);
  }
  function cancel(reason = 'user') {
    // Invalidate a response even when its fetch implementation ignores abort.
    if (!activePhase(state.phase)) { ++generation; clearRequest(); return false; }
    finish('cancelled', reason); return true;
  }
  function fail(message) { if (activePhase(state.phase)) finish('error', 'error', String(message)); }
  function closeStep(reason) {
    const now = getSimTime(), position = getPosition(), last = state.history.at(-1);
    if (state.phase === 'moving' && last) {
      const elapsed = Math.max(0, now - state.actionStartSimTime);
      state.history = [...state.history.slice(0, -1), { ...last, endSimTime: now, executedSeconds: elapsed,
        displacement: position.map((x, i) => x - startPosition[i]), terminationReason: reason }];
      state.completedSteps++; state.elapsedSeconds += elapsed;
    }
  }
  async function decide(token) {
    if (!current(token)) return;
    try {
      if (context() !== sessionContext) throw Error('Creature session changed before visual observation');
      freeze(); state = { ...state, phase: 'thinking', active: true, remainingSeconds: 0, action: null }; onChange(state);
      const frame = capture(); image = frame.imageDataUrl;
      if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,')) throw Error('Camera did not return a PNG image');
      const bytes = Uint8Array.from(atob(image.slice('data:image/png;base64,'.length)), c => c.charCodeAt(0));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const imageSha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (!current(token)) return;
      state = { ...state, frame: { observationId: frame.observationId, width: frame.width ?? 640, height: frame.height ?? 400, simTime: getSimTime() } }; onChange(state);
      abort = new AbortController(); const ownAbort = abort;
      timer = setTimeout(() => { if (current(token)) fail('Vision request timed out; creature paused'); }, timeoutMs);
      const value = await request({ instruction, imageDataUrl: image, observationId: frame.observationId }, ownAbort.signal);
      if (!current(token)) return;
      clearRequest();
      if (context() !== sessionContext) throw Error('Creature session changed while vision was thinking');
      const decision = validateExploreDecision(value, frame.observationId);
      // Bind the adapter's digest to this exact local frame: a cached or
      // mismatched response can never issue a move.
      if (decision.provenance.imageSha256 !== imageSha256) throw Error('Visual decision image hash does not match');
      const action = decision.action, now = getSimTime(); startPosition = [...getPosition()];
      state = { ...state, lastDecision: decision, provider: decision.provenance.provider, model: decision.provenance.model, action,
        history: [...state.history, { step: state.completedSteps + 1, ...decision, operation: action.operation, durationSeconds: action.durationSeconds, startSimTime: now }].slice(-EXPLORE_MAX_DECISIONS) };
      if (action.operation === 'stand') { state.completedSteps++; finish('done', 'model_stand'); return; }
      if (state.elapsedSeconds + action.durationSeconds > EXPLORE_MAX_SIM_SECONDS + 1e-8) throw Error('Visual motion budget exceeded');
      state = { ...state, phase: 'moving', remainingSeconds: action.durationSeconds, actionStartSimTime: now };
      apply([action.vx, action.vy, action.wz]); onChange(state);
    } catch (error) { if (current(token)) fail(error?.message ?? error); }
  }
  async function start(nextInstruction, { maxSteps = 12, landmark = null } = {}) {
    if (typeof nextInstruction !== 'string' || !nextInstruction.trim() || nextInstruction.trim().length > 2000) throw Error('Enter an instruction of 1–2000 characters');
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > EXPLORE_MAX_DECISIONS) throw Error(`Choose 1–${EXPLORE_MAX_DECISIONS} visual decisions`);
    cancel('restarted');
    const token = ++generation; instruction = nextInstruction.trim(); image = null;
    goal = (landmark && landmarks.find(l => l.id === landmark)) || findLandmark(instruction, landmarks);
    state = { ...fresh(), phase: 'thinking', active: true, instruction, maxSteps, landmark: goal ? { id: goal.id, name: goal.name } : null }; onChange(state);
    try {
      if (!isReady()) throw Error('A healthy, standing creature is required for AI Explore');
      sessionContext = context(); await decide(token);
    } catch (error) { if (current(token)) fail(error?.message ?? error); }
  }
  // Called by the engine after every control step with the creature position.
  function advance(simTime = getSimTime()) {
    if (goal && activePhase(state.phase)) {
      const p = getPosition();
      if (Math.hypot(p[0] - goal.x, p[1] - goal.y) < goal.reach) {
        closeStep('reached_landmark');
        state = { ...state, reached: goal.id }; finish('done', 'reached_landmark'); onReached(goal); return;
      }
    }
    if (state.phase !== 'moving') return;
    if (context() !== sessionContext) { fail('Creature session changed during visual movement'); return; }
    const elapsed = simTime - state.actionStartSimTime;
    if (!Number.isFinite(elapsed) || elapsed < 0) { fail('Simulation time changed during visual movement'); return; }
    state.remainingSeconds = Math.max(0, state.action.durationSeconds - elapsed);
    if (elapsed + 1e-8 < state.action.durationSeconds) return;
    freeze(); closeStep('duration');
    if (state.completedSteps >= state.maxSteps || state.elapsedSeconds >= EXPLORE_MAX_SIM_SECONDS - 1e-8) { finish('done', 'step_limit'); return; }
    void decide(generation);
  }
  return {
    start, cancel, fail, advance,
    reset() { cancel('reset'); image = null; sessionContext = null; instruction = ''; goal = null; state = fresh(); onChange(state); },
    getFrame: () => image, snapshot: () => structuredClone(state), isActive: () => activePhase(state.phase),
    get moving() { return state.phase === 'moving'; }, get action() { return state.action; },
    dispose() { cancel('disposed'); image = null; },
  };
}
