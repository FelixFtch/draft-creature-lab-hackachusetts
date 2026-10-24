// Creature Lab UI kit: public entry. Documented in contracts/ui-kit.md.
// Import the stylesheet once from the app: import "../styles/index.css".

export { AppShell, ModeSwitch, StageStatus } from "./AppShell.jsx";
export { TitleScreen } from "./TitleScreen.jsx";
export { WorkshopLayout, LoopStepper, LOOP_STEPS, NameTag, StageToolbar, ViewModeSwitch, TabDot } from "./WorkshopLayout.jsx";

export { ChatPanel, ProviderBadge, ProblemCard, TrainingOfferCard, LookCard, PlayOfferCard } from "./ChatPanel.jsx";
export { DesignCard, ACTUATORS, designFacts } from "./DesignCard.jsx";
export { SpecSheet, BlueprintDrawing, RangeArc } from "./SpecSheet.jsx";
export { LookPanel, LOOK_OPTIONS, TOY_COLORS, lookWithDefaults, optionName } from "./LookPanel.jsx";
export { TrainingPanel, TrainingChart, EvalTable } from "./TrainingPanel.jsx";
export { CreatureShelf } from "./CreatureShelf.jsx";
export { ShapeTweaks, DESIGN_BOUNDS } from "./ShapeTweaks.jsx";
export { LabNotes } from "./LabNotes.jsx";

export { PlayHUD, CreatureBadge, ChallengeTracker, SparkCounter, DEFAULT_HINTS, GAMEPAD_HINTS } from "./PlayHUD.jsx";
export { TouchControls } from "./TouchControls.jsx";
export { ExplorePanel } from "./ExplorePanel.jsx";
export { PauseMenu } from "./PauseMenu.jsx";
export { ChallengeBoard } from "./ChallengeBoard.jsx";
export { StickerBook, Sticker, StickerPop } from "./StickerBook.jsx";

export { RobotRoster, SkillBadges } from "./RobotRoster.jsx";
export { TerrainLab, StructureCard } from "./TerrainLab.jsx";
export { TERRAIN_LANES, TERRAIN_GROUPS, normalizeTrials, normalizeLane, predictCell, cellFor, whyLine, bestAtFromTrials, profileStat } from "./terrain.js";

export { Modal } from "./Modal.jsx";
export { Toasts, useToasts } from "./Toasts.jsx";
export { SettingsPanel, roleStatus, DEFAULT_KEYMAP } from "./SettingsPanel.jsx";

export { Button, IconButton, Badge, Chip, Segmented, Slider, Switch, Keycap, Tabs, tabPanelProps, ProgressRing, Meter, Callout, Swatch, CopyButton, inkFor } from "./primitives.jsx";
export { Icon, ICON_NAMES } from "./icons.jsx";
export { Logo, LogoGlyph } from "./Logo.jsx";
export { Tinker } from "./Tinker.jsx";
export { CreatureGlyph, normalizeShape, lookForGlyph, PRESET_SHAPES, describePlan } from "./CreatureGlyph.jsx";
export { useMediaQuery, useLayoutSize, useReducedMotion, useCoarsePointer } from "./hooks.js";
export * as format from "./format.js";
