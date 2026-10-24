# Policy bundle — `creature-policy/1`

Owner: **trainer**. Consumers: `play/src/creature-controller.js` (browser),
draft-service (`/api/creatures`, readiness), UI (training panel), world
(playground pilot).

A bundle is one trained skill for one exact body.

```
<bodyDir>/policies/<skill>/            skill = walk | jump
  scene.xml        the exact simulation model used in training: body + position
                   actuators + sensors + collision bits + floor + options
  <mesh files>     copies, hashed
  policy.onnx      single input, single output, normalisation baked in
  manifest.json    below
  eval.json        validation report (below)
  fixtures.json    short deterministic rollout for JS/Python parity tests
```

## `manifest.json` (initial shape; trainer finalises and documents here)

```jsonc
{
  "schema": "creature-policy/1",
  "skill": "walk" | "jump",
  "kind": "perpetual" | "episodic",          // walk loops; jump is a one-shot window
  "bodyId": "…", "bodyAssetSha256": { … },   // must equal body.json provenance.assetSha256
  "sceneXml": "scene.xml", "sceneSha256": "…", "assets": [{ "name": "…", "sha256": "…" }],
  "policy": "policy.onnx", "policySha256": "…", "onnxInput": "obs", "onnxOutput": "action",
  "control": { "timestep": 0.005, "decimation": 4, "controlDt": 0.02 },
  "rootBody": "…", "jointNames": [ … ], "actuatorNames": [ … ],
  "defaultJointPositions": [ … ], "actionScale": [ … ], "actionClip": 4.0,
  "observation": { "size": N, "terms": [ { "name": "…", "start": 0, "length": 3, "scale": 1 } ] },
  "commandBounds": { "vx": [-0.4, 0.8], "vy": [0, 0], "wz": [-1, 1] },
  "clock": { "frequencyHz": 2.0, "legPhaseOffsets": [ … ] } | null,
  "episode": { "durationS": 1.2 } | null,    // episodic skills
  "fallCriteria": { … },
  "initialQpos": [ … ],
  "training": { "algorithm": "PPO", "envSteps": …, "iterations": …, "wallSeconds": …,
                "machine": "…", "seed": 0, "mujocoVersion": "3.11.0", "torchVersion": "…" },
  "honesty": "Flat-ground PPO policy for this exact body; …"
}
```

## `eval.json`

Deterministic rollouts of the exported ONNX in Python MuJoCo (same version as
the browser), e.g. stand 10 s, forward, backward, turn left/right, push
recovery; for jump: apex height gain, landing upright, recovery to walk. Each
row: command, measured mean velocity, fall flag, pass flag. Top-level
`pass: true` only when every required row passes. The UI shows this verbatim.

The browser must refuse a bundle whose hashes do not match or whose `eval.json`
does not pass — same spirit as the existing Flower readiness gate.
