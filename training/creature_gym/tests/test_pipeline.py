"""Unit tests for the creature_gym pipeline (run with the training venv).

    cd training && ../.venv-train/bin/python -m unittest discover -s creature_gym/tests -t . -v
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import mujoco
import numpy as np

from creature_gym import obs as O
from creature_gym.body import BodyError, load_body
from creature_gym.dev_bodies import make_cheetah
from creature_gym.sim_model import KD_PER_NM, KP_PER_NM, SceneIndex, TerrainSpec, build_scene

TRAINING = Path(__file__).resolve().parents[2]


class BodyAndSceneTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.body_dir = Path(cls.tmp.name) / 'cheetah'
        make_cheetah(cls.body_dir)
        cls.body = load_body(cls.body_dir)
        cls.scene = build_scene(cls.body)
        cls.model = cls.scene.compile()
        cls.index = SceneIndex.build(cls.model, cls.body, cls.scene.sensor_names)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_body_contract(self):
        b = self.body
        self.assertEqual(len(b.legs), 4)
        self.assertEqual(len(b.joint_names), 12)
        self.assertAlmostEqual(b.leg_length, 0.48, places=6)    # Draft thigh + shank
        self.assertEqual(b.gait_groups, ((0, 3), (1, 2)))
        for joint, value in zip(b.joints, b.nominal_joint_positions):
            self.assertTrue(joint.range[0] <= value <= joint.range[1])

    def test_stale_body_refused(self):
        copy = Path(self.tmp.name) / 'stale'
        shutil.copytree(self.body_dir, copy)
        (copy / 'body.xml').write_text((copy / 'body.xml').read_text().replace('0.26 0.08 0', '0.27 0.08 0'))
        with self.assertRaises(BodyError):
            load_body(copy)

    def test_actuators_follow_draft_pd_rule(self):
        m, idx = self.model, self.index
        for i, joint in enumerate(self.body.joints):
            a = idx.actuators[i]
            self.assertAlmostEqual(m.actuator_gainprm[a, 0], KP_PER_NM * joint.effort, places=6)
            self.assertAlmostEqual(m.actuator_biasprm[a, 1], -KP_PER_NM * joint.effort, places=6)
            self.assertAlmostEqual(m.actuator_biasprm[a, 2], -KD_PER_NM * joint.effort, places=6)
            np.testing.assert_allclose(m.actuator_forcerange[a], [-joint.effort, joint.effort])
            np.testing.assert_allclose(m.actuator_ctrlrange[a], joint.range)

    def test_collision_bits_and_options(self):
        m = self.model
        name = lambda g: mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, g)  # noqa: E731
        roles = self.body.geom_roles
        for g in range(m.ngeom):
            n, bits = name(g), (int(m.geom_contype[g]), int(m.geom_conaffinity[g]))
            if n == 'cg_floor':
                self.assertEqual(bits, (1, 15))
            elif n in roles['feet']:
                self.assertEqual(bits, (2, 9))
            elif n in roles['motors'] or n in roles['details']:
                self.assertEqual(bits, (0, 0))
            else:
                self.assertEqual(bits, (4, 9), n)
        self.assertAlmostEqual(m.opt.timestep, 0.005)
        self.assertEqual(m.opt.integrator, mujoco.mjtIntegrator.mjINT_IMPLICITFAST)
        np.testing.assert_allclose(m.opt.gravity, [0, 0, -9.81])

    def test_scene_is_deterministic_and_terrain_keeps_robot(self):
        self.assertEqual(build_scene(self.body).sha256, self.scene.sha256)
        terrain = build_scene(self.body, terrain=TerrainSpec()).compile()
        for key in ('nq', 'nv', 'nu', 'nsensordata'):
            self.assertEqual(getattr(terrain, key), getattr(self.model, key))

    def test_observation_math_matches_mujoco_sensors(self):
        m, idx = self.model, self.index
        d = mujoco.MjData(m)
        rng = np.random.default_rng(3)
        for _ in range(5):
            d.qpos[:] = self.body.initial_qpos
            q = rng.normal(size=4)
            d.qpos[3:7] = q / np.linalg.norm(q)
            d.qvel[:] = rng.normal(size=m.nv)
            mujoco.mj_forward(m, d)
            v = O.proprio_values(d.qpos[None], d.qvel[None], idx.root_qpos, idx.root_dof, idx.joint_qpos,
                                 idx.joint_dof, np.array(self.body.nominal_joint_positions))
            np.testing.assert_allclose(v['base_lin_vel'][0], d.sensordata[idx.velocimeter:idx.velocimeter + 3], atol=1e-10)
            np.testing.assert_allclose(v['base_ang_vel'][0], d.sensordata[idx.gyro:idx.gyro + 3], atol=1e-10)
            R = d.xmat[idx.root_body].reshape(3, 3)
            np.testing.assert_allclose(v['projected_gravity'][0], R.T @ [0, 0, -1], atol=1e-12)

    def test_observation_layout(self):
        terms = O.walk_terms(12, 4)
        self.assertEqual(O.obs_size(terms), 3 + 3 + 3 + 3 + 12 * 3 + 8)
        clock = O.gait_clock(np.array([0.25]), np.array([0, 0.5, 0.5, 0]), np.array([True]))
        np.testing.assert_allclose(clock[0, :2], [1.0, 0.0], atol=1e-12)
        self.assertTrue(np.all(O.gait_clock(np.array([0.25]), np.zeros(4), np.array([False])) == 0))


class EnvAndPPOTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.body_dir = Path(cls.tmp.name) / 'cheetah'
        make_cheetah(cls.body_dir)
        cls.body = load_body(cls.body_dir)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_env_shapes_rewards_and_termination(self):
        from creature_gym.envs import CreatureEnv
        env = CreatureEnv(self.body, 'walk', n_envs=8, threads=1, seed=1, n_variants=4, cache_dir=self.tmp.name)
        try:
            obs, crit = env.actor_obs(), env.critic_obs()
            self.assertEqual(obs.shape, (8, env.task.obs_size))
            self.assertEqual(crit.shape[1], env.task.obs_size + env.task.privileged_size)
            o, c, r, term, trunc, info = env.step(np.zeros((8, env.nu), np.float32))
            self.assertTrue(np.isfinite(o).all() and np.isfinite(r).all())
            self.assertEqual(r.shape, (8,))
            env.state[0, 1 + 3:1 + 7] = [0, 1, 0, 0]   # upside down
            _, _, r2, term2, _, _ = env.step(np.zeros((8, env.nu), np.float32))
            self.assertTrue(term2[0])
            self.assertLess(r2[0], r2[1:].min())
        finally:
            env.close()

    def test_normalizer_matches_numpy(self):
        import torch
        from creature_gym.ppo import Normalizer
        n = Normalizer(3)
        data = np.random.default_rng(0).normal(2.0, 3.0, size=(1000, 3))
        for chunk in np.array_split(data, 7):
            n.update(torch.from_numpy(chunk))
        np.testing.assert_allclose(n.mean.numpy(), data.mean(0), rtol=1e-10)
        np.testing.assert_allclose(n.var.numpy(), data.var(0), rtol=1e-10)

    def test_onnx_export_matches_torch(self):
        import onnx
        import torch
        from creature_gym.export import build_onnx, verify_onnx
        from creature_gym.ppo import ActorCritic, PPOConfig
        torch.manual_seed(0)
        model = ActorCritic(56, 67, 12, PPOConfig())
        for p in model.actor.parameters():
            p.data.normal_(0, 0.3)
        model.obs_norm.update(torch.randn(500, 56, dtype=torch.float64) * 3 + 1)
        data = build_onnx(model, 56)
        proto = onnx.load_from_string(data)
        self.assertEqual(proto.ir_version, 8)
        self.assertEqual(proto.opset_import[0].version, 17)
        samples = np.random.default_rng(1).normal(size=(64, 56)).astype(np.float32) * 3
        with torch.no_grad():
            scale = float(model.policy_mean(torch.from_numpy(samples)).abs().max())
        self.assertLess(verify_onnx(model, data, samples, tolerance=1e-5), 1e-5 * max(1.0, scale))


class EvaluationScoringTest(unittest.TestCase):
    """Scoring logic on synthetic samples (no simulation)."""

    def sample(self, t, vel, pos, yaw=0.0, touch=(50.0, 0.0), feet=(0.0, 0.05), fall=False):
        return {'t': t, 'mode': 'walk', 'vel': np.array(vel), 'pos': np.array(pos), 'yaw': yaw, 'tilt': 0.05,
                'heightAboveFeet': 0.4, 'touch': np.array(touch), 'feetZ': np.array(feet), 'fall': fall}

    def test_schedule_lookup(self):
        from creature_gym.evaluate import schedule_command
        rows = [[0, 0, 0, 0], [2, 0.5, 0, 0], [5, 0, 0, 0.3]]
        self.assertEqual(schedule_command(rows, 0.0), [0, 0, 0])
        self.assertEqual(schedule_command(rows, 2.0), [0.5, 0, 0])
        self.assertEqual(schedule_command(rows, 9.0), [0, 0, 0.3])

    def test_forward_row_criteria(self):
        from creature_gym.evaluate import score_walk_row
        sc = {'name': 'forward', 'durationS': 0.1, 'measureFromS': 0.0, 'schedule': [[0, 1.0, 0, 0]],
              'criteria': {'minVxFraction': 0.5, 'maxAbsWz': 0.1}}
        start = self.sample(0, [0, 0, 0], [0, 0, 0.4])
        good = [self.sample(0.02 * (k + 1), [0.8, 0, 0.02], [0.016 * (k + 1), 0, 0.4]) for k in range(5)]
        row = score_walk_row(sc, {'samples': good, 'error': None, 'start': start}, {'contactThresholdN': 10})
        self.assertTrue(row['pass'])
        curving = [self.sample(0.02 * (k + 1), [0.8, 0, 0.3], [0.016 * (k + 1), 0, 0.4]) for k in range(5)]
        row = score_walk_row(sc, {'samples': curving, 'error': None, 'start': start}, {'contactThresholdN': 10})
        self.assertFalse(row['pass'])                      # yaw-rate limit catches a curving "forward"
        fell = good[:3] + [self.sample(0.08, [0.8, 0, 0], [0.06, 0, 0.1], fall=True)]
        row = score_walk_row(sc, {'samples': fell, 'error': None, 'start': start}, {'contactThresholdN': 10})
        self.assertFalse(row['pass'])
        self.assertTrue(row['fall'])

    def test_gait_stats(self):
        from creature_gym.evaluate import gait_stats
        samples = [self.sample(0.02 * (k + 1), [0, 0, 0], [0, 0, 0.4],
                               touch=(50.0 if k % 10 < 5 else 0.0, 50.0), feet=(0.0 if k % 10 < 5 else 0.06, 0.0))
                   for k in range(100)]
        stats = gait_stats(samples, 0.0, 10.0)
        self.assertAlmostEqual(stats['dutyFactor'][0], 0.5, places=2)
        self.assertEqual(stats['dutyFactor'][1], 1.0)
        self.assertAlmostEqual(stats['touchdownsPerS'][0], 4.5, places=1)   # 9 touchdowns in 2 s
        self.assertAlmostEqual(stats['peakFootClearanceM'][0], 0.06)


class ResumeEquivalenceTest(unittest.TestCase):
    """Two chunks (--chunk-iterations then --resume) must equal one continuous run."""

    def test_chunked_run_equals_continuous_run(self):
        import torch
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            make_cheetah(tmp / 'body')
            common = [sys.executable, '-m', 'creature_gym.train', '--body', str(tmp / 'body'), '--skill', 'walk',
                      '--steps', str(16 * 24 * 4), '--envs', '16', '--threads', '1', '--torch-threads', '1', '--no-export']
            env = dict(os.environ, PYTHONPATH=str(TRAINING))

            def run(extra):
                result = subprocess.run(common + extra, cwd=TRAINING, env=env, capture_output=True, text=True, timeout=600)
                self.assertEqual(result.returncode, 0, result.stderr[-2000:])
                return json.loads(result.stdout.strip().splitlines()[-1])

            whole = run(['--out', str(tmp / 'a')])
            first = run(['--out', str(tmp / 'b'), '--chunk-iterations', '2'])
            self.assertEqual(first['iteration'], 2)
            self.assertFalse(first['done'])
            second = run(['--out', str(tmp / 'b'), '--resume'])
            self.assertEqual(second['iteration'], whole['iteration'])
            a = torch.load(tmp / 'a/.work/checkpoint.pt', weights_only=False)
            b = torch.load(tmp / 'b/.work/checkpoint.pt', weights_only=False)
            for key, value in a['ppo']['model'].items():
                self.assertTrue(torch.equal(value, b['ppo']['model'][key]), key)
            np.testing.assert_array_equal(a['env']['state'], b['env']['state'])
            self.assertEqual(a['ppo']['lr'], b['ppo']['lr'])


if __name__ == '__main__':
    unittest.main()
