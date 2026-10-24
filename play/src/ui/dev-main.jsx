// UI kit harness: every major state of the kit on a fake stage, driven by
// mock data. Open /ui-dev.html?s=<scenario>; add &still=1 for screenshots
// (renders the fake 3D stage once) and &bar=0 to hide the scenario picker.
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/index.css";
import { createFakeStage } from "./dev-stage.js";
import * as M from "./dev-mocks.js";
import {
  AppShell,
  WorkshopLayout,
  LoopStepper,
  NameTag,
  StageToolbar,
  ViewModeSwitch,
  TabDot,
  ChatPanel,
  SpecSheet,
  ShapeTweaks,
  LookPanel,
  TrainingPanel,
  CreatureShelf,
  LabNotes,
  TitleScreen,
  PlayHUD,
  TouchControls,
  ExplorePanel,
  PauseMenu,
  ChallengeBoard,
  StickerBook,
  StickerPop,
  Modal,
  Toasts,
  useToasts,
  SettingsPanel,
  Badge,
  ProgressRing,
  IconButton,
  Icon,
  useLayoutSize,
} from "./index.js";
import { Kit } from "./dev-kit.jsx";

const params = new URLSearchParams(location.search);
const STILL = params.get("still") === "1";
const SHOW_BAR = params.get("bar") !== "0" && !STILL;

const STEPS = {
  imagine: { imagine: "current", draft: "todo", dress: "todo", train: "todo", play: "locked" },
  draft: { imagine: "done", draft: "current", dress: "todo", train: "todo", play: "locked" },
  dress: { imagine: "done", draft: "done", dress: "current", train: "todo", play: "locked" },
  train: { imagine: "done", draft: "done", dress: "done", train: "current", play: "locked" },
  play: { imagine: "done", draft: "done", dress: "done", train: "done", play: "current" },
};

const T = M.TRAINING_STATES;
const base = { mode: "workshop", provider: M.PROVIDER_LOCAL, design: M.DESIGN_HOPPER, body: M.BODY_HOPPER, training: T.untrained, steps: STEPS.draft, messages: M.CHAT_BUILT, suggestions: M.SUGGESTIONS.built, tab: "blueprint" };

export const SCENARIOS = {
  title: { ...base, label: "Title screen", title: true, body: null, messages: M.CHAT_IMAGINE.slice(0, 1), steps: STEPS.imagine },
  "ws-chat": { ...base, label: "Workshop: imagine with Tinker", body: null, messages: M.CHAT_IMAGINE, suggestions: M.SUGGESTIONS.imagine, steps: STEPS.imagine, drafted: true, phoneTab: "chat" },
  "ws-building": { ...base, label: "Workshop: Draft is building", body: null, messages: [...M.CHAT_IMAGINE.slice(0, 4), { ...M.CHAT_IMAGINE[4], designStatus: "building" }], suggestions: [], steps: STEPS.draft, drafted: true, building: true, phoneTab: "blueprint", busy: false },
  "ws-blueprint": { ...base, label: "Workshop: blueprint spec sheet", drafted: true, phoneTab: "blueprint", toast: { tone: "good", title: "Hopper passed Draft's check", text: "12 joints, 6.4 kg. Ready to teach." } },
  "ws-tweaks": { ...base, label: "Workshop: shape tweaks", drafted: true, tweaks: true, phoneTab: "blueprint" },
  "ws-multileg": { ...base, label: "Workshop: six-leg blueprint", design: M.DESIGN_PETAL, body: M.BODY_PETAL, look: M.lookById("candy"), training: { walk: { state: "untrained", estimateMinutes: 9 } }, phoneTab: "blueprint" },
  "ws-problem": { ...base, label: "Workshop: feasibility problem", body: null, design: M.DESIGN_MOOSE, messages: M.CHAT_PROBLEM, suggestions: M.SUGGESTIONS.problem, provider: M.PROVIDER_OFFLINE, mood: "worried", drafted: true, phoneTab: "chat" },
  "ws-look": { ...base, label: "Workshop: dress up", tab: "look", steps: STEPS.dress, messages: M.CHAT_LOOK, suggestions: ["Shinier", "Add a crown", "Back to frog"], look: M.lookById("ladybug"), presetId: "ladybug", phoneTab: "look" },
  "ws-training": { ...base, label: "Workshop: training live", tab: "train", steps: STEPS.train, training: T.training, messages: M.CHAT_STREAMING, look: M.lookById("ladybug"), phoneTab: "train" },
  "ws-validating": { ...base, label: "Workshop: validating", tab: "train", steps: STEPS.train, training: T.validating, look: M.lookById("ladybug"), phoneTab: "train" },
  "ws-ready": { ...base, label: "Workshop: skills verified", tab: "train", steps: STEPS.play, training: T.ready, look: M.lookById("ladybug"), messages: [...M.CHAT_BUILT, { id: "pl", role: "tinker", kind: "play", creatureName: "Hopper", skills: ["walk", "jump"] }], suggestions: ["Go play", "Make it faster", "New creature"], phoneTab: "train" },
  "ws-failed": { ...base, label: "Workshop: training failed", tab: "train", steps: STEPS.train, training: T.failed, look: M.lookById("ladybug"), phoneTab: "train" },
  "ws-notes": { ...base, label: "Workshop: lab notes drawer", training: T.ready, steps: STEPS.play, modal: "notes", look: M.lookById("ladybug") },
  "ws-shelf": { ...base, label: "Workshop: shelf (phone tab)", training: T.ready, steps: STEPS.play, look: M.lookById("ladybug"), phoneTab: "shelf" },
  settings: { ...base, label: "Settings", modal: "settings", training: T.ready, steps: STEPS.play },
  "pg-hud": { ...base, label: "Playground: HUD", mode: "playground", training: T.ready, look: M.lookById("ladybug"), toast: { tone: "spark", title: "+1 spark", text: "12 of 40 found" } },
  "pg-explore": { ...base, label: "Playground: AI Explore", mode: "playground", training: T.ready, look: M.lookById("ladybug"), explore: "moving" },
  "pg-pause": { ...base, label: "Playground: pause menu", mode: "playground", training: T.ready, look: M.lookById("ladybug"), modal: "pause" },
  "pg-challenges": { ...base, label: "Playground: challenges", mode: "playground", training: T.ready, look: M.lookById("ladybug"), modal: "challenges" },
  "pg-stickers": { ...base, label: "Playground: sticker book", mode: "playground", training: T.ready, look: M.lookById("ladybug"), modal: "stickers" },
  "pg-pop": { ...base, label: "Playground: new sticker", mode: "playground", training: T.ready, look: M.lookById("ladybug"), pop: true },
  "pg-locked": { ...base, label: "Playground: jump locked, fall", mode: "playground", training: { walk: T.ready.walk, jump: { state: "untrained" } }, look: M.lookById("frog"), fall: true },
  kit: { label: "Kit: identity and primitives", kit: true },
};

function useFakeStage(kind, design, look) {
  const ref = useRef(null);
  const stage = useRef(null);
  useEffect(() => {
    if (!ref.current) return undefined;
    stage.current = createFakeStage(ref.current, { kind, design, look, still: STILL });
    return () => stage.current?.dispose();
    // Created once; later changes go through setKind / setCreature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => stage.current?.setKind(kind), [kind]);
  useEffect(() => stage.current?.setCreature(design, look), [design, look]);
  return ref;
}

function Harness({ id }) {
  const sc = SCENARIOS[id] || SCENARIOS["ws-chat"];
  const size = useLayoutSize();
  const [mode, setMode] = useState(sc.mode);
  const [tab, setTab] = useState(size === "phone" ? sc.phoneTab || sc.tab : sc.tab);
  const [messages, setMessages] = useState(sc.messages || []);
  const [view, setView] = useState("normal");
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(!!sc.busy);
  const [modal, setModal] = useState(sc.modal || null);
  const [titleOpen, setTitleOpen] = useState(!!sc.title);
  const [look, setLook] = useState(sc.look || sc.design.look);
  const [presetId, setPresetId] = useState(sc.presetId || "frog");
  const [draft, setDraft] = useState(() => (sc.tweaks ? { ...sc.design, quadruped: { ...sc.design.quadruped, upperLeg: 0.26, lowerLeg: 0.29, strength: 1.3 } } : sc.design));
  const [pose, setPose] = useState({ crouch: 0.2, wave: 0 });
  const [exploreText, setExploreText] = useState("Go to the red ball");
  const [exploreOpen, setExploreOpen] = useState(!!sc.explore);
  const [pop, setPop] = useState(sc.pop ? M.STICKERS[4] : null);
  const [quality, setQuality] = useState("high");
  const [motion, setMotion] = useState("auto");
  const [controls, setControls] = useState("stick");
  const [activeChallenge, setActiveChallenge] = useState("ramp-run");
  const { toasts, push, dismiss } = useToasts();
  const design = sc.design;
  const stageRef = useFakeStage(mode, design, look);
  const body = sc.body;
  const training = sc.training || {};
  const walk = training.walk?.state;
  const jump = training.jump?.state;

  useEffect(() => {
    if (sc.toast) push({ ...sc.toast, id: "scenario-toast", duration: STILL ? 0 : 5000 });
  }, [sc.toast, push]);

  function send(text) {
    setMessages(list => [...list, { id: `u${Date.now()}`, role: "user", kind: "text", text }]);
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      setMessages(list => [...list, { id: `t${Date.now()}`, role: "tinker", kind: "text", text: "Got it! (Harness reply: the real one comes from ai-service /chat.)" }]);
    }, 1200);
  }

  const creature = { name: design.name, design, look, skills: { walk: walk === "ready" ? "ready" : walk, jump: jump === "ready" ? "ready" : jump || "untrained" } };
  const spec = (
    <SpecSheet
      body={body}
      design={design}
      loading={!!sc.building}
      policies={training}
      onTrain={() => setTab("train")}
      onOpenLabNotes={() => setModal("notes")}
      onTweak={() => {}}
    />
  );
  const tabs = [
    {
      id: "blueprint",
      label: "Blueprint",
      icon: "blueprint",
      content: sc.tweaks ? (
        <div style={{ display: "grid", gap: 12 }}>
          <ShapeTweaks value={draft} original={design} onChange={setDraft} onReset={() => setDraft(design)} onRebuild={() => push({ tone: "info", title: "Drafting a new body", text: "Harness only" })} pose={pose} onPoseChange={setPose} poseNote="Pose and drop tests use motors off; skills aren't involved." onDrop={() => {}} />
          {spec}
        </div>
      ) : (
        spec
      ),
    },
    {
      id: "look",
      label: "Look",
      icon: "palette",
      content: (
        <LookPanel
          look={look}
          onChange={next => {
            setLook(next);
            setPresetId(null);
          }}
          presets={M.LOOK_PRESETS}
          presetId={presetId}
          onPreset={(pid, l) => {
            setPresetId(pid);
            setLook(l);
          }}
          design={design}
          onExportPrintKit={() => push({ tone: "good", title: "Print kit ready", text: "hopper-shell.zip (harness)" })}
          onAskTinker={send}
        />
      ),
    },
    {
      id: "train",
      label: "Train",
      icon: "train",
      badge: walk === "training" ? <ProgressRing value={0.52} size={20} stroke={3.5} label="Training 52%" /> : walk === "ready" ? <TabDot tone="good" label="Skills verified" /> : walk === "failed" ? <TabDot tone="bad" label="Needs attention" /> : null,
      content: <TrainingPanel creatureName={design.name} skills={training} onTrain={() => {}} onStop={() => {}} onPlay={() => setMode("playground")} onAskTinker={send} />,
    },
  ];

  const nameBadges =
    walk === "ready" ? (
      <>
        <Badge tone="good" icon="check">
          Walks
        </Badge>
        {jump === "ready" && (
          <Badge tone="good" icon="check">
            Jumps
          </Badge>
        )}
      </>
    ) : walk === "training" || walk === "validating" ? (
      <Badge tone="info" icon="train">
        Learning to walk
      </Badge>
    ) : sc.building ? (
      <Badge tone="info" icon="blueprint">
        Drafting
      </Badge>
    ) : body ? (
      <Badge tone="warn" icon="alert">
        Untrained
      </Badge>
    ) : (
      <Badge tone="outline" icon="blueprint">
        Not built yet
      </Badge>
    );

  const phone = size === "phone";
  const exploreState = sc.explore || "idle";

  return (
    <AppShell
      mode={mode}
      onModeChange={setMode}
      playgroundLocked={walk !== "ready"}
      playgroundHint="Teach it to walk first. The playground needs a verified walking skill."
      stage={<div ref={stageRef} />}
      muted={muted}
      onToggleMute={() => setMuted(m => !m)}
      onOpenSettings={() => setModal("settings")}
      motion={motion}
      topActions={mode === "playground" ? <IconButton icon="pause" label="Pause" onClick={() => setModal("pause")} /> : null}
      toasts={<Toasts toasts={toasts} onDismiss={dismiss} placement={mode === "playground" ? "hud" : "top"} />}
      titleScreen={
        titleOpen ? (
          <TitleScreen
            onStart={() => setTitleOpen(false)}
            onStarter={() => setTitleOpen(false)}
            starters={M.SHELF.starters.map(s => ({ ...s, design: s.design }))}
            hero={{ design: "cheetah", look: "#1f8c80" }}
          />
        ) : null
      }
      modals={
        <>
          <Modal open={modal === "settings"} onClose={() => setModal(null)} title="Settings" icon="settings" size="lg" placement={phone ? "bottom" : "center"}>
            <SettingsPanel health={M.HEALTH_MIXED} onRefreshHealth={() => {}} muted={muted} onMutedChange={setMuted} quality={quality} onQualityChange={setQuality} motion={motion} onMotionChange={setMotion} controls={controls} onControlsChange={setControls} />
          </Modal>
          <Modal open={modal === "notes"} onClose={() => setModal(null)} title="Lab notes" icon="note" description="Where every number on this creature comes from" placement={phone ? "bottom" : "right"}>
            <LabNotes body={body} look={look} policies={{ walk: { ...training.walk, manifest: { policySha256: "a91f03c2be7d5e44f1c0b8d2a6e9f7c4d1b5a3e8f2c7d9b0a4e6f1c3d5b7a9e2", sceneSha256: "5c1e9a7b3d2f4e6a8c0b1d3f5e7a9c2b4d6f8e0a1c3b5d7f9e2a4c6b8d0f1e3a", training: { algorithm: "PPO", envSteps: 5000000, wallSeconds: 1162, machine: "Apple M2, 8 CPU cores", seed: 0, mujocoVersion: "3.11.0" }, honesty: training.walk?.honesty } }, jump: training.jump }} />
          </Modal>
          <PauseMenu
            open={modal === "pause"}
            onResume={() => setModal(null)}
            onRestart={() => setModal(null)}
            onChallenges={() => setModal("challenges")}
            onStickers={() => setModal("stickers")}
            onSettings={() => setModal("settings")}
            onWorkshop={() => {
              setModal(null);
              setMode("workshop");
            }}
            creature={creature}
            stats={{ sparks: M.PLAY_SNAPSHOT.sparks, stickers: { got: 4, total: M.STICKERS.length }, challenges: { done: 2, total: M.CHALLENGES.length } }}
          />
          <Modal open={modal === "challenges"} onClose={() => setModal(null)} title="Challenges" icon="flag" size="lg" placement={phone ? "bottom" : "center"}>
            <ChallengeBoard challenges={M.CHALLENGES} activeId={activeChallenge} onSelect={setActiveChallenge} onUnlock={() => setModal(null)} stickers={M.STICKERS} />
          </Modal>
          <Modal open={modal === "stickers"} onClose={() => setModal(null)} title="Sticker book" icon="sticker" size="lg" placement={phone ? "bottom" : "center"}>
            <StickerBook stickers={M.STICKERS} newId="spark-hunt" />
          </Modal>
        </>
      }
    >
      {mode === "workshop" ? (
        <WorkshopLayout
          chat={<ChatPanel messages={messages} suggestions={sc.suggestions} provider={sc.provider} busy={busy} mood={sc.mood} onSend={send} onAction={() => {}} onStop={() => {}} />}
          tabs={tabs}
          activeTab={tab}
          onTabChange={setTab}
          stepper={<LoopStepper status={sc.steps} onStep={step => setTab(step === "dress" ? "look" : step === "train" ? "train" : "blueprint")} compact={phone} />}
          nameTag={<NameTag name={design.name} drafted={!!sc.drafted} badges={nameBadges} />}
          stageTools={
            phone ? (
              <StageToolbar
                actions={[
                  { id: "view", label: "Blueprint", icon: "blueprint", pressed: view === "blueprint", onClick: () => setView(v => (v === "blueprint" ? "normal" : "blueprint")) },
                  { id: "drop", label: "Drop test", icon: "download" },
                  { id: "reset", label: "Reset", icon: "undo" },
                  { id: "save", label: "Save", icon: "box", primary: true },
                ]}
              />
            ) : (
              <>
                <StageToolbar
                  actions={[
                    { id: "home", label: "Center", icon: "home", hint: "Center the camera" },
                    { id: "drop", label: "Drop test", icon: "download", hint: "Motors off: see how gravity takes it" },
                    { id: "reset", label: "Reset", icon: "undo", hint: "Back to the standing pose" },
                    { id: "save", label: "Save", icon: "box", primary: true, hint: "Save to your shelf", onClick: () => push({ tone: "good", title: "Saved to your shelf", text: "Hopper stays in this browser.", action: { label: "Undo" } }) },
                  ]}
                />
                <ViewModeSwitch value={view} onChange={setView} />
              </>
            )
          }
          shelf={<CreatureShelf starters={M.SHELF.starters} mine={M.SHELF.mine} currentId="hopper" onOpen={() => {}} onRemix={() => {}} onDelete={() => {}} onNew={() => {}} onImport={() => {}} defaultTab="mine" layout={phone ? "grid" : "row"} />}
          phoneStatus={<span className="cl-hint">Tap a tab to open it.</span>}
        />
      ) : (
        <PlayHUD
          creature={creature}
          snapshot={{ ...M.PLAY_SNAPSHOT, robot: { ...M.PLAY_SNAPSHOT.robot, fall: !!sc.fall }, challenge: { ...M.PLAY_SNAPSHOT.challenge } }}
          onJump={() => {}}
          canJump={jump === "ready"}
          onExplore={() => setExploreOpen(o => !o)}
          exploreOpen={exploreOpen}
          explorePanel={
            <ExplorePanel
              state={exploreState}
              instruction={exploreText}
              onInstructionChange={setExploreText}
              landmarks={M.LANDMARKS}
              onStart={() => {}}
              onStop={() => {}}
              onClose={() => setExploreOpen(false)}
              steps={exploreState === "moving" ? { done: 3, max: 12 } : undefined}
              lastDecision={exploreState === "moving" ? { action: "turn_left", reason: "The red ball is ahead and a little to the left." } : undefined}
              eyes={{ model: "qwen2.5vl:7b", kind: "local" }}
            />
          }
          cameraMode="chase"
          onCamera={() => {}}
          onOpenChallenges={() => setModal("challenges")}
          onOpenStickers={() => setModal("stickers")}
          stickerCount={4}
          onReset={() => {}}
          touchControls={
            <TouchControls
              variant={controls}
              onCommand={() => {}}
              onJump={() => {}}
              canJump={jump === "ready"}
              extra={
                <button type="button" className="cl-roundbtn" aria-label="AI Explore" aria-pressed={exploreOpen} onClick={() => setExploreOpen(o => !o)}>
                  <Icon name="eye" size={26} />
                </button>
              }
            />
          }
          stickerPop={pop ? <StickerPop sticker={pop} onDone={() => (STILL ? null : setPop(null))} duration={STILL ? 999999 : 2800} onOpenBook={() => setModal("stickers")} /> : null}
        />
      )}
    </AppShell>
  );
}

function DevBar({ id }) {
  return (
    <nav className="cl-devbar" aria-label="Harness scenarios">
      <label>
        Scenario{" "}
        <select value={id} onChange={event => (location.search = `?s=${event.target.value}`)}>
          {Object.entries(SCENARIOS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}

function Root() {
  const id = params.get("s") || "title";
  const sc = SCENARIOS[id];
  const content = useMemo(() => (sc?.kit ? <Kit /> : <Harness id={id} />), [id, sc]);
  return (
    <>
      {content}
      {SHOW_BAR && <DevBar id={id} />}
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
