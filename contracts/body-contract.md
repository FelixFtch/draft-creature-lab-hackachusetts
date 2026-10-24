# Body contract — `creature-body/1`

Owner: **morphology**. Consumers: trainer (builds the simulation model from it),
workshop engine and appearance (pose, blueprint, body roles), UI (spec sheet).

A *body* is what Draft generated: geometry, masses, joints, joint limits and
motor envelopes. It deliberately contains **no actuators, sensors-for-training
or floor**; the trainer adds those and exports the exact simulation XML inside
each policy bundle (see `policy-bundle.md`). The workshop poses the body XML.

## Files in a body directory

```
<root>/<bodyId>/
  body.xml            Draft MJCF of the robot only (mesh assets by relative file name)
  <mesh files>.stl    every mesh the XML references
  body.json           this contract
  feasibility_report.yaml, parameters_resolved.yaml   Draft outputs, unchanged
```

`bodyId` = `<plan>-<16 hex>` (hash of design + template sources + Draft revision),
e.g. `quadruped-3f…`, `multileg-9a…`. Bundled showcase bodies live under
`creatures/<bodyId>/` (committed). Bodies generated at runtime live in a
git-ignored work directory and are served by draft-service at
`/creatures/<bodyId>/<file>` (allowlisted file names only).

## `body.json`

```jsonc
{
  "schema": "creature-body/1",
  "id": "quadruped-…",
  "name": "Hopper",                       // from the design
  "bodyPlan": "quadruped" | "multileg",
  "design": { /* the validated DesignSpec (creature-design/1) */ },
  "xmlFile": "body.xml",
  "meshFiles": ["torso_mesh.stl"],
  "rootBody": "torso_link",               // body with the free joint
  "imuSite": "imu",
  "forwardAxis": [1, 0, 0],               // in root-body frame
  "legs": [                               // fixed order; joints listed proximal -> distal
    { "name": "fl", "joints": ["fl_hip_roll", "fl_hip_pitch", "fl_knee"],
      "footGeom": "…", "footSite": "fl_foot", "footRadius": 0.03,
      "mountAngle": 0.0,                  // radians, leg direction around the body (atan2 y,x)
      "side": "left" | "right" | "center", "end": "front" | "middle" | "rear",
      "bodies": ["…upper…", "…lower…"]    // MuJoCo bodies of this leg, proximal -> distal
    }
  ],
  "jointNames": ["…"],                    // canonical order = legs x joints
  "joints": [ { "name": "fl_knee", "range": [-2.8, 0], "effort": 72, "velocity": 40,
                "gear": 6, "armature": 0.0154, "damping": 0.0127, "frictionloss": 0.127,
                "role": "hip_roll" | "hip_yaw" | "hip_pitch" | "knee" } ],
  "nominalJointPositions": [ … ],         // standing pose: all feet on flat ground, torso level
  "nominalRootHeight": 0.42,              // world z of root body in that pose (floor at z = 0)
  "initialQpos": [ … ],                   // nq of body.xml alone: free joint + joints, nominal pose
  "massKg": 12.3,
  "dimensions": { "lengthM": 0.6, "widthM": 0.4, "heightM": 0.45, "legLengthM": 0.44 },
  "gaitHint": { "pattern": "trot" | "tripod" | "wave" | "ripple", "groups": [[0, 3], [1, 2]] },
  "geomRoles": {                          // geom name lists, used for collision classes + looks
    "feet": ["…"], "torso": ["…"], "limbs": ["…"], "motors": ["…"], "details": ["…"]
  },
  "bodyRoles": { "torso": "torso_link", "head": null },
  "motors": [ { "class": "L", "family": "qdd", "effortNm": 72, "velocityRadS": 40,
                "gear": 6, "massKg": 1.1, "catalogAnchor": "MIT U12" } ],
  "feasibility": { "passed": true, "warnings": ["…"], "overridden": ["…"] },
  "provenance": { "generator": "Draft RobotGenerator strict=True", "draftRevision": "3b03e14…",
                  "template": "quadruped" | "multileg", "sourcesSha256": { … },
                  "assetSha256": { "body.xml": "…", "torso_mesh.stl": "…" } }
}
```

Rules:
- Everything needed to simulate and train must be derivable from `body.xml` +
  `body.json`; no hidden defaults.
- `nominalJointPositions` must be within joint ranges and produce ground contact
  on every foot with the torso roughly level (state your tolerance).
- Legacy presets (cheetah, bear, giraffe, flower at original size) must also be
  available as bodies so the new trainer can train Bear and Giraffe.
- Hashes make stale policies detectable: a policy bundle records the
  `assetSha256` of the body it was trained on.
