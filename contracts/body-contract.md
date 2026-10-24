# Body contract — `creature-body/1`

Owner: **morphology**. Consumers: trainer (builds the simulation model from it),
workshop engine and appearance (pose, blueprint, body roles), UI (spec sheet),
ai-service (feasibility and trainability feedback for Tinker).
Producer: `draft-service/designs.py` (see `draft-service/DESIGNS.md`).

A *body* is what Draft generated: geometry, masses, joints, joint limits and
motor envelopes. It deliberately contains **no actuators, sensors-for-training
or floor**; the trainer adds those and exports the exact simulation XML inside
each policy bundle (see `policy-bundle.md`). The workshop poses the body XML.
Exception: the legacy Flower body keeps the 18 direct torque `<motor>`s and the
`nominal` keyframe of its legacy XML so its bytes match the validated legacy
policy; `xmlContents` says so and the trainer should drop both.

## Files in a body directory

```
<root>/<bodyId>/
  body.xml            Draft MJCF of the robot only (mesh assets by relative file name)
  <mesh files>.stl    every mesh the XML references (today: torso_mesh.stl)
  body.json           this contract
  feasibility_report.yaml, parameters_resolved.yaml   Draft outputs, unchanged
  policies/<skill>/   written later by the trainer (skill = walk | jump), see policy-bundle.md
```

`bodyId` = `<plan>-<16 hex>`: SHA-256 of the exact Draft overrides the design
maps to, the template source files, the Draft revision and Draft's generation
and trend sources. Cosmetic design fields (`name`, `concept`, `look`, `skills`)
never change a body; any change to what Draft receives always does. A body
therefore serves every design that compiles to it; `body.json` `name`/`design`
record the design that first produced it, and `POST /api/design` echoes the
caller's own name/design in its response.

Stores (resolve with `designs.body_dir(bodyId)`; showcase wins):
- `creatures/<bodyId>/` — committed showcase and legacy bodies.
- `draft-service/.bodies/<bodyId>/` — generated at runtime, git-ignored, LRU
  capped at 48; a body that has a `policies/` directory is never evicted.

Served by draft-service at `/creatures/<bodyId>/<file>` for exactly:
`body.xml`, `body.json`, `feasibility_report.yaml`, `parameters_resolved.yaml`,
the body's own `meshFiles`, and `policies/<walk|jump>/<manifest.json |
policy.onnx | scene.xml | eval.json | fixtures.json | progress.json | own mesh
names>`. No traversal, no symlinks (any symlinked path component is a 404).
XML/STL are `immutable` (content-addressed); JSON/YAML and policies `no-store`.

## `body.json`

```jsonc
{
  "schema": "creature-body/1",
  "id": "quadruped-…",
  "name": "Hopper",                       // from the design that first produced the body
  "bodyPlan": "quadruped" | "multileg",
  "design": { /* the validated DesignSpec (creature-design/1), normalised */ },
  "resolvedDesign": { /* every physical design field after defaults, e.g. upperLeg, actuator, strength */ },
  "xmlFile": "body.xml",
  "meshFiles": ["torso_mesh.stl"],
  "rootBody": "torso_link",               // body with the free joint
  "imuSite": "imu",
  "forwardAxis": [1, 0, 0],               // in root-body frame
  "legs": [                               // fixed order; joints listed proximal -> distal
    { "name": "fl", "joints": ["fl_hip_roll", "fl_hip_pitch", "fl_knee"],
      "roles": ["hip_roll", "hip_pitch", "knee"],
      "footGeom": "fl_lower_leg_link_sphere", "footSite": "fl_foot", "footRadius": 0.0276,
      "mountAngle": 0.298,                // radians, leg direction around the body (atan2 y,x)
      "side": "left" | "right" | "center", "end": "front" | "middle" | "rear",
      "bodies": ["fl_roll_motor_link", "fl_roll_link", "fl_pitch_link", "fl_upper_leg_link", "fl_lower_leg_link"]
    }
  ],
  "jointNames": ["…"],                    // canonical order = legs x joints
  "joints": [ { "name": "fl_knee", "role": "hip_roll" | "hip_yaw" | "hip_pitch" | "knee", "leg": "fl",
                "range": [-2.8, 0], "effort": 72, "velocity": 40, "gear": 6, "armature": 0.0154,
                "damping": 0.0127, "frictionloss": 0.127, "motorClass": "L" } ],
  "nominalJointPositions": [ … ],         // standing pose: all feet on flat ground, torso level
  "nominalRootHeight": 0.42,              // world z of root body in that pose (floor at z = 0)
  "initialQpos": [ … ],                   // nq of body.xml alone: free joint + joints, nominal pose
  "stanceCheck": { "footHeightsM": [ … ], "maxFootHeightErrorM": 0, "rollRad": 0, "pitchRad": 0,
                   "bellyClearanceM": 0.17, "minJointMarginFraction": 0.36,
                   "tolerances": { "footHeightM": 1e-4, "levelRad": 1e-6, "jointMarginFraction": 0.1,
                                   "minBellyClearanceM": 0.01 }, "source": "…", "method": "…" },
  "massKg": 12.3,
  "dimensions": { "lengthM": 0.6, "widthM": 0.4, "heightM": 0.45, "legLengthM": 0.44 },  // nominal pose, solid geoms
  "gaitHint": { "pattern": "trot" | "tripod" | "wave" | "ripple", "groups": [[0, 3], [1, 2]],
                "phaseOffsets": [0, 0.5, 0.5, 0], "dutyFactor": 0.5 },
  "geomRoles": {                          // every geom exactly once; used for collision classes + looks
    "feet": ["…"], "torso": ["…"], "limbs": ["…"], "motors": ["…"], "details": ["…"]
  },
  "bodyRoles": { "torso": "torso_link", "head": null },
  "poseHints": { "crouchDelta": [0, 0.475, -0.95], "waveLeg": "fl", "waveDelta": [0, -1.25, -0.3] },
                                          // workshop pose experiments only: per-role deltas (leg joint order)
  "xmlContents": { "actuators": 0, "sensors": 3, "sensorNames": ["imu_ang_vel", "…"], "keyframes": [], "note": "…" },
  "motors": [ { "class": "L", "family": "qdd", "familyLabel": "…", "catalogAnchor": "MIT U12",
                "category": "QDD", "count": 12, "effortNm": 72, "velocityRadS": 40, "gear": 6,
                "massKg": 1.1, "diameterMm": 126, "lengthMm": 46, "armatureKgm2": 0.0154,
                "peakPowerW": 720, "torqueDensityNmPerKg": 65.5, "powerDensityWPerKg": 654.5,
                "frontierTorqueMaxNm": 79.3 } ],
  "feasibility": { "passed": true, "strict": true, "allowHypothetical": false,
                   "warnings": ["…"], "overridden": ["…"], "extraGates": ["…"] },
  "trainability": {
    "verdict": { "stand": "ok" | "marginal" | "fails", "walk": "plausible" | "hard" | "unlikely",
                 "jump": "strong" | "capable" | "weak" | "unlikely" },
    "flags": [ { "code": "may-struggle-to-stand", "severity": "info" | "warning" | "error", "message": "…" } ],
    "metrics": { "standLoad": 0.12, "gaitLoad": 0.25, "verticalForceRatio": 8.2, "staticMarginM": 0.16,
                 "gaitMarginM": -0.002, "comHeightM": 0.45, "bellyClearanceM": 0.18, "legToBodyRatio": 0.92,
                 "minJointVelocityRadS": 40, "maxFootSpeedMS": 19, "jumpEstimate": { … }, … },
    "holdTest": { "passed": true, "sagFraction": 0.01, "tiltRad": 0.0, "peakTorqueFraction": 0.13, … },
    "notes": "…"
  },
  "legacy": { "preset": "cheetah", "controller": "/controller/cheetah/manifest.json", "note": "…" } | null,
  "specSheet": { /* UI-ready summary: title, subtitle, massKg, dimensions, motors, feasibility, trainability */ },
  "provenance": { "generator": "Draft RobotGenerator strict=True", "draftRevision": "3b03e14…",
                  "draftPackageVersion": "0.1.0", "mujocoVersion": "3.8.0",
                  "template": "quadruped" | "multileg" | "flower-legacy", "templateDir": "…",
                  "family": "qdd", "basePreset": null, "archetype": "cheetah",
                  "sourcesSha256": { … }, "draftOverrides": { … }, "designsVersion": 1,
                  "massModel": "…", "assetSha256": { "body.xml": "…", "torso_mesh.stl": "…" } }
}
```

Field notes:
- Leg order: quadrupeds `fl, fr, rl, rr` (Draft names); multileg `leg0..legN-1`
  counter-clockwise from +X (`leg0` points forward on radial bodies; bilateral
  bodies start with the left-front leg). `gaitHint` indices refer to this order.
- Joint roles: quadruped `hip_roll, hip_pitch, knee` (knee range negative);
  multileg `hip_yaw, hip_pitch, knee` (positive pitch/knee fold the outward leg down).
- `geomRoles.details` are weightless visual rings; Draft emits them with
  `contype=1`, so the trainer must set them to `0/0` (plan collision bits).
  `motors` includes the quadruped's weightless knee pulleys.
- `trainability` is coaching, not evidence: static loads at the nominal pose
  (`standLoad` = peak-torque fraction to stand on all feet, `gaitLoad` with only
  the stance group of `gaitHint` loaded, `verticalForceRatio` = summed maximum
  vertical foot force / weight) and a torque-limited PD hold of the nominal pose.
  Thresholds are listed in `draft-service/DESIGNS.md`.

Rules:
- Everything needed to simulate and train must be derivable from `body.xml` +
  `body.json`; no hidden defaults.
- `nominalJointPositions` are within joint ranges with at least 10% of each
  range to spare, every foot sphere rests on z = 0 within 0.1 mm with the torso
  exactly level (identity root orientation), and every non-foot solid clears the
  ground by at least 1 cm. `stanceCheck` records the achieved values.
- Legacy presets (cheetah, bear, giraffe, flower at original size) are bodies
  too, with `body.xml` + mesh byte-identical to the legacy `/api/generate`
  model, so the legacy Cheetah/Flower policy hashes still match and the new
  trainer can train Bear and Giraffe. A design that names only `basePreset`
  (no overrides) compiles to exactly these bodies.
- Hashes make stale policies detectable: a policy bundle records the
  `assetSha256` of the body it was trained on.
