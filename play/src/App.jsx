// Local Draft Creature Lab UI. Geometry and MuJoCo execution are supplied by draft-lab.js.
import { useCallback, useEffect, useRef, useState } from "react";
import { createDraftLab } from "./draft-lab.js";
import TrainingCard from "./TrainingCard.jsx";
import WalkControls from "./WalkControls.jsx";
import FlowerCard from "./FlowerCard.jsx";
import VisionCard from "./VisionCard.jsx";
import "./playground.css";

const PRESETS = ["cheetah", "bear", "giraffe", "flower"];
const COLORS = ["#1f8c80", "#ed9553", "#647db6", "#d16b78", "#c5ac5a", "#e5e9e2"];
const STORAGE = "draft-creature-lab-remixes-v1";
const DEFAULT = { schema: 1, preset: "cheetah", lengthScale: 1, legScale: 1, color: COLORS[0], pose: { crouch: 0, wave: 0 } };
const TEXT = {
  zh: {
    walkMode: "真实策略行走", walkingNotice: "在下方用摇杆或 WASD 指路 · 空格站立", walkPaused: "行走已暂停 · 重置可回到造型", walkingLoading: "正在装载真实行走策略…", walkBadge: "本地训练的 Draft 猎豹", returnPose: "回到造型", walkPoseNote: "行走模式中，先回到造型再摆姿态。",
    generatorOffline: "模型生成器暂时不可用。启动实验室后，再点生成重试。", explore: "探索小径",
    name: "造物实验室", brand: "DRAFT CREATURE LAB", intro: "一只新朋友，从你的想法开始。", language: "English", presetTitle: "01 / 选个起点",
    cheetah: "猎豹", bear: "棕熊", giraffe: "长颈鹿", flower: "花朵六足", flowerDesc: "六条腿，另一种可能", cheetahDesc: "轻快的身形", bearDesc: "敦实的骨架", giraffeDesc: "修长的四肢", flowerTorso: "花心宽度", flowerPose: "抬起一条腿", flowerSource: "自定义六足身体 · Draft 生成",
    shapeTitle: "02 / 捏出新模样", torso: "躯干长度", legs: "腿长", original: "原始尺寸", shorter: "短一点", longer: "长一点",
    generate: "生成这个朋友", generating: "正在生成…", changed: "调整已就绪，生成后应用", generated: "模型已生成", paint: "换个颜色", paintNote: "只改变外观", poseTitle: "03 / 打个招呼", crouch: "蹲下", wave: "前腿挥手", poseReset: "重置后可继续摆姿态",
    mode: "姿态与重力实验", poseMode: "姿态工作台", physicsMode: "重力实验中", gravityNotice: "重力实验：电机未驱动，身体可能自然塌落", gravityComplete: "实验完成，重置后可再摆姿态", shareScope: "配方链接需在运行实验室的电脑上打开", orbit: "拖动旋转 · 滚轮缩放", home: "回到默认视角", reset: "重置", drop: "试试重力", dropAgain: "再落下一次", save: "保存我的改作", saving: "保存中…",
    challenge: "今天的小挑战", challengeHint: "造一个高个子朋友", taller: "加长腿", posed: "摆姿态", dropped: "落下", saved: "存改作",
    library: "我的小小家族", local: "仅保存在此浏览器", emptyTitle: "第一个朋友，还在等你", emptyHint: "做好造型，点「保存我的改作」。", open: "打开", parent: "来自", originalParent: "原始体型", missingParent: "较早的改作", remix: "改作", current: "当前",
    share: "复制分享链接", export: "导出配方", import: "导入配方", evidence: "实验数据", loading: "正在搭建实验室…", loadingModel: "正在生成并装载真实模型…", ready: "可以开始创造了", failure: "操作未完成", finiteError: "物理状态异常，请重置。", shareDone: "配方链接已复制", savedDone: "新朋友已加入家族", exportDone: "配方已导出", importDone: "配方已导入", copiedFallback: "可复制下方的配方链接", badRecipe: "配方无效：请使用 schema 1、有效体型、0.8–1.2 比例和十六进制颜色。", badStorage: "浏览器无法保存；请导出配方保留作品。", catalogError: "无法读取体型目录", close: "关闭", recipeLink: "配方分享链接", fileError: "请选择不超过 8 KB 的 JSON 配方。", learn: "真实 Draft 几何 · 本地 MuJoCo 实验", unsaved: "未保存", dataHint: "当前引擎状态、配方与模型来源；不代表行走训练结果。",
  },
  en: {
    walkMode: "Learned walking policy", walkingNotice: "Steer below with the stick or WASD · Space to stand", walkPaused: "Walking paused · Reset to return to design", walkingLoading: "Loading the real walking policy…", walkBadge: "Locally trained Draft cheetah", returnPose: "Back to design", walkPoseNote: "Return to design before changing the pose.",
    generatorOffline: "The generator is unavailable. Start the lab launcher, then choose Generate to retry.", explore: "Explore the trail",
    name: "Draft Creature Lab", brand: "MAKE A LITTLE SOMETHING", intro: "A new friend starts with your idea.", language: "中文", presetTitle: "01 / Pick a starting point",
    cheetah: "Cheetah", bear: "Bear", giraffe: "Giraffe", flower: "Flower crawler", flowerDesc: "Six legs. A different possibility.", cheetahDesc: "A light, nimble shape", bearDesc: "A sturdy little frame", giraffeDesc: "Lovely long limbs", flowerTorso: "Flower center width", flowerPose: "Lift one leg", flowerSource: "Custom six-legged body · Generated with Draft",
    shapeTitle: "02 / Make it your own", torso: "Torso length", legs: "Leg length", original: "Original size", shorter: "Shorter", longer: "Longer",
    generate: "Generate my creature", generating: "Generating…", changed: "New shape ready to generate", generated: "Creature generated", paint: "A splash of color", paintNote: "Appearance only", poseTitle: "03 / Say hello", crouch: "Crouch", wave: "Front-leg wave", poseReset: "Reset to pose your creature again",
    mode: "Pose + gravity experiments", poseMode: "Pose workbench", physicsMode: "Gravity experiment", gravityNotice: "Gravity experiment: motors off; the body may collapse", gravityComplete: "Drop complete — reset to pose again", shareScope: "Recipe link works with this running lab", orbit: "Drag to orbit · Scroll to zoom", home: "Home camera", reset: "Reset", drop: "Try gravity", dropAgain: "Drop again", save: "Save my remix", saving: "Saving…",
    challenge: "A little challenge", challengeHint: "Make a taller friend", taller: "Taller legs", posed: "Pose", dropped: "Drop", saved: "Save",
    library: "My little family", local: "Saved in this browser only", emptyTitle: "Your first friend is waiting", emptyHint: "Make a shape, then choose “Save my remix”.", open: "Open", parent: "From", originalParent: "Original preset", missingParent: "An earlier remix", remix: "Remix", current: "Current",
    share: "Copy share link", export: "Export recipe", import: "Import recipe", evidence: "Lab evidence", loading: "Setting up your lab…", loadingModel: "Generating and loading real geometry…", ready: "Ready to make something", failure: "That didn't complete", finiteError: "Physics state is invalid. Please reset.", shareDone: "Recipe link copied", savedDone: "A new friend joined your family", exportDone: "Recipe exported", importDone: "Recipe imported", copiedFallback: "Copy your recipe link below", badRecipe: "Invalid recipe: use schema 1, a supported preset, 0.8–1.2 scales, and a hex color.", badStorage: "Browser storage is unavailable. Export the recipe to keep it.", catalogError: "Couldn't read the preset catalog", close: "Close", recipeLink: "Recipe share link", fileError: "Choose a JSON recipe no larger than 8 KB.", learn: "Real Draft geometry · Local MuJoCo experiments", unsaved: "Unsaved", dataHint: "Current engine state, recipe, and model provenance; not a walking-training result.",
  },
};

function normalizeRecipe(value) {
  if (!value || typeof value !== "object" || value.schema !== 1 || !PRESETS.includes(value.preset)) throw Error("badRecipe");
  const inRange = (number, min, max) => typeof number === "number" && Number.isFinite(number) && number >= min && number <= max;
  if (!inRange(value.lengthScale, .8, 1.2) || !inRange(value.legScale, .8, 1.2) || !/^#[0-9a-f]{6}$/i.test(value.color || "")) throw Error("badRecipe");
  const pose = value.pose || { crouch: 0, wave: 0 };
  if (!inRange(pose.crouch, 0, 1) || !inRange(pose.wave, 0, 1)) throw Error("badRecipe");
  return { schema: 1, preset: value.preset, lengthScale: value.lengthScale, legScale: value.legScale, color: value.color.toLowerCase(), pose: { crouch: pose.crouch, wave: pose.wave } };
}
function parseRecipe(text) {
  if (typeof text !== "string" || text.length > 8192) throw Error("badRecipe");
  try { return normalizeRecipe(JSON.parse(text)); } catch { throw Error("badRecipe"); }
}
function recipeFromHash() {
  if (!location.hash || !location.hash.startsWith("#recipe=")) return null;
  if (location.hash.length > 8192) throw Error("badRecipe");
  return parseRecipe(new URLSearchParams(location.hash.slice(1)).get("recipe"));
}
function initialRecipe() {
  try { return { recipe: recipeFromHash() || DEFAULT, error: "" }; }
  catch { return { recipe: DEFAULT, error: "badRecipe" }; }
}
function readRemixes() {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw || raw.length > 150000) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    return items.slice(0, 24).flatMap(item => {
      try {
        if (!/^remix-[a-z0-9-]{1,80}$/i.test(item.id || "")) return [];
        return [{ id: item.id, parentId: /^remix-[a-z0-9-]{1,80}$/i.test(item.parentId || "") ? item.parentId : null, createdAt: typeof item.createdAt === "string" ? item.createdAt.slice(0, 40) : "", recipe: normalizeRecipe(item.recipe) }];
      } catch { return []; }
    });
  } catch { return []; }
}
function friendlyError(error) { return error instanceof Error ? error.message : String(error); }
function Icon({ kind, ...props }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7M6 9v12h12V9M10 21v-7h4v7" /></>,
    reset: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" /></>,
    drop: <><path d="M12 3v12m-5-5 5 5 5-5M4 21h16" /><path d="M5 18v3m14-3v3" /></>,
    save: <><path d="M5 3h12l3 3v15H4V3ZM8 3v6h8V3M8 21v-7h8v7" /></>,
    share: <><path d="M8 8H5v13h14V8h-3M12 15V2m-4 4 4-4 4 4" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></>,
    upload: <><path d="M12 15V3m-4 4 4-4 4 4M4 17v4h16v-4" /></>,
    sparkle: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[kind] || paths.sparkle}</svg>;
}
function Creature({ preset, color = "currentColor" }) {
  if (preset === "flower") return <svg viewBox="0 0 100 68" fill="none" aria-hidden="true"><g stroke={color} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">{Array.from({length:6}, (_,i) => <path key={i} d="M62 34h13l9-9" transform={`rotate(${i*60} 50 34)`} />)}<path d="M61 23 66 34 61 45H39L34 34l5-11Z" fill={color} fillOpacity=".13" /></g><circle cx="50" cy="34" r="6" fill={color}/></svg>;
  const giraffe = preset === "giraffe", bear = preset === "bear";
  return <svg viewBox="0 0 100 68" fill="none" aria-hidden="true"><g stroke={color} strokeWidth={bear ? 8 : 6} strokeLinecap="round" strokeLinejoin="round"><path d={bear ? "M24 32h42l13-5" : "M21 30h42l13-8"} /><path d={giraffe ? "M66 28 75 9h10" : bear ? "M69 29 80 22h7" : "M67 28 80 20h8"} /><path d={giraffe ? "m28 32-8 29m20-29-2 29m20-29 7 29m5-29 10 29" : bear ? "m29 34-2 23m14-23 1 23m17-23 2 23m9-23 5 23" : "m27 32-8 23m20-23-2 23m20-23 8 23m4-23 10 23"} /><path d="m22 31-10-9" /></g><circle cx={giraffe ? 83 : 85} cy={giraffe ? 8 : 20} r="2" fill="#fffdf5" /></svg>;
}

export default function App() {
  const initial = useRef(initialRecipe());
  const stage = useRef(null), engine = useRef(null), fileInput = useRef(null);
  const requestNumber = useRef(0), modelQueue = useRef(Promise.resolve());
  // This release is English-only, including browsers with an older zh preference.
  const language = "en";
  const t = TEXT.en;
  const [form, setForm] = useState(initial.current.recipe);
  const [activeRecipe, setActiveRecipe] = useState(null);
  const [color, setColor] = useState(initial.current.recipe.color);
  const [pose, setPose] = useState(initial.current.recipe.pose);
  const [state, setState] = useState({ ready: false, mode: "pose" });
  const [manifest, setManifest] = useState(null);
  const [busy, setBusy] = useState(true);
  const [walkingBusy, setWalkingBusy] = useState(false);
  const [error, setError] = useState(initial.current.error);
  const [notice, setNotice] = useState("");
  const [catalog, setCatalog] = useState(null);
  const [flowerStatus, setFlowerStatus] = useState(null);
  const [remixes, setRemixes] = useState(readRemixes);
  const [parentId, setParentId] = useState(null);
  const [shareFallback, setShareFallback] = useState("");
  const [steps, setSteps] = useState({ taller: false, posed: false, dropped: false, saved: false });
  const working = busy || walkingBusy;
  const ready = !!state.ready && !!activeRecipe && !working;
  const physics = state.mode === "physics";
  const walkingSession = !!state.walking?.active || ["walk", "walking", "walk-paused"].includes(state.mode);
  const walkingEligible = !!activeRecipe && activeRecipe.lengthScale === 1 && activeRecipe.legScale === 1 && (activeRecipe.preset === "cheetah" || (activeRecipe.preset === "flower" && flowerStatus?.browserReady===true));
  const isFlower = (activeRecipe?.preset ?? form.preset) === "flower";
  const dirty = !!activeRecipe && (form.preset !== activeRecipe.preset || form.lengthScale !== activeRecipe.lengthScale || form.legScale !== activeRecipe.legScale);
  const currentRecipe = activeRecipe ? { ...activeRecipe, color, pose } : null;

  const loadRecipe = useCallback(async (recipeInput, nextParentId = null) => {
    let recipe;
    try { recipe = normalizeRecipe(recipeInput); } catch (err) { setError(friendlyError(err)); return; }
    const request = ++requestNumber.current;
    setBusy(true); setError(""); setNotice(""); setShareFallback("");
    try {
      engine.current?.setDriveCommand?.([0, 0, 0]);
      engine.current?.stopWalking?.();
      const response = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preset: recipe.preset, lengthScale: recipe.lengthScale, legScale: recipe.legScale }) });
      const data = await response.json().catch(() => { throw Error("generatorOffline"); });
      if (!response.ok) throw Error(typeof data.error === "string" ? data.error : `Generation failed (${response.status})`);
      if (request !== requestNumber.current) return;
      if (!data.id || !data.xmlUrl || !data.meshUrl) throw Error("Generated model manifest is incomplete.");
      const normalized = normalizeRecipe({ ...recipe, lengthScale: data.parameters?.lengthScale ?? recipe.lengthScale, legScale: data.parameters?.legScale ?? recipe.legScale });
      const operation = modelQueue.current.catch(() => {}).then(async () => {
        if (request !== requestNumber.current || !engine.current) return;
        await engine.current.loadModel(data);
        if (request !== requestNumber.current) return;
        engine.current.setColor(normalized.color);
        engine.current.setPose(normalized.pose);
        setManifest(data); setActiveRecipe(normalized); setForm(normalized); setColor(normalized.color); setPose(normalized.pose); setParentId(nextParentId);
        setSteps({ taller: normalized.legScale > 1.005, posed: normalized.pose.crouch > .005 || normalized.pose.wave > .005, dropped: false, saved: false });
        setState({ ...engine.current.snapshot() });
        setNotice("generated");
      });
      modelQueue.current = operation;
      await operation;
    } catch (err) { if (request === requestNumber.current) setError(friendlyError(err)); }
    finally { if (request === requestNumber.current) setBusy(false); }
  }, []);

  useEffect(() => {
    let cancelled = false, created = null;
    fetch("/api/catalog").then(response => { if (!response.ok) throw Error("catalogError"); return response.json(); }).then(value => { if (!cancelled) setCatalog(value); }).catch(() => { if (!cancelled) setNotice("catalogError"); });
    (async () => {
      try {
        created = await createDraftLab(stage.current, { onState: next => { if (!cancelled) setState(previous => ({ ...previous, ...next })); } });
        if (cancelled) { created.dispose(); return; }
        engine.current = created;
        await loadRecipe(initial.current.recipe);
        if (initial.current.error) setError(initial.current.error);
      } catch (err) { if (!cancelled) { setError(friendlyError(err)); setBusy(false); } }
    })();
    const poll = window.setInterval(() => {
      if (!engine.current || cancelled) return;
      try { setState({ ...engine.current.snapshot() }); } catch (err) { setError(friendlyError(err)); }
    }, 250);
    const hashChanged = () => {
      try { const recipe = recipeFromHash(); if (recipe && engine.current) loadRecipe(recipe); }
      catch (err) { setError(friendlyError(err)); }
    };
    window.addEventListener("hashchange", hashChanged);
    return () => { cancelled = true; ++requestNumber.current; window.clearInterval(poll); window.removeEventListener("hashchange", hashChanged); if (created) created.dispose(); engine.current = null; };
  }, [loadRecipe]);

  useEffect(() => {
    document.documentElement.lang = "en";
    document.title = t.name;
    try { localStorage.setItem("draft-creature-language", language); } catch { /* Preference persistence is optional. */ }
  }, [language, t.name]);

  function updatePose(key, value) {
    if (!ready || physics || walkingSession) return;
    const next = { ...pose, [key]: value };
    try { engine.current.setPose(next); setPose(next); setSteps(previous => ({ ...previous, posed: true, saved: false })); setNotice(""); }
    catch (err) { setError(friendlyError(err)); }
  }
  function paint(value) {
    if (!ready) return;
    try { engine.current.setColor(value); setColor(value); setSteps(previous => ({ ...previous, saved: false })); }
    catch (err) { setError(friendlyError(err)); }
  }
  async function exploreTrail() {
    if (!ready || !walkingEligible) return;
    setWalkingBusy(true); setError(""); setNotice("");
    try { await engine.current.startTrail(false); setState({ ...engine.current.snapshot() }); }
    catch (err) { setError(friendlyError(err)); }
    finally { setWalkingBusy(false); }
  }
  function run(action) {
    if (!ready || (action === "drop" && walkingSession)) return;
    try {
      engine.current[action](); setError(""); setNotice("");
      if (action === "drop") setSteps(previous => ({ ...previous, dropped: true, saved: false }));
      if (action === "reset") { engine.current.setPose({ crouch: 0, wave: 0 }); setPose({ crouch: 0, wave: 0 }); }
      setState({ ...engine.current.snapshot() });
    } catch (err) { setError(friendlyError(err)); }
  }
  function saveRemix() {
    if (!ready || !currentRecipe) return;
    try {
      const id = `remix-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`}`;
      const entry = { id, parentId, createdAt: new Date().toISOString(), recipe: normalizeRecipe(currentRecipe) };
      const next = [entry, ...remixes].slice(0, 24);
      localStorage.setItem(STORAGE, JSON.stringify(next));
      setRemixes(next); setParentId(id); setSteps(previous => ({ ...previous, saved: true })); setNotice("savedDone"); setError("");
    } catch { setError("badStorage"); }
  }
  async function share() {
    if (!ready || !currentRecipe) return;
    const url = new URL(location.href); url.hash = `recipe=${encodeURIComponent(JSON.stringify(normalizeRecipe(currentRecipe)))}`;
    try { await navigator.clipboard.writeText(url.href); setNotice("shareDone"); setShareFallback(""); }
    catch { setShareFallback(url.href); setNotice("copiedFallback"); }
  }
  function exportRecipe() {
    if (!ready || !currentRecipe) return;
    const blob = new Blob([JSON.stringify(normalizeRecipe(currentRecipe), null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `draft-${currentRecipe.preset}-recipe.json`; document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("exportDone");
  }
  async function importRecipe(event) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    if (file.size > 8192) { setError("fileError"); return; }
    try { const recipe = parseRecipe(await file.text()); await loadRecipe(recipe); }
    catch (err) { setError(friendlyError(err)); }
  }

  const catalogSummary = catalog && {
    presets: (Array.isArray(catalog.presets) ? catalog.presets : []).map(item => typeof item === "string" ? item : { id: item.id, name: typeof item.name === "string" ? item.name : item.name?.en || item.id }),
    provenance: catalog.provenance,
  };
  const evidence = JSON.stringify({ engine: state, recipe: currentRecipe, manifest: manifest && { id: manifest.id, preset: manifest.preset, xmlUrl: manifest.xmlUrl, meshUrl: manifest.meshUrl, parameters: manifest.parameters, resolvedParameters: manifest.resolvedParameters, warnings: manifest.warnings, assetSha256: manifest.assetSha256, provenance: manifest.provenance, massKg: manifest.massKg }, catalog: catalogSummary, error: error || null }, null, 2);
  const displayedError = error || state.error || (state.ready && state.finite === false ? "finiteError" : "");
  const visionStatus = state.vision?.phase === "thinking" ? "Looking through the robot camera · Physics paused" : state.vision?.phase === "moving" ? "Trying a visual instruction · Use the stick to take over" : null;
  const status = walkingBusy ? t.walkingLoading : busy ? (engine.current ? t.loadingModel : t.loading) : displayedError ? (t[displayedError] || String(displayedError)) : visionStatus || (walkingSession ? (state.walking?.active ? t.walkingNotice : t.walkPaused) : physics ? (state.physicsComplete ? t.gravityComplete : t.gravityNotice) : notice ? (t[notice] || notice) : t.ready);
  const entryName = entry => `${t[entry.recipe.preset]} ${t.remix} · ${entry.id.slice(-4).toUpperCase()}`;

  return (
    <main className={`draft-app${walkingSession ? " is-walking-view" : ""}`}>
      <header className="draft-topbar">
        <div className="draft-brand"><span className="draft-brand-icon"><Icon kind="sparkle" /></span><div><span className="draft-eyebrow">{t.brand}</span><h1>{t.name}</h1></div></div>
        <p className="draft-tagline">{t.intro}</p>
        <div className="draft-top-actions"><button className="draft-share" disabled={!ready} onClick={share} title={t.shareScope}><Icon kind="share" /><span>{t.share}</span></button></div>
      </header>

      <div className="draft-workspace">
        <aside className="draft-inspector" aria-label={t.shapeTitle}>
          <section className="draft-control-section">
            <h2>{t.presetTitle}</h2>
            <div className="draft-presets">{PRESETS.map(preset => <button key={preset} className={`draft-preset${form.preset === preset ? " is-selected" : ""}${preset === "flower" ? " is-flower" : ""}`} aria-pressed={form.preset === preset} disabled={working || !engine.current} onClick={() => { const next = { ...DEFAULT, preset, color }; setForm(next); loadRecipe(next); }}><Creature preset={preset} /><strong>{t[preset]}</strong><span>{t[`${preset}Desc`]}</span></button>)}</div>
          </section>

          <section className="draft-control-section draft-shape">
            <h2>{t.shapeTitle}</h2>
            {[{ key: "lengthScale", label: isFlower ? t.flowerTorso : t.torso }, { key: "legScale", label: t.legs }].map(({ key, label }) => <div className="draft-slider" key={key}><label htmlFor={`draft-${key}`}>{label}<output>{form[key].toFixed(2)}×</output></label><input id={`draft-${key}`} type="range" min="0.8" max="1.2" step="0.01" value={form[key]} disabled={!ready} onChange={event => setForm(previous => ({ ...previous, [key]: Number(event.target.value) }))} /><div className="draft-range-labels"><span>{t.shorter}</span><span>{t.longer}</span></div></div>)}
            <button className="draft-generate" disabled={working || !engine.current} onClick={() => loadRecipe({ ...form, color, pose }, parentId)}><Icon kind="sparkle" />{busy ? t.generating : t.generate}</button>
            <p className={`draft-shape-note${dirty ? " is-dirty" : ""}`}>{dirty ? t.changed : activeRecipe?.lengthScale === 1 && activeRecipe?.legScale === 1 ? t.original : t.generated}</p>
          </section>

          <section className="draft-control-section draft-paint"><div className="draft-label-row"><h2>{t.paint}</h2><span>{t.paintNote}</span></div><div className="draft-swatches">{COLORS.map(value => <button key={value} style={{ "--swatch": value }} className={color === value ? "is-selected" : ""} disabled={!ready} onClick={() => paint(value)} aria-label={`${t.paint} ${value}`} aria-pressed={color === value}>{color === value ? "✓" : ""}</button>)}<label className="draft-custom-color" title={t.paint}><input type="color" aria-label={t.paint} value={color} disabled={!ready} onChange={event => paint(event.target.value)} /><span aria-hidden="true">＋</span></label></div></section>

          <section className="draft-control-section draft-pose"><h2>{t.poseTitle}</h2>{[{ key: "crouch", label: t.crouch }, { key: "wave", label: isFlower ? t.flowerPose : t.wave }].map(({ key, label }) => <div className="draft-slider" key={key}><label htmlFor={`draft-${key}`}>{label}<output>{Math.round(pose[key] * 100)}%</output></label><input id={`draft-${key}`} type="range" min="0" max="1" step="0.01" value={pose[key]} disabled={!ready || physics || walkingSession} onChange={event => updatePose(key, Number(event.target.value))} /></div>)}{(physics || walkingSession) && <p className="draft-small-note">{walkingSession ? t.walkPoseNote : t.poseReset}</p>}</section>

          <div className="draft-file-actions"><button disabled={!ready} onClick={exportRecipe}><Icon kind="download" />{t.export}</button><button disabled={working || !engine.current} onClick={() => fileInput.current?.click()}><Icon kind="upload" />{t.import}</button><input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={importRecipe} /></div>
          <details className="draft-evidence"><summary>{t.evidence}<span>＋</span></summary><p>{t.dataHint}</p><textarea aria-label="Lab evidence" readOnly spellCheck={false} value={evidence} /></details>
        </aside>

        <section className="draft-main">
          <section className="draft-stage-shell" aria-label={t.name}>
            <div className="draft-stage" ref={stage} />
            <div className="draft-stage-top"><div><span className="draft-stage-kicker">{walkingSession ? t.walkMode : physics ? t.physicsMode : isFlower ? t.flowerSource : t.poseMode}</span><h2>{t[activeRecipe?.preset || form.preset]}<span className="draft-status-dot" /></h2></div><button className="draft-camera" disabled={!ready} onClick={() => run("home")} aria-label={t.home} title={t.home}><Icon kind="home" /></button></div>
            <p className="draft-orbit-hint">{t.orbit}</p>
            {!walkingSession && walkingEligible && <button className="draft-explore" disabled={!ready} onClick={exploreTrail}><Icon kind="sparkle" />{t.explore}<span aria-hidden="true">↗</span></button>}
            <div className={`draft-stage-message${displayedError ? " is-error" : ""}`} role="status" aria-live="polite">{working && <span className="draft-spinner" aria-hidden="true" />}{status}</div>
            {shareFallback && <div className="draft-share-fallback"><label htmlFor="draft-share-url">{t.recipeLink} · {t.shareScope}</label><input id="draft-share-url" readOnly value={shareFallback} onFocus={event => event.target.select()} /><button onClick={() => setShareFallback("")} aria-label={t.close}>×</button></div>}
            <div className="draft-stage-bottom"><p className="draft-policy-note"><span aria-hidden="true">○</span>{walkingSession ? (isFlower ? "Locally trained custom Flower" : t.walkBadge) : t.mode}</p><div className="draft-stage-actions"><button className="draft-reset" disabled={!ready} onClick={() => run("reset")}><Icon kind="reset" />{walkingSession ? t.returnPose : t.reset}</button><button className="draft-drop" disabled={!ready || walkingSession} onClick={() => run("drop")}><Icon kind="drop" />{physics ? t.dropAgain : t.drop}</button><button className="draft-save" disabled={!ready} onClick={saveRemix}><Icon kind="save" />{t.save}</button></div></div>
          </section>

          <WalkControls body={activeRecipe?.preset ?? form.preset} flowerTrained={flowerStatus?.browserReady===true} language={language} lab={engine.current} walking={state.walking} visionActive={state.vision?.active===true} eligible={walkingEligible} disabled={!ready} paused={state.mode === "walk-paused"} onRestore={() => loadRecipe({ ...DEFAULT, preset:isFlower&&flowerStatus?.browserReady?'flower':'cheetah', color })} onBusyChange={setWalkingBusy} onRefresh={() => { if (engine.current) setState({ ...engine.current.snapshot() }); setError(""); setNotice(""); }} />

          <VisionCard engine={engine.current} language={language} eligible={walkingEligible} disabled={!ready} walking={state.walking} vision={state.vision} />

          <section className="draft-challenge" aria-label={t.challenge}><div><span className="draft-eyebrow">{t.challenge}</span><strong>{t.challengeHint}</strong></div><ol>{["taller", "posed", "dropped", "saved"].map((key, index) => <li key={key} className={steps[key] ? "is-done" : ""}><span>{steps[key] ? "✓" : index + 1}</span>{t[key]}</li>)}</ol></section>

          <section className="draft-library" aria-label={t.library}><div className="draft-library-heading"><h2>{t.library}<span>{remixes.length}</span></h2><p>{t.local}</p></div>{remixes.length ? <div className="draft-remix-list">{remixes.map(entry => { const parent = remixes.find(item => item.id === entry.parentId); return <article key={entry.id} className={`draft-remix${parentId === entry.id ? " is-current" : ""}`}><button className="draft-remix-open" disabled={working} onClick={() => loadRecipe(entry.recipe, entry.id)} aria-label={`${t.open} ${entryName(entry)}`}><span className="draft-remix-art" style={{ "--creature-color": entry.recipe.color }}><Creature preset={entry.recipe.preset} color={entry.recipe.color} /></span><span><strong>{entryName(entry)}</strong><small>{entry.recipe.lengthScale.toFixed(2)}× · {entry.recipe.legScale.toFixed(2)}×</small></span></button><p className="draft-parent">{t.parent} {parent ? <button disabled={working} onClick={() => loadRecipe(parent.recipe, parent.id)}>{entryName(parent)}</button> : entry.parentId ? t.missingParent : t.originalParent}</p></article>; })}</div> : <div className="draft-library-empty"><span className="draft-empty-illustration"><Creature preset="giraffe" /></span><div><strong>{t.emptyTitle}</strong><p>{t.emptyHint}</p></div><span className="draft-empty-spark" aria-hidden="true">✳</span></div>}</section>
          {isFlower ? <FlowerCard language={language} onStatus={setFlowerStatus} /> : <TrainingCard language={language} />}
          <footer className="draft-footer">{t.learn}</footer>
        </section>
      </div>
    </main>
  );
}
