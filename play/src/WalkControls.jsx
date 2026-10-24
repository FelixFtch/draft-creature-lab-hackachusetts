import { useCallback, useEffect, useRef, useState } from "react";
import { createDriveInput } from "./drive-input.js";
import "./walk-controls.css";

const COPY = {
  zh: {
    title: "带小猎豹散个步", shortTitle: "散步时间", badge: "本地训练 · Draft", intro: "直接拖动方向摇杆，它就会开始走。松手回到平衡指令。",
    start: "启动行走", resume: "继续行走", loading: "正在装载行走策略…", stand: "站立", pause: "暂停", reset: "重新站好",
    ready: "拖动方向摇杆，开始走吧", active: "你来指路，它来迈步", standing: "站立指令 · 控制器仍在平衡", paused: "已暂停 · 拖动摇杆即可继续", fall: "检测到跌倒，请重新站好",
    joystick: "方向摇杆：直接拖动即可启动或继续行走；上下控制前后，左右控制转向", joystickTitle: "方向摇杆", joystickHint: "拖动即走 · 松手平衡", joystickLoading: "保持拖动，正在准备…", forward: "前进", back: "后退", left: "左转", right: "右转",
    keys: "W / S 前后 · A / D 转向 · 空格平衡", release: "摇杆或 WASD 可直接启动、继续或接管视觉控制。松手后速度归零；暂停会冻结身体。",
    needsTraining: "这个身体还没学会走路。棕熊、长颈鹿和改过比例的猎豹仍可摆姿态、做重力实验；行走需要各自训练。",
    restore: "恢复原始猎豹", original: "仅限原始猎豹 · 躯干 1× / 腿长 1×", restoreHint: "恢复体型后再启动；保留你选的颜色。",
    failure: "行走遇到问题", unavailable: "行走引擎尚未就绪，请稍后重试。", design: "回到造型：使用场景里的「重置」。", loadingBody: "等待模型就绪…",
    tryMove: "试个动作", demoForward: "前进 5 秒", demoTurn: "转向 4 秒", demoHint: "先启动行走。动作按模拟时间计时，结束后回到站立指令；手动操作会取消。", demoRunning: "示范进行中", demoComplete: "示范完成 · 已回到站立指令", seconds: "秒",
    trailTitle: "路线挑战", trailHint: "依次走进 3 个标记圈。用摇杆带路，或先看一圈示范。", trailStart: "开始挑战", trailShow: "示范一圈", trailStarting: "正在准备路线…", trailNext: "下一个", trailCollected: "已收集标记", trailGuide: "帮我带路", trailManual: "我来控制", trailAssistNote: "辅助指引方向，猎豹自己迈步；操作摇杆即可接管。", trailManualStatus: "走进下一个标记圈", trailAssistStatus: "转向辅助中 · 可随时接管", trailPaused: "挑战已暂停 · 进度已保留", trailComplete: "三个标记，全都找到啦！", trailFall: "跌倒了，再试一圈吧", trailTimeout: "时间到了，再试一圈吧", trailRetry: "再来一圈", trailFinishedIn: "本圈用时",
  },
  en: {
    title: "Take your cheetah for a walk", shortTitle: "Walking time", badge: "Locally trained · Draft", intro: "Drag the joystick to start moving. Release to request balance.",
    start: "Start walking", resume: "Resume", loading: "Loading walking policy…", stand: "Stand", pause: "Pause", reset: "Reset stance",
    ready: "Drag the joystick to get moving", active: "You steer. Your creature takes the steps.", standing: "Standing command · Balance controller stays on", paused: "Paused · Drag the joystick to resume", fall: "A fall was detected. Reset the stance.",
    joystick: "Joystick: drag to start or resume walking; up and down move, left and right turn", joystickTitle: "Joystick", joystickHint: "Drag to move · Release to balance", joystickLoading: "Keep holding — getting ready…", forward: "Forward", back: "Back", left: "Left", right: "Right",
    keys: "W / S move · A / D turn · Space to balance", release: "The joystick or WASD can start, resume, or take over visual control. Release to request zero speed; Pause freezes the body.",
    needsTraining: "This body has not learned to walk. Bears, giraffes, and resized cheetahs can still pose and try gravity; each body needs its own walking training.",
    restore: "Restore original cheetah", original: "Original cheetah only · Torso 1× / Legs 1×", restoreHint: "Restore the body, then start. Your color stays.",
    failure: "Walking needs attention", unavailable: "The walking engine is not ready. Please try again shortly.", design: "To design again, use Reset in the scene.", loadingBody: "Waiting for the model…",
    tryMove: "Try a move", demoForward: "Forward 5 s", demoTurn: "Turn 4 s", demoHint: "Start walking first. Moves use simulation time, then request standing. Manual input cancels a move.", demoRunning: "Demo running", demoComplete: "Demo complete · Standing requested", seconds: "s",
    trailTitle: "Trail challenge", trailHint: "Walk into all 3 markers in order. Steer with the stick, or watch a lap first.", trailStart: "Start trail", trailShow: "Show me a lap", trailStarting: "Preparing your trail…", trailNext: "Next", trailCollected: "Markers collected", trailGuide: "Guide me", trailManual: "I'll steer", trailAssistNote: "The guide steers; your cheetah takes the steps. Use the stick to take over.", trailManualStatus: "Walk into the next marker", trailAssistStatus: "Steering assist on · Take over anytime", trailPaused: "Trail paused · Progress saved", trailComplete: "All three markers found!", trailFall: "A tumble. Try another lap!", trailTimeout: "Time's up. Try another lap!", trailRetry: "Try another lap", trailFinishedIn: "Lap time",
  },
};

const DRIVE_KEYS = new Set(["KeyW", "KeyS", "KeyA", "KeyD"]);
const DRIVE_LIMITS={cheetah:{forward:.7,backward:.5,turn:.7},flower:{forward:.4,backward:.3,turn:.7}};
const zero = () => [0, 0, 0];
const clamp = (value, low, high) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : 0));
export function keyboardDrive(keys,limits=DRIVE_LIMITS.cheetah) {
  const forward = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  return [forward * (forward > 0 ? limits.forward : limits.backward), 0, limits.turn * (Number(keys.has("KeyA")) - Number(keys.has("KeyD")))];
}
export function joystickDrive(x, y,limits=DRIVE_LIMITS.cheetah) {
  x = clamp(x, -1, 1); y = clamp(y, -1, 1);
  const magnitude = Math.hypot(x, y);
  if (magnitude < .1) return zero();
  if (magnitude > 1) { x /= magnitude; y /= magnitude; }
  return [clamp(-y * (y < 0 ? limits.forward : limits.backward), -limits.backward, limits.forward), 0, clamp(-x * limits.turn, -limits.turn, limits.turn)];
}
function isEditable(target) {
  return !!target?.closest?.("input, textarea, select, [contenteditable='true'], [role='slider'], [role='textbox']");
}

export default function WalkControls({ language, body, flowerTrained=false, lab, walking = {}, visionActive=false, eligible, disabled, paused, onRestore, onBusyChange, onRefresh }) {
  const t = { ...(COPY[language] || COPY.en) };
  if (body === 'flower') Object.assign(t, language === 'zh' ? {
    title: '带花朵散个步', original: '原始尺寸花朵 · 花心 1× / 腿长 1×',
    stand: '原地平衡', standing: '零速度指令 · 腿仍可能原地踏步',
    needsTraining: '六条腿的新身体，需要自己的步态。先试试造型和重力，下方成长日记会显示训练进展。',
    restore: '试试已会走路的猎豹', restoreHint: '先保存一个改作，就可以随时回到这只花朵。',
    trailAssistNote: '辅助指引方向，花朵自己迈步；操作摇杆即可接管。',
  } : {
    title: 'Take your flower for a walk', original: 'Original flower only · Center 1× / Legs 1×',
    stand: 'Balance here', standing: 'Zero-speed command · Legs may still step in place',
    needsTraining: 'Six legs need their own gait. Try shapes and gravity while the learning diary below tracks training.',
    restore: 'Try the walking cheetah', restoreHint: 'Save a remix first if you want to keep this flower design.',
    trailAssistNote: 'The guide steers; your flower takes the steps. Use the stick to take over.',
  });
  if(body==='flower'&&flowerTrained) Object.assign(t,language==='zh'?{
    needsTraining:'这个改作的比例变了，需要重新训练和验证步态。原始尺寸的花朵已经可以尝试行走。',
    restore:'恢复原始花朵',restoreHint:'恢复 1× 比例后再启动；保留你选的颜色。',
  }:{needsTraining:'These proportions need new training and gait validation. The original-size flower is ready to try.',restore:'Restore original flower',restoreHint:'Restore 1× proportions, then start. Your color stays.'});
  const limits=DRIVE_LIMITS[body]||DRIVE_LIMITS.cheetah;
  const [pending, setPending] = useState(false);
  const [pendingMethod, setPendingMethod] = useState("");
  const [error, setError] = useState("");
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const [inputPending, setInputPending] = useState(false);
  const held = useRef(new Set()), pointer = useRef(null), pointerGeometry = useRef(null), mounted = useRef(true), operation = useRef(false);
  const canDrive = eligible && !disabled && !pending && (!!walking.active || visionActive) && !walking.fall;
  const canInteract = eligible && !disabled && !pending && !walking.fall && !walking.error;
  const current = useRef({ lab, canDrive,canInteract,limits });
  current.current = { lab, canDrive,canInteract,limits };

  const send = useCallback(command => {
    const controls = current.current;
    if (!controls.lab?.setDriveCommand) return;
    const next = controls.canDrive ? [clamp(command[0], -controls.limits.backward, controls.limits.forward), 0, clamp(command[2], -controls.limits.turn, controls.limits.turn)] : zero();
    try { controls.lab.setDriveCommand(next); }
    catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  const clearInput = useCallback(() => {
    held.current.clear(); pointer.current = null; pointerGeometry.current = null;
    if (mounted.current) setStick({ x: 0, y: 0 });
  }, []);
  const driveInput = useRef(null);
  if (!driveInput.current) driveInput.current = createDriveInput({
    getContext: () => ({ lab: current.current.lab, allowed: current.current.canInteract }),
    onPending: value => { if (mounted.current) setInputPending(value); },
    onError: err => { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); },
    onInvalidated: clearInput,
  });
  const release = useCallback(() => {
    clearInput();
    driveInput.current.release();
    send(zero());
  }, [clearInput, send]);

  useEffect(() => {
    mounted.current = true;
    function keyDown(event) {
      if (!current.current.canInteract || isEditable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === "Space") {
        // Keep native keyboard activation for buttons, links and disclosures.
        const action = event.target?.closest?.('button, summary, a[href], [role="button"]');
        if (action && !action.classList.contains('draft-walk-pad')) return;
        event.preventDefault(); release(); return;
      }
      if (!DRIVE_KEYS.has(event.code)) return;
      event.preventDefault();
      if (event.repeat || pointer.current !== null) return;
      const continuing = held.current.size > 0;
      held.current.add(event.code);
      const limits=current.current.limits,command = keyboardDrive(held.current,limits);
      setStick({ x: -command[2] / limits.turn, y: -command[0] / (command[0] >= 0 ? limits.forward : limits.backward) });
      if (continuing) driveInput.current.update(command); else void driveInput.current.begin(command);
    }
    function keyUp(event) {
      if (!held.current.has(event.code)) return;
      held.current.delete(event.code);
      if (!held.current.size) { release(); return; }
      const limits=current.current.limits,command = keyboardDrive(held.current,limits);
      setStick({ x: -command[2] / limits.turn, y: -command[0] / (command[0] >= 0 ? limits.forward : limits.backward) });
      driveInput.current.update(command);
    }
    const visibility = () => { if (document.hidden) release(); };
    const focusChanged = event => { if (isEditable(event.target)) release(); };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("focusin", focusChanged);
    return () => {
      mounted.current = false;
      release();
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", focusChanged);
    };
  }, [release, send]);
  useEffect(() => {
    const input = driveInput.current;
    // A VLM takeover emits a paused snapshot before setDriveCommand resumes
    // physics. Inspect the engine now instead of cancelling from that old UI frame.
    const actual = current.current.lab?.snapshot?.();
    if (!canInteract || (input.hasSession() && !input.isStarting() && !actual?.walking?.active && !actual?.vision?.active)) {
      input.cancel({ sendZero: false }); clearInput();
    }
  }, [canInteract, walking.active, visionActive, body, paused, clearInput]);
  useEffect(() => { setError(""); }, [eligible, lab]);

  function moveStick(event) {
    if (!canInteract || pointer.current !== event.pointerId) return;
    const anchor = pointerGeometry.current;
    if (!anchor) return;
    let x = (event.clientX - anchor.x) / anchor.radius;
    let y = (event.clientY - anchor.y) / anchor.radius;
    const length = Math.hypot(x, y);
    if (length > 1) { x /= length; y /= length; }
    setStick({ x, y });
    const command = joystickDrive(x, y,limits);
    if (driveInput.current.hasSession()) driveInput.current.update(command);
    else void driveInput.current.begin(command);
  }
  function pointerDown(event) {
    if (!canInteract || pointer.current !== null || event.button !== 0) return;
    event.preventDefault(); held.current.clear(); pointer.current = event.pointerId;
    const rect = event.currentTarget.getBoundingClientRect();
    // Keep this gesture's origin stable if loading changes the surrounding layout.
    pointerGeometry.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, radius: rect.width * .34 };
    event.currentTarget.setPointerCapture(event.pointerId); moveStick(event);
  }
  function pointerEnd(event) {
    if (pointer.current !== event.pointerId) return;
    release();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function action(method, ...args) {
    if (disabled || pending || operation.current || !eligible) return;
    if (walking.trail?.phase === "active" && ["startWalking", "stopWalking"].includes(method)) { driveInput.current.cancel({ sendZero: false }); clearInput(); }
    else release();
    setError("");
    if (typeof lab?.[method] !== "function") { setError(t.unavailable); return; }
    operation.current = true;
    setPendingMethod(method); setPending(true); onBusyChange?.(true);
    try { await lab[method](...args); if (mounted.current) onRefresh?.(); }
    catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { operation.current = false; if (mounted.current) { setPending(false); setPendingMethod(""); onBusyChange?.(false); } }
  }
  async function demo(command, seconds) {
    if (!canDrive) return;
    release(); setError("");
    if (typeof lab?.runWalkingDemo !== "function") { setError(t.unavailable); return; }
    try { await lab.runWalkingDemo(command, seconds); if (mounted.current) onRefresh?.(); }
    catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); }
  }
  function toggleTrailAssist() {
    if (!canDrive || walking.trail?.phase !== "active") return;
    const assisted = !walking.trail.assisted;
    release(); setError("");
    if (typeof lab?.setTrailAssist !== "function") { setError(t.unavailable); return; }
    try { lab.setTrailAssist(assisted); onRefresh?.(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  const loading = pending || inputPending || !!walking.loading;
  const trail = walking.trail || null;
  const trailActive = trail?.phase === "active";
  const collected = Number.isFinite(trail?.collected) ? Math.max(0, Math.min(3, Math.floor(trail.collected))) : 0;
  const distance = Number.isFinite(trail?.distance) ? `${Math.max(0, trail.distance).toFixed(1)} m` : "…";
  const elapsed = Number.isFinite(trail?.elapsedSeconds) ? `${trail.elapsedSeconds.toFixed(1)} ${t.seconds}` : "…";
  const trailStatus = trail?.phase === "complete" ? t.trailComplete : trail?.phase === "failed" ? (trail.reason === "fall" ? t.trailFall : t.trailTimeout) : paused ? t.trailPaused : trail?.assisted ? t.trailAssistStatus : t.trailManualStatus;
  const walkingError = error || walking.error;
  const moving = Array.isArray(walking.command) && walking.command.some(value => Math.abs(value) > .01);
  const demoRemaining = Number.isFinite(walking.demo?.remainingSeconds) ? walking.demo.remainingSeconds.toFixed(1) : "…";
  const status = loading ? (pendingMethod === "startTrail" ? t.trailStarting : t.loading) : walkingError ? `${t.failure}: ${walkingError}` : trail ? trailStatus : walking.fall ? t.fall : walking.demo?.active ? `${t.demoRunning} · ${demoRemaining} ${t.seconds}` : walking.active ? (moving ? t.active : walking.demo?.completed ? t.demoComplete : t.standing) : paused ? t.paused : disabled ? t.loadingBody : t.ready;

  return <section className={`draft-walk-controls${walking.active ? " is-active" : ""}${paused ? " is-paused" : ""}${!eligible ? " is-locked" : ""}`} aria-labelledby="draft-walk-title">
    <div className="draft-walk-copy">
      <span className="draft-walk-badge"><span aria-hidden="true">✦</span>{t.badge}</span>
      <h2 id="draft-walk-title">{trail ? t.trailTitle : walking.active || paused ? t.shortTitle : t.title}</h2>
      <p className="draft-walk-intro">{eligible ? t.intro : t.needsTraining}</p>
      {!eligible ? <div className="draft-walk-restore"><button type="button" className="draft-walk-primary" disabled={disabled || loading} onClick={onRestore}>{t.restore}<span aria-hidden="true">↗</span></button><p>{t.restoreHint}</p></div> : <>
        <div className={`draft-walk-status${walkingError || walking.fall ? " is-error" : ""}`} role="status" aria-live="polite">{loading ? <span className="draft-spinner" aria-hidden="true" /> : <span className="draft-walk-light" aria-hidden="true" />}{status}</div>
        <div className="draft-walk-actions">
          {!walking.active && <button type="button" className="draft-walk-primary" disabled={disabled || loading} onClick={() => action("startWalking")}><span aria-hidden="true">▶</span>{loading ? t.loading : paused && !walking.fall ? t.resume : t.start}</button>}
          {walking.active && <><button type="button" className="draft-walk-primary" disabled={!canDrive} onClick={release}><span aria-hidden="true">●</span>{t.stand}</button><button type="button" disabled={disabled || loading} onClick={() => action("stopWalking")}><span aria-hidden="true">Ⅱ</span>{t.pause}</button></>}
          {(walking.active || paused) && <button type="button" disabled={disabled || loading || !walking.ready} onClick={() => action("resetWalking")}><span aria-hidden="true">↺</span>{t.reset}</button>}
        </div>
        <p className="draft-walk-keyboard">{t.keys}</p>
        {trail ? <div className={`draft-trail-panel draft-walk-demos is-${trail.phase}`} aria-label={t.trailTitle}>
          <div className="draft-trail-progress" role="progressbar" aria-label={t.trailCollected} aria-valuemin={0} aria-valuemax={3} aria-valuenow={collected}>
            <strong>{collected}<span> / 3</span></strong><span className="draft-trail-dots" aria-hidden="true">{[0, 1, 2].map(index => <i key={index} className={index < collected ? "is-collected" : ""}>{index < collected ? "✓" : index + 1}</i>)}</span>
            <span className="draft-trail-distance">{trailActive ? <>{t.trailNext} <b>{distance}</b></> : <>{t.trailFinishedIn} <b>{elapsed}</b></>}</span>
          </div>
          <div className="draft-trail-actions">{trailActive ? <button type="button" disabled={!canDrive} onClick={toggleTrailAssist} aria-pressed={!!trail.assisted} title={t.trailAssistNote}>{trail.assisted ? t.trailManual : t.trailGuide}<span aria-hidden="true">{trail.assisted ? "✋" : "↗"}</span></button> : <><button type="button" className="draft-walk-primary" disabled={disabled || loading} onClick={() => action("startTrail", false)}>{t.trailRetry}</button><button type="button" disabled={disabled || loading} onClick={() => action("startTrail", true)}>{t.trailShow}</button></>}</div>
        </div> : <details className="draft-walk-demos draft-trail-entry"><summary>{t.trailTitle}<span aria-hidden="true">＋</span></summary><p>{t.trailHint}</p><div><button type="button" className="draft-walk-primary" disabled={disabled || loading} onClick={() => action("startTrail", false)}>{t.trailStart}</button><button type="button" disabled={disabled || loading} onClick={() => action("startTrail", true)} title={t.trailAssistNote}>{t.trailShow}</button></div><p className="draft-trail-assist-note">{t.trailAssistNote}</p><details className="draft-walk-basic-moves"><summary>{t.tryMove}<span aria-hidden="true">＋</span></summary><p>{t.demoHint}</p><div><button type="button" disabled={!canDrive} onClick={() => demo([body === "flower" ? .25 : .5, 0, 0], 5)}>{t.demoForward}</button><button type="button" disabled={!canDrive} onClick={() => demo([0, 0, .5], 4)}>{t.demoTurn}</button></div></details></details>}
      </>}
      <p className="draft-walk-scope">{eligible ? (paused ? t.design : t.original) : t.original}</p>
    </div>
    {eligible && <div className="draft-walk-pad-wrap">
      <strong className="draft-walk-pad-title">{t.joystickTitle}</strong>
      <div className="draft-walk-pad-label">{t.forward}</div>
      <div className="draft-walk-pad-row"><span>{t.left}</span><button type="button" className={`draft-walk-pad${inputPending ? ' is-loading' : ''}`} aria-label={t.joystick} aria-describedby="draft-walk-pad-hint draft-walk-release" aria-busy={inputPending} disabled={!canInteract} onPointerDown={pointerDown} onPointerMove={moveStick} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onContextMenu={event => event.preventDefault()}><span className="draft-walk-cross" aria-hidden="true" /><span className="draft-walk-knob" style={{ transform: `translate(${stick.x * 39}px, ${stick.y * 39}px)` }} aria-hidden="true"><span>✣</span></span></button><span>{t.right}</span></div>
      <div className="draft-walk-pad-label">{t.back}</div>
      <p id="draft-walk-pad-hint" className="draft-walk-pad-hint" role="status">{inputPending ? t.joystickLoading : t.joystickHint}</p>
      <p id="draft-walk-release" className="draft-walk-release">{t.release}</p>
    </div>}
  </section>;
}
