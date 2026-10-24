# Optional local vision adapter

Off by default. This CPU-only service proposes bounded drive actions from one PNG image and an instruction; it does not execute motion or launch a model.

Copy `config.example.json` to ignored `config.json`, configure an already-running local image-capable chat-completions server, then run `./start.sh --with-vision` from the repository root. The endpoint is restricted to loopback. The UI's **Stop** and manual joystick cancel robot visual control. Stop the launcher with Ctrl+C to stop its adapter process.

`GET /health` reports service/provider readiness. `POST /decide` accepts validated PNG data, an observation ID and instruction, then returns an action plus image hash/model provenance. Allowed operations: forward, backward, turn_left, turn_right, stand. Movement is capped at two simulated seconds per decision. The browser verifies observation ID/hash and bounds before executing through the body's own controller.

The adapter never returns a scripted substitute when the model is offline. It rejects malformed schema, images, invalid durations, non-loopback endpoints and unapproved origins. Tests use mock providers and HTTP fixtures; passing them does not prove navigation.

Only the image and instruction go to the model. A local experiment reached two of three markers; generalized navigation and manipulation remain unverified. No provider weights, credentials or GPU launcher are included.
