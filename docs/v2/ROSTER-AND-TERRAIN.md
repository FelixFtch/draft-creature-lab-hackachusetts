# Addendum: the four-robot roster and the Terrain Lab

Added after the user's second brief (verbatim): "you need to create 1 wheel leg
robot, 2.robot dog 3.one spider .4. humanoid robot. they can be controlled by
the gimbla, and jump with (space), (or wasd), simple of terrain /gap can be
created to show that some robot are able to go pass the terrain (At the same
time, you need to look at how the robot's structure interacts with the
topography, and how its design adapts to it or what advantages it has on that
terrain. Specifically, look at the structure you're working on now) and they can
also achieve different goal automatically with vlm."

Interpretation: "gimbla" = the joystick sticks (RC "gimbals"): gamepad sticks,
the on-screen virtual joystick, and WASD/arrows. **Space = jump** for every robot
that has a validated jump skill.

## 1. Roster (showcase robots, all real Draft bodies)

| Robot | Body plan | Draft template | Skills to train | Design intent |
| --- | --- | --- | --- | --- |
| **Rollo** — wheel-leg | `wheeled` (two wheel-legs, dynamically balanced like a segway; Ollie/Diablo style) | new `robots/wheel_biped/` | `drive` (balance + vx/wz tracking), `jump` | fastest on flat ground and slopes; jumps up steps and over gaps; small wheels dislike rubble |
| **Dog** — robot dog | `quadruped` | Draft official (Cheetah preset, original size) | `walk`, `jump` (trainer already has validated Cheetah walk + jump bundles) | all-rounder: rough ground, moderate steps, jumps gaps |
| **Octo** — spider | `multileg` (8 legs, radial) | `robots/multileg/` | `walk` (jump only if it truly validates) | very stable (wide support polygon, low COM, always ≥ 4 feet down), long legs bridge narrow gaps without jumping, crawls over rubble; slow, low step-up height |
| **Bipo** — humanoid | `humanoid` | Draft official humanoid with arm/torso joints disabled (`*_dof: false`) → 12 leg joints, flat feet | `walk` (hop only if it validates) | narrow footprint, steps over small obstacles and up low steps; dynamically balanced, weakest on rubble |

Bring the four to a comparable "dog-sized" scale where Draft allows it (the
Dog is the Cheetah preset as-is). Names are working names; the UI may show them.

Body-contract extensions (morphology owns `contracts/body-contract.md`):
- `bodyPlan` adds `"wheeled"` and `"humanoid"`.
- Wheel legs: `legs[i].wheel = { joint, geom, radiusM, axis }`; the wheel joint has
  `role: "wheel"`, `continuous: true` (no range) and a velocity limit.
- Humanoid legs: joints `hip_yaw, hip_roll, hip_pitch, knee, ankle_pitch, ankle_roll`;
  `footGeom` is the sole plate; `footContactSites` lists Draft's sole corner sites.
- New `terrainProfile` section computed from the structure (predictions, not
  measurements): ground clearance, max foot reach / stride, leg span (front-to-rear
  foot distance), support-polygon area and stability margin at nominal stance, COM
  height, torque-to-weight per joint class, wheel radius, contact type
  (`point-feet` / `flat-feet` / `wheels`), static vs dynamic stability, and
  predicted limits: max step-up, max gap by walking, max gap by jumping (if jump
  requested), max slope (friction μ and tipping). State every formula.

Policy-bundle extensions (trainer owns `contracts/policy-bundle.md`): skill ids
`walk`, `drive` (perpetual, wheels), `jump` (episodic). Wheel actuators are
MuJoCo `<velocity>` actuators (action = wheel speed target) with force limits;
observations use wheel *velocities* (never wheel angles). The browser controller
handles all four plans through the same pilot interface.

## 2. The Terrain Lab (playground zone + automated trials)

A dedicated area of the park with parallel lanes and identical start/finish lines:

| Lane | Obstacle grades (absolute sizes) |
| --- | --- |
| Flat sprint | 5 m |
| Rubble | scattered blocks 2–6 cm high |
| Step-up | 6 cm, 12 cm, 18 cm (three steps in sequence or three sub-lanes) |
| Gap | 0.20 m, 0.35 m, 0.50 m (pit 0.6 m deep — falling in fails the run) |
| Slope | 12°, 20° ramps |

Rules: each robot gets automated trials (headless Node with real MuJoCo WASM +
ONNX, its own validated policies, fixed command at a standard fraction of its
max speed, a deterministic "approach and jump" trigger at gap/step edges when it
has a jump skill). Record pass / fail / fall, time, and where it failed. Results
go to `qa/terrain-trials.json` and feed the UI's capability matrix. Measured
results are shown next to the structure-based predictions with a one-line "why"
per cell (e.g. "Octo: walked across — leg span 0.62 m > gap 0.35 m";
"Rollo: blocked at 18 cm — wheel radius 0.08 m, jump apex 0.14 m").

The same lanes are drivable by the user (gamepad/joystick/WASD, Space to jump).

## 3. Autonomous goals with the VLM

AI Explore gets goal presets per robot ("reach the yellow flag beyond the gap",
"push the ball into the goal", "climb onto the platform", "visit the blue
tower"). `/decide` gains operation `jump` (durationSeconds 0) — only executed
when the pilot has a validated jump skill; otherwise the browser refuses it.
The environment, not the model, judges goal completion.

## 4. Analysis deliverable

`docs/v2/TERRAIN-ANALYSIS.md` (main agent): for each robot, how its structure
(from `body.json` + `terrainProfile`) meets each terrain, predicted vs measured,
and what design changes would help — written from the actual bodies and trial
results, not from generic claims.
