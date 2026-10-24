"""Runtime schema loading, validation, repair and prompt summaries."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest

from schemas import DESIGN_ID, LOOK_ID, SchemaStore, SchemaUnavailable
from tests.helpers import CONTRACTS

SYNTH_DESIGN = {
    "$id": "creature-design/1", "type": "object", "additionalProperties": False, "required": ["schema", "name", "kind"],
    "properties": {
        "schema": {"const": "creature-design/1"},
        "name": {"type": "string", "minLength": 1, "maxLength": 10},
        "kind": {"enum": ["a", "b"]},
        "count": {"type": "integer", "minimum": 3, "maximum": 8},
        "ratio": {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1},
        "tags": {"type": "array", "items": {"enum": ["x", "y", "z"]}, "uniqueItems": True, "maxItems": 2, "minItems": 0},
        "flag": {"type": "boolean"},
        "either": {"anyOf": [{"type": "integer"}, {"type": "string", "pattern": "^v[0-9]$"}]},
        "look": {"$ref": "look.schema.json"},
        "tint": {"$ref": "look.schema.json#/$defs/color"},
        "fill": {"type": "string", "default": "solid"},
        "extra": {"type": "object", "additionalProperties": {"type": "number", "maximum": 5}},
    },
}
SYNTH_LOOK = {
    "$id": "creature-look/1", "type": "object", "additionalProperties": False, "required": ["schema"],
    "properties": {"schema": {"const": "creature-look/1"}, "color": {"$ref": "#/$defs/color"},
                   "items": {"type": "array", "maxItems": 2, "items": {"type": "object", "required": ["kind"],
                                                                      "additionalProperties": False,
                                                                      "properties": {"kind": {"enum": ["hat", "bow"]}}}}},
    "$defs": {"color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}},
}


class SyntheticSchemaTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / "design.schema.json").write_text(json.dumps(SYNTH_DESIGN))
        (self.dir / "look.schema.json").write_text(json.dumps(SYNTH_LOOK))
        self.store = SchemaStore(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_validation_keywords(self):
        good = {"schema": "creature-design/1", "name": "Bot", "kind": "a", "count": 4, "ratio": 0.5, "tags": ["x"],
                "flag": True, "either": "v1", "look": {"schema": "creature-look/1", "color": "#aabbcc"}, "tint": "#000000",
                "extra": {"k": 4}}
        self.assertEqual(self.store.validate(DESIGN_ID, good), [])
        cases = {"count": 2, "ratio": 1, "tags": ["x", "x"], "flag": "yes", "either": "w1", "tint": "red",
                 "look": {"schema": "creature-look/1", "items": [{"kind": "hat"}] * 3}, "extra": {"k": 6}, "bogus": 1}
        for key, value in cases.items():
            with self.subTest(key=key):
                self.assertTrue(self.store.validate(DESIGN_ID, {**good, key: value}))
        self.assertTrue(self.store.validate(DESIGN_ID, {k: v for k, v in good.items() if k != "kind"}))
        self.assertTrue(self.store.validate(DESIGN_ID, {**good, "count": True}))  # bool is not an integer

    def test_repair_clamps_drops_and_normalises(self):
        broken = {"schema": "old", "name": "A very long robot name", "kind": "A", "count": 9.6, "ratio": 3,
                  "tags": "x", "flag": "TRUE", "either": 2.0, "tint": "#ABC", "look": {"color": "blue", "items": [{"kind": "hat"}, {"kind": "cape"}]},
                  "unknown": 1, "Fill": "dots"}
        fixed, notes, _ = self.store.repair(DESIGN_ID, broken)
        self.assertIsNotNone(fixed)
        self.assertEqual(self.store.validate(DESIGN_ID, fixed), [])
        self.assertEqual(fixed["schema"], "creature-design/1")
        self.assertEqual(len(fixed["name"]), 10)
        self.assertEqual((fixed["kind"], fixed["count"], fixed["tags"], fixed["flag"]), ("a", 8, ["x"], True))
        self.assertTrue(0 < fixed["ratio"] < 1)
        self.assertEqual(fixed["tint"], "#aabbcc")
        self.assertEqual(fixed["look"], {"color": NAMED_BLUE, "items": [{"kind": "hat"}], "schema": "creature-look/1"})
        self.assertEqual(fixed["fill"], "dots")  # key case repaired
        self.assertNotIn("unknown", fixed)
        self.assertTrue(any("clamped" in n for n in notes))

    def test_unrepairable_and_synonyms(self):
        fixed, _, errors = self.store.repair(DESIGN_ID, {"name": "x", "kind": "c"})
        self.assertIsNone(fixed)
        self.assertTrue(any("kind" in e for e in errors))
        fixed, _, _ = self.store.repair(DESIGN_ID, {"name": "x", "kind": "alpha"}, synonyms={"alpha": "a"})
        self.assertEqual(fixed["kind"], "a")

    def test_reload_on_change_and_keep_last_good(self):
        updated = json.loads(json.dumps(SYNTH_DESIGN))
        updated["properties"]["count"]["maximum"] = 6
        time.sleep(0.01)
        path = self.dir / "design.schema.json"
        path.write_text(json.dumps(updated))
        os.utime(path, (time.time() + 5, time.time() + 5))
        fixed, _, _ = self.store.repair(DESIGN_ID, {"name": "x", "kind": "a", "count": 8})
        self.assertEqual(fixed["count"], 6)
        path.write_text("{ half written")
        os.utime(path, (time.time() + 10, time.time() + 10))
        fixed, _, _ = self.store.repair(DESIGN_ID, {"name": "x", "kind": "a", "count": 8})
        self.assertEqual(fixed["count"], 6)  # previous good copy still in use

    def test_missing_schema_is_fatal_at_start(self):
        empty = Path(tempfile.mkdtemp())
        try:
            with self.assertRaises(SchemaUnavailable):
                SchemaStore(empty)
        finally:
            shutil.rmtree(empty)


NAMED_BLUE = "#2f6fd6"


class ContractSchemaTests(unittest.TestCase):
    """The real contracts, read at runtime (they may gain fields)."""

    @classmethod
    def setUpClass(cls):
        cls.store = SchemaStore(CONTRACTS)

    def test_summaries_follow_live_schema(self):
        design = self.store.summary(DESIGN_ID)
        look = self.store.summary(LOOK_ID)
        document = json.loads((CONTRACTS / "design.schema.json").read_text())
        for name in document["properties"]:
            self.assertIn(name, design)
        for name in document["properties"]["quadruped"]["properties"]:
            self.assertIn(name, design)
        look_doc = json.loads((CONTRACTS / "look.schema.json").read_text())
        for name in look_doc["properties"]:
            self.assertIn(name, look)
        self.assertIn("#rrggbb", look)
        self.assertLess(len(design) + len(look), 5200)  # keeps Tinker's prompt inside a 4k-token Ollama context

    def test_design_with_embedded_look_validates_across_files(self):
        design = {"schema": DESIGN_ID, "name": "Hop", "bodyPlan": "quadruped",
                  "quadruped": {"torsoLength": 0.4, "actuator": "qdd"}, "skills": ["walk", "jump"],
                  "look": {"schema": LOOK_ID, "palette": {"body": "#112233"}}}
        self.assertEqual(self.store.validate(DESIGN_ID, design), [])
        design["look"]["palette"]["body"] = "green"
        self.assertTrue(self.store.validate(DESIGN_ID, design))
        fixed, _, _ = self.store.repair(DESIGN_ID, design)
        self.assertRegex(fixed["look"]["palette"]["body"], r"^#[0-9a-f]{6}$")


if __name__ == "__main__":
    unittest.main()
