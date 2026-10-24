# Design pipeline: DesignSpec → Draft body

`draft-service/designs.py` turns a `creature-design/1` DesignSpec (what Tinker or
the UI proposes, `contracts/design.schema.json`) into a real Draft robot body
(`contracts/body-contract.md`) that the trainer can train. Owner: morphology.

```
validate     strict subset of JSON Schema + cross-field rules           -> 400 invalid-design
map          design -> Draft template + exact params_override
generate     RobotGenerator(template).generate(out, params_override, strict=True)
               fitted actuator trends size every motor; Draft's gate     -> 422 infeasible-design
lab gates    rigid actuator overlap, level stance with body clearance   -> 422 infeasible-design
analyse      legs/roles/joints, nominal stance (MuJoCo FK), gait hint,
             trainability heuristics + PD hold test, spec sheet
store        creatures/<id>/ (committed) or draft-service/.bodies/<id>/ (runtime)
```

Nothing here creates or certifies a controller. Trainability is coaching
(static loads + a torque-limited PD hold); only a trained policy's evaluation
shows that a body walks or jumps.

## Templates

| template | source | used for |
| --- | --- | --- |
| `quadruped` | Draft's official `src/draft/robots/quadruped` (pinned revision) | every quadruped; optional `basePreset` loads `experiments/quadruped_variants/<preset>.yaml` first, exactly as `/api/generate` |
| `multileg` | `robots/multileg/` (new, this repo) | every multileg design except the unmodified Flower |
| `flower-legacy` | `robots/flower/generate.py` | `bodyPlan: multileg, basePreset: flower` with nothing changed |

`robots/multileg` generalises the Flower: 3–8 identical legs, each a mount link
carrying the hip-yaw actuator, a coxa (hip yaw, axis z), thigh (hip pitch, axis
y) and shank (knee, axis y) ending in a sphere foot and a `<leg>_foot` site.
`tree.yaml` is one `for_each` over a `legs` parameter; `mesh.yaml` lofts an
elliptical hub (semi-axes `body_radius·body_aspect` × `body_radius`, Flower
profile). Draft expressions have no trigonometry, so `designs.py` computes the
leg list (dimensionless wall point, outward normal, yaw) and the hip-yaw range
and passes them as overrides, as the Flower does; the YAML stays declarative.

- **radial**: leg directions evenly spaced from +X (`leg0` points forward).
- **bilateral** (even leg counts): left/right pairs whose directions spread from
  45° (front) to 135° (rear) per side. Each mount sits where the hub ellipse's
  outward normal points along the leg, so elongated bodies splay naturally.
- Legs are named `leg0..legN-1` counter-clockwise from +X.
- Hip-yaw half range = 0.6 × the angular gap to the nearest leg, clamped to
  0.30–0.75 rad, so neighbours cannot be commanded through each other.
- Mass model: actuators from Draft's trends (mass, envelope, armature, gate);
  structure is stated (link radii as fractions of the actuator radius, densities
  750/500 kg/m³ as the Flower) because no multileg mass population exists. Draft
  reports these as "stated members"; quadrupeds use the measured quadruped
  population throughout.

## Actuator families

The design names a family; the pipeline restates a catalogued part's rated
operating point as Draft's `L` motor class (every joint uses it) and Draft
derives mass, envelope and armature from its fitted trends and gates the result.
`strength` multiplies the rated peak torque (and the asserted gearbox
friction/damping with it); speed and reduction stay the part's.

| plan | family | catalogue anchor (Draft category) | rated torque | no-load speed | gear | notes |
| --- | --- | --- | --- | --- | --- | --- |
| quadruped | `micro` | Xiaomi CyberGear MS01 (QDD) | 12 N·m | 25.13 rad/s | 7.75 | small robots; archetype "pup" proportions |
| quadruped | `qdd` | MIT U12 (QDD) — Cheetah preset | 72 N·m | 40 rad/s | 6 | fast, best for jumping; archetype Cheetah |
| quadruped | `geared` | MyActuator RMD-X15-P20-450-E (MidGear) — Bear preset | 450 N·m | 11.31 rad/s | 20.25 | heavy and strong; archetype Bear |
| quadruped | `harmonic` | ZeroErr eRob110H-80 (Harmonic) — Giraffe preset | 332 N·m | 3.93 rad/s | 80 | very strong, very slow; archetype Giraffe |
| multileg | `micro` | Xiaomi CyberGear MS01 (QDD), drawn at L/D 0.6 | 12 N·m | 25.13 rad/s | 7.75 | default |
| multileg | `qdd` | MIT Mini Cheetah U8 (QDD), drawn at L/D 0.6 | 17 N·m | 40 rad/s | 6 | faster, stronger crawler |
| multileg | (Flower class) | none — trend-sized 12 N·m class (ALL frontier) | 12 N·m | 20 rad/s | 12 | only via `basePreset: flower` without `actuator` |

**`allow_hypothetical` is `false` for every family.** A strength that pushes an
actuator past the best catalogued part of its category is refused with a 422 and
a "decrease strength" hint instead of being promoted to an imaginary motor. Only
the MIT U12 starts close to its frontier (its power density is above the QDD p90
already), so quadruped `qdd` is the one family with a strength ceiling below 1.5
(see Bounds). Multileg families anchor on smaller QDDs than the quadruped `qdd`
because a crawler's coxa must hold two actuators apart.

Without `basePreset`, a quadruped borrows its family's archetype proportions
(qdd → Cheetah, geared → Bear, harmonic → Giraffe, micro → pup: torso
0.30×0.16×0.10, shoulder 0.10, hip offset 0.06, legs 0.15/0.15). A design that
names only `basePreset` compiles to exactly the legacy preset (same overrides as
`/api/generate`, so byte-identical XML and mesh).

## Identity, caching, stores

`bodyId = <plan>-sha256(contract, template, exact Draft overrides, Draft
revision, template files, Draft generation/trend sources)[:16]`. Cosmetic fields
(name, concept, look, skills) do not enter it; lengths are rounded to 1 mm and
strength/aspect to 0.01 before mapping. Two designs that compile to the same
Draft input share a body. Post-processing (`DESIGNS_VERSION`) is not part of the
id: a cached body from an older version keeps its assets and gets a fresh
`body.json`.

- `creatures/<id>/` committed (showcase + legacy), looked up first.
- `draft-service/.bodies/<id>/` runtime, git-ignored, LRU (body.json mtime) to
  48 bodies; a body with a `policies/` directory is never evicted.
- Generation happens in a temp dir inside the store and is renamed into place,
  so readers never see half-written bodies. Assets are re-hashed on every reuse.
- `designs.body_dir(bodyId)` resolves an id for other processes (training jobs).

## Gates and the 422 format

Draft's own gate runs strict: actuator frontier (torque and power density
against the best catalogued part of the anchor's category), speed/aspect/radius
warnings, actuator packing along each chain, actuators buried in the trunk,
mass-composition audit (quadrupeds). The pipeline adds two gates Draft does not
make:

- **Rigid actuator overlap**: actuators bolted to the same rigid body (no joint
  between them, e.g. neighbouring hip-yaw housings on a small hub, or left/right
  hip-roll housings) must not interpenetrate. Draft treats such pairs on
  different branches as a soft neutral-pose warning; here no joint can separate
  them, so it is a refusal. Uses Draft's own oriented-box overlap test and the
  design's `packing_exempt_geoms`.
- **Stance**: a level standing pose must exist with every foot on the ground,
  joints at least 10% of their range from a limit, and every non-foot solid at
  least 1 cm above the ground.

A refusal is HTTP 422:

```json
{ "error": "infeasible-design", "gate": "actuator-frontier",
  "message": "[L]: power density 749 W/kg beats the best catalogued QDD actuator ...",
  "hints": [ { "field": "quadruped.strength", "direction": "decrease", "reason": "..." },
             { "field": "quadruped.actuator", "direction": "change", "reason": "..." } ],
  "violations": [ "... every message ..." ], "design": { "...": "the normalised request" } }
```

Gates: `actuator-frontier`, `actuator-packing`, `actuator-in-structure`,
`structure-density`, `stance`, `draft-error` (Draft/MuJoCo refused the
geometry), `draft` (anything else). `direction` is `increase`, `decrease` or
`change`; `field` is a dotted DesignSpec path. Invalid requests are HTTP 400
`{error: "invalid-design", message, issues: [{field, message}]}`.

## Nominal stance

1. Guess: quadrupeds put the foot straight below the hip-pitch axis at 85% leg
   extension (closed form, hip roll 0); the legacy Cheetah keeps its policy's
   `[0, 0.5, -1.0]`. Multileg bodies use the Flower stance (hip yaw 0, hip pitch
   0.15, knee 1.25 rad: thigh slightly down, shank ~80° below horizontal).
2. MuJoCo forward kinematics with the root at identity orientation; the root is
   lowered until the lowest foot sphere touches z = 0.
3. Per leg, Newton on hip pitch and knee puts the foot sphere exactly on z = 0
   at the guessed horizontal position.
4. Checks (failures are the `stance` gate): foot heights within **0.1 mm**,
   torso exactly level (identity quaternion; `|roll|, |pitch| ≤ 1e-6 rad`
   recorded), every joint at least **10%** of its range from a limit, every
   non-foot, non-shank solid at least **1 cm** above the ground. The achieved
   values are in `body.json` `stanceCheck`; the tests re-check them with an
   independent FK pass (feet within 0.02 mm).

## Gait hints

`gaitHint = {pattern, groups, phaseOffsets, dutyFactor}`; indices follow the
`legs` order. Quadruped: trot `[[fl, rr], [fr, rl]]`. Multileg: 4 legs trot
`[[0,2],[1,3]]`, 6 legs tripod `[[0,2,4],[1,3,5]]` (works for radial and
bilateral orderings), 8 legs ripple `[[0,4],[2,6],[1,5],[3,7]]` (six feet always
down), 3/5/7 legs wave, every other leg in turn. A clock prior only.

## Trainability heuristics

Computed at the nominal pose (`body.json` `trainability`):

| metric | meaning |
| --- | --- |
| `standLoad` | largest joint-torque fraction of peak needed to stand with weight shared equally by all feet (foot Jacobian transpose) |
| `gaitLoad` | the same with only the stance feet of the gait hint loaded |
| `verticalForceRatio` | Σ legs of the largest vertical foot force the joint limits allow ÷ weight (the geometric torque-to-weight figure) |
| `staticMarginM` / `gaitMarginM` | COM ground projection to the support-polygon edge, all feet / worst gait phase |
| `bellyClearanceM`, `legToBodyRatio`, `minJointVelocityRadS`, `maxFootSpeedMS` | geometry and speed |
| `jumpEstimate` | rough hop height: min(v²/2g, (verticalForceRatio − 1) × 0.4 leg length), v from half no-load joint speeds |
| `holdTest` | 2 s PD hold of the nominal pose on a floor: kp = effort / 0.15 rad, damping ratio 1, torque capped at Draft effort, dt 0.005 implicitfast, plan collision classes; sag, tilt, peak torque, body-ground contacts |

Flags (`{code, severity, message}`) and thresholds:

| code | severity | when |
| --- | --- | --- |
| `cannot-stand` | error | `standLoad > 1.0`, or the hold test sags > 25%, tilts > 0.35 rad or the body touches the ground |
| `may-struggle-to-stand` | warning | `standLoad > 0.5` or hold-test sag > 8% |
| `may-struggle-to-walk` | warning | `gaitLoad > 0.9` |
| `tippy` | warning | `staticMarginM < 0.02` |
| `low-belly` | warning | belly clearance < 3 cm |
| `jump-unlikely` | warning | the design asks for `jump` but the jump verdict is weak/unlikely |
| `dynamic-gait` | info | a gait phase leaves fewer than three feet or the COM outside them (normal for trot) |
| `slow-joints` | info | no-load speed < 6 rad/s |
| `short-legs` / `long-legs` | info | leg/body length < 0.45 or > 2.2 |

Jump verdict: `strong` (ratio ≥ 5 and hop ≥ 0.15 m), `capable` (≥ 3, ≥ 0.08 m),
`weak` (≥ 2), else `unlikely`.

## Routes (`designs.ROUTES`)

| route | reply |
| --- | --- |
| `POST /api/design` | `{body, urls, specSheet, cached}`; 400 invalid-design; 422 infeasible-design; 500 design-failed |
| `GET /api/bodies` | `{bodies: [{id, name, bodyPlan, template, legCount, massKg, origin: legacy/showcase/generated, legacyPreset, verdict, policies, urls}]}` |
| `GET /api/design/schema` | `contracts/design.schema.json` as stored |
| `GET /creatures/<bodyId>/<file>` | allowlisted body files and `policies/<walk|jump>/<file>` (see body contract) |

## Bounds

BOUNDS_PLACEHOLDER

## Showcase bodies

SHOWCASE_PLACEHOLDER

## Commands

```bash
export DRAFT_ROOT=$PWD/.deps/draft
PY=$PWD/.venv/bin/python
$PY -m unittest draft-service/test_designs.py            # tests (~1 min)
$PY draft-service/designs.py build-showcase               # regenerate creatures/
$PY draft-service/designs.py evaluate my-design.json      # one design, not stored
CREATURE_BODY_DIR=/tmp/x nice -n 10 $PY draft-service/designs.py probe-bounds --out bounds.json
```
