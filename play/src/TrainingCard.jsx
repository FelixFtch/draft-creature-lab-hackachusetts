import { useEffect, useState } from "react";
import "./training-card.css";

const COPY = {
  zh: {
    eyebrow: "一只猎豹的练习日记", title: "身体造好了，动作要学会。",
    intro: "4,096 只虚拟猎豹一起练习，把经验交给同一个行走策略。",
    running: "正在练习", completed: "训练完成", capacity: "正在检查训练容量", capacityComplete: "容量检查完成", stopping: "正在停止", checking: "等待训练数据",
    stopped: "训练已停止", failed: "训练未完成", refused: "训练未启动", starting: "正在准备", offline: "连接暂时中断", stale: "状态更新已延迟",
    progress: "训练轮次", elapsed: "已用时", minutes: "分钟", gpu: "训练显存峰值", ram: "训练内存峰值",
    resources: "CPU、GPU、内存、显存，各做什么？",
    cpuTitle: "CPU ＋ 内存 RAM", cpuBody: "准备机器人与场景、协调训练、写入日志。内存存放这些程序和数据。",
    gpuTitle: "GPU ＋ 显存 VRAM", gpuBody: "这次训练由 GPU 并行模拟物理、更新神经网络。显存容纳并行世界、策略与训练批次。",
    browserTitle: "浏览器里的设计台", browserBody: "MuJoCo 物理和已训练策略推理在 CPU 上运行；GPU 用 Three.js 渲染画面。浏览器不执行强化学习训练，也不需要训练时的 6.7 GiB 显存。",
    memoryHint: "实测为本机这次训练进程约每秒采样的峰值，可能漏掉短暂峰值。更多并行机器人通常更耗显存；更多训练轮次主要增加时间。",
    stages: ["练习动作", "测量表现", "看练习录像"],
    evaluation: "学得怎么样？", scenario: "指令", measured: "平均前向速度 / 转速", falls: "出现终止的副本",
    stationary: "停住", forward: "前进 0.5 m/s", turn: "转向 0.5 rad/s",
    evalNote: "每项 32 个副本：2 秒适应 + 10 秒测量。速度只统计首次失败前的有效采样；终止比例覆盖整个测试。",
    drift: "前进测试的侧向偏移", driftNote: "平均绝对偏移，测量时段 10 秒。已展示行走；精确导航仍需改进。",
    videoTitle: "猎豹的模拟练习录像", videoNote: "这是原始尺寸猎豹在本机模拟器中的策略回放。上方行走面板可驾驶原始尺寸猎豹；改造体型需要另行训练和验证。",
    waiting: "训练结束后，还要测量停住、前进和转向的表现。完成训练本身不保证会走。",
    unavailable: "训练状态暂不可用，造型和重力实验仍可使用。", scope: "原始尺寸猎豹 · 单个训练种子",
  },
  en: {
    eyebrow: "A CHEETAH'S PRACTICE DIARY", title: "A body is built. Movement is learned.",
    intro: "4,096 virtual cheetahs practice together, sharing experience with one walking policy.",
    running: "Practicing", completed: "Training complete", capacity: "Checking training capacity", capacityComplete: "Capacity check complete", stopping: "Stopping", checking: "Waiting for training data",
    stopped: "Training stopped", failed: "Training incomplete", refused: "Training did not start", starting: "Getting ready", offline: "Connection interrupted", stale: "Status update delayed",
    progress: "Training iterations", elapsed: "Elapsed", minutes: "min", gpu: "Peak training VRAM", ram: "Peak training RAM",
    resources: "What do CPU, GPU, RAM and VRAM do?",
    cpuTitle: "CPU + system RAM", cpuBody: "Prepare robots and scenes, coordinate training and write logs. RAM holds these programs and data.",
    gpuTitle: "GPU + VRAM", gpuBody: "This run uses the GPU for parallel physics and neural-network updates. VRAM holds the worlds, policy and training batches.",
    browserTitle: "The browser workbench", browserBody: "MuJoCo physics and the trained policy run on the CPU. The GPU renders with Three.js. Browser play does not run reinforcement learning or require the training run’s 6.7 GiB of VRAM.",
    memoryHint: "Measured peaks for this training process, sampled about once a second; brief peaks may be missed. More parallel robots usually need more VRAM. More iterations mainly take more time.",
    stages: ["Practice", "Measure", "Watch the replay"],
    evaluation: "What did it learn?", scenario: "Command", measured: "Mean forward / yaw rate", falls: "Replicas with a termination",
    stationary: "Stand still", forward: "Forward 0.5 m/s", turn: "Turn 0.5 rad/s",
    evalNote: "32 replicas per task: 2 seconds settling + 10 seconds measuring. Speed uses valid samples before each first failure; termination fractions cover the whole test.",
    drift: "Sideways drift in the forward test", driftNote: "Mean absolute displacement over the 10-second measurement. Walking is demonstrated; precise navigation still needs work.",
    videoTitle: "Cheetah simulation replay", videoNote: "A policy rollout of the original-size Cheetah in the local simulator. Use the walking panel above to drive the original-size Cheetah. Altered bodies need separate training and validation.",
    waiting: "After training, standing, forward motion and turning still need measurement. Finishing training does not guarantee walking.",
    unavailable: "Training status is unavailable. Shape and gravity experiments still work.", scope: "Original-size Cheetah · one training seed",
  },
};

function gib(value) { return Number.isFinite(value) ? `${(value / 1024).toFixed(1)} GiB` : "—"; }
function speed(result) {
  const index = result.scenario === "turn" ? 2 : 0;
  const value = result.meanActualVxVyWz?.[index];
  return Number.isFinite(value) ? `${value.toFixed(3)} ${index === 2 ? "rad/s" : "m/s"}` : "—";
}

export default function TrainingCard({ language }) {
  const t = COPY[language];
  const [data, setData] = useState(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let closed = false, timer, request;
    async function refresh() {
      request = new AbortController();
      const timeout = setTimeout(() => request.abort(), 4000);
      try {
        const response = await fetch("/api/training-status", { signal: request.signal, cache: "no-store" });
        if (!response.ok) throw Error("status unavailable");
        const next = await response.json();
        if (!closed) { setData(next); setOffline(false); }
      } catch { if (!closed) setOffline(true); }
      finally { clearTimeout(timeout); if (!closed) timer = setTimeout(refresh, 5000); }
    }
    refresh();
    return () => { closed = true; clearTimeout(timer); request?.abort(); };
  }, []);
  const available = data?.available;
  const completed = available && data.status === "completed" && data.mode === "full";
  const evaluation = data?.evaluation;
  const forward = evaluation?.results?.find(result => result.scenario === "forward");
  const total = data?.iterationsRequested || 1200;
  const count = Math.min(total, data?.iterationsObserved || 0);
  const status = offline ? t.offline : data?.stale ? t.stale : available ? data.mode === "capacity" && data.status === "running" ? t.capacity : data.mode === "capacity" && data.status === "completed" ? t.capacityComplete : t[data.status] || t.checking : t.checking;
  return <section className="training-card" aria-label={t.eyebrow}>
    <div className="training-heading"><div><span className="draft-eyebrow">{t.eyebrow}</span><h2>{t.title}</h2></div><span className={`training-badge${offline || data?.stale ? " is-delayed" : ""}`}>{status}</span></div>
    <p className="training-intro">{t.intro}</p>
    {available ? <>
      <div className="training-progress-label"><label htmlFor="training-progress">{t.progress}</label><span>{count.toLocaleString()} / {total.toLocaleString()}</span></div>
      <progress id="training-progress" max={total} value={count} />
      <div className="training-stages">{t.stages.map((label, i) => <span key={label} className={(i === 0 ? completed : i === 1 ? !!evaluation : !!evaluation?.videoUrl) ? "is-done" : ""}><b>{(i === 0 ? completed : i === 1 ? !!evaluation : !!evaluation?.videoUrl) ? "✓" : i + 1}</b>{label}</span>)}</div>
      <dl className="training-numbers"><div><dt>{t.elapsed}</dt><dd>{Math.floor((data.elapsedSeconds || 0) / 60)} <small>{t.minutes}</small></dd></div><div><dt>{t.gpu}</dt><dd>{gib(data.peakOwnedGpuMiB)}</dd></div><div><dt>{t.ram}</dt><dd>{gib(data.peakOwnedRamMiB)}</dd></div></dl>
    </> : <p className="training-note">{t.unavailable}</p>}
    <details className="training-explainer"><summary>{t.resources}</summary><div className="training-resource-grid">{["cpu", "gpu", "browser"].map(key => <article key={key}><h3>{t[`${key}Title`]}</h3><p>{t[`${key}Body`]}</p></article>)}</div><p className="training-note">{t.memoryHint}</p></details>
    {evaluation ? <div className="training-evaluation"><h3>{t.evaluation}</h3><div className="training-table-wrap"><table><thead><tr><th>{t.scenario}</th><th>{t.measured}</th><th>{t.falls}</th></tr></thead><tbody>{evaluation.results.map(result => <tr key={result.scenario}><th scope="row">{t[result.scenario] || result.scenario}</th><td>{speed(result)}</td><td>{Number.isFinite(result.fallFraction) ? `${Math.round(result.fallFraction * 100)}%` : "—"}</td></tr>)}</tbody></table></div><p className="training-note">{t.evalNote}</p></div> : <p className="training-note">{t.waiting}</p>}
    {Number.isFinite(forward?.meanAbsLateralDisplacementM) && <p className="training-drift"><strong>{t.drift}: {forward.meanAbsLateralDisplacementM.toFixed(2)} m</strong><span>{t.driftNote}</span></p>}
    {evaluation?.videoUrl && <figure className="training-replay"><video controls preload="metadata" playsInline aria-label={t.videoTitle} src={evaluation.videoUrl} /><figcaption>{t.videoNote}</figcaption></figure>}
    <p className="training-scope">{t.scope}</p>
  </section>;
}
