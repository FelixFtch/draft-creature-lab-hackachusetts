#!/usr/bin/env python3
"""Tests for the design pipeline (draft-service/designs.py).

Run with the generator venv:
    DRAFT_ROOT=.deps/draft .venv/bin/python -m unittest draft-service/test_designs.py
Generated bodies go to a temporary store; committed showcase bodies are only read.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import mujoco  # noqa: E402
import numpy as np  # noqa: E402

import designs  # noqa: E402

PROJECT = HERE.parent
BASE = {'schema': 'creature-design/1', 'name': 'Test'}


def design(**fields) -> dict:
    return {**copy.deepcopy(BASE), **fields}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class StoreMixin:
    """A throwaway generated-body store per test class."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix='designs-test-')
        cls._old = designs.GENERATED_DIR
        designs.GENERATED_DIR = Path(cls._tmp.name) / 'store'

    @classmethod
    def tearDownClass(cls):
        designs.GENERATED_DIR = cls._old
        cls._tmp.cleanup()


class ValidationTests(unittest.TestCase):
    def issues(self, payload) -> list[str]:
        with self.assertRaises(designs.DesignError) as context:
            designs.validate_design(payload)
        return [f"{i['field']}: {i['message']}" for i in context.exception.issues]

    def test_rejects_non_objects_and_missing_fields(self):
        self.assertTrue(self.issues([]))
        found = self.issues({'schema': 'creature-design/1'})
        self.assertIn('name: is required', found)
        self.assertIn('bodyPlan: is required', found)

    def test_rejects_wrong_schema_unknown_fields_and_types(self):
        self.assertTrue(any(s.startswith('schema:') for s in self.issues(design(schema='x', bodyPlan='quadruped'))))
        self.assertIn('wings: is not a known field', self.issues(design(bodyPlan='quadruped', wings=2)))
        found = self.issues(design(bodyPlan='quadruped', quadruped={'upperLeg': True, 'lowerLeg': '0.3'}))
        self.assertTrue(any(s.startswith('quadruped.upperLeg: must be a number') for s in found))
        self.assertTrue(any(s.startswith('quadruped.lowerLeg: must be a number') for s in found))
        self.assertTrue(self.issues(design(bodyPlan='quadruped', quadruped={'upperLeg': float('nan')})))

    def test_rejects_out_of_range_and_bad_enums(self):
        found = self.issues(design(bodyPlan='quadruped', quadruped={'upperLeg': 2.0, 'actuator': 'rocket'}))
        self.assertTrue(any('quadruped.upperLeg: must be at most' in s for s in found))
        self.assertTrue(any(s.startswith('quadruped.actuator: must be one of') for s in found))
        self.assertTrue(self.issues(design(bodyPlan='multileg', multileg={'legCount': 9})))
        self.assertTrue(self.issues(design(bodyPlan='multileg', multileg={'legCount': 5.5})))
        self.assertTrue(self.issues(design(bodyPlan='multileg', multileg={'actuator': 'harmonic'})))

    def test_cross_field_rules(self):
        self.assertTrue(any('multileg:' in s for s in self.issues(design(bodyPlan='quadruped', multileg={}))))
        self.assertTrue(any('basePreset' in s for s in self.issues(design(bodyPlan='quadruped', basePreset='flower'))))
        self.assertTrue(any('basePreset' in s for s in self.issues(design(bodyPlan='multileg', basePreset='bear'))))
        found = self.issues(design(bodyPlan='multileg', multileg={'legCount': 5, 'arrangement': 'bilateral'}))
        self.assertTrue(any('even leg count' in s for s in found))
        self.assertTrue(self.issues(design(name='   ', bodyPlan='quadruped')))

    def test_look_is_validated_against_its_schema(self):
        self.assertTrue(self.issues(design(bodyPlan='quadruped', look={'schema': 'creature-look/1',
                                                                      'palette': {'body': 'red'}})))
        ok = designs.validate_design(design(bodyPlan='quadruped', look={'schema': 'creature-look/1',
                                                                         'palette': {'body': '#ff0000'}}))
        self.assertEqual(ok['look']['palette']['body'], '#ff0000')

    def test_normalisation(self):
        ok = designs.validate_design(design(name='  Frog ', bodyPlan='multileg', skills=['jump', 'walk'],
                                            multileg={'legCount': 6.0, 'upperLeg': 0.20049, 'strength': 1.234}))
        self.assertEqual(ok['name'], 'Frog')
        self.assertEqual(ok['skills'], ['walk', 'jump'])
        self.assertEqual(ok['multileg'], {'legCount': 6, 'upperLeg': 0.2, 'strength': 1.23})
        self.assertIs(type(ok['multileg']['legCount']), int)


class MappingTests(unittest.TestCase):
    def test_pure_presets_map_to_legacy_overlays(self):
        for preset in ('cheetah', 'bear', 'giraffe'):
            plan = designs.plan_design(designs.validate_design(design(bodyPlan='quadruped', basePreset=preset)))
            self.assertEqual(plan['legacy'], preset)
            self.assertEqual(plan['overrides'], {**designs.preset_overlay(preset), 'allow_hypothetical': False})
        plan = designs.plan_design(designs.validate_design(design(bodyPlan='multileg', basePreset='flower')))
        self.assertEqual((plan['template'], plan['legacy']), ('flower-legacy', 'flower'))
        plan = designs.plan_design(designs.validate_design(
            design(bodyPlan='multileg', basePreset='flower', multileg={'lowerLeg': 0.25})))
        self.assertEqual((plan['template'], plan['legacy']), ('multileg', None))

    def test_family_and_strength_mapping(self):
        plan = designs.plan_design(designs.validate_design(
            design(bodyPlan='quadruped', basePreset='bear', quadruped={'actuator': 'qdd', 'strength': 1.2})))
        o = plan['overrides']
        self.assertEqual(o['L_motor'], 'MIT U12')
        self.assertAlmostEqual(o['L_motor_effort'], 72.0 * 1.2)
        self.assertAlmostEqual(o['L_motor_friction'], 0.127 * 1.2)
        self.assertEqual(o['torso_lx'], designs.preset_overlay('bear')['torso_lx'])
        self.assertIs(o['allow_hypothetical'], False)
        flower = designs.plan_design(designs.validate_design(
            design(bodyPlan='multileg', basePreset='flower', multileg={'legCount': 8})))
        self.assertIsNone(flower['overrides']['L_motor'])   # Flower class has no catalogue anchor

    def test_leg_layouts(self):
        for count in range(3, 9):
            legs = designs.leg_layout(count, 'radial', 1.0)
            angles = [math.atan2(l['ny'], l['nx']) % (2 * math.pi) for l in legs]
            self.assertEqual(angles, sorted(angles))
            self.assertAlmostEqual(angles[0], 0.0)
        legs = designs.leg_layout(6, 'bilateral', 1.8)
        names = [l['name'] for l in legs]
        self.assertEqual(names, [f'leg{i}' for i in range(6)])
        ys = [l['uy'] for l in legs]
        self.assertTrue(all(y > 0 for y in ys[:3]) and all(y < 0 for y in ys[3:]))
        for leg in legs:
            # (ux, uy) parameterises the wall point (hub_a*ux, hub_b*uy); the ellipse's outward
            # normal there is parallel to (ux/hub_a, uy/hub_b) and must equal (nx, ny).
            self.assertAlmostEqual(leg['ux'] ** 2 + leg['uy'] ** 2, 1.0, places=9)
            gx, gy = leg['ux'] / 1.8, leg['uy'] / 1.0
            self.assertAlmostEqual(gx * leg['ny'] - gy * leg['nx'], 0.0, places=9)
            self.assertGreater(gx * leg['nx'] + gy * leg['ny'], 0)
        self.assertLessEqual(designs.yaw_half_range(designs.leg_layout(8, 'radial', 1.0)), 0.75)

    def test_gait_hints(self):
        q = designs.gait_hint({'kind': 'quadruped'}, 4)
        self.assertEqual((q['pattern'], q['groups']), ('trot', [[0, 3], [1, 2]]))
        for count, pattern in ((3, 'wave'), (4, 'trot'), (5, 'wave'), (6, 'tripod'), (7, 'wave'), (8, 'ripple')):
            hint = designs.gait_hint({'kind': 'multileg'}, count)
            self.assertEqual(hint['pattern'], pattern)
            self.assertEqual(sorted(i for g in hint['groups'] for i in g), list(range(count)))
            self.assertEqual(len(hint['phaseOffsets']), count)


class GenerationTests(StoreMixin, unittest.TestCase):
    CASES = {
        'quadruped-micro': design(bodyPlan='quadruped', quadruped={'actuator': 'micro'}),
        'quadruped-qdd': design(bodyPlan='quadruped', quadruped={'actuator': 'qdd', 'upperLeg': 0.24}),
        'quadruped-geared': design(bodyPlan='quadruped', quadruped={'actuator': 'geared', 'strength': 0.8}),
        'quadruped-harmonic': design(bodyPlan='quadruped', quadruped={'actuator': 'harmonic', 'upperLeg': 0.6}),
        'multileg-micro-radial5': design(bodyPlan='multileg', multileg={'legCount': 5, 'actuator': 'micro'}),
        'multileg-qdd-bilateral8': design(bodyPlan='multileg', multileg={
            'legCount': 8, 'arrangement': 'bilateral', 'bodyAspect': 2.0, 'coxa': 0.11, 'actuator': 'qdd'}),
        'multileg-flower-class': design(bodyPlan='multileg', basePreset='flower', multileg={'legCount': 4}),
    }

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.bodies = {name: designs.build_body(payload)[0] for name, payload in cls.CASES.items()}

    def test_contract_fields(self):
        required = {'schema', 'id', 'name', 'bodyPlan', 'design', 'xmlFile', 'meshFiles', 'rootBody', 'imuSite',
                    'forwardAxis', 'legs', 'jointNames', 'joints', 'nominalJointPositions', 'nominalRootHeight',
                    'initialQpos', 'massKg', 'dimensions', 'gaitHint', 'geomRoles', 'bodyRoles', 'motors',
                    'feasibility', 'provenance', 'trainability', 'specSheet'}
        for name, body in self.bodies.items():
            with self.subTest(name):
                self.assertTrue(required <= set(body))
                self.assertEqual(body['schema'], 'creature-body/1')
                self.assertRegex(body['id'], designs.BODY_ID_RE)
                self.assertTrue(body['id'].startswith(body['bodyPlan'] + '-'))
                directory = designs.body_dir(body['id'])
                self.assertIsNotNone(directory)
                self.assertEqual(sorted(p.name for p in directory.iterdir()),
                                 sorted(['body.json', 'body.xml', 'feasibility_report.yaml',
                                         'parameters_resolved.yaml', *body['meshFiles']]))
                model = mujoco.MjModel.from_xml_path(str(directory / 'body.xml'))
                self.assertEqual(model.nq, len(body['initialQpos']))
                self.assertEqual(len(body['jointNames']), 3 * len(body['legs']))
                self.assertEqual(body['jointNames'], [j for leg in body['legs'] for j in leg['joints']])
                self.assertEqual(model.nu, 0)   # bodies carry no actuators
                self.assertAlmostEqual(body['massKg'], float(model.body_mass.sum()), places=3)
                self.assertTrue(body['feasibility']['passed'])
                self.assertFalse(body['feasibility']['allowHypothetical'])
                self.assertTrue(body['specSheet']['motors'])
                self.assertEqual(body['provenance']['assetSha256'],
                                 {n: sha(directory / n) for n in ['body.xml', *body['meshFiles']]})

    def test_geom_roles_cover_every_geom_once(self):
        for name, body in self.bodies.items():
            with self.subTest(name):
                model = mujoco.MjModel.from_xml_path(str(designs.body_dir(body['id']) / 'body.xml'))
                listed = [g for names in body['geomRoles'].values() for g in names]
                every = [mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, g) for g in range(model.ngeom)]
                self.assertEqual(sorted(listed), sorted(every))
                self.assertEqual(len(body['geomRoles']['feet']), len(body['legs']))
                self.assertEqual(body['geomRoles']['torso'], ['torso_link_mesh'])

    def test_joint_table_matches_model(self):
        for name, body in self.bodies.items():
            with self.subTest(name):
                model = mujoco.MjModel.from_xml_path(str(designs.body_dir(body['id']) / 'body.xml'))
                for row in body['joints']:
                    j = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, row['name'])
                    self.assertGreaterEqual(j, 0)
                    self.assertEqual(row['range'], [round(float(v), 6) for v in model.jnt_range[j]])
                    self.assertAlmostEqual(row['effort'], float(model.jnt_actfrcrange[j][1]), places=5)
                    self.assertGreater(row['velocity'], 0)
                    self.assertIn(row['role'], ('hip_roll', 'hip_yaw', 'hip_pitch', 'knee'))
                motor = body['motors'][0]
                self.assertAlmostEqual(motor['effortNm'], body['joints'][0]['effort'], places=3)

    def test_stance_check(self):
        """Independent FK check of the nominal pose: feet on z=0, torso level, within ranges."""
        for name, body in self.bodies.items():
            with self.subTest(name):
                model = mujoco.MjModel.from_xml_path(str(designs.body_dir(body['id']) / 'body.xml'))
                data = mujoco.MjData(model)
                data.qpos[:] = body['initialQpos']
                mujoco.mj_forward(model, data)
                self.assertAlmostEqual(float(data.qpos[2]), body['nominalRootHeight'], places=6)
                for leg in body['legs']:
                    site = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, leg['footSite'])
                    bottom = float(data.site_xpos[site][2]) - leg['footRadius']
                    self.assertLess(abs(bottom), 2e-5, f"{leg['name']} foot at {bottom}")
                R = data.xmat[1].reshape(3, 3)
                self.assertAlmostEqual(float(R[2, 2]), 1.0, places=9)
                for row, angle in zip(body['joints'], body['nominalJointPositions']):
                    lo, hi = row['range']
                    margin = designs.JOINT_MARGIN_FRACTION * (hi - lo)
                    self.assertTrue(lo + margin - 1e-6 <= angle <= hi - margin + 1e-6, row['name'])
                self.assertGreaterEqual(body['stanceCheck']['bellyClearanceM'], designs.MIN_BELLY_CLEARANCE_M)
                self.assertLessEqual(body['stanceCheck']['maxFootHeightErrorM'], designs.FOOT_HEIGHT_TOL_M)

    def test_trainability_is_sane(self):
        for name, body in self.bodies.items():
            with self.subTest(name):
                train = body['trainability']
                self.assertIn(train['verdict']['stand'], ('ok', 'marginal', 'fails'))
                self.assertTrue(train['holdTest']['finite'])
                m = train['metrics']
                self.assertGreater(m['verticalForceRatio'], 0)
                self.assertGreater(m['standLoad'], 0)
                self.assertTrue(all(f['severity'] in ('info', 'warning', 'error') for f in train['flags']))

    def test_hash_stability_and_cosmetic_independence(self):
        payload = self.CASES['multileg-micro-radial5']
        body = self.bodies['multileg-micro-radial5']
        again, cached = designs.build_body(payload)
        self.assertTrue(cached)
        self.assertEqual(again['id'], body['id'])
        renamed = {**payload, 'name': 'Renamed', 'concept': 'x', 'skills': ['walk'],
                   'look': {'schema': 'creature-look/1', 'theme': 'ladybug'}}
        self.assertEqual(designs.body_id(designs.plan_design(designs.validate_design(renamed))), body['id'])
        changed = copy.deepcopy(payload)
        changed['multileg']['lowerLeg'] = 0.25
        self.assertNotEqual(designs.body_id(designs.plan_design(designs.validate_design(changed))), body['id'])
        # A fresh build elsewhere reproduces the same bytes.
        with tempfile.TemporaryDirectory() as other:
            fresh = designs.evaluate(payload, keep_dir=Path(other))
            self.assertEqual(fresh['provenance']['assetSha256'], body['provenance']['assetSha256'])

    def test_route_post_design(self):
        status, reply = designs.dispatch('POST', '/api/design', {**self.CASES['quadruped-micro'], 'name': 'Pip'})
        self.assertEqual(status, 200)
        self.assertEqual(reply['body']['name'], 'Pip')
        self.assertEqual(reply['specSheet']['title'], 'Pip')
        self.assertTrue(reply['cached'])
        self.assertEqual(reply['urls']['bodyXml'], f"/creatures/{reply['body']['id']}/body.xml")
        status, served = designs.dispatch('GET', reply['urls']['bodyXml'])
        self.assertEqual(status, 200)
        self.assertIsInstance(served, designs.FileResponse)
        self.assertEqual(served.content_type, 'application/xml')
        status, listing = designs.dispatch('GET', '/api/bodies')
        self.assertEqual(status, 200)
        self.assertIn(reply['body']['id'], {row['id'] for row in listing['bodies']})

    def test_route_errors(self):
        status, reply = designs.dispatch('POST', '/api/design', {'schema': 'creature-design/1'})
        self.assertEqual((status, reply['error']), (400, 'invalid-design'))
        self.assertTrue(reply['issues'])
        status, schema = designs.dispatch('GET', '/api/design/schema')
        self.assertEqual((status, schema['$id']), (200, 'creature-design/1'))
        self.assertIsNone(designs.dispatch('GET', '/api/nothing'))


class InfeasibleTests(StoreMixin, unittest.TestCase):
    def assert_gate(self, payload, gate, field, direction, fixes=True):
        """422 shape, the expected hint, and (fixes=True) that its suggested value clears the gate."""
        status, reply = designs.dispatch('POST', '/api/design', payload)
        self.assertEqual(status, 422, reply)
        self.assertEqual(reply['error'], 'infeasible-design')
        self.assertEqual(reply['gate'], gate)
        self.assertTrue(reply['message'])
        self.assertTrue(reply['violations'])
        hint = next((h for h in reply['hints'] if (h['field'], h['direction']) == (field, direction)), None)
        self.assertIsNotNone(hint, reply['hints'])
        for item in reply['hints']:
            self.assertLessEqual({'field', 'direction', 'reason'}, set(item))
            self.assertLessEqual(set(item), {'field', 'direction', 'reason', 'value'})
            self.assertIn(item['direction'], ('increase', 'decrease', 'change'))
        self.assertEqual(reply['design']['name'], payload['name'])
        self.assertIsNone(designs.body_dir(designs.body_id(designs.plan_design(designs.validate_design(payload)))))
        if fixes:
            self.assertIn('value', hint)
            revised = copy.deepcopy(payload)
            block, key = field.split('.')
            revised[block][key] = hint['value']
            status, fixed = designs.dispatch('POST', '/api/design', revised)
            self.assertEqual(status, 200, f'suggested {field}={hint["value"]} did not clear the gate: {fixed}')
        return reply

    def test_frontier(self):
        reply = self.assert_gate(design(bodyPlan='quadruped', quadruped={'actuator': 'qdd', 'strength': 1.5}),
                                 'actuator-frontier', 'quadruped.strength', 'decrease')
        self.assertEqual(reply['hints'][0]['value'], 1.35)

    def test_packing(self):
        self.assert_gate(design(bodyPlan='multileg', multileg={'actuator': 'qdd', 'coxa': 0.08, 'strength': 1.5}),
                         'actuator-packing', 'multileg.coxa', 'increase')
        self.assert_gate(design(bodyPlan='quadruped', quadruped={'actuator': 'geared', 'hipOffset': 0.06}),
                         'actuator-packing', 'quadruped.hipOffset', 'increase')

    def test_rigid_packing(self):
        self.assert_gate(design(bodyPlan='multileg', multileg={'actuator': 'qdd', 'strength': 1.5, 'coxa': 0.14,
                                                               'legCount': 8, 'bodyRadius': 0.08}),
                         'actuator-packing', 'multileg.bodyRadius', 'increase')
        self.assert_gate(design(bodyPlan='quadruped', quadruped={'actuator': 'qdd', 'shoulderWidth': 0.1}),
                         'actuator-packing', 'quadruped.shoulderWidth', 'increase')

    def test_stance_gate(self):
        """Valid designs always find a stance; force the clearance rule to exercise the 422 path."""
        old = designs.MIN_BELLY_CLEARANCE_M
        designs.MIN_BELLY_CLEARANCE_M = 5.0
        try:
            self.assert_gate(design(bodyPlan='quadruped', quadruped={'actuator': 'micro', 'lowerLeg': 0.2}),
                             'stance', 'quadruped.lowerLeg', 'increase', fixes=False)
        finally:
            designs.MIN_BELLY_CLEARANCE_M = old


class LegacyTests(StoreMixin, unittest.TestCase):
    """Pure presets compile to bodies whose XML + mesh bytes equal today's /api/generate."""

    def legacy_reference(self, preset: str) -> Path:
        matches = sorted((PROJECT / 'play/public/draft').glob(f'{preset}-*'))
        self.assertEqual(len(matches), 1, preset)
        return matches[0]

    def test_byte_equivalence(self):
        for preset, plan in (('cheetah', 'quadruped'), ('bear', 'quadruped'), ('giraffe', 'quadruped'),
                             ('flower', 'multileg')):
            with self.subTest(preset):
                body = designs.evaluate(design(bodyPlan=plan, basePreset=preset))
                reference = self.legacy_reference(preset)
                xml = reference / ('flower.xml' if preset == 'flower' else 'quadruped.xml')
                self.assertEqual(body['provenance']['assetSha256']['body.xml'], sha(xml))
                self.assertEqual(body['provenance']['assetSha256']['torso_mesh.stl'], sha(reference / 'torso_mesh.stl'))
                self.assertEqual(body['legacy']['preset'], preset)

    def test_legacy_policy_hashes_line_up(self):
        for preset in ('cheetah', 'flower'):
            with self.subTest(preset):
                manifest = json.loads((PROJECT / f'play/public/controller/{preset}/manifest.json').read_text())
                body = designs.evaluate(design(bodyPlan='multileg' if preset == 'flower' else 'quadruped',
                                               basePreset=preset))
                self.assertEqual(body['provenance']['assetSha256']['body.xml'], manifest['sourceRobotXmlSha256'])
                mesh = next(a for a in manifest['assets'] if a['name'].endswith('torso_mesh.stl'))
                self.assertEqual(body['provenance']['assetSha256']['torso_mesh.stl'], mesh['sha256'])
        cheetah = designs.evaluate(design(bodyPlan='quadruped', basePreset='cheetah'))
        self.assertEqual(cheetah['nominalJointPositions'][:3], [0.0, 0.5, -1.0])
        flower = designs.evaluate(design(bodyPlan='multileg', basePreset='flower'))
        self.assertEqual(flower['nominalJointPositions'][:3], [0.0, 0.15, 1.25])
        self.assertEqual(flower['xmlContents']['actuators'], 18)


class PathSafetyTests(StoreMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.body, _ = designs.build_body(design(bodyPlan='quadruped', quadruped={'actuator': 'micro'}))
        cls.dir = designs.body_dir(cls.body['id'])
        policy = cls.dir / 'policies' / 'walk'
        policy.mkdir(parents=True)
        (policy / 'manifest.json').write_text('{}')
        (policy / 'torso_mesh.stl').write_bytes(b'solid')
        (policy / 'notes.txt').write_text('no')
        (cls.dir / 'secret.txt').write_text('no')
        cls.outside = Path(cls._tmp.name) / 'outside.txt'
        cls.outside.write_text('outside')

    def get(self, path):
        return designs.dispatch('GET', path)

    def test_allowlisted_files_are_served(self):
        bid = self.body['id']
        for name in ('body.json', 'body.xml', 'torso_mesh.stl', 'feasibility_report.yaml',
                     'parameters_resolved.yaml', 'policies/walk/manifest.json', 'policies/walk/torso_mesh.stl'):
            status, reply = self.get(f'/creatures/{bid}/{name}')
            self.assertEqual(status, 200, name)
            self.assertTrue(reply.path.is_file())
        self.assertEqual(self.get(f'/creatures/{bid}/policies/walk/manifest.json')[1].cache_control, 'no-store')
        self.assertIn('immutable', self.get(f'/creatures/{bid}/body.xml')[1].cache_control)

    def test_everything_else_is_refused(self):
        bid = self.body['id']
        bad = [f'/creatures/{bid}/secret.txt', f'/creatures/{bid}/../{bid}/body.json',
               f'/creatures/{bid}/policies/walk/notes.txt', f'/creatures/{bid}/policies/run/manifest.json',
               f'/creatures/{bid}/policies/walk/../../body.json', f'/creatures/{bid}/policies/walk',
               f'/creatures/{bid}/scene.xml', f'/creatures/{bid}/policies/walk/sub/manifest.json',
               '/creatures/quadruped-0000000000000000/body.json', '/creatures/robot-0123456789abcdef/body.json',
               f'/creatures/{bid}//etc/passwd', f'/creatures/{bid}/.body.json.tmp']
        for path in bad:
            reply = self.get(path)
            self.assertTrue(reply is None or reply[0] == 404, path)

    def test_symlinks_are_refused(self):
        bid = self.body['id']
        link = self.dir / 'policies' / 'jump'
        link.symlink_to(self.dir / 'policies' / 'walk', target_is_directory=True)
        mesh_link = self.dir / 'policies' / 'walk' / 'eval.json'
        mesh_link.symlink_to(self.outside)
        try:
            self.assertEqual(self.get(f'/creatures/{bid}/policies/jump/manifest.json')[0], 404)
            self.assertEqual(self.get(f'/creatures/{bid}/policies/walk/eval.json')[0], 404)
            fake = 'multileg-' + 'f' * 16
            (designs.GENERATED_DIR / fake).symlink_to(self.dir, target_is_directory=True)
            self.assertIsNone(designs.body_dir(fake))
            self.assertEqual(self.get(f'/creatures/{fake}/body.json')[0], 404)
        finally:
            link.unlink()
            mesh_link.unlink()
            (designs.GENERATED_DIR / ('multileg-' + 'f' * 16)).unlink(missing_ok=True)

    def test_body_dir_rejects_malformed_ids(self):
        for value in ('', '..', '../creatures', 'quadruped-XYZ', 'quadruped-0123456789abcdef/../x', None):
            self.assertIsNone(designs.body_dir(value))

    def test_eviction_keeps_bodies_with_policies(self):
        designs.evict_generated(keep=1)
        self.assertIsNotNone(designs.body_dir(self.body['id']))


class ShowcaseTests(unittest.TestCase):
    """Committed bodies under creatures/ are current, intact and trainable."""

    def test_showcase_bodies(self):
        expected = {entry['name'] for entry in designs.showcase_designs()}
        found = {}
        for entry in designs.showcase_designs():
            payload = designs.validate_design(entry)
            identifier = designs.body_id(designs.plan_design(payload))
            directory = designs._store_dir(designs.SHOWCASE_DIR, identifier)
            with self.subTest(entry['name']):
                self.assertIsNotNone(directory, f"{entry['name']} not committed as {identifier}; run build-showcase")
                body = json.loads((directory / 'body.json').read_text())
                self.assertEqual(body['provenance']['designsVersion'], designs.DESIGNS_VERSION)
                self.assertTrue(designs._assets_intact(directory, body))
                self.assertTrue(body['feasibility']['passed'])
                self.assertFalse([f for f in body['trainability']['flags'] if f['severity'] == 'error'])
                self.assertLessEqual(body['stanceCheck']['maxFootHeightErrorM'], designs.FOOT_HEIGHT_TOL_M)
                self.assertTrue(body['trainability']['holdTest']['passed'])
                total = sum(p.stat().st_size for p in directory.iterdir() if p.is_file())
                self.assertLess(total, 400_000)
                found[entry['name']] = body
        self.assertEqual(set(found), expected)
        self.assertEqual(found['Octo']['gaitHint']['pattern'], 'ripple')
        self.assertEqual(len(found['Octo']['legs']), 8)
        self.assertEqual(found['Beetle']['gaitHint']['pattern'], 'tripod')
        self.assertEqual({leg['side'] for leg in found['Beetle']['legs']}, {'left', 'right'})
        self.assertIn(found['Hopper']['trainability']['verdict']['jump'], ('strong', 'capable'))


def _class_report(family: dict, strength: float) -> dict:
    """Draft's own sizing/frontier verdict for a family's L class at a strength."""
    from draft.generation.generator import size_actuators
    from draft.trends.motor_catalog import resolve_catalog_motors
    params = {'L_motor': family['anchor'], 'L_motor_effort': family['effort'] * strength,
              'L_motor_velocity': family['velocity'], 'L_motor_gear': family['gear'], 'allow_hypothetical': False}
    if family.get('aspect'):
        params['L_motor_aspect'] = family['aspect']
    _, report = size_actuators(resolve_catalog_motors(params), strict=False)
    return report


WASM_CHECK = r"""
import fs from 'node:fs/promises';
import path from 'node:path';
const [factory, root, ids] = [process.argv[2], process.argv[3], process.argv.slice(4)];
const mj = await (await import(factory)).default();
const out = [];
for (const id of ids) {
  const dir = path.join(root, id), body = JSON.parse(await fs.readFile(path.join(dir, 'body.json'), 'utf8'));
  const vfs = new mj.MjVFS();
  for (const mesh of body.meshFiles) vfs.addBuffer(mesh, new Uint8Array(await fs.readFile(path.join(dir, mesh))));
  const model = mj.MjModel.from_xml_string(await fs.readFile(path.join(dir, 'body.xml'), 'utf8'), vfs);
  const data = new mj.MjData(model);
  data.qpos.set(body.initialQpos);
  mj.mj_forward(model, data);
  let mass = 0;
  for (let i = 0; i < model.nbody; i++) mass += model.body_mass[i];
  const feet = body.legs.map(leg => data.site_xpos[mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, leg.footSite) * 3 + 2] - leg.footRadius);
  out.push({ id, version: mj.mj_versionString(), nq: model.nq, mass, feet });
  data.delete(); model.delete(); vfs.delete();
}
console.log(JSON.stringify(out));
"""


class BrowserEngineTests(unittest.TestCase):
    """Committed bodies load in the browser's MuJoCo WASM build with the same mass and stance."""

    def test_bodies_load_in_mujoco_wasm(self):
        factory = PROJECT / 'play/node_modules/@mujoco/mujoco/mujoco.js'
        node = shutil.which('node')
        if not node or not factory.is_file():
            self.skipTest('node or play/node_modules/@mujoco/mujoco not installed')
        import subprocess
        ids = sorted(p.name for p in designs.SHOWCASE_DIR.iterdir() if designs._store_dir(designs.SHOWCASE_DIR, p.name))
        self.assertTrue(ids)
        with tempfile.NamedTemporaryFile('w', suffix='.mjs', delete=False) as script:
            script.write(WASM_CHECK)
        try:
            result = subprocess.run([node, script.name, str(factory), str(designs.SHOWCASE_DIR), *ids],
                                    capture_output=True, text=True, timeout=300)
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        finally:
            os.unlink(script.name)
        rows = json.loads(result.stdout.strip().splitlines()[-1])
        for row in rows:
            body = json.loads((designs.SHOWCASE_DIR / row['id'] / 'body.json').read_text())
            with self.subTest(body['name']):
                self.assertEqual(row['nq'], len(body['initialQpos']))
                self.assertAlmostEqual(row['mass'], body['massKg'], places=3)
                self.assertLess(max(abs(z) for z in row['feet']), 1e-4)


class SchemaTests(StoreMixin, unittest.TestCase):
    def test_family_table_documented_in_schema(self):
        documented = designs.design_schema()['x-actuatorFamilies']
        for plan, families in designs.FAMILIES.items():
            for name, family in families.items():
                if name == 'flower':
                    continue
                with self.subTest(f'{plan}/{name}'):
                    row = documented[plan][name]
                    self.assertEqual(row['catalogAnchor'], family['anchor'])
                    self.assertEqual(row['category'], family['category'])
                    self.assertEqual(row['ratedTorqueNm'], family['effort'])
                    self.assertEqual(row['noLoadSpeedRadS'], family['velocity'])
                    self.assertEqual(row['gear'], family['gear'])
                    report = _class_report(family, 1.0)
                    c = report['classes']['L']
                    self.assertEqual(c['anchor'], family['anchor'])   # catalogue name resolves
                    self.assertAlmostEqual(row['actuatorMassKg'], c['mass_kg'], places=3)
                    self.assertAlmostEqual(row['diameterMm'], 2000 * c['radius_m'], delta=0.1)
                    # The documented strength ceiling passes Draft's frontier; qdd fails just above it.
                    self.assertFalse(_class_report(family, row['strengthMax'])['errors'])
        self.assertTrue(_class_report(designs.FAMILIES['quadruped']['qdd'], 1.4)['errors'])

    def test_documented_minimums_generate(self):
        """Designs at each family's documented minimums and strength ceiling pass every gate."""
        documented = designs.design_schema()['x-actuatorFamilies']
        for name, row in documented['quadruped'].items():
            with self.subTest(f'quadruped/{name}'):
                body = designs.evaluate(design(bodyPlan='quadruped', quadruped={
                    'actuator': name, 'strength': row['strengthMax'], **row['minimums']}))
                self.assertTrue(body['feasibility']['passed'])
        for name, strength, coxa in (('micro', 1.5, 0.08), ('qdd', 1.2, 0.09), ('qdd', 1.5, 0.10)):
            with self.subTest(f'multileg/{name}@{strength}'):
                body = designs.evaluate(design(bodyPlan='multileg', multileg={
                    'actuator': name, 'strength': strength, 'coxa': coxa}))
                self.assertTrue(body['feasibility']['passed'])
        for count, arrangement, radius, aspect in ((8, 'radial', 0.11, 1.2), (8, 'bilateral', 0.11, 1.6),
                                                  (8, 'bilateral', 0.17, 1.0), (6, 'bilateral', 0.11, 1.0)):
            with self.subTest(f'hub {arrangement}{count} r={radius} a={aspect}'):
                body = designs.evaluate(design(bodyPlan='multileg', multileg={
                    'actuator': 'qdd', 'strength': 1.5, 'coxa': 0.10, 'legCount': count,
                    'arrangement': arrangement, 'bodyRadius': radius, 'bodyAspect': aspect}))
                self.assertEqual(len(body['legs']), count)

    def test_schema_uses_supported_keywords_only(self):
        supported = {'$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'enum', 'const',
                     'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'required', 'properties',
                     'additionalProperties', 'items', 'uniqueItems', 'maxItems', 'minItems'}

        def walk(node):
            if isinstance(node, dict):
                for key, value in node.items():
                    if key.startswith('x-'):
                        continue
                    if key not in supported and not isinstance(value, (dict, list)):
                        self.fail(f'unsupported keyword {key}')
                    if key in ('properties', '$defs'):
                        for child in value.values():
                            walk(child)
                    elif key not in ('enum', 'const', 'required'):
                        walk(value)
            elif isinstance(node, list):
                for item in node:
                    walk(item)

        walk(designs.design_schema())


if __name__ == '__main__':
    unittest.main()
