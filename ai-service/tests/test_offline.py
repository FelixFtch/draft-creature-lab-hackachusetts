"""Offline designer: many prompts -> valid, varied, honest proposals."""
import re
import unittest

from designer import CLAIM_PATTERNS, Tinker
from schemas import DESIGN_ID, LOOK_ID, SchemaStore
from tests.helpers import CONTRACTS

STORE = SchemaStore(CONTRACTS)
TINKER = Tinker(STORE)  # no brain provider -> offline designer

PROMPTS = [
    "I want a frog that jumps onto platforms", "make a spider", "an octopus robot", "a beetle", "build me an ant",
    "a dog", "a cat", "a cheetah please", "a bear", "a tank", "a mule that carries stuff", "a giraffe", "something tall",
    "a flower", "a starfish", "a jellyfish", "a crab", "a scorpion", "a centipede", "an alien tripod", "a tiny mouse",
    "a dragon", "a jade dragon", "a dinosaur", "a crocodile", "a turtle", "a unicorn", "a horse", "a zebra", "a fox",
    "a wolf", "a tiger", "a lion", "a panda", "a kangaroo", "a bunny", "a grasshopper", "a ladybug", "a bumblebee",
    "a butterfly", "a mantis", "a firefly", "a hamster", "a squirrel", "a gecko", "a chameleon", "a llama",
    "an elephant", "a rhino", "a robot dog", "a mech", "a sunflower", "a mushroom", "surprise me", "random",
    "a fast fox with long legs", "a big red crocodile", "something with six legs", "an eight-legged creepy thing",
    "a 5 legged star", "a three legged alien", "a small purple spider", "a glowing jellyfish", "a golden unicorn",
    "a robot with lots of legs", "make something that can jump", "a heavy strong hauler", "a speedy racer",
    "hi", "hello there", "help", "what is draft?", "what is qdd?", "what is harmonic?", "what does training do?",
    "make a robot", "design a creature", "asdf qwerty", "", "thanks!",
]
FROG = {"schema": DESIGN_ID, "name": "Ribbit", "bodyPlan": "quadruped", "basePreset": "cheetah",
        "quadruped": {"torsoLength": 0.36, "torsoWidth": 0.22, "torsoHeight": 0.12, "shoulderWidth": 0.18,
                      "hipOffset": 0.08, "upperLeg": 0.24, "lowerLeg": 0.23, "actuator": "qdd", "strength": 1.35},
        "skills": ["walk", "jump"]}
BEAR = {"schema": DESIGN_ID, "name": "Bruno", "bodyPlan": "quadruped", "basePreset": "bear",
        "quadruped": {"torsoLength": 0.64, "torsoWidth": 0.44, "torsoHeight": 0.3, "upperLeg": 0.36, "lowerLeg": 0.34,
                      "actuator": "geared", "strength": 1.1}, "skills": ["walk"]}
FROG_LOOK = {"schema": LOOK_ID, "theme": "frog", "palette": {"body": "#4caf50"}}
MODIFIERS = ["make it look like a ladybug", "bigger", "longer legs", "make it jump", "no jump please", "six legs",
             "give it 8 legs", "make it a spider", "paint it purple and gold", "add wings and a crown",
             "call it Captain Hop", "make it look like lava", "make it look like a jade dragon", "turn it into an astronaut",
             "make it faster", "make it stronger and heavier", "make it smaller", "shorter legs", "wider", "make it lighter",
             "more legs", "fewer legs", "make it glossy with stripes", "give it horns and a tail", "no tail",
             "cute eyes and paws", "make it look like a panda", "candy style", "make it look like ice", "make it look like a robot",
             "make it look like a toaster", "train it", "let's play", "build it", "another one", "try a different body",
             "Surprise me with a look", "use harmonic motors", "qdd motors please", "radial legs", "legs in pairs"]


def say(text, state=None, history=None):
    messages = list(history or []) + ([{"role": "user", "content": text}] if text else [])
    return TINKER.chat({"messages": messages, "state": state or {}})


def acts(result):
    return {a["type"]: a for a in result["actions"]}


class CoverageTests(unittest.TestCase):
    def check(self, result):
        self.assertTrue(result["ok"])
        self.assertTrue(result["reply"].strip())
        self.assertTrue(result["provider"]["offline"])
        self.assertEqual(result["provider"]["name"], "offline")
        self.assertLessEqual(len(result["suggestions"]), 4)
        for chip in result["suggestions"]:
            self.assertLessEqual(len(chip), 60)
        for pattern in CLAIM_PATTERNS:
            self.assertIsNone(pattern.search(result["reply"]), result["reply"])
        for action in result["actions"]:
            if action["type"] == "design":
                self.assertEqual(STORE.validate(DESIGN_ID, action["design"]), [])
                self.assertNotIn("look", action["design"])
            elif action["type"] == "look":
                self.assertEqual(STORE.validate(LOOK_ID, action["look"]), [])
            elif action["type"] == "train":
                self.assertEqual(action["skills"][0], "walk")

    def test_many_fresh_prompts_produce_valid_output(self):
        designs = 0
        for text in PROMPTS:
            with self.subTest(text=text):
                result = say(text)
                self.check(result)
                designs += "design" in acts(result)
        self.assertGreater(designs, 55)

    def test_many_modifiers_on_existing_designs(self):
        for base in (FROG, BEAR):
            for text in MODIFIERS:
                with self.subTest(base=base["name"], text=text):
                    self.check(say(text, {"design": base, "look": FROG_LOOK}))

    def test_build_feedback_states(self):
        states = [{"design": FROG, "body": {"id": "q-1", "feasibility": {"passed": False, "warnings": ["knee torque insufficient"]}}},
                  {"design": FROG, "body": {"id": "q-1", "feasibility": {"passed": False, "reasons": ["motor overlap at the hip"]}}},
                  {"design": FROG, "body": {"error": "Draft feasibility gate failed: speed too low"}},
                  {"design": FROG, "body": {"id": "q-1", "feasibility": {"passed": True}, "trainability": {"warnings": ["tips over easily"]}}}]
        for state in states:
            for text in ("", "why did it fail?", "fix it"):
                with self.subTest(state=str(state)[:60], text=text):
                    self.check(say(text, state, history=[{"role": "user", "content": "a frog"},
                                                         {"role": "assistant", "content": "Here is Ribbit."}]))


class IntentTests(unittest.TestCase):
    def design(self, text, state=None):
        result = say(text, state)
        return acts(result).get("design", {}).get("design"), result

    def test_creature_families(self):
        frog, _ = self.design("a frog that jumps onto platforms")
        self.assertEqual((frog["bodyPlan"], frog["quadruped"]["actuator"]), ("quadruped", "qdd"))
        self.assertIn("jump", frog["skills"])
        self.assertTrue(1.25 <= frog["quadruped"]["strength"] <= 1.35)  # strong, but inside the QDD frontier
        for text in ("a spider", "an octopus"):
            spider, _ = self.design(text)
            self.assertEqual((spider["bodyPlan"], spider["multileg"]["legCount"], spider["multileg"]["arrangement"]),
                             ("multileg", 8, "radial"))
        for text in ("a beetle", "an ant", "an insect"):
            bug, _ = self.design(text)
            self.assertEqual((bug["multileg"]["legCount"], bug["multileg"]["arrangement"]), (6, "bilateral"))
        for text in ("a dog", "a cat", "a cheetah"):
            runner, _ = self.design(text)
            self.assertEqual((runner["bodyPlan"], runner["basePreset"]), ("quadruped", "cheetah"))
        for text in ("a bear", "a tank", "a mule"):
            tank, _ = self.design(text)
            self.assertEqual(tank["quadruped"]["actuator"], "geared")
        for text in ("a giraffe", "something tall"):
            tall, _ = self.design(text)
            self.assertGreaterEqual(tall["quadruped"]["upperLeg"], 0.5)
        flower, _ = self.design("a flower")
        self.assertEqual((flower["multileg"]["arrangement"], flower["multileg"]["legCount"], flower["basePreset"]),
                         ("radial", 6, "flower"))
        star, _ = self.design("a starfish")
        self.assertEqual((star["multileg"]["arrangement"], star["multileg"]["legCount"]), ("radial", 5))
        tripod, _ = self.design("an alien tripod")
        self.assertEqual(tripod["multileg"]["legCount"], 3)

    def test_looks_for_named_themes(self):
        for theme in ("ladybug", "tiger", "panda", "robot", "candy", "lava", "ice", "jade dragon", "astronaut"):
            with self.subTest(theme=theme):
                result = say(f"make it look like {'an' if theme[0] in 'aeiou' else 'a'} {theme}", {"design": FROG, "look": FROG_LOOK})
                self.assertNotIn("design", acts(result))  # looks never change physics
                self.assertIn(theme, acts(result)["look"]["look"]["theme"])
                self.assertIn("cosmetic", result["reply"])

    def test_restyle_offers_real_body_and_yes_accepts(self):
        first = say("make it a ladybug", {"design": FROG, "look": FROG_LOOK})
        self.assertIn("six-legged", first["reply"])
        history = [{"role": "user", "content": "make it a ladybug"}, {"role": "assistant", "content": first["reply"]}]
        second = say("yes", {"design": FROG, "look": FROG_LOOK}, history)
        self.assertEqual(acts(second)["design"]["design"]["multileg"]["legCount"], 6)

    def test_body_modifiers(self):
        state = {"design": FROG, "look": FROG_LOOK}
        bigger, _ = self.design("bigger", state)
        self.assertGreater(bigger["quadruped"]["torsoLength"], FROG["quadruped"]["torsoLength"])
        smaller, _ = self.design("make it smaller", state)
        self.assertLess(smaller["quadruped"]["torsoLength"], FROG["quadruped"]["torsoLength"])
        longer, _ = self.design("longer legs", state)
        self.assertGreater(longer["quadruped"]["upperLeg"], FROG["quadruped"]["upperLeg"])
        bear_jump, _ = self.design("make it jump", {"design": BEAR})
        self.assertEqual((bear_jump["skills"], bear_jump["quadruped"]["actuator"]), (["walk", "jump"], "qdd"))
        six, _ = self.design("six legs", state)
        self.assertEqual((six["bodyPlan"], six["multileg"]["legCount"]), ("multileg", 6))
        named, result = self.design("call it Captain Hop", state)
        self.assertEqual(named["name"], "Captain Hop")
        self.assertNotIn("look", acts(result))  # "captain" in a name is not a pirate costume
        no_jump, _ = self.design("no jump please", state)
        self.assertEqual(no_jump["skills"], ["walk"])
        result = say("make it jump", state)
        self.assertNotIn("design", acts(result))
        self.assertIn("already", result["reply"])

    def test_colours_and_accessories(self):
        result = say("paint it purple and gold", {"design": FROG, "look": FROG_LOOK})
        palette = acts(result)["look"]["look"]["palette"]
        self.assertEqual((palette["body"], palette["accent"]), ("#7c4dbe", "#d4a72c"))
        result = say("add wings and a crown", {"design": FROG, "look": FROG_LOOK})
        kinds = [a["kind"] for a in acts(result)["look"]["look"]["accessories"]]
        self.assertEqual(kinds, ["wings", "crown"])
        result = say("make it look like a jade dragon", {"design": FROG, "look": FROG_LOOK})
        self.assertEqual(acts(result)["look"]["look"]["theme"], "jade dragon")  # "jade" is not also a paint colour

    def test_vague_requests_ask_one_question(self):
        for text in ("make a robot", "design a creature", "asdf qwerty"):
            with self.subTest(text=text):
                result = say(text)
                self.assertNotIn("design", acts(result))
                self.assertEqual(result["reply"].count("?"), 1)
                self.assertTrue(result["suggestions"])

    def test_unknown_style_offers_alternatives(self):
        result = say("make it look like a toaster", {"design": FROG, "look": FROG_LOOK})
        self.assertIn("toaster", result["reply"])
        self.assertEqual(result["actions"], [])
        self.assertGreaterEqual(len(result["suggestions"]), 3)

    def test_failure_is_revised_with_reason(self):
        state = {"design": FROG, "body": {"id": "q-1", "feasibility": {"passed": False, "warnings": ["knee torque insufficient"]}}}
        result = say("", state, history=[{"role": "user", "content": "a frog"}, {"role": "assistant", "content": "Here."}])
        revised = acts(result)["design"]["design"]
        self.assertIn("knee torque insufficient", result["reply"])
        self.assertLess(revised["quadruped"]["upperLeg"], FROG["quadruped"]["upperLeg"])
        self.assertGreaterEqual(revised["quadruped"]["strength"], FROG["quadruped"]["strength"])
        overlap = say("why did it fail?", {"design": FROG, "body": {"feasibility": {"passed": False, "reasons": ["motor overlap"]}}})
        self.assertGreater(acts(overlap)["design"]["design"]["quadruped"]["upperLeg"], FROG["quadruped"]["upperLeg"])

    def test_train_and_play_are_gated_and_honest(self):
        result = say("train it", {"design": FROG})
        self.assertEqual(acts(result)["train"]["skills"], ["walk", "jump"])
        self.assertIn("Build it first", result["reply"])
        result = say("train it", {"design": FROG, "body": {"id": "q-1", "feasibility": {"passed": False}}})
        self.assertNotIn("train", acts(result))
        result = say("let's play", {"design": FROG, "body": {"id": "q-1", "feasibility": {"passed": True}}})
        self.assertNotIn("play", acts(result))
        result = say("let's play", {"design": FROG, "body": {"id": "q-1"}, "policies": {"walk": "validated"}})
        self.assertIn("play", acts(result))

    def test_deterministic_but_varied(self):
        self.assertEqual(say("a frog"), say("a frog"))
        names = {acts(say(text))["design"]["design"]["name"] for text in
                 ("a frog", "a frog please", "make a frog", "I want a frog", "build a frog", "a little frog",
                  "a green frog", "frog!", "a jumping frog", "a frog robot")}
        self.assertGreaterEqual(len(names), 3)
        replies = {say(text)["reply"].split(":")[0] for text in ("a dog", "a spider", "a bear", "a frog", "a crab")}
        self.assertGreaterEqual(len(replies), 3)

    def test_draft_line_once_per_conversation(self):
        first = say("a frog")
        self.assertIn("114 real actuators", first["reply"])
        second = say("a spider", history=[{"role": "user", "content": "a frog"}, {"role": "assistant", "content": first["reply"]}])
        self.assertNotIn("114 real actuators", second["reply"])

    def test_concept_is_users_words(self):
        frog, _ = self.design("I want a frog that jumps onto platforms")
        self.assertEqual(frog["concept"], "I want a frog that jumps onto platforms")
        self.assertTrue(re.match(r"^[A-Z]", frog["name"]))


if __name__ == "__main__":
    unittest.main()
