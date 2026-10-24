// ShapeTweaks: the few direct controls that still matter once Tinker has
// proposed a design. Edits are a draft until "Rebuild with Draft": a new
// shape is a new body, re-checked by Draft and needing new training.
// Also hosts the pose & gravity experiments from v1 (crouch, wave).
import { Icon } from "./icons.jsx";
import { Button, Segmented, Slider, IconButton } from "./primitives.jsx";
import { ACTUATORS } from "./DesignCard.jsx";
import { normalizeShape } from "./CreatureGlyph.jsx";

// Mirrors contracts/design.schema.json (owner: morphology). Pass `bounds`
// to override if the schema is tightened.
export const DESIGN_BOUNDS = {
  quadruped: { torsoLength: [0.25, 0.8], torsoHeight: [0.08, 0.35], upperLeg: [0.12, 0.7], lowerLeg: [0.12, 0.65], strength: [0.5, 1.5] },
  multileg: { legCount: [3, 8], bodyRadius: [0.08, 0.25], upperLeg: [0.1, 0.32], lowerLeg: [0.12, 0.36], strength: [0.5, 1.5] },
};

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

function changedKeys(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * ShapeTweaks props:
 *  value: draft DesignSpec being edited; original: the built DesignSpec
 *  onChange(nextDesign), onRebuild(design), onReset()
 *  building: Draft is compiling; bounds: override DESIGN_BOUNDS
 *  pose: { crouch: 0..1, wave: 0..1 } + onPoseChange(nextPose) + poseDisabled + poseNote
 *  onDrop(): gravity experiment (motors off)
 */
export function ShapeTweaks({ value, original, onChange, onRebuild, onReset, building = false, bounds = DESIGN_BOUNDS, pose, onPoseChange, poseDisabled = false, poseNote, onDrop }) {
  if (!value) return null;
  const plan = value.bodyPlan === "multileg" ? "multileg" : "quadruped";
  const shape = normalizeShape(value);
  const params = value[plan] || {};
  const b = bounds[plan];
  const set = patch => onChange?.({ ...value, [plan]: { ...params, ...patch } });
  const origParams = original?.[plan] || {};
  const dirty = original ? changedKeys(params, origParams).length + (value.bodyPlan !== original.bodyPlan ? 1 : 0) : 0;

  const upper = params.upperLeg ?? shape.upperLeg;
  const lower = params.lowerLeg ?? shape.lowerLeg;
  const total = upper + lower;
  const ratio = upper / (total || 1);
  const totalMin = b.upperLeg[0] + b.lowerLeg[0];
  const totalMax = b.upperLeg[1] + b.lowerLeg[1];
  const setLegTotal = t => set({ upperLeg: round(clamp(t * ratio, b.upperLeg)), lowerLeg: round(clamp(t * (1 - ratio), b.lowerLeg)) });
  const actuators = plan === "multileg" ? ["micro", "qdd"] : ["micro", "qdd", "geared", "harmonic"];

  return (
    <section className="cl-tweaks" aria-label="Adjust shape">
      <div className="cl-tweaks__head">
        <div>
          <h3 className="cl-section-title">
            <Icon name="ruler" />
            Adjust shape
          </h3>
          <p className="cl-hint">A new shape is a new body. Draft checks it again and skills must be relearned.</p>
        </div>
      </div>
      <div className="cl-tweaks__grid">
        {plan === "quadruped" ? (
          <>
            <Slider label="Body length" value={params.torsoLength ?? shape.torsoLength} min={b.torsoLength[0]} max={b.torsoLength[1]} step={0.01} format={v => `${Math.round(v * 100)} cm`} ends={["Short", "Long"]} onChange={v => set({ torsoLength: round(v, 2) })} />
            <Slider label="Leg length" value={total} min={totalMin} max={totalMax} step={0.01} format={v => `${Math.round(v * 100)} cm`} ends={["Stubby", "Stilts"]} onChange={setLegTotal} />
          </>
        ) : (
          <>
            <div>
              <span className="cl-tweaks__group-label">Legs</span>
              <div className="cl-tweaks__stepper">
                <IconButton icon="minus" label="Fewer legs" size="sm" disabled={shape.legCount <= b.legCount[0]} onClick={() => set({ legCount: shape.legCount - 1 })} />
                <output aria-live="polite">{shape.legCount}</output>
                <IconButton icon="plus" label="More legs" size="sm" disabled={shape.legCount >= b.legCount[1]} onClick={() => set({ legCount: shape.legCount + 1 })} />
              </div>
            </div>
            <Segmented
              label="Leg layout"
              hideLabel={false}
              value={shape.arrangement}
              onChange={arrangement => set({ arrangement })}
              options={[
                { value: "radial", label: "All around" },
                { value: "bilateral", label: "In pairs" },
              ]}
              block
            />
            <Slider label="Body size" value={params.bodyRadius ?? shape.bodyRadius} min={b.bodyRadius[0]} max={b.bodyRadius[1]} step={0.005} format={v => `${Math.round(v * 200)} cm`} ends={["Small", "Big"]} onChange={v => set({ bodyRadius: round(v) })} />
            <Slider label="Leg length" value={total} min={totalMin} max={totalMax} step={0.01} format={v => `${Math.round(v * 100)} cm`} ends={["Short", "Long"]} onChange={setLegTotal} />
          </>
        )}
        <div>
          <span className="cl-tweaks__group-label">Motors</span>
          <Segmented label="Motors" value={params.actuator || "qdd"} onChange={actuator => set({ actuator })} options={actuators.map(a => ({ value: a, label: ACTUATORS[a].short, hint: ACTUATORS[a].hint }))} block />
          <p className="cl-hint cl-tweaks__motor-hint">{ACTUATORS[params.actuator || "qdd"]?.hint}</p>
        </div>
        <Slider label="Motor strength" value={params.strength ?? 1} min={b.strength[0]} max={b.strength[1]} step={0.05} format={v => `${v.toFixed(2)}×`} ends={["Gentle", "Mighty"]} hint="Stronger motors weigh more. Draft may flag strong motors on a small body." onChange={v => set({ strength: round(v, 2) })} />
      </div>
      {dirty > 0 && (
        <div className="cl-tweaks__pending" role="status">
          <p>
            {dirty} {dirty === 1 ? "change" : "changes"} not built yet
          </p>
          <div className="cl-tweaks__actions">
            <Button variant="ghost" size="sm" icon="undo" onClick={onReset} disabled={building}>
              Undo
            </Button>
            <Button variant="primary" size="sm" icon="blueprint" busy={building} disabled={building} onClick={() => onRebuild?.(value)}>
              {building ? "Drafting" : "Rebuild with Draft"}
            </Button>
          </div>
        </div>
      )}
      {pose && onPoseChange && (
        <div className="cl-tweaks__pose">
          <h4 className="cl-tweaks__group-label">Pose and gravity</h4>
          <Slider label="Crouch" value={pose.crouch ?? 0} min={0} max={1} step={0.01} format={v => `${Math.round(v * 100)}%`} disabled={poseDisabled} onChange={crouch => onPoseChange({ ...pose, crouch })} />
          <Slider label={plan === "multileg" ? "Lift one leg" : "Wave a front leg"} value={pose.wave ?? 0} min={0} max={1} step={0.01} format={v => `${Math.round(v * 100)}%`} disabled={poseDisabled} onChange={wave => onPoseChange({ ...pose, wave })} />
          {poseNote && <p className="cl-hint">{poseNote}</p>}
          {onDrop && (
            <Button size="sm" icon="download" onClick={onDrop} disabled={poseDisabled}>
              Drop test
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export default ShapeTweaks;
