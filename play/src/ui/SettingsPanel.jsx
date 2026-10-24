// SettingsPanel: AI helpers (from ai-service GET /health), how to set them
// up, sound, graphics, motion and controls. Keys are never shown or entered
// here: ai-service reads them from the environment or a git-ignored file.
import { Icon } from "./icons.jsx";
import { Badge, Button, CopyButton, Keycap, Segmented, Slider, Switch, cx } from "./primitives.jsx";

const ROLE_COPY = {
  brain: { title: "Tinker's brain", what: "Chats with you and proposes designs and looks." },
  eyes: { title: "Tinker's eyes", what: "Looks through the robot's camera for AI Explore." },
};

/** Normalise one role from /health (defensive: fields may be missing). */
export function roleStatus(role) {
  const r = role && typeof role === "object" ? role : {};
  const kind = r.kind === "local" || r.kind === "cloud" ? r.kind : r.configured ? (r.provider === "ollama" || r.provider === "lmstudio" ? "local" : "cloud") : "none";
  const state = !r.configured ? "unset" : r.reachable === false ? "unreachable" : "ready";
  return { kind, state, model: r.model || null, provider: r.provider || null, error: r.error || null };
}

function RoleCard({ id, role, offline }) {
  const copy = ROLE_COPY[id];
  const s = roleStatus(role);
  const fallback = id === "brain" ? "Uses the built-in offline designer: simpler ideas, still real Draft bodies." : "AI Explore stays off. You can still drive with the joystick or keys.";
  return (
    <article className={cx("cl-role", `is-${s.state}`)}>
      <div className="cl-role__head">
        <span className="cl-role__icon" aria-hidden="true">
          <Icon name={id === "brain" ? "chat" : "eye"} />
        </span>
        <div className="cl-role__titles">
          <h4>{copy.title}</h4>
          <span className="cl-hint">{copy.what}</span>
        </div>
        {s.state === "ready" ? (
          <Badge tone="good" icon="check">
            Ready
          </Badge>
        ) : s.state === "unreachable" ? (
          <Badge tone="bad" icon="alert">
            Can't reach
          </Badge>
        ) : (
          <Badge tone="outline" icon="offline">
            Not set up
          </Badge>
        )}
      </div>
      <dl className="cl-role__facts">
        <div>
          <dt>Where</dt>
          <dd>{s.state === "unset" || offline ? "Nowhere yet" : s.kind === "local" ? "On this computer" : "Cloud service"}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="cl-mono">{s.model || "None"}</dd>
        </div>
      </dl>
      {s.state !== "ready" && <p className="cl-hint">{s.state === "unreachable" ? `Configured but not answering${s.error ? `: ${s.error}` : ""}. Is the model server running?` : fallback}</p>}
    </article>
  );
}

// Bindings live in the world engine; pass its real keymap. These defaults
// only list what the v1 lab already supported plus pause.
export const DEFAULT_KEYMAP = [
  { keys: ["W", "A", "S", "D"], or: "or arrows", label: "Move and turn" },
  { keys: ["Space"], label: "Jump, once learned" },
  { keys: ["Esc"], label: "Pause" },
];

function CommandLine({ command, label }) {
  return (
    <div className="cl-cmd">
      <code className="cl-mono">{command}</code>
      <CopyButton text={command} label={label || "Copy command"} />
    </div>
  );
}

/**
 * SettingsPanel props:
 *  health: GET /health payload ({ offline, roles: { brain, eyes } }); checking; onRefreshHealth()
 *  setup: optional overrides { localScript, configFile, envFile, envVars: [names] }
 *  muted, onMutedChange, volume (0..1), onVolumeChange
 *  quality: "high" | "low", onQualityChange
 *  motion: "auto" | "reduce" | "full", onMotionChange
 *  controls: "stick" | "buttons", onControlsChange
 *  keymap: [{ keys: ["W"], or?, label }] from the world engine; gamepadNote
 */
export function SettingsPanel({
  health,
  checking = false,
  onRefreshHealth,
  setup = {},
  muted = false,
  onMutedChange,
  volume = 0.8,
  onVolumeChange,
  quality = "high",
  onQualityChange,
  motion = "auto",
  onMotionChange,
  controls = "stick",
  onControlsChange,
  keymap = DEFAULT_KEYMAP,
  gamepadNote = "Gamepads work too.",
}) {
  const roles = health?.roles || {};
  const offline = !!health?.offline;
  const script = setup.localScript || "./scripts/setup-local-ai.sh";
  const envFile = setup.envFile || "ai-service/.env.local";
  const configFile = setup.configFile || "ai-service/config.json";
  return (
    <div className="cl-settings">
      <section className="cl-settings__section" aria-labelledby="cl-set-ai">
        <div className="cl-settings__head">
          <h3 id="cl-set-ai" className="cl-section-title">
            <Icon name="sparkle" />
            AI helpers
          </h3>
          {onRefreshHealth && (
            <Button size="sm" variant="ghost" icon="retry" busy={checking} disabled={checking} onClick={onRefreshHealth}>
              Check again
            </Button>
          )}
        </div>
        {!health && !checking && (
          <p className="cl-hint" role="status">
            The AI service isn't answering. Start the lab with ./start.sh to use Tinker and AI Explore.
          </p>
        )}
        <div className="cl-roles">
          <RoleCard id="brain" role={roles.brain} offline={offline} />
          <RoleCard id="eyes" role={roles.eyes} offline={offline} />
        </div>

        <details className="cl-setup">
          <summary>
            <Icon name="laptop" />
            Run models on this Mac
          </summary>
          <div className="cl-setup__body">
            <p>Installs Ollama and picks a chat model and a vision model that fit your Mac's memory. Everything stays on your computer.</p>
            <CommandLine command={script} label="Copy setup command" />
            <p className="cl-hint">Then restart the lab and press Check again.</p>
          </div>
        </details>
        <details className="cl-setup">
          <summary>
            <Icon name="cloud" />
            Use a cloud model
          </summary>
          <div className="cl-setup__body">
            <p>
              Put your API key in <code className="cl-mono">{envFile}</code> (git-ignored) or an environment variable, and choose the provider in <code className="cl-mono">{configFile}</code>. Supported: Qwen (DashScope), Zhipu GLM, Gemini, OpenAI-compatible services and OpenRouter.
            </p>
            {Array.isArray(setup.envVars) && setup.envVars.length > 0 && (
              <ul className="cl-setup__vars">
                {setup.envVars.map(name => (
                  <li key={name}>
                    <code className="cl-mono">{name}</code>
                  </li>
                ))}
              </ul>
            )}
            <p className="cl-hint">Keys stay in the local AI service. The browser never sees them, and they are never logged.</p>
          </div>
        </details>
        <details className="cl-setup">
          <summary>
            <Icon name="offline" />
            No AI at all
          </summary>
          <div className="cl-setup__body">
            <p>Tinker falls back to a rule-based designer. Draft, training and the playground all work the same; only AI Explore needs a vision model.</p>
          </div>
        </details>
      </section>

      <section className="cl-settings__section" aria-labelledby="cl-set-sound">
        <h3 id="cl-set-sound" className="cl-section-title">
          <Icon name="sound" />
          Sound
        </h3>
        <Switch label="Sound effects" checked={!muted} onChange={on => onMutedChange?.(!on)} />
        <Slider label="Volume" value={volume} min={0} max={1} step={0.05} format={v => `${Math.round(v * 100)}%`} disabled={muted} onChange={onVolumeChange} />
      </section>

      <section className="cl-settings__section" aria-labelledby="cl-set-view">
        <h3 id="cl-set-view" className="cl-section-title">
          <Icon name="cube" />
          Graphics and motion
        </h3>
        <div className="cl-settings__field">
          <span className="cl-tweaks__group-label">Graphics</span>
          <Segmented
            label="Graphics quality"
            value={quality}
            onChange={onQualityChange}
            block
            options={[
              { value: "high", label: "Sharp", hint: "Shadows and full resolution" },
              { value: "low", label: "Smooth", hint: "Faster on older computers" },
            ]}
          />
        </div>
        <div className="cl-settings__field">
          <span className="cl-tweaks__group-label">Motion</span>
          <Segmented
            label="Interface motion"
            value={motion}
            onChange={onMotionChange}
            block
            options={[
              { value: "auto", label: "Like my system" },
              { value: "reduce", label: "Less motion" },
              { value: "full", label: "All of it" },
            ]}
          />
        </div>
      </section>

      <section className="cl-settings__section" aria-labelledby="cl-set-controls">
        <h3 id="cl-set-controls" className="cl-section-title">
          <Icon name="gamepad" />
          Controls
        </h3>
        <div className="cl-settings__field">
          <span className="cl-tweaks__group-label">Touch controls</span>
          <Segmented
            label="Touch controls"
            value={controls}
            onChange={onControlsChange}
            block
            options={[
              { value: "stick", label: "Joystick", icon: "target" },
              { value: "buttons", label: "Arrow buttons", icon: "grid" },
            ]}
          />
        </div>
        <ul className="cl-keys">
          {keymap.map(item => (
            <li key={item.label}>
              <span>
                {item.keys.map(k => (
                  <Keycap key={k}>{k}</Keycap>
                ))}
                {item.or && <span className="cl-keys__or">{item.or}</span>}
              </span>
              {item.label}
            </li>
          ))}
        </ul>
        {gamepadNote && <p className="cl-hint">{gamepadNote}</p>}
      </section>
    </div>
  );
}

export default SettingsPanel;
