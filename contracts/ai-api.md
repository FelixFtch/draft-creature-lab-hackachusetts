# ai-service API (loopback, port 18383)

Owner: **ai**. This file must stay accurate. The service replaces `vlm-service/` and stays backward compatible with its
`POST /decide` and `GET /health`. The browser reaches it through the Vite proxy as `/ai/<route>`, and as
`/vlm/<route>` for legacy callers; the proxy strips the prefix. Implementation and setup notes are in
`ai-service/README.md`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Service and provider status. Never returns keys and never runs inference. |
| `POST /chat` | Tinker design conversation: a reply plus validated actions. |
| `POST /decide` | Legacy VLM drive proposal. Contract unchanged except for the two provenance additions below. |
| `POST /critique` | The VLM looks at a creature render and returns a critique plus an optional `lookPatch`. |

Roles: **brain** is the chat/design LLM behind `/chat`. **eyes** is the VLM behind `/decide` and `/critique`. Each is
configured independently (see "Providers" below). With no brain, `/chat` uses the built-in offline designer. With no
eyes, `/decide` and `/critique` return `503 provider_not_configured`.

## Common rules

- Requests: `Content-Type: application/json` with a `Content-Length`. The body must be strict JSON: no duplicate keys
  and no NaN or Infinity.
- Body limits: `/chat` 256 KiB; `/decide` 2 MiB image + 16 KiB; `/critique` 2 MiB image + 96 KiB.
- Images are `data:image/png;base64,...`, at most 2 MiB decoded and 2048 by 2048. The full PNG container is
  validated. Remote URLs and file paths are rejected.
- Browser `Origin` must be one of the allowed loopback origins: `127.0.0.1` or `localhost` on the lab port, plus
  `LAB_PORT`. `Host` must be a loopback name; any port is fine, because the Vite proxy forwards the browser's Host.
- Errors always have this shape: `{ "ok": false, "error": { "code": "...", "message": "..." }, "executesMotion": false }`.
  Messages are fixed strings. They never contain provider response bodies, request data or keys.
- Concurrency: one `/decide`, one `/critique` and two `/chat` requests at a time. More get `429 busy`.

## `POST /chat`

Request:

```jsonc
{
  "messages": [ { "role": "user" | "assistant", "content": "..." } ],   // 0..40 items, each 1..4000 chars
  "state": {                                    // all optional; invalid parts are ignored, never fatal
    "design": { /* creature-design/1 */ },
    "look":   { /* creature-look/1 */ },
    "body": {                                   // EITHER the body.json of the current design (creature-body/1; a subset is enough)…
      "id": "quadruped-…",                      // present once Draft has built the current design
      "massKg": 9.1,
      "design": { … },                          // used when state.design is missing
      "resolvedDesign": { … },                  // optional: base values for direction-only hints
      "feasibility": { "passed": true, "warnings": ["…"] },        // also: reasons/errors/failures
      "trainability": { "verdict": { "stand": "ok", "walk": "plausible", "jump": "weak" },
                        "flags": [ { "code": "may-struggle-to-walk", "severity": "warning", "message": "…" } ] }
                                                // warning/error flags are coached; info flags are ignored.
                                                // A list/string of warnings is also accepted, here or at state.trainability
    },
    // …OR, when the build failed, the draft-service error JSON itself:
    //   422 { "error": "infeasible-design", "gate": "actuator-frontier", "message": "…",
    //         "hints": [ { "field": "quadruped.strength", "direction": "decrease", "reason": "…", "value": 1.35 } ],
    //         "violations": ["…"], "design": { … } }
    //   400 { "error": "invalid-design", "message": "…", "issues": [ { "field": "…", "message": "…" } ] }
    // A free-text "error" string also counts as a failed build.
    "policies": { "walk": <status>, "jump": <status> }  // true | "ready"/"validated"/"pass" | {ready|pass|validated: true} | {status}
  },
  "language": "en"                              // optional BCP-47-ish tag; the LLM replies in it
}
```

If the last message is from the assistant, or there are no messages, Tinker reacts to the state:

- **Build failed (400/422):** Tinker proposes a revised design. Hints that carry a `value` are applied first; draft-service
  guarantees each one clears the gate. Direction-only hints are used when no hint has a value. If there are no hints,
  the gate and message decide the revision.
- **Build passed:**
  - `cannot-stand` (or `verdict.stand: fails`): Tinker proposes a revision directly.
  - Warnings: Tinker explains them and offers to fix them ("Fix it" or "yes" accepts).
  - Otherwise: Tinker reports the mass and the jump outlook, and suggests training.

The LLM prompt also carries the gate, the hints, the verdict and the flags.

Every proposed design also passes the schema's machine-readable template rules when the schema provides them:
`x-actuatorFamilies.<plan>.<family>.minimums` and `strengthMax` are enforced, and `x-designRules` is shown to the LLM.
On top of that, bilateral layouts with an odd leg count become radial. Each fix is listed in `repairs`.

Response:

```jsonc
{
  "ok": true,
  "reply": "Meet Ribbit: a bouncy frog bot…",      // <= 700 chars, plain text
  "actions": [
    { "type": "design", "design": { /* complete, schema-valid creature-design/1 */ } },
    { "type": "look",   "look":   { /* complete, schema-valid creature-look/1 */ } },
    { "type": "train",  "skills": ["walk"] | ["walk", "jump"] },
    { "type": "play" }
  ],
  "suggestions": ["Make it jump", "Paint it like a tiger"],   // 0..4 chips, <= 60 chars each; send back as user text
  "provider": {
    "name": "ollama" | "dashscope" | … | "offline",
    "model": "qwen3.5:4b" | "tinker-rules/1",
    "offline": false,
    "local": true,
    "kind": "local" | "cloud" | "offline",         // for the provider badge
    "fallbackReason": "provider_offline",          // only when a configured brain failed and the offline designer answered
    "fallbackFrom": { "name": "ollama", "model": "qwen3.5:4b" }
  },
  "repairs": ["design.quadruped.upperLeg clamped from 3 to 0.7"]   // optional: what validation fixed (max 8)
}
```

Action rules:

- Designs and looks are validated against `contracts/design.schema.json` and `contracts/look.schema.json`. Both are
  read at runtime and reloaded when they change. Out-of-range numbers are clamped, near-miss enums and colours are
  normalised, and invalid optional fields are dropped. Anything still invalid is never returned.
- A design action **never contains `look`**. Looks always come as a separate `look` action, so a cosmetic change can
  never alter a design or body hash. Clients that want `design.look` can merge it themselves.
- A design action holds the full design, not a patch. The client compares it with its current design to decide
  whether a rebuild is needed. A look-only turn ("make it look like a ladybug") returns only a `look` action.
- `train` is a proposal for the client to confirm and run; skills are `["walk"]` or `["walk", "jump"]`. `play` is
  only returned when `state.policies.walk` is ready.
- The reply never says that anything was built, trained or tested. Sentences that claim so are removed.

## `POST /decide` (legacy contract, unchanged)

Request: `{ "instruction": "1..2000 chars", "imageDataUrl": "data:image/png;base64,…", "observationId"?: "1..96 chars" }`.
No other fields are accepted.

Response:

```jsonc
{
  "ok": true,
  "decisionId": "uuid",
  "observationId": "frame-1",
  "action": { "operation": "forward" | "backward" | "turn_left" | "turn_right" | "stand",
              "vx": 0.35, "vy": 0, "wz": 0, "durationSeconds": 1.0 },   // 0.1..2.0 s; stand = 0
  "executesMotion": false,
  "provenance": {
    "source": "local_vlm" | "cloud_vlm",    // local_vlm when the eyes provider is on loopback (Ollama, LM Studio, custom 127.0.0.1)
    "provider": "ollama",                   // NEW in v2: preset name (ollama, lmstudio, dashscope, dashscope-cn, dashscope-us,
                                            // zhipu, zhipu-cn, gemini, openai, openrouter, custom)
    "model": "qwen3.5:4b",                  // the configured model id
    "imageSha256": "<64 hex>",              // hash of the exact PNG bytes received
    "elapsedMilliseconds": 812
  }
}
```

The model must return exactly `{"operation", "durationSeconds"}` within the bounds. Anything else gives
`502 invalid_model_response` with no `action`. The service never substitutes an action when the model is offline or
wrong. The v2 changes are `provenance.source` (it can now be `cloud_vlm`) and the added `provenance.provider`.
Clients that bind decisions to frames must accept both sources and should show the user when images went to the cloud.

## `POST /critique`

Request: `{ "imageDataUrl": "data:image/png;base64,…", "prompt"?: "<= 600 chars", "design"?: {…}, "look"?: {…} }`.

Response:

```jsonc
{
  "ok": true,
  "text": "Love the spots! A beetle shell would read as a ladybug from far away.",   // <= 600 chars
  "suggestions": ["Add a beetle shell"],                // 0..3, <= 80 chars
  "lookPatch": { "shell": { "kind": "beetle", "color": "#d93a32", "size": 1.3 } },  // optional
  "look": { /* the current look with the patch merged; complete and schema-valid */ },  // present with lookPatch
  "provider": { "name": "ollama", "model": "qwen3.5:4b", "offline": false, "local": true, "kind": "local" },
  "provenance": { "source": "local_vlm", "provider": "ollama", "model": "qwen3.5:4b",
                  "imageSha256": "<64 hex>", "elapsedMilliseconds": 1400 }
}
```

`lookPatch` is a partial `creature-look/1`: only changed top-level fields, never `schema`. Deep-merge it into the
current look, or just use the returned `look`. Invalid patch fields are dropped. A critique talks about looks only and
never changes physics.

## `GET /health`

`GET /health?refresh=1` skips the provider-status cache. The cache lasts 4 s for local providers and 60 s for cloud
providers.

```jsonc
{
  "ok": true, "service": "draft_ai_service", "version": 2,
  "offline": true,                       // true when Tinker would use the offline designer (no brain, or brain not ready)
  "roles": {
    "brain": { "configured": true, "kind": "local", "provider": "ollama", "label": "Ollama on this computer",
               "model": "qwen3.5:4b", "local": true, "reachable": true, "ready": true, "modelAvailable": true, "latencyMs": 4 },
    "eyes":  { "configured": false, "kind": "none", "reachable": false, "ready": false }
    // kind: "local" | "cloud" for a configured role; unconfigured brain = "offline" (offline designer), eyes = "none"
    // other fields that may appear: error (provider_offline | provider_missing_key | provider_auth_error |
    // model_not_pulled | model_not_listed | invalid_api_key_format | …), hint, modelListed, note
  },
  // legacy vlm-service fields (VisionCard): describe the eyes role
  "model": "qwen3.5:4b" | null,
  "provider": { "reachable": true, "ready": true, "name": "ollama", "local": true, "error"?: "…" },
  "busy": false, "successfulDecisions": 0, "executesMotion": false,
  "schemas": { "design": "creature-design/1", "look": "creature-look/1" },
  "configProblems": ["…"]                // only when config.json/.env.local had problems; never contains key values
}
```

## Error codes

| HTTP | code | When |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_image` | bad JSON, fields or PNG |
| 403 | `origin_denied`, `host_denied` | browser origin or Host not allowed |
| 404 | `not_found` | unknown route |
| 408 / 411 / 413 / 415 | `request_timeout`, `invalid_request`, `request_too_large` / `image_too_large`, `invalid_request` | transport limits |
| 429 | `busy` | concurrency limit reached |
| 502 | `invalid_model_response`, `provider_http_error`, `provider_auth_error`, `provider_not_found`, `provider_tls_error`, `model_refused`, `model_output_truncated` | provider failed or replied badly (vision routes; `/chat` falls back to the offline designer instead) |
| 503 | `provider_not_configured`, `provider_offline`, `provider_missing_key`, `provider_rate_limited` | no usable provider |
| 504 | `provider_timeout` | provider too slow |
| 500 | `internal_error` | unexpected; no action issued |

## Providers

All providers are OpenAI-compatible chat completions.
- Local: Ollama (`http://127.0.0.1:11434/v1`) and LM Studio (`http://127.0.0.1:1234/v1`).
- Cloud presets: Qwen via Alibaba Cloud Model Studio/DashScope (`dashscope` international, `dashscope-cn` mainland,
  `dashscope-us` with a workspace id), Zhipu GLM (`zhipu` Z.ai, `zhipu-cn` BigModel), Google Gemini (`gemini`,
  OpenAI-compatible endpoint), `openai`, `openrouter`, and `custom` (any HTTPS URL, or loopback http).
- Configuration lives in `ai-service/config.json` (git-ignored; an example is committed). It picks a provider and model
  per role. `AI_BRAIN` and `AI_EYES` (`<preset>:<model>`) override it.
- Keys come only from environment variables or the git-ignored `ai-service/.env.local`: `DASHSCOPE_API_KEY`,
  `ZHIPUAI_API_KEY`/`ZAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `LM_API_TOKEN`, or the
  name set in `api_key_env`. They are sent only in the `Authorization` header to that provider. They are never logged,
  never sent to the browser, and redirects are never followed.
- `scripts/setup-local-ai.sh` configures Ollama on a Mac, choosing the model from the Mac's RAM.

## Changes from the initial contract (v2 extensions, all additive)

- `/decide` provenance: `source` can be `cloud_vlm`, and `provider` was added (coordinator decision).
- `/chat`:
  - request accepts `language`, draft-service 400/422 error JSON as `state.body` (with `hints`), and body.json
    `trainability` (`verdict`, `flags`);
  - response adds `provider.local`, `provider.kind`, `provider.fallbackReason`, `provider.fallbackFrom` and `repairs`;
  - design actions never embed `look`, and they follow `x-actuatorFamilies` when the schema has it.
- `/critique` response adds `look`, `provider` and `provenance`.
- `/health` adds `roles` (with `kind`), `offline`, `version`, `schemas`, `configProblems` and `?refresh=1`, and keeps
  all legacy fields.
