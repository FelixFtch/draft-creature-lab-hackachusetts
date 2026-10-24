# Policy bundle — `creature-policy/1`

Owner: **trainer** (finalised). Consumers: `play/src/creature-controller.js`
(browser), draft-service (`training_jobs.py` readiness, `/creatures/...` file
serving), UI (training panel), world (playground pilot).

A bundle is one trained skill for one exact body. Producer:
`python -m creature_gym.train` (see `training/README.md`).

```
<bodyDir>/policies/<skill>/            skill = walk | jump
  manifest.json    below (the root of trust: every other file is hashed in it)
  scene.xml        exact simulation model used in training (see "Scene")
  <mesh files>     copies of the body's meshes, named as in body.json meshFiles
  policy.onnx      input "obs" [batch, N] float32 -> output "action" [batch, nu]
  eval.json        validation report (below)
  fixtures.json    deterministic rollout for JS/Python parity (QA only)
  progress.json    live training progress (written every PPO iteration)
  .work/           checkpoints, logs, caches: NEVER served
```

Draft-service serves exactly these names: `manifest.json`, `policy.onnx`,
`scene.xml`, `eval.json`, `fixtures.json`, `progress.json` and the body's mesh
file names. Everything else (notably `.work/`) stays private.

## Scene (`scene.xml`)

Built by `training/creature_gym/sim_model.py` from `body.xml` + `body.json`:

- one MuJoCo `<position>` actuator per joint, named like the joint, with Draft's
  PD rule `kp = 100/70 * effort`, `kv = 5/70 * effort` (velocity gain of the
  position actuator), `forcerange = +-effort`, `ctrlrange = joint range`. The PD
  runs inside MuJoCo every substep. Not modelled: DC-motor speed droop, backlash;
- collision bits from docs/v2/PLAN.md §3: feet `2/9` (condim 3, priority 1),
  torso and structural limbs `4/9`, motors and details `0/0`, floor `1/15`; no
  robot self-collision;
- `cg_floor`: a plane at z = 0, first geom of `<worldbody>`. A playground may
  keep it or replace it with its own ground (`meta.floorGeom` names it);
- sensors `cg_*`: `cg_imu_gyro`, `cg_imu_vel`, `cg_imu_acc` (IMU site),
  per leg `cg_touch_<leg>` (touch on site `cg_touch_site_<leg>`, a sphere 15% +
  2 mm larger than the foot), `cg_foot_pos_<leg>` / `cg_foot_vel_<leg>`
  (world frame), `cg_torso_contact` and `cg_thigh_contact_<leg>` (contact
  "found"), `cg_frc_<joint>` (actuator force);
- options: `timestep 0.005`, `implicitfast`, pyramidal cone, Newton solver,
  10 iterations / 20 line-search iterations, tolerance 1e-8, gravity -9.81.

Walk and jump bundles of one body share the byte-identical `scene.xml`
(same `sceneSha256`). Training adds a bump height field on top of this scene;
the robot part (bodies, joints, actuators, sensors) is identical.

## `manifest.json`

```jsonc
{
  "schema": "creature-policy/1",
  "skill": "walk" | "jump",
  "kind": "perpetual" | "episodic",
  "bodyId": "quadruped-…", "bodyName": "…",
  "bodyAssetSha256": { "body.xml": "…", "torso_mesh.stl": "…" },   // == body.json provenance.assetSha256
  "sceneXml": "scene.xml", "sceneSha256": "…",
  "assets": [{ "name": "torso_mesh.stl", "sha256": "…" }],
  "policy": "policy.onnx", "policySha256": "…", "onnxInput": "obs", "onnxOutput": "action", "onnxOpset": 17,
  "control": { "timestep": 0.005, "decimation": 4, "controlDt": 0.02 },
  "rootBody": "torso_link", "rootJoint": "torso_link_freejoint", "imuSite": "imu", "floorGeom": "cg_floor",
  "legNames": [ … ], "footSites": [ … ], "footGeoms": [ … ], "footRadius": [ … ],
  "jointNames": [ … ], "actuatorNames": [ … ],            // same order; actuators named like joints
  "defaultJointPositions": [ … ],                          // = body nominalJointPositions
  "actionScale": [ … ], "actionClip": 4.0,                 // target = clip(default + scale * clip(a, ±4), ctrlrange)
  "observation": { "size": N, "terms": [ { "name": "…", "start": 0, "length": 3, "scale": 1 } ], "notes": "…" },
  "commandBounds": { "vx": [-0.54, 1.08], "vy": [0, 0], "wz": [-0.96, 0.96] },   // controller clamps to these
  "moving": { "fraction": 0.05, "vmax": 1.085, "wmax": 0.957 },                 // gait clock on/off rule
  "clock": { "frequencyHz": 1.91, "legPhaseOffsets": [ … ], "swingFraction": 0.45,
             "pattern": "trot", "groups": [[0, 3], [1, 2]] } | null,          // walk only
  "episode": { "durationS": 1.46, "steps": 73, "handoff": "walk" } | null,     // jump only
  "handoff": { "skill": "walk", "walkPolicySha256": "…" },                     // jump only
  "fallCriteria": { "tiltRad": 1.0, "minHeightAboveFeetM": 0.22, "torsoContactSensor": "cg_torso_contact" },
  "sensors": { "touch": [ … ], "footPos": [ … ], "footVel": [ … ], "torsoContact": "…", "thighContact": [ … ],
               "gyro": "…", "velocimeter": "…", "accelerometer": "…" },
  "contactThresholdN": 20.0,                                 // touch > this = foot in contact
  "initialQpos": [ … ], "nominalRootHeight": 0.449,          // robot only: free joint + joints
  "scaling": { "legLengthM": 0.48, "froudeTopCommand": 0.25, "referenceLegM": 0.44 },
  "pd": { "kp": [ … ], "kv": [ … ], "effort": [ … ], "rule": "…" },
  "training": { "algorithm": "PPO", "envSteps": …, "iterations": …, "wallSeconds": …, "machine": { … },
                "seed": 0, "envs": 256, "budget": "quick", "mujocoVersion": "3.11.0", "torchVersion": "…",
                "ppo": { … }, "domainRandomization": { … }, "terrain": "…" },
  "export": { "onnxMaxAbsErrorVsTorch": 3.6e-7, "opset": 17, "irVersion": 8 },
  "evaluation": { "evalFile": "eval.json", "evalSha256": "…", "pass": true },
  "fixtures": { "file": "fixtures.json", "sha256": "…" },
  "honesty": "PPO velocity-tracking policy trained on CPU for this exact body …"
}
```

### Observation terms

All terms come from the robot's `qpos`/`qvel` (resolved by joint name) and
controller state, never from `sensordata` (MuJoCo computes sensors before the
step's integration, so they lag the state by one substep). Values are computed
in float64, multiplied by `scale`, then stored as float32.

| term | length | value |
| --- | --- | --- |
| `base_lin_vel` | 3 | `R^T qvel[root:root+3]` (root-origin velocity in the root frame) |
| `base_ang_vel` | 3 | `qvel[root+3:root+6]` (free-joint angular velocity is already in the root frame), scale 0.25 |
| `projected_gravity` | 3 | `R^T (0, 0, -1)` from the normalised root quaternion `(w, x, y, z)` |
| `command` | 3 | clamped `[vx, vy, wz]` (walk only) |
| `joint_pos` | nu | `q - defaultJointPositions` |
| `joint_vel` | nu | `qd`, scale 0.05 |
| `last_action` | nu | previous clipped action of the active skill |
| `gait_clock` | 2·legs | per leg `(sin, cos)(2π·frac(phase + offset))`, all zero when not moving (walk only) |
| `jump_phase` | 3 | `(p, sin 2πp, cos 2πp)`, `p` = window progress 0…1 (jump only) |

Clocks: `phase += frequencyHz * 0.02; if (phase >= 1) phase -= 1` after every
control step (also during a jump). Moving iff `|vx| > fraction·vmax` or
`|vy| > fraction·vmax` or `|wz| > fraction·wmax`.

### Walk → jump → walk handoff (Microduck-style)

On a jump trigger while walking: `mode = jump`, `p = 0`, and the last action is
re-expressed in jump units (`a · walkScale / jumpScale`, clipped). Each control
step runs the jump policy, then `p += 0.02 / durationS`; when `p >= 1 - 1e-9`
the walk policy resumes with `a · jumpScale / walkScale` (clipped). The user's
command is ignored during the window. The browser only enables jump if
`jump.sceneSha256 == walk.sceneSha256` and
`jump.handoff.walkPolicySha256 == walk.policySha256`.

## `eval.json`

Deterministic Python MuJoCo 3.11.0 rollouts of the exported ONNX (onnxruntime)
through `evaluate.ReferenceController`, the Python twin of the browser
controller. `{schema: "creature-eval/1", skill, bodyId, policySha256,
sceneSha256, pass, rows: [...], engine, scope}`. Each row: `name`, command
`schedule` (`[[t, vx, vy, wz], …]`), optional `pushes` (`[[t, dvx, dvy]]`) and
`jumps` (`[t]`), `durationS`, `measureFromS`, `criteria`, measured
`meanVelocity` `[vx, vy, wz]` (root frame), `fall`, `complete`, `outcomes`,
`pass`. Top-level `pass` is true only if every required row passes.

Walk rows (thresholds scale with the body): `stand` (drift ≤ max(0.2, 0.5·leg)
m, speed ≤ 0.1·vmax, |Δyaw| ≤ 0.5), `forward` (0.6·vmax; ≥ 50%, |wz| ≤
0.2·wmax), `forward_max` (vmax; ≥ 40%), `backward` (vx min; ≥ 40%),
`turn_left/right` (0.6·wmax; ≥ 50%, planar speed ≤ 0.25·vmax), `arc`,
`start_stop`, `push_recovery` (three 0.5·√s m/s shoves), `drop_recovery`
(dropped 0.15·leg with 0.2 rad roll), `bumpy` (training bump patch at 80%).
Every row also requires no fall, no MuJoCo warning, all steps executed.

Jump rows: `jump_from_stand`, `jump_from_walk`, `jump_repeat` (three jumps);
each jump needs apex root gain ≥ 0.10·leg, all feet airborne ≥ 0.10 s, tilt ≤
0.6 rad through the window and the first second of walking after it, and the
whole row must finish without a fall. `handoff.walkPolicySha256` records the
walk policy it was validated with.

## Readiness rule (browser and draft-service)

A bundle is **ready** only when: `manifest.schema` matches; `scene.xml`,
every asset, `policy.onnx` and `eval.json` match their SHA-256 in the
manifest; `eval.pass === true` and `eval.policySha256`/`eval.sceneSha256` equal
the manifest's; and (when the body is known) `bodyAssetSha256` equals the
body's `provenance.assetSha256`. The browser refuses anything else; a failed
jump never blocks a ready walk (the jump is simply unavailable, with a reason).

## `fixtures.json`

`{schema: "creature-fixtures/1", skill, source, tolerances, steps}`. Each step
stores the full state before the step (`qpos`, `qvel`, `qaccWarmstart`, `time`,
controller `mode`/`phase`/`jumpPhase`/`lastAction`), the `command` and `jump`
flag, the observation, raw ONNX action, targets (`ctrl`) and the state after
the step. QA restores each step independently and compares.

## `progress.json` (`creature-train-progress/1`)

`phase` (`training` | `exporting` | `evaluating` | `done` | `failed`),
`running`, `done`, `iteration`, `envSteps`, `envStepsTarget`, `fraction`,
`stepsPerSecond`, `meanReward`, `meanEpisodeLengthS`, `tracking`
(walk: `vx_abs_err`, `wz_abs_err`; jump: `apex_gain_m`, `air_time_s`),
`etaSeconds`, `wallSeconds`, `machine`, `updatedAt`, `message`, `evalPass`,
`chunks`, `maxWallSeconds`. Written atomically every iteration; ETA comes from
the measured steps per second, never a guess.

## Changes from the initial draft (owner notes)

Extended, not broken: added `rootJoint`, `floorGeom`, `footSites`/`footGeoms`/
`footRadius`, `moving`, `handoff`, `sensors`, `contactThresholdN`, `scaling`,
`pd`, `export`, `evaluation`, `fixtures`, `bodyName`; `fallCriteria` is
`{tiltRad, minHeightAboveFeetM, torsoContactSensor}`; command bounds are
clamped (not rejected) by the controller.
