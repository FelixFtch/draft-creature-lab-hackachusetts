# Requirements: bring the ai-service tests up to date

## Introduction

`(cd ai-service && ../.venv/bin/python -m unittest discover -s tests)` currently reports 3 failures out of 123 tests. The failures come from stale expectations, not from broken behaviour. The design schema (`contracts/design.schema.json`) gained per-actuator strength limits and more fields after the tests were written:

- `test_designer.TinkerModelTests.test_out_of_range_values_are_clamped_and_reported` expects strength `1.5`. For the `qdd` actuator class, the schema now caps strength at `strengthMax: 1.35`.
- `test_designer.TinkerModelTests.test_prompt_is_built_from_live_schemas_and_state` measures the prompt at 11,740 characters, over its 9,000 budget.
- `test_schemas.ContractSchemaTests.test_summaries_follow_live_schema` measures the schema summaries at 7,112 characters, over their 5,200 budget. That budget exists to keep Tinker's prompt inside a small local model's context.

## Requirements

### Requirement 1: clamping follows the live schema

**User Story:** As a designer chatting with Tinker, I want out-of-range values clamped to what the chosen actuator can really do, so that Draft never receives an impossible spec.

#### Acceptance Criteria
1. WHEN a model proposes a strength above the selected actuator class's `strengthMax` THEN the ai-service SHALL clamp it to that `strengthMax`, not to the generic schema maximum.
2. WHEN any numeric design field is outside its schema range THEN the ai-service SHALL clamp it into range AND record a repair entry the UI can show.
3. WHEN unknown fields such as `wings` appear THEN the ai-service SHALL drop them and record a repair.
4. The tests SHALL derive expected limits from the loaded schema instead of hard-coding them.

### Requirement 2: prompts fit the model's context

**User Story:** As a user running a small local model (for example `qwen3-vl:2b-instruct` in Ollama), I want Tinker's prompt to fit the model's context window, so that replies are not truncated.

#### Acceptance Criteria
1. The ai-service SHALL keep the schema summaries and the full Tinker prompt within explicit budgets. Each budget is defined once, next to the code that builds the prompt.
2. IF the summaries exceed the budget THEN the summariser SHALL shorten descriptions (field descriptions first, enums and ranges never) until they fit.
3. WHEN the provider is `ollama` THEN the request SHALL set a context size (`num_ctx`) large enough for the prompt plus the reply.

### Requirement 3: property-based tests

**User Story:** As a maintainer, I want property-based tests for the clamping and summarising code, so that future schema changes cannot silently break them.

#### Acceptance Criteria
1. For any generated design value (numbers in and out of range, strings, unknown keys), clamping SHALL produce a design that validates against `contracts/design.schema.json`.
2. Clamping SHALL be idempotent: clamping an already-clamped design changes nothing and records no repairs.
3. The summary length SHALL stay within budget for the live schema, and for the live schema with any single description doubled in length.
