# ai-service API (loopback, port 18383)

Owner: **ai** (finalise and keep accurate). Replaces `vlm-service/` and stays
backward compatible with its `POST /decide` and `GET /health`. The browser
reaches it through the Vite proxy as `/ai/<route>` (and legacy `/vlm/<route>`).

| Route | Purpose |
| --- | --- |
| `GET /health` | service + provider status: which roles are configured (brain = chat/design LLM, eyes = VLM), reachable, model ids, offline mode. Never returns keys. |
| `POST /chat` | Tinker design conversation. Request `{ messages: [{role:'user'|'assistant', content}], state: { design?, look?, body?: {id, feasibility, massKg, …}, policies?: {walk?, jump?} } }`. Response `{ ok, reply, actions: [ {type:'design', design} | {type:'look', look} | {type:'train', skills} | {type:'play'} ], suggestions: [string], provider: {name, model, offline} }`. Designs/looks are validated against `contracts/*.schema.json` (loaded at runtime) and repaired or dropped; the reply never claims something was built/trained. |
| `POST /decide` | legacy VLM drive proposal (unchanged contract, new providers). |
| `POST /critique` | `{ imageDataUrl, prompt?, design?, look? }` → `{ ok, text, suggestions?, lookPatch? }`: the VLM looks at a render of the creature. |

Providers: OpenAI-compatible chat completions. Local: Ollama
(`http://127.0.0.1:11434/v1`), LM Studio. Cloud presets: Qwen via DashScope
(international and mainland endpoints), Zhipu GLM, Google Gemini
(OpenAI-compatible endpoint), OpenAI, OpenRouter. Keys come from environment
variables or a git-ignored `ai-service/.env.local`. Config file
`ai-service/config.json` (git-ignored) picks a provider per role; an example
file is committed. With nothing configured, `/chat` runs the offline designer.
