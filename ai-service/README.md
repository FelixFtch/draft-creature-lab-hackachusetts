# ai-service: Tinker and the robot's eyes

A small loopback HTTP service (Python standard library only) on
`127.0.0.1:18383`. It replaces `vlm-service/`, keeps that service's `POST /decide`
contract, and adds Tinker, the design partner you chat with.

| Route | What it does |
| --- | --- |
| `GET /health` | Which roles are configured, provider names, model ids, reachability, offline mode. Never returns keys. |
| `POST /chat` | Tinker turns ideas into `creature-design/1` designs and `creature-look/1` looks, reacts to Draft build failures and trainer warnings. |
| `POST /decide` | AI Explore: one robot-camera PNG plus an instruction gives one bounded drive proposal. The service never moves the robot. |
| `POST /critique` | The vision model looks at a render of your creature and suggests style changes, with a validated `lookPatch`. |

Exact request and response shapes are in [`contracts/ai-api.md`](../contracts/ai-api.md).

There are two roles. Each can use a different provider:

- **brain**: the chat/design model behind `/chat`.
- **eyes**: the vision model (VLM) behind `/decide` and `/critique`.

With nothing configured, Tinker still works using its built-in **offline designer**: rule-based, playful, and
always schema-valid. `/decide` and `/critique` answer `503 provider_not_configured` until you set up eyes.

## Quick start

```bash
python3 ai-service/server.py                # 127.0.0.1:18383, offline designer
curl -s http://127.0.0.1:18383/health       # what is configured and reachable
python3 ai-service/server.py --check        # print health once and exit (no inference)
```

The lab's `start.sh` starts the service for you. In the browser it is reachable as `/ai/*`, and as `/vlm/*` for the
legacy vision card.

## Local AI on your Mac (private, no key needed)

On an Apple-silicon Mac, one command does everything:

```bash
scripts/setup-local-ai.sh             # or: --dry-run to see the plan first
```

It reads the chip and memory with `sysctl`. It installs Ollama with Homebrew if needed; without Homebrew it prints the
official install command instead. It starts Ollama, pulls a vision model sized for your RAM, and sends one small test
image through `/v1/chat/completions` to check that the model can actually see. Then it writes
`ai-service/config.json` for both roles. It is safe to run again: an installed Ollama, a downloaded model and an
unchanged config are left as they are.

| Your Mac | Default model | Download | Why |
| --- | --- | --- | --- |
| less than 12 GB (8 GB Macs) | `qwen3-vl:2b-instruct` | ~1.9 GB | The lab also runs MuJoCo in the browser and trains on the CPU, so the model must stay small. The instruct tag skips "thinking" for fast answers. |
| 12 to 23 GB (16 GB Mac mini) | `qwen3.5:4b` | ~3.3 to 4.0 GB | Natively multimodal Qwen3.5. Good JSON designs and vision, with room left for training. |
| 24 GB or more | `qwen3.5:9b` | ~6.6 to 7.6 GB | Noticeably better at designing and seeing, still quick. |
| Intel Mac | `qwen3-vl:2b-instruct` | ~1.9 GB | Ollama runs on the CPU only. |

Choose a different model with `--model`, for example:
- `--model qwen3-vl:4b-instruct` or `--model qwen3-vl:8b-instruct`, for no thinking at all.
- `--model gemma4:e4b`.
- On 48 GB or more, `--model qwen3.5:35b-a3b`, a mixture-of-experts model with about 3B active parameters, so it is
  fast for its size.

Other options:
- `--roles eyes` sets up only the vision role, so you can keep a cloud brain.
- `--update` pulls the model again.
- `--skip-smoke` writes the config without sending the test image.

Note: the plain `qwen3-vl:2b`, `:4b` and `:8b` tags point at the thinking variants, which answer slower. That is why
the script uses the `-instruct` tags. For models that report a thinking capability (such as Qwen3.5), the script
writes `"reasoning_effort": "none"` into the config, and Ollama then answers without thinking. If you configure by
hand, add it yourself.

To set things up by hand instead:

1. Install Ollama. The official methods are `curl -fsSL https://ollama.com/install.sh | sh`, or the
   [Ollama.dmg](https://ollama.com/download/Ollama.dmg) app (needs macOS 14 or newer), or `brew install ollama`.
2. Pull a model:

   ```bash
   ollama pull qwen3.5:4b
   ```

3. Create `ai-service/config.json`:

   ```json
   {
     "roles": {
       "brain": {"provider": "ollama", "model": "qwen3.5:4b", "reasoning_effort": "none"},
       "eyes":  {"provider": "ollama", "model": "qwen3.5:4b", "reasoning_effort": "none"}
     }
   }
   ```

**LM Studio** works too. Load a vision model and start its server, then use
`{"provider": "lmstudio", "model": "<the model id LM Studio shows>"}`. The default address is `http://127.0.0.1:1234/v1`.

## Cloud providers

Use a cloud provider if your Mac is small or you want a stronger brain. **Keys never go in `config.json`.** Either
export them in your shell, or put them in the git-ignored `ai-service/.env.local` and run `chmod 600` on it:

```bash
# ai-service/.env.local
DASHSCOPE_API_KEY=sk-...
ZHIPUAI_API_KEY=...
GEMINI_API_KEY=...
```

The service reads keys from the environment first, then from `.env.local`. They go only into the `Authorization`
header of requests to that provider. They are never logged, never sent to the browser, and never included in errors.

| Preset | Endpoint | Key variable | Default brain / eyes |
| --- | --- | --- | --- |
| `dashscope` (Qwen, international/Singapore) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen3.8-flash` / `qwen3.8-flash` |
| `dashscope-cn` (Qwen, mainland China/Beijing) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen3.8-flash` / `qwen3.8-flash` |
| `dashscope-us` (Qwen, Virginia) | `https://{workspace}.us-east-1.maas.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen3.8-flash` / `qwen3.8-flash` |
| `zhipu` (GLM on Z.ai, international) | `https://api.z.ai/api/paas/v4` | `ZHIPUAI_API_KEY` or `ZAI_API_KEY` | `glm-4.7-flash` / `glm-4.6v-flash` (both free) |
| `zhipu-cn` (GLM on BigModel, mainland China) | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPUAI_API_KEY` or `ZAI_API_KEY` | `glm-4.7-flash` / `glm-4.6v-flash` (both free) |
| `gemini` (Google, OpenAI-compatible) | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-3.8-flash` / `gemini-3.8-flash` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-6-luna` / `gpt-6-luna` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `qwen/qwen3.8-flash` / `qwen/qwen3.8-flash` |
| `custom` | any HTTPS URL, or http on 127.0.0.1 | `api_key_env` you choose | (required) |

Examples (`ai-service/config.json`):

```json
{"roles": {"brain": {"provider": "dashscope"}, "eyes": {"provider": "dashscope"}}}
```

```json
{"roles": {"brain": {"provider": "zhipu-cn"}, "eyes": {"provider": "zhipu-cn", "model": "glm-4.6v-flash"}}}
```

```json
{"roles": {"brain": {"provider": "gemini", "model": "gemini-3.8-flash"},
           "eyes":  {"provider": "ollama", "model": "qwen3.5:4b", "reasoning_effort": "none"}}}
```

If you leave out the model, each preset uses its default. A quick test without a config file:
`AI_BRAIN=dashscope:qwen3.8-flash AI_EYES=gemini:gemini-3.8-flash python3 ai-service/server.py`.

Provider notes:

- **Qwen / DashScope (Alibaba Cloud Model Studio).**
  - API keys are tied to a region. A Beijing key gets `401 invalid_api_key` on the Singapore endpoint and the other
    way round.
  - Model Studio now recommends workspace domains: set `"workspace_id": "..."` (or `DASHSCOPE_WORKSPACE_ID`) and
    the service uses `https://{workspace}.ap-southeast-1.maas.aliyuncs.com/...` (Singapore) or `...cn-beijing...`
    (mainland).
  - Qwen3.5 and newer models "think" by default, so the service sends `enable_thinking: false` for quick answers.
  - For images, the system prompt is merged into the user message, as Model Studio recommends.
  - Other vision models: `qwen3.8-max`, `qwen3.7-plus`, `qwen3-vl-plus`, `qwen3-vl-flash`.
- **Zhipu GLM.**
  - `glm-4.6v-flash` (vision) and `glm-4.7-flash` (text) are free. The service sends `thinking: {type: disabled}`.
  - `glm-5.3-flash` is natively multimodal and cheap, but its thinking cannot be turned off. Expect slower answers,
    and raise `max_tokens` (for example to 4096) if you use it.
  - Since 16 October 2026, Z.ai manages Coding Plan keys separately from standard API keys. Use a standard API key.
- **Gemini.**
  - Gemini 3 models cannot switch reasoning off, so the service asks for `reasoning_effort: "low"` and leaves extra
    output budget.
  - `gemini-3.5-flash-lite` is the cheapest stable option.
- **OpenAI.** The service uses `max_completion_tokens`, `reasoning_effort: "none"`, and no temperature.
- If a provider rejects an optional parameter (`HTTP 400`, for example no JSON mode), the service retries once with
  only `model`, `messages` and `stream`, and keeps that setting from then on.

## Configuration reference

`ai-service/config.json` is git-ignored. Every field is optional:

```jsonc
{
  "port": 18383,
  "allowed_origins": ["http://127.0.0.1:18381", "http://localhost:18381"],  // loopback only; LAB_PORT adds its pair
  "roles": {
    "brain": {
      "provider": "ollama",            // a preset from the table above
      "model": "qwen3.5:4b",           // default: the preset's model for this role
      "base_url": "http://127.0.0.1:11434/v1",  // override; must stay on the preset's hosts (any https for custom)
      "api_key_env": "MY_KEY_VAR",     // names the variable, never the key itself
      "workspace_id": "ws-123",        // dashscope presets only
      "timeout_seconds": 90,           // default 90 local / 45 cloud
      "max_tokens": 900, "temperature": 0.7,
      "reasoning_effort": "none",      // none|minimal|low|medium|high|default
      "json_mode": true,               // send response_format json_object
      "extra_body": {"top_k": 20}      // small extra request fields (cannot override model/messages/...)
    },
    "eyes": "brain"                     // same settings as brain
  }
}
```

An old `vlm-service/config.json` (with `endpoint`/`model`) is also accepted. It becomes the eyes role.

A broken configuration never takes the lab down. The affected role is disabled, and the reason appears under
`configProblems` in `GET /health` and on stderr. Keys never appear there.

Environment variables:
- Keys: `DASHSCOPE_API_KEY`, `ZHIPUAI_API_KEY`/`ZAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`, `LM_API_TOKEN`.
- `DASHSCOPE_WORKSPACE_ID`.
- `AI_BRAIN` and `AI_EYES` (`<preset>:<model>`).
- `LAB_PORT`: the extra allowed browser origin.
- `AI_CONTRACTS_DIR`: where the schemas live (default `contracts/`).

## Privacy: what leaves your computer

- **Local providers (Ollama, LM Studio, custom on 127.0.0.1): nothing.** Requests go to `127.0.0.1` and never
  through a proxy.
- **Cloud providers receive only what each request needs:**
  - `/chat`: the last 8 chat messages, the current design and look, and a short build/training status (feasibility
    messages, mass, policy readiness).
  - `/decide`: the robot-camera PNG and your instruction.
  - `/critique`: the render PNG, your question, and the design/look.
- **Never sent:** API keys to the browser, and file paths, other projects or anything else on disk to anyone.
- The service binds `127.0.0.1` only. It rejects browser origins that are not loopback and Host headers that are not
  loopback (a guard against DNS rebinding). It limits request and response sizes, does not follow redirects (so a key
  cannot be forwarded), and does not log request bodies, images, provider responses or keys.
- `/decide` provenance says `local_vlm` or `cloud_vlm` and names the provider, so the UI can be honest about where an
  image went.

## How Tinker designs

1. The prompt is built at runtime from `contracts/design.schema.json` and `contracts/look.schema.json`, so new fields
   and new bounds are picked up without code changes. It is kept compact enough for Ollama's default 4k context.
2. The model answers with one JSON object (`reply`, `design`, `look`, `train`, `play`, `suggestions`). The service
   then:
   - parses it leniently (code fences and `<think>` blocks are tolerated);
   - merges partial designs onto the current one;
   - clamps out-of-range numbers, normalises near-miss enums ("Quasi-Direct-Drive" becomes `qdd`, "green" becomes
     `#3fa34d`), and drops unknown fields;
   - asks the model again once with the validation errors;
   - falls back to the offline designer if it still fails. The response then reports `provider.offline` and
     `fallbackReason`.
3. Small local models get an optional, schema-valid "starter sketch" from the offline designer to copy and improve.
4. Draft's feedback goes into the loop.
   - When the client passes the draft-service 422 response (`gate`, `message`, `hints`) or the body's
     `trainability` (`verdict`, `flags`), Tinker revises with them.
   - Hint values are applied as given, because draft-service guarantees each one clears the gate.
   - The schema's `x-designRules` go into the prompt, and the `x-actuatorFamilies` minimums and strength limits are
     enforced on every design. Many builds then pass the first time.
5. Looks are always separate `look` actions and never part of the design. Looks never change physics, so a trained
   policy stays valid.
6. Replies never claim that something was built or trained. Sentences like "I've built it" or "it can now walk" are
   removed. Building and training are the client's job.

The offline designer knows dozens of creatures:
- Frogs, kangaroos and bunnies become strong, light QDD hoppers with jump.
- Spiders, octopuses and jellyfish become 8-leg radial walkers.
- Beetles, ants, bees and ladybugs become 6-leg bilateral walkers.
- Crabs and scorpions become 8-leg paired walkers; centipedes get long bodies.
- Dogs, cats, foxes and big cats become runners on Cheetah proportions.
- Bears, tanks, mules and elephants become geared haulers.
- Giraffes and llamas become long-legged harmonic walkers; horses and unicorns become long-striding trotters.
- Mice and hamsters become micro-servo critters; lizards, crocs and dragons become low, wide crawlers.
- Turtles, flowers, starfish (5 legs) and alien tripods (3 legs) each get their own body.

In total it recognises about 200 creature words across 16 body families. It also has 88 looks, including ladybug,
tiger, panda, robot, candy, lava, ice, jade dragon, astronaut, galaxy, neon, steampunk and dalmatian. It understands:
- "make it look like X", "paint it purple and gold", "add wings and a crown";
- "bigger", "smaller", "longer legs", "make it jump", "six legs", "faster", "sturdier", "call it ...";
- train and play requests, "what is Draft?", and Draft feasibility failures, which it revises according to the
  reason (torque, motor overlap, speed).

It asks one clarifying question when a request is too vague, and varies its phrasing per conversation.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/health` shows `error: provider_offline` for Ollama | Open the Ollama app, or run `ollama serve`, `brew services start ollama`, or `scripts/setup-local-ai.sh`. |
| `model_not_pulled` | `ollama pull <model>` (the hint field shows the exact command). |
| The first answer takes a minute | Ollama loads the model on first use, and unloads it after 5 idle minutes. Later answers are faster. |
| Tinker forgets the schema or rambles on a small Mac | Ollama gives under-24 GB machines a 4k context. Tinker's prompt fits, but you can give it more room with `OLLAMA_CONTEXT_LENGTH=8192 ollama serve` or the context slider in the Ollama app. |
| Replies come from the offline designer | `provider.fallbackReason` in the `/chat` response says why: `provider_offline`, `provider_missing_key`, `provider_auth_error`, `invalid_model_output`, and so on. |
| `provider_auth_error` with DashScope | The key's region must match the endpoint (`dashscope` is international, `dashscope-cn` is mainland), or use your workspace domain. |
| `provider_tls_error` | Python cannot verify HTTPS certificates. With the python.org installer, run "Install Certificates.command" once. Homebrew Python works as is. |
| `provider_rate_limited` | Wait, check your quota, or switch to a local model. |
| `429 busy` | One `/decide` and one `/critique` run at a time; `/chat` allows two. Retry after the current answer. |
| `invalid_model_response` from `/decide` | The model's reply was not exactly one bounded action. The robot stays still; try a stronger vision model. |
| Slow cloud answers with GLM-5.3 or Gemini | Thinking cannot be turned off for these models. Use `glm-4.6v-flash`, or `gemini-3.5-flash-lite`. |

## Tests

```bash
python3 -m unittest discover -s ai-service -p 'test_*.py'
```

The tests use fake transports, a real HTTP mock of the OpenAI and Ollama APIs, an end-to-end run of `server.py` as a
separate process, and the setup script against fake `uname`, `sysctl`, `brew` and `ollama` tools. They need no keys,
no network and no model. Passing them shows the contracts and safety checks hold. It does not show that any
particular model designs or drives well.

## Sources (checked October 2026)

- Ollama OpenAI compatibility (image input, `response_format`, `reasoning_effort`, `/v1/models`): https://docs.ollama.com/api/openai-compatibility
- Ollama on macOS (dmg install, macOS 14+): https://docs.ollama.com/macos · install command and dmg: https://ollama.com/download/mac · Homebrew formula `ollama` 0.40.10: https://formulae.brew.sh/formula/ollama
- Ollama default context lengths: https://docs.ollama.com/context-length · thinking control: https://docs.ollama.com/capabilities/thinking
- Ollama model tags: https://ollama.com/library/qwen3-vl/tags · https://ollama.com/library/qwen3.5/tags · https://ollama.com/library/gemma4/tags
- Alibaba Cloud Model Studio OpenAI compatibility (regions, workspace domains, region-bound keys): https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
- Model Studio recommended models: https://www.alibabacloud.com/help/en/model-studio/models · vision and `enable_thinking`: https://www.alibabacloud.com/help/en/model-studio/vision · JSON mode: https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output
- Z.ai OpenAI SDK base URL: https://docs.z.ai/guides/develop/openai/python · GLM-4.6V models: https://docs.z.ai/guides/vlm/glm-4.6v · GLM-5.3-Flash: https://docs.z.ai/guides/vlm/glm-5.3-flash · thinking mode: https://docs.z.ai/guides/capabilities/thinking-mode · JSON mode: https://docs.z.ai/guides/capabilities/struct-output · pricing (free flash models): https://docs.z.ai/guides/overview/pricing · separate standard/Coding Plan keys: https://docs.z.ai/devpack/notice/api-key-management
- BigModel OpenAI compatibility (mainland endpoint): https://docs.bigmodel.cn/cn/guide/develop/openai/introduction · model overview: https://docs.bigmodel.cn/cn/guide/start/model-overview
- Gemini OpenAI compatibility (base URL, reasoning mapping): https://ai.google.dev/gemini-api/docs/openai · model list: https://ai.google.dev/gemini-api/docs/models
- OpenAI models: https://developers.openai.com/api/docs/models · GPT-6 Luna (Chat Completions, `reasoning_effort: none`): https://developers.openai.com/api/docs/models/gpt-6-luna
- OpenRouter: https://openrouter.ai/docs/quickstart · model list: https://openrouter.ai/api/v1/models
- LM Studio OpenAI compatibility: https://lmstudio.ai/docs/developer/openai-compat
