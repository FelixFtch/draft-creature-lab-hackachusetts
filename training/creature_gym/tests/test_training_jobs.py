"""Tests for draft-service/training_jobs.py (stdlib only; uses a fake trainer executable)."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('training_jobs', REPO / 'draft-service/training_jobs.py')
training_jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(training_jobs)

FAKE_TRAINER = '''#!{python}
import json, signal, sys, time
from pathlib import Path
args = sys.argv[1:]
out = Path(args[args.index('--out') + 1])
mode = Path(args[args.index('--body') + 1], 'mode.txt').read_text().strip()
def progress(phase, running, **extra):
    data = dict(schema='creature-train-progress/1', phase=phase, running=running, iteration=3, envSteps=18432,
                envStepsTarget=6000000, message='training ' + str(out), **extra)
    (out / 'progress.json').write_text(json.dumps(data))
stop = False
def handler(*_):
    global stop
    stop = True
signal.signal(signal.SIGTERM, handler)
if mode == 'fail':
    progress('training', False, error='boom at ' + str(out))
    sys.exit(1)
if mode == 'finish':
    progress('done', False, evalPass=True)
    sys.exit(0)
progress('training', True)
for _ in range(400):
    if stop:
        progress('training', False)
        sys.exit(0)
    time.sleep(0.05)
'''


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class TrainingJobsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.body_id = 'quadruped-0123456789abcdef'
        self.body = self.root / 'bodies' / self.body_id
        self.body.mkdir(parents=True)
        (self.body / 'body.xml').write_text('<mujoco/>')
        self.assets = {'body.xml': sha(b'<mujoco/>')}
        (self.body / 'body.json').write_text(json.dumps({'schema': 'creature-body/1', 'id': self.body_id,
                                                          'provenance': {'assetSha256': self.assets}}))
        (self.body / 'mode.txt').write_text('run')
        fake = self.root / 'fake-python'
        fake.write_text(FAKE_TRAINER.format(python=sys.executable))
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        bodies = {self.body_id: self.body}

        def resolver(body_id):
            if body_id not in bodies:
                raise KeyError(body_id)
            return bodies[body_id]

        self.manager = training_jobs.JobManager(python=fake, resolver=resolver, training_root=self.root, threads=1)
        training_jobs.CANCEL_GRACE_S = 3.0

    def tearDown(self):
        job = self.manager.job
        if job and job['process'].poll() is None:
            job['process'].kill()
            job['process'].wait()
        self.tmp.cleanup()

    def wait_status(self, wanted, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.manager.status()[1]['job']['status']
            if status == wanted:
                return status
            time.sleep(0.05)
        self.fail(f'status never became {wanted}; last {status}')

    def assert_no_paths(self, response):
        text = json.dumps(response)
        self.assertNotIn(self.tmp.name, text)
        self.assertNotIn('"pid"', text)

    def test_validation(self):
        self.assertEqual(self.manager.start({'bodyId': self.body_id, 'skill': 'fly'})[0], 400)
        self.assertEqual(self.manager.start({'bodyId': self.body_id, 'budget': 'huge'})[0], 400)
        self.assertEqual(self.manager.start({'bodyId': self.body_id, 'seed': -1})[0], 400)
        self.assertEqual(self.manager.start({'bodyId': self.body_id, 'seed': True})[0], 400)
        self.assertEqual(self.manager.start({'bodyId': '../etc'})[0], 400)
        self.assertEqual(self.manager.start({'bodyId': 'quadruped-ffffffffffffffff'})[0], 404)
        self.assertEqual(self.manager.policies('Bad_Id')[0], 400)

    def test_start_status_cancel(self):
        code, response = self.manager.start({'bodyId': self.body_id, 'skill': 'walk', 'budget': 'quick'})
        self.assertEqual(code, 202)
        self.assertEqual(response['job']['status'], 'running')
        self.assert_no_paths(response)
        job_id = response['job']['id']
        self.assertTrue(re.match(r'^[a-f0-9]{12}$', job_id))
        deadline = time.monotonic() + 5
        while self.manager.status(job_id)[1]['job']['progress'] is None and time.monotonic() < deadline:
            time.sleep(0.05)
        status = self.manager.status(job_id)[1]
        self.assertEqual(status['job']['progress']['envSteps'], 18432)
        self.assertIn('…/walk', status['job']['progress']['message'])
        self.assert_no_paths(status)
        self.assertEqual(self.manager.start({'bodyId': self.body_id})[0], 409)   # one job at a time
        self.assertEqual(self.manager.status('ffffffffffff')[0], 404)
        self.assertEqual(self.manager.cancel(job_id)[0], 202)
        self.wait_status('cancelled')
        argv = self.manager.job['process'].args
        self.assertIsInstance(argv, list)                       # never a shell string
        self.assertIn('--resume', argv)

    def test_finish_and_fail(self):
        (self.body / 'mode.txt').write_text('finish')
        self.assertEqual(self.manager.start({'bodyId': self.body_id})[0], 202)
        self.wait_status('finished')
        (self.body / 'mode.txt').write_text('fail')
        self.assertEqual(self.manager.start({'bodyId': self.body_id})[0], 202)
        self.wait_status('failed')
        response = self.manager.status()[1]
        self.assertIn('boom', response['job']['error'])
        self.assert_no_paths(response)

    def test_jump_requires_ready_walk(self):
        code, response = self.manager.start({'bodyId': self.body_id, 'skill': 'jump'})
        self.assertEqual(code, 409)

    def make_bundle(self, skill='walk', passing=True, assets=None):
        d = self.body / 'policies' / skill
        d.mkdir(parents=True, exist_ok=True)
        files = {'scene.xml': b'<mujoco model="x"/>', 'policy.onnx': b'onnx-bytes', 'torso_mesh.stl': b'solid'}
        for name, data in files.items():
            (d / name).write_bytes(data)
        report = {'pass': passing, 'policySha256': sha(files['policy.onnx']), 'sceneSha256': sha(files['scene.xml']),
                  'rows': [{'name': 'stand', 'pass': passing}]}
        eval_bytes = json.dumps(report).encode()
        (d / 'eval.json').write_bytes(eval_bytes)
        manifest = {'schema': 'creature-policy/1', 'skill': skill, 'bodyId': self.body_id,
                    'bodyAssetSha256': assets or self.assets, 'sceneXml': 'scene.xml', 'sceneSha256': sha(files['scene.xml']),
                    'policy': 'policy.onnx', 'policySha256': sha(files['policy.onnx']),
                    'assets': [{'name': 'torso_mesh.stl', 'sha256': sha(files['torso_mesh.stl'])}],
                    'evaluation': {'evalFile': 'eval.json', 'evalSha256': sha(eval_bytes), 'pass': passing}}
        (d / 'manifest.json').write_text(json.dumps(manifest))
        return d

    def test_policy_readiness(self):
        code, response = self.manager.policies(self.body_id)
        self.assertEqual(code, 200)
        self.assertFalse(response['skills']['walk']['ready'])
        d = self.make_bundle()
        walk = self.manager.policies(self.body_id)[1]['skills']['walk']
        self.assertTrue(walk['ready'], walk['reasons'])
        (d / 'policy.onnx').write_bytes(b'tampered')
        walk = self.manager.policies(self.body_id)[1]['skills']['walk']
        self.assertFalse(walk['ready'])
        self.assertIn('policy.onnx: hash mismatch', walk['reasons'])
        self.make_bundle(passing=False)
        walk = self.manager.policies(self.body_id)[1]['skills']['walk']
        self.assertIn('validation did not pass', walk['reasons'])
        self.make_bundle(assets={'body.xml': '0' * 64})
        walk = self.manager.policies(self.body_id)[1]['skills']['walk']
        self.assertIn('trained on a different version of this body (stale)', walk['reasons'])
        self.assert_no_paths(self.manager.policies(self.body_id)[1])

    def test_routes(self):
        table = [(m, re.compile(p), h) for m, p, h in training_jobs.ROUTES]

        def find(method, path):
            return [h for m, p, h in table if m == method and p.match(path)]

        self.assertTrue(find('POST', '/api/training/jobs'))
        self.assertTrue(find('GET', '/api/training/jobs/current'))
        self.assertTrue(find('GET', '/api/training/jobs/0123456789ab'))
        self.assertTrue(find('POST', '/api/training/jobs/0123456789ab/cancel'))
        self.assertTrue(find('GET', f'/api/creatures/{self.body_id}/policies'))
        self.assertFalse(find('GET', '/api/creatures/../secret/policies'))
        self.assertFalse(find('GET', '/api/training/jobs/../../x'))
        for method, pattern, handler in training_jobs.ROUTES:
            self.assertIn(method, ('GET', 'POST'))
            self.assertTrue(callable(handler))


if __name__ == '__main__':
    unittest.main()
