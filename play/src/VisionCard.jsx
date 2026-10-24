import { useEffect, useId, useRef, useState } from 'react';
import './vision-controls.css';

const COPY = {
  zh: {
    title: '让它看着走', subtitle: '给小伙伴一个视觉任务', badge: '视觉伙伴 · 本地模型',
    intro: '写下目的地，让它看一眼，再迈一小步。你可以随时接管。',
    instruction: '想让它做什么？', defaultInstruction: '走进下一个带数字的圆圈。目标还在前方时，继续小步靠近；只有圆圈中心来到脚下、离开前方视野时才停止。根据每次的新画面选择前进或转向。',
    quick: '试个任务', marker: '开始数字小径', markerAgain: '重新开始数字小径', preparing: '正在摆好数字标记…', prepareError: '数字小径未能准备好，请重试。', turn: '看看左边', turnInstruction: '向左转一点，看看左边有什么。',
    one: '看一眼，走一步', six: '试走六步', full: '试着走完整条小径', fullHint: '最多 30 次视觉判断 · 随时用摇杆接管', fullInstruction: '依次走进数字 1、2、3 的圆圈。完成的数字牌会消失并留下绿色地面圆圈。继续寻找画面中编号最小的剩余数字，先转向对准，再小步靠近。不要因为完成一个圆圈就停下。若暂时看不到目标，可以短暂转向或后退，重新观察。所有数字牌消失后停下。只根据每次的新画面行动。', stop: '停止并暂停',
    checking: '正在连接视觉伙伴…', ready: '视觉伙伴已就绪', offline: '视觉伙伴尚未连接', loading: '视觉伙伴正在准备', busy: '视觉伙伴正在处理其他请求',
    retry: '重新连接', local: '画面发送到本机视觉模型',
    needsBody: '先选择已学会行走的原始尺寸花朵或猎豹。',
    offlineHint: '启动本地视觉服务后，点「重新连接」。手动摇杆仍可使用。',
    idle: '你的指令，它的下一步。', thinking: '正在看画面、想方向 · 场景已暂停', moving: '正在执行这一小步', done: '这一轮已结束 · 场景已暂停', cancelled: '视觉控制已结束', error: '这一步没有继续 · 场景已暂停',
    camera: '它最近看到的画面', cameraAlt: '机器人前方相机的最近一帧', cameraEmpty: '先看看它眼中的世界，再给它一个任务。', preview: '看看它的视角', previewError: '暂时无法获取画面，请等身体装载完成后再试。',
    history: '它选择了哪些动作？', step: '步', seconds: '模拟秒', model: '视觉伙伴',
    explanation: '视觉伙伴选择方向，已学会的步态负责平衡。每次最多走 2 模拟秒；思考和结束时暂停。摇杆可接管，切出页面会停止。',
    scope: '这是视觉行走实验。到达目标仍需观察；目前不能抓取物品。',
    startError: '暂时无法开始，请检查连接后重试。', stopError: '暂停未完成，请使用行走面板中的「暂停」。',
    forward: '向前走', backward: '往后退', turn_left: '向左转', turn_right: '向右转', stand: '停在这里',
  },
  en: {
    title: 'Let it look & explore', subtitle: 'A visual mission for your creature', badge: 'Vision buddy · Local model',
    intro: 'Describe a destination. Your creature looks, then takes a small step. You can take over anytime.',
    instruction: 'What should it do?', defaultInstruction: 'Walk into the next numbered circle. While the target is still ahead, keep approaching in small steps. Stop only when the center of the circle is beneath your feet and has left the forward view. Use each new image to choose whether to move forward or turn.',
    quick: 'Try a mission', marker: 'Start marker trail', markerAgain: 'Restart marker trail', preparing: 'Setting up the numbered markers…', prepareError: 'Could not prepare the marker trail. Please try again.', turn: 'Look to the left', turnInstruction: 'Turn a little to the left to see what is there.',
    one: 'Look & move', six: 'Try 6 moves', full: 'Try the whole trail', fullHint: 'Up to 30 visual decisions · Take over with the joystick anytime', fullInstruction: 'Visit the circles numbered 1, 2, then 3. Completed number signs disappear, leaving green circles on the ground. Keep looking for the smallest remaining visible number. Turn to face it, then approach in small steps. Do not stop just because one circle is complete. If the target is out of view, briefly turn or back up and look again. Stop when all numbered signs have disappeared. Act only from each new image.', stop: 'Stop & pause',
    checking: 'Connecting to your vision buddy…', ready: 'Vision buddy ready', offline: 'Vision buddy is not connected', loading: 'Vision buddy is getting ready', busy: 'Vision buddy is handling another request',
    retry: 'Check connection', local: 'Images go to the vision model on this computer',
    needsBody: 'Choose an original-size flower or cheetah that has learned to walk first.',
    offlineHint: 'Start the local vision service, then check the connection. You can still use the joystick.',
    idle: 'Your instruction. Its next move.', thinking: 'Looking and choosing a direction · Scene paused', moving: 'Taking this small step', done: 'This round has ended · Scene paused', cancelled: 'Visual control has ended', error: 'This move did not continue · Scene paused',
    camera: 'Its latest camera view', cameraAlt: 'Latest image from the robot-mounted front camera', cameraEmpty: 'See the world through its eyes before giving it a mission.', preview: 'Refresh camera view', previewError: 'Could not get a camera view. Wait for the body to finish loading, then try again.',
    history: 'Which moves did it choose?', step: 'moves', seconds: 'simulation s', model: 'Vision buddy',
    explanation: 'The vision buddy chooses a direction; the learned gait handles balance. Each move lasts at most 2 simulation seconds. Thinking and finishing pause the scene. Use the joystick to take over; switching tabs stops it.',
    scope: 'An experiment in visual walking. Check its progress toward the goal; picking up objects is not available.',
    startError: 'Could not start. Check the connection and try again.', stopError: 'Could not pause. Use Pause in the walking controls.',
    forward: 'Forward', backward: 'Backward', turn_left: 'Turn left', turn_right: 'Turn right', stand: 'Stay here',
  },
};

const ACTIVE_PHASES = new Set(['thinking', 'moving']);
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export default function VisionCard({ engine, language = 'en', eligible = false, disabled = false, walking = {}, vision = {} }) {
  vision = vision || {};
  const t = COPY[language] || COPY.en;
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState(t.defaultInstruction);
  const [edited, setEdited] = useState(false);
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState('');
  const mounted = useRef(true), operation = useRef(false), preparation = useRef(false), operationSequence = useRef(0);
  const currentEngine = useRef(engine);
  currentEngine.current = engine;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++operationSequence.current; }; }, []);
  useEffect(() => { if (!edited) setInstruction(t.defaultInstruction); }, [edited, t.defaultInstruction]);

  // A health request never triggers inference. Poll only while the panel is open.
  useEffect(() => {
    let closed = false, timer, request;
    async function check() {
      request = new AbortController();
      const timeout = setTimeout(() => request.abort(), 5000);
      setChecking(true);
      try {
        const response = await fetch('/vlm/health', { signal: request.signal, cache: 'no-store' });
        if (!response.ok) throw Error('offline');
        const next = await response.json();
        if (!next || typeof next !== 'object' || typeof next.provider !== 'object') throw Error('offline');
        if (!closed) setHealth(next);
      } catch { if (!closed) setHealth(null); }
      finally {
        clearTimeout(timeout);
        if (!closed) { setChecking(false); if (open) timer = setTimeout(check, 8000); }
      }
    }
    void check();
    return () => { closed = true; clearTimeout(timer); request?.abort(); };
  }, [open, refresh]);

  const active = !!vision.active || ACTIVE_PHASES.has(vision.phase);
  const ready = health?.provider?.ready === true;
  const providerBusy = health?.busy === true;
  const canStart = !!engine?.startVision && eligible && !disabled && !pending && !active && ready && !providerBusy && !!instruction.trim();
  const phase = vision.phase || 'idle';
  const frame = engine?.getVisionFrame?.();
  const safeFrame = typeof frame === 'string' && frame.startsWith('data:image/png;base64,') ? frame : null;
  const history = Array.isArray(vision.history) ? vision.history.slice(-30) : [];
  const model = vision.lastDecision?.provenance?.model || health?.model;
  const serviceLabel = checking && !health ? t.checking : ready ? providerBusy && !active ? t.busy : t.ready : health?.provider?.reachable ? t.loading : t.offline;
  const currentAction = vision.action?.operation;
  const statusText = preparing ? t.preparing : active && phase === 'moving' && currentAction ? `${t.moving} · ${t[currentAction] || currentAction}` : t[phase] || t.idle;

  async function start(maxSteps, nextInstruction = instruction) {
    if (!canStart || operation.current) return;
    const sequence = ++operationSequence.current;
    operation.current = true; setPending(true); setLocalError('');
    try { await engine.startVision(nextInstruction.trim(), { maxSteps }); }
    catch (error) { if (mounted.current && sequence === operationSequence.current && error?.name !== 'AbortError') setLocalError(t.startError); }
    finally {
      if (sequence === operationSequence.current) {
        operation.current = false;
        if (mounted.current) setPending(false);
      }
    }
  }
  function stop(reason = 'user') {
    // Release the panel immediately, even if a cancelled asset request remains
    // unresolved. A late completion must not clear a newer operation's state.
    ++operationSequence.current;
    const wasPreparing = preparation.current;
    operation.current = false; preparation.current = false;
    setPending(false); setPreparing(false); setLocalError('');
    try {
      if (wasPreparing) engine?.stopWalking?.();
      engine?.stopVision?.(reason);
    }
    catch { setLocalError(t.stopError); }
  }
  function toggle(event) {
    const next = event.currentTarget.open;
    setOpen(next);
    if (!next && (active || pending)) stop('panel_closed');
  }
  function choose(text) { setInstruction(text); setEdited(true); setLocalError(''); }
  async function prepareTrail() {
    if (!engine?.startTrail || !eligible || disabled || active || pending || operation.current) return;
    const sequence = ++operationSequence.current;
    const bodyId = engine.snapshot?.().modelId;
    const currentBody = () => currentEngine.current === engine && engine.snapshot?.().modelId === bodyId;
    operation.current = true; preparation.current = true;
    setPending(true); setPreparing(true); choose(t.defaultInstruction);
    try {
      await engine.startTrail(false);
      if (!mounted.current || sequence !== operationSequence.current || !currentBody()) return;
      engine.stopWalking();
      engine.captureVision?.();
    } catch (error) {
      if (mounted.current && sequence === operationSequence.current && currentBody() && error?.name !== 'AbortError') setLocalError(t.prepareError);
    } finally {
      if (sequence === operationSequence.current) {
        operation.current = false; preparation.current = false;
        if (mounted.current) { setPending(false); setPreparing(false); }
      }
    }
  }
  async function preview() {
    if (!engine?.captureVision || disabled || active || pending || previewBusy) return;
    setPreviewBusy(true); setLocalError('');
    try { await engine.captureVision(); }
    catch { if (mounted.current) setLocalError(t.previewError); }
    finally { if (mounted.current) setPreviewBusy(false); }
  }

  return <details className={`draft-vision-card${active ? ' is-active' : ''}`} open={open} onToggle={toggle}>
    <summary>
      <span className="draft-vision-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span>
      <span className="draft-vision-title"><strong>{t.title}</strong><span>{active ? statusText : t.subtitle}</span></span>
      <span className="draft-vision-expand" aria-hidden="true">＋</span>
    </summary>
    <div className="draft-vision-body">
      <div className="draft-vision-copy">
        <span className="draft-vision-badge">{t.badge}</span>
        <p className="draft-vision-intro">{t.intro}</p>
        <div className="draft-vision-connection"><span className={`draft-vision-health${ready ? ' is-ready' : ''}`}><i aria-hidden="true" />{serviceLabel}</span><button type="button" onClick={() => setRefresh(value => value + 1)} disabled={checking}>{t.retry}</button></div>
        {!eligible && <p className="draft-vision-note">{t.needsBody}</p>}
        {!ready && !checking && <p className="draft-vision-note">{t.offlineHint}</p>}
        <label className="draft-vision-label" htmlFor={fieldId}>{t.instruction}</label>
        <textarea id={fieldId} value={instruction} rows={3} maxLength={2000} disabled={active || pending} onChange={event => { setInstruction(event.target.value); setEdited(true); }} aria-describedby={`${fieldId}-scope`} />
        <div className="draft-vision-missions" aria-label={t.quick}><button type="button" disabled={!engine?.startTrail || !eligible || disabled || active || pending} onClick={() => void prepareTrail()}>{walking?.trail ? t.markerAgain : t.marker}</button><button type="button" disabled={active || pending} onClick={() => choose(t.turnInstruction)}>{t.turn}</button></div>
        <div className="draft-vision-actions"><button type="button" className="draft-vision-primary" disabled={!canStart} onClick={() => void start(1)}>{t.one}</button><button type="button" disabled={!canStart} onClick={() => void start(6)}>{t.six}</button><button type="button" className="draft-vision-stop" disabled={!active && !pending} onClick={() => stop()}><span aria-hidden="true">■</span>{t.stop}</button></div>
        <div className="draft-vision-full"><button type="button" disabled={!canStart || !walking?.trail || walking.trail.phase !== 'active'} onClick={() => { choose(t.fullInstruction); void start(30, t.fullInstruction); }}>{t.full}</button><span>{t.fullHint}</span></div>
        <div className={`draft-vision-status${phase === 'error' || localError ? ' is-error' : ''}`} role="status" aria-live="polite"><strong>{localError || statusText}</strong>{vision.maxSteps > 0 && <span>{finite(vision.completedSteps)} / {vision.maxSteps} {t.step}{phase === 'moving' ? ` · ${Math.max(0, finite(vision.remainingSeconds)).toFixed(1)} ${t.seconds}` : ''}</span>}</div>
        {vision.error && !localError && <p className="draft-vision-error">{String(vision.error).slice(0, 400)}</p>}
      </div>
      <div className="draft-vision-observation">
        <figure><div className="draft-vision-frame">{safeFrame ? <img src={safeFrame} width="640" height="400" alt={t.cameraAlt} /> : <p>{t.cameraEmpty}</p>}</div><figcaption>{t.camera}<span>{t.local}</span></figcaption></figure>
        <button type="button" className="draft-vision-preview" disabled={!engine?.captureVision || disabled || active || pending || previewBusy} onClick={() => void preview()}>{t.preview}</button>
        {history.length > 0 && <details className="draft-vision-history"><summary>{t.history}<span aria-hidden="true">＋</span></summary><ol>{history.map((item, index) => <li key={item.decisionId || `${item.step}-${index}`}><span>{t[item.operation] || item.operation}</span><span>{finite(item.durationSeconds).toFixed(1)} {t.seconds}</span></li>)}</ol></details>}
        {model && <p className="draft-vision-model">{t.model}: {String(model).slice(0, 120)}</p>}
      </div>
      <div className="draft-vision-about" id={`${fieldId}-scope`}><p>{t.explanation}</p><p>{t.scope}</p></div>
    </div>
  </details>;
}
