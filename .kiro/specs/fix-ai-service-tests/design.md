# Design: bring the ai-service tests up to date

## Overview
Fix the expectations at their source. Limits come from the live schema, and the prompt budget is enforced by the code that builds the prompt, not only by the tests.

## Components
- `ai-service/design_rules.py` / `designer.py`: the clamp function looks up `strengthMax` for the selected actuator class (the actuator catalogue in `contracts/design.schema.json`) and uses it as the effective maximum.
- `ai-service/schemas.py`: one `SUMMARY_BUDGET` and one `PROMPT_BUDGET` constant. The summariser shortens field descriptions until the summary fits; enums, ranges and required fields are never dropped.
- `ai-service/providers.py`: Ollama requests send `options.num_ctx`, computed from the prompt length plus a reply allowance.

## Testing strategy
- Update the three failing unit tests to read limits and budgets from the code and schema.
- Add property-based tests with **Hypothesis** (`pip install hypothesis` into `.venv`; tests skip cleanly if it is missing) in `ai-service/tests/test_properties.py`:
  - P1: clamp(design) validates against the schema.
  - P2: clamp is idempotent and records no repairs the second time.
  - P3: strength never exceeds the selected actuator's `strengthMax`.
  - P4: the summary stays within `SUMMARY_BUDGET` when any one description is doubled.
