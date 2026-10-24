# Implementation plan

- [ ] 1. Use the actuator-specific strength limit when clamping
  - Look up `strengthMax` for the selected actuator class from the schema catalogue and clamp to it
  - Record a repair entry whenever a value changes
  - Update `test_out_of_range_values_are_clamped_and_reported` to read the expected limit from the schema
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 2. Enforce prompt and summary budgets in code
  - Add `SUMMARY_BUDGET` and `PROMPT_BUDGET` in `ai-service/schemas.py`, with a comment explaining the target context
  - Shorten field descriptions in the summariser until the summary fits; never drop enums, ranges or required fields
  - Update `test_prompt_is_built_from_live_schemas_and_state` and `test_summaries_follow_live_schema` to use the constants
  - _Requirements: 2.1, 2.2_

- [ ] 3. Send a context size to Ollama
  - In `ai-service/providers.py`, set `options.num_ctx` from the prompt length plus a reply allowance
  - Add a unit test with a fake Ollama endpoint that checks the field
  - _Requirements: 2.3_

- [ ] 4. Add property-based tests with Hypothesis
  - Create `ai-service/tests/test_properties.py` with properties P1–P4 from design.md
  - Skip the module cleanly when `hypothesis` is not installed
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 5. Run the whole ai-service suite and Tinker offline mode
  - `cd ai-service && ../.venv/bin/python -m unittest discover -s tests` must report 0 failures
  - Start the stack and send one offline Tinker chat to confirm nothing regressed
  - _Requirements: all_
