# Draft Creature Lab handoff

Phase: playable local prototype, English-only public source release.

Run `./setup.sh`, then `./start.sh`. The generator and frontend bind to loopback. VLM control is optional and off by default; no model launcher or weights are supplied.

The original-size Flower and Cheetah have independent validated ONNX policies. Resized bodies are intentionally locked out of walking. Preserve controller/policy/XML/reference-mesh hashes and readiness checks. Do not imply arbitrary-body walking, pickup, hardware validation or public hosting.

Fresh Linux setup, both real WASM controller suites, input checks, deterministic trails and production build pass. Actual Chrome verifies English labels and Flower joystick motion. See `qa/release-verification.json` and `qa/english-browser-release.json`.

Next useful work: learner feedback on manual design and joystick play. Any VLM experiment requires an explicitly configured local provider.
