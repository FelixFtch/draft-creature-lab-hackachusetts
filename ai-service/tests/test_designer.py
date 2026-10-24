"""Tinker with a (fake) brain provider: parsing, repair, retry, fallback, honesty."""
import json
import unittest

from designer import Tinker, scrub_claims
from providers import ProviderError
from schemas import DESIGN_ID, LOOK_ID, SchemaStore
from vision import ServiceError
from tests.helpers import CONTRACTS, FakeTransport, completion, provider

STORE = SchemaStore(CONTRACTS)
GOOD = {
    "reply": "Meet Ribbit: a springy frog bot with short, punchy legs, tuned to jump.",
    "design": {"schema": DESIGN_ID, "name": "Ribbit", "bodyPlan": "quadruped", "basePreset": "cheetah",
               "quadruped": {"torsoLength": 0.36, "upperLeg": 0.24, "lowerLeg": 0.23, "actuator": "qdd", "strength": 1.35},
               "skills": ["walk", "jump"]},
    "look": {"schema": LOOK_ID, "theme": "frog", "palette": {"body": "#4caf50"}},
    "train": None, "play": False, "suggestions": ["Longer legs", "Make it a poison dart frog"],
}
FROG_STATE = {"design": GOOD["design"], "look": GOOD["look"]}


def _envelope(reply):
    if isinstance(reply, Exception) or (isinstance(reply, dict) and "choices" in reply):
        return reply  # already a transport-level reply
    return completion(reply if isinstance(reply, str) else json.dumps(reply), model="m")


def tinker(replies, raw=None, env=None):
    transport = FakeTransport([_envelope(r) for r in replies])
    brain = provider(raw or {"provider": "custom", "base_url": "https://llm.example.com/v1", "model": "m"},
                     transport, env=env, role_name="brain")
    return Tinker(STORE, brain), transport


def chat(t, text="I want a frog that jumps onto platforms", state=None, messages=None):
    return t.chat({"messages": messages or [{"role": "user", "content": text}], "state": state or {}})


def actions(result):
    return {a["type"]: a for a in result["actions"]}


class TinkerModelTests(unittest.TestCase):
    def test_valid_output_becomes_validated_actions(self):
        t, transport = tinker([GOOD])
        result = chat(t)
        acts = actions(result)
        self.assertEqual(STORE.validate(DESIGN_ID, acts["design"]["design"]), [])
        self.assertEqual(STORE.validate(LOOK_ID, acts["look"]["look"]), [])
        self.assertEqual(result["provider"], {"name": "custom", "model": "m", "offline": False, "local": False, "kind": "cloud"})
        self.assertEqual(result["suggestions"], GOOD["suggestions"])
        payload = transport.posts[0]["payload"]
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(len(transport.posts), 1)

    def test_fenced_json_and_think_blocks_are_tolerated(self):
        text = "<think>hmm</think>Sure! Here you go:\n```json\n" + json.dumps(GOOD) + "\n```"
        t, _ = tinker([text])
        self.assertIn("design", actions(chat(t)))

    def test_out_of_range_values_are_clamped_and_reported(self):
        bad = json.loads(json.dumps(GOOD))
        bad["design"]["quadruped"].update({"upperLeg": 3.0, "strength": 9, "actuator": "Quasi-Direct-Drive", "wings": 2})
        bad["look"]["palette"]["body"] = "green"
        t, _ = tinker([bad])
        result = chat(t)
        quad = actions(result)["design"]["design"]["quadruped"]
        self.assertEqual((quad["upperLeg"], quad["strength"], quad["actuator"]), (0.7, 1.5, "qdd"))
        self.assertNotIn("wings", quad)
        self.assertRegex(actions(result)["look"]["look"]["palette"]["body"], r"^#[0-9a-f]{6}$")
        self.assertTrue(result["repairs"])

    def test_partial_design_merges_onto_current(self):
        partial = {"reply": "Longer legs coming up.", "design": {"quadruped": {"upperLeg": 0.3}}}
        t, _ = tinker([partial])
        design = actions(chat(t, "longer legs", FROG_STATE))["design"]["design"]
        self.assertEqual(design["name"], "Ribbit")
        self.assertEqual(design["quadruped"]["upperLeg"], 0.3)
        self.assertEqual(design["quadruped"]["actuator"], "qdd")

    def test_embedded_look_moves_to_its_own_action(self):
        value = json.loads(json.dumps(GOOD))
        value["design"]["look"] = value.pop("look")
        t, _ = tinker([value])
        acts = actions(chat(t))
        self.assertNotIn("look", acts["design"]["design"])
        self.assertEqual(acts["look"]["look"]["theme"], "frog")

    def test_plan_synonyms_and_wrong_sections(self):
        value = {"reply": "A hexapod!", "design": {"name": "Hexa", "bodyPlan": "hexapod",
                                                   "quadruped": {"upperLeg": 0.2, "torsoWidth": 0.3}}}
        t, _ = tinker([value])
        design = actions(chat(t, "a bug"))["design"]["design"]
        self.assertEqual(design["bodyPlan"], "multileg")
        self.assertEqual(design["multileg"]["legCount"], 6)
        self.assertNotIn("quadruped", design)
        self.assertEqual(design["multileg"]["upperLeg"], 0.2)

    def test_retry_with_validation_errors_then_success(self):
        t, transport = tinker(["I think a frog would be lovely!", GOOD])
        result = chat(t)
        self.assertFalse(result["provider"]["offline"])
        self.assertEqual(len(transport.posts), 2)
        retry_messages = transport.posts[1]["payload"]["messages"]
        self.assertIn("not a JSON object", retry_messages[-1]["content"])
        unrepairable = {"reply": "ok", "design": {"name": "X", "bodyPlan": "wheel"}}
        t, transport = tinker([unrepairable, GOOD])
        chat(t)
        self.assertIn("bodyPlan", transport.posts[1]["payload"]["messages"][-1]["content"])

    def test_invalid_twice_falls_back_to_offline_designer(self):
        t, transport = tinker(["nope", "still nope"])
        result = chat(t)
        self.assertTrue(result["provider"]["offline"])
        self.assertEqual(result["provider"]["fallbackReason"], "invalid_model_output")
        self.assertEqual(result["provider"]["fallbackFrom"], {"name": "custom", "model": "m"})
        self.assertIn("design", actions(result))

    def test_truncated_output_gets_one_shorter_retry(self):
        t, transport = tinker([completion('{"reply": "Meet', model="m", finish="length"), GOOD])
        result = chat(t)
        self.assertFalse(result["provider"]["offline"])
        self.assertIn("cut off", transport.posts[1]["payload"]["messages"][-1]["content"])

    def test_provider_down_or_keyless_falls_back(self):
        t, _ = tinker([ProviderError("provider_offline", "down", 503)])
        result = chat(t)
        self.assertEqual(result["provider"]["fallbackReason"], "provider_offline")
        t, transport = tinker([], raw={"provider": "gemini"}, env={})
        result = chat(t)
        self.assertEqual(result["provider"]["fallbackReason"], "provider_missing_key")
        self.assertEqual(transport.calls, [])

    def test_auth_errors_also_fall_back(self):
        t, _ = tinker([ProviderError("provider_auth_error", "HTTP 401", 502, 401)])
        self.assertEqual(chat(t)["provider"]["fallbackReason"], "provider_auth_error")

    def test_honesty_scrub(self):
        claim = dict(GOOD, reply="I've built Ribbit and trained it to walk! It can now walk. Once it's trained, try the park.")
        t, _ = tinker([claim])
        reply = chat(t)["reply"]
        self.assertNotIn("I've built", reply)
        self.assertNotIn("can now walk", reply)
        self.assertIn("Once it's trained", reply)
        self.assertEqual(scrub_claims("Your robot has been trained."), "Here's my proposal - press Build to let Draft check it.")
        self.assertEqual(scrub_claims("When it is built, Draft will check it."), "When it is built, Draft will check it.")

    def test_play_needs_a_ready_policy_and_train_is_normalised(self):
        value = dict(GOOD, design=None, look=None, train=["jump"], play=True, reply="Let's play in the park!")
        t, _ = tinker([value, value])
        result = chat(t, "let's play")
        self.assertNotIn("play", actions(result))
        self.assertEqual(actions(result)["train"]["skills"], ["walk", "jump"])
        self.assertIn("validated walking policy", result["reply"])
        result = chat(t, "let's play", {**FROG_STATE, "policies": {"walk": {"ready": True}}})
        self.assertIn("play", actions(result))

    def test_prompt_is_built_from_live_schemas_and_state(self):
        t, transport = tinker([GOOD])
        state = {**FROG_STATE, "body": {"id": "quadruped-1", "feasibility": {"passed": False,
                                                                            "warnings": ["knee torque too low"]}}}
        history = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"message {i} " + "x" * 900} for i in range(13)]
        chat(t, state=state, messages=history)
        messages = transport.posts[0]["payload"]["messages"]
        system = messages[0]["content"]
        for field in json.loads((CONTRACTS / "design.schema.json").read_text())["properties"]["quadruped"]["properties"]:
            self.assertIn(field, system)
        self.assertIn("114 real actuators", system)
        self.assertIn("Draft build FAILED: knee torque too low", system)
        self.assertNotIn("starter sketch", system)  # cloud models get no sketch hint
        self.assertEqual(len(messages), 1 + 8)
        self.assertTrue(all(len(m["content"]) < 800 for m in messages[1:]))
        self.assertIn("JSON", messages[-1]["content"])
        self.assertLess(len(system), 9000)

    def test_local_models_get_a_starter_sketch(self):
        t, transport = tinker([GOOD], raw={"provider": "ollama", "model": "qwen3.5:4b"})
        chat(t, "a spider please")
        self.assertIn("starter sketch", transport.posts[0]["payload"]["messages"][0]["content"])

    def test_no_new_user_message_reacts_to_state(self):
        t, transport = tinker([GOOD])
        chat(t, messages=[{"role": "user", "content": "a frog"}, {"role": "assistant", "content": "Here it is."}],
             state={**FROG_STATE, "body": {"feasibility": {"passed": False, "reasons": ["motor overlap"]}}})
        self.assertIn("React to the CURRENT STATE", transport.posts[0]["payload"]["messages"][-1]["content"])

    def test_request_validation(self):
        t, _ = tinker([])
        bad = [[], {"messages": "hi"}, {"messages": [{"role": "system", "content": "x"}]},
               {"messages": [{"role": "user", "content": "x" * 4001}]}, {"messages": [{"role": "user"}]},
               {"messages": [{"role": "user", "content": "x"}] * 41}, {"messages": [], "state": []},
               {"messages": [], "language": "english please"}, {"messages": [], "extra": 1}]
        for value in bad:
            with self.subTest(value=str(value)[:60]), self.assertRaises(ServiceError) as caught:
                t.chat(value)
            self.assertEqual(caught.exception.status, 400)

    def test_busy_when_two_answers_in_flight(self):
        t, _ = tinker([GOOD])
        t.slot.acquire(); t.slot.acquire()
        try:
            with self.assertRaises(ServiceError) as caught:
                chat(t)
            self.assertEqual(caught.exception.status, 429)
        finally:
            t.slot.release(); t.slot.release()

    def test_invalid_state_design_is_ignored_not_fatal(self):
        t, _ = tinker([GOOD])
        result = chat(t, state={"design": {"bodyPlan": "wheel"}, "look": "pink", "body": "nope", "policies": [1]})
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
