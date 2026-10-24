"""draft-service feedback (422 hints, 400 issues, trainability) and design rules."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from design_rules import enforce, fit_multileg
from designer import Tinker
from offline_designer import StateView
from schemas import DESIGN_ID, SchemaStore
from tests.helpers import CONTRACTS, FakeTransport, completion, provider

FROG = {"schema": DESIGN_ID, "name": "Ribbit", "bodyPlan": "quadruped", "basePreset": "cheetah",
        "quadruped": {"torsoLength": 0.36, "torsoWidth": 0.22, "torsoHeight": 0.12, "shoulderWidth": 0.18,
                      "hipOffset": 0.08, "upperLeg": 0.24, "lowerLeg": 0.23, "actuator": "qdd", "strength": 1.35},
        "skills": ["walk", "jump"]}
FRONTIER_422 = {"error": "infeasible-design", "gate": "actuator-frontier",
                "message": "[L]: power density 749 W/kg beats the best catalogued QDD actuator (728 W/kg, RS06).",
                "hints": [{"field": "quadruped.strength", "direction": "decrease", "reason": "denser than any part", "value": 1.2},
                          {"field": "quadruped.actuator", "direction": "change", "reason": "power density binds"},
                          {"field": "evil", "direction": "drop"}],
                "violations": ["[L]: power density 749 W/kg beats the best catalogued QDD actuator"], "design": FROG}
PACKING_422 = {"error": "infeasible-design", "gate": "actuator-packing", "message": "actuator packing: fl_knee interpenetrates",
               "hints": [{"field": "quadruped.strength", "direction": "decrease", "reason": "weaker is smaller"},
                         {"field": "quadruped.hipOffset", "direction": "increase", "reason": "room"}]}
INVALID_400 = {"error": "invalid-design", "message": "Design does not match the schema",
               "issues": [{"field": "multileg.legCount", "message": "bilateral needs an even count"}]}
BODY_OK = {"id": "quadruped-abc", "massKg": 9.1, "feasibility": {"passed": True, "warnings": []},
           "trainability": {"verdict": {"stand": "ok", "walk": "plausible", "jump": "capable"},
                            "flags": [{"code": "dynamic-gait", "severity": "info", "message": "trot gait"}]}}
BODY_WEAK = {"id": "quadruped-abc", "massKg": 21.0, "feasibility": {"passed": True},
             "trainability": {"verdict": {"stand": "marginal", "walk": "hard", "jump": "unlikely"},
                              "flags": [{"code": "may-struggle-to-walk", "severity": "warning", "message": "gait load 0.95"},
                                        {"code": "jump-unlikely", "severity": "warning", "message": "jump verdict unlikely"}]}}
BODY_FALLS = {"id": "quadruped-abc", "feasibility": {"passed": True},
              "trainability": {"verdict": {"stand": "fails"}, "flags": [{"code": "cannot-stand", "severity": "error",
                                                                       "message": "stand load 1.4"}]}}

STORE = SchemaStore(CONTRACTS)
TINKER = Tinker(STORE)


def chat(state, text=None, tinker=TINKER):
    history = [{"role": "user", "content": "a frog"}, {"role": "assistant", "content": "Here is Ribbit."}]
    if text:
        history.append({"role": "user", "content": text})
    return tinker.chat({"messages": history, "state": state})


def design_of(result):
    return next((a["design"] for a in result["actions"] if a["type"] == "design"), None)


class FeedbackTests(unittest.TestCase):
    def test_state_view_reads_draft_service_errors(self):
        view = StateView({"body": FRONTIER_422}, FROG, None)
        self.assertTrue(view.failed)
        self.assertEqual(view.gate, "actuator-frontier")
        self.assertIn("749 W/kg", view.feasibility_messages[0])
        self.assertEqual([h["field"] for h in view.hints], ["quadruped.strength", "quadruped.actuator"])
        view = StateView({"body": INVALID_400}, FROG, None)
        self.assertTrue(view.failed)
        self.assertIn("multileg.legCount: bilateral needs an even count", view.feasibility_messages)
        view = StateView({"body": BODY_WEAK}, FROG, None)
        self.assertFalse(view.failed)
        self.assertEqual(view.verdict["jump"], "unlikely")
        self.assertEqual(view.flags, ["may-struggle-to-walk", "jump-unlikely"])
        self.assertEqual(len(view.trainability), 2)
        self.assertEqual(StateView({"body": BODY_OK}, FROG, None).trainability, [])  # info flags are not warnings

    def test_hint_values_are_applied_and_win(self):
        result = chat({"design": FROG, "body": FRONTIER_422})
        revised = design_of(result)
        self.assertEqual(revised["quadruped"]["strength"], 1.2)
        self.assertEqual(revised["quadruped"]["actuator"], "qdd")  # value hint wins; jumpers keep QDD
        self.assertIn("actuator frontier", result["reply"])
        self.assertIn("Draft's own hints", result["reply"])

    def test_direction_hints_when_no_value(self):
        revised = design_of(chat({"design": FROG, "body": PACKING_422}))
        self.assertEqual(revised["quadruped"]["strength"], 1.2)
        self.assertGreater(revised["quadruped"]["hipOffset"], FROG["quadruped"]["hipOffset"])

    def test_design_from_422_payload_is_used_when_state_has_none(self):
        revised = design_of(chat({"body": FRONTIER_422}))
        self.assertEqual(revised["name"], "Ribbit")
        self.assertEqual(revised["quadruped"]["strength"], 1.2)

    def test_after_build_reactions(self):
        happy = chat({"design": FROG, "body": BODY_OK})
        self.assertIn("9.1 kg", happy["reply"])
        self.assertIn("Jump outlook: capable", happy["reply"])
        self.assertEqual(happy["actions"], [])
        self.assertIn("Train it", happy["suggestions"])
        weak = chat({"design": FROG, "body": BODY_WEAK})
        self.assertIn("gait load 0.95", weak["reply"])
        self.assertEqual(weak["actions"], [])
        self.assertIn("Fix it", weak["suggestions"])
        fixed = chat({"design": FROG, "body": BODY_WEAK}, "fix it")
        self.assertIsNotNone(design_of(fixed))
        falls = chat({"design": FROG, "body": BODY_FALLS})
        revised = design_of(falls)
        self.assertLess(revised["quadruped"]["upperLeg"], FROG["quadruped"]["upperLeg"])
        history = [{"role": "user", "content": "a frog"}, {"role": "assistant", "content": weak["reply"]},
                   {"role": "user", "content": "yes"}]
        accepted = TINKER.chat({"messages": history, "state": {"design": FROG, "body": BODY_WEAK}})
        self.assertIsNotNone(design_of(accepted))

    def test_llm_prompt_carries_gate_hints_and_verdict(self):
        transport = FakeTransport([completion('{"reply": "Fixed!"}', model="m")])
        brain = provider({"provider": "custom", "base_url": "https://llm.example.com/v1", "model": "m"}, transport,
                         role_name="brain")
        chat({"design": FROG, "body": FRONTIER_422}, "fix it", Tinker(STORE, brain))
        system = transport.posts[0]["payload"]["messages"][0]["content"]
        self.assertIn("gate actuator-frontier", system)
        self.assertIn("quadruped.strength decrease to 1.2", system)
        transport = FakeTransport([completion('{"reply": "Hmm."}', model="m")])
        brain = provider({"provider": "custom", "base_url": "https://llm.example.com/v1", "model": "m"}, transport,
                         role_name="brain")
        chat({"design": FROG, "body": BODY_WEAK}, "why is it hard?", Tinker(STORE, brain))
        system = transport.posts[0]["payload"]["messages"][0]["content"]
        self.assertIn("Trainability verdict: stand marginal, walk hard, jump unlikely", system)
        self.assertIn("gait load 0.95", system)


class RuleTests(unittest.TestCase):
    """A schema carrying the morphology agent's x-extensions."""

    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        design = json.loads((CONTRACTS / "design.schema.json").read_text())
        design["x-designRules"] = ["Give the block that matches bodyPlan.", "Quadruped qdd strength <= 1.35."]
        design["x-actuatorFamilies"] = {
            "quadruped": {"qdd": {"strengthMax": 1.35, "minimums": {"shoulderWidth": 0.14, "hipOffset": 0.08}},
                          "geared": {"strengthMax": 1.5, "minimums": {"shoulderWidth": 0.19, "hipOffset": 0.15}}},
            "multileg": {"micro": {"strengthMax": 1.5, "minimums": {"coxa": 0.08}},
                         "qdd": {"strengthMax": 1.5, "minimums": {"coxa": 0.09}}}}
        (cls.dir / "design.schema.json").write_text(json.dumps(design))
        shutil.copy(CONTRACTS / "look.schema.json", cls.dir / "look.schema.json")
        cls.store = SchemaStore(cls.dir)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir)

    def test_family_minimums_and_strength_cap(self):
        design = json.loads(json.dumps(FROG))
        design["quadruped"].update({"strength": 1.5, "hipOffset": 0.06, "shoulderWidth": 0.12})
        fixed, notes = enforce(self.store, design)
        self.assertEqual((fixed["quadruped"]["strength"], fixed["quadruped"]["hipOffset"], fixed["quadruped"]["shoulderWidth"]),
                         (1.35, 0.08, 0.14))
        self.assertEqual(len(notes), 3)
        bear = {"schema": DESIGN_ID, "name": "B", "bodyPlan": "quadruped", "basePreset": "bear",
                "quadruped": {"hipOffset": 0.1, "shoulderWidth": 0.3}}
        fixed, _ = enforce(self.store, bear)  # family from the preset (geared)
        self.assertEqual(fixed["quadruped"]["hipOffset"], 0.15)

    def test_multileg_rules(self):
        odd = {"schema": DESIGN_ID, "name": "O", "bodyPlan": "multileg",
               "multileg": {"legCount": 5, "arrangement": "bilateral", "bodyAspect": 1.8, "coxa": 0.05}}
        fixed, notes = enforce(self.store, odd)
        self.assertEqual(fixed["multileg"]["arrangement"], "radial")
        self.assertEqual(fixed["multileg"]["coxa"], 0.08)
        self.assertLessEqual(fixed["multileg"]["bodyAspect"], 1.2)
        detail = {"legCount": 8, "arrangement": "radial", "bodyRadius": 0.09, "bodyAspect": 1.5, "coxa": 0.09,
                  "upperLeg": 0.3, "lowerLeg": 0.2, "actuator": "qdd", "strength": 1.3}
        fit_multileg(detail, "qdd")
        self.assertEqual((detail["bodyRadius"], detail["bodyAspect"], detail["coxa"]), (0.11, 1.2, 0.10))
        self.assertLessEqual(detail["upperLeg"], detail["lowerLeg"])
        crab = {"legCount": 8, "arrangement": "bilateral", "bodyRadius": 0.12, "bodyAspect": 1.0}
        fit_multileg(crab)
        self.assertEqual(crab["bodyAspect"], 1.6)
        big = {"legCount": 6, "bodyRadius": 0.22, "upperLeg": 0.3, "lowerLeg": 0.32}
        fit_multileg(big)
        self.assertLessEqual(big["upperLeg"] + big["lowerLeg"], 0.5 + 1e-9)

    def test_rules_reach_the_prompt_and_every_design(self):
        transport = FakeTransport([completion(json.dumps({"reply": "A strong frog!", "design": {
            "name": "Hulk", "bodyPlan": "quadruped", "quadruped": {"actuator": "qdd", "strength": 1.5, "hipOffset": 0.07}}}),
            model="m")])
        brain = provider({"provider": "custom", "base_url": "https://llm.example.com/v1", "model": "m"}, transport,
                         role_name="brain")
        result = Tinker(self.store, brain).chat({"messages": [{"role": "user", "content": "a super strong frog"}]})
        system = transport.posts[0]["payload"]["messages"][0]["content"]
        self.assertIn("Draft design rules", system)
        self.assertIn("Quadruped qdd strength <= 1.35.", system)
        design = design_of(result)
        self.assertEqual((design["quadruped"]["strength"], design["quadruped"]["hipOffset"]), (1.35, 0.08))
        self.assertTrue(any("capped" in r for r in result["repairs"]))

    def test_offline_designs_already_follow_the_rules(self):
        tinker = Tinker(self.store)
        for text in ("a frog", "a spider", "a crab", "a centipede", "a beetle", "a bear", "a giraffe", "a turtle",
                     "a tiny mouse", "an alien tripod", "a jellyfish", "a starfish", "a crocodile"):
            with self.subTest(text=text):
                result = tinker.chat({"messages": [{"role": "user", "content": text}]})
                self.assertFalse(result.get("repairs"), result.get("repairs"))


if __name__ == "__main__":
    unittest.main()
