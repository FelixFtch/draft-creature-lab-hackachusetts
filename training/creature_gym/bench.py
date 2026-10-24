"""Measure CPU throughput for a body: physics-only rollouts and the full PPO loop.

    python -m creature_gym.bench --body <bodyDir> [--threads 1,2,4] [--envs 256] [--seconds 5] [--iterations 6]

Prints one JSON object. "env step" = one 50 Hz control step of one env (4 physics
substeps). The full-loop number includes observations, rewards, resets, policy
inference and the PPO update, i.e. what training actually achieves.
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np


def physics_rate(env, seconds: float) -> float:
    """Env steps/s of the batched rollout alone (targets near the nominal stance)."""
    rng = np.random.default_rng(0)
    start_state = env.state.copy()
    ctrl = np.clip(env.default + 0.05 * rng.normal(size=(env.n, env.nu)), env.lo, env.hi)
    steps, t0 = 0, time.perf_counter()
    while time.perf_counter() - t0 < seconds:
        env.physics(ctrl)
        env.state[:] = env.out_state[:, -1]
        steps += env.n
        if steps % (env.n * 100) == 0:
            env.state[:] = start_state   # keep robots standing instead of drifting into odd states
    return steps / (time.perf_counter() - t0)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--body', required=True)
    parser.add_argument('--threads', default='1,2')
    parser.add_argument('--torch-threads', type=int, default=None)
    parser.add_argument('--envs', type=int, default=256)
    parser.add_argument('--seconds', type=float, default=5.0)
    parser.add_argument('--iterations', type=int, default=6)
    args = parser.parse_args(argv)

    import torch

    from .body import load_body
    from .envs import CreatureEnv
    from .ppo import PPO, ActorCritic, PPOConfig, Storage
    from .train import machine_info

    body = load_body(args.body)
    thread_list = [int(t) for t in args.threads.split(',')]
    result = {'body': body.id, 'envs': args.envs, 'machine': machine_info(max(thread_list)), 'physicsOnly': {}}
    for threads in thread_list:
        env = CreatureEnv(body, 'walk', n_envs=args.envs, threads=threads, seed=0, n_variants=8)
        try:
            physics_rate(env, 0.5)  # warm-up
            result['physicsOnly'][str(threads)] = round(physics_rate(env, args.seconds))
        finally:
            env.close()

    threads = max(thread_list)
    torch.set_num_threads(args.torch_threads or min(threads, 4))
    env = CreatureEnv(body, 'walk', n_envs=args.envs, threads=threads, seed=0)
    cfg = PPOConfig()
    obs, crit = env.actor_obs(), env.critic_obs()
    model = ActorCritic(obs.shape[1], crit.shape[1], env.nu, cfg)
    ppo = PPO(model, cfg)
    storage = Storage(cfg.steps_per_env, args.envs, obs.shape[1], crit.shape[1], env.nu)
    timing = {'physics': 0.0, 'envPython': 0.0, 'policy': 0.0, 'update': 0.0}
    original_physics = env.physics

    def timed_physics(ctrl):
        t = time.perf_counter()
        original_physics(ctrl)
        timing['physics'] += time.perf_counter() - t

    env.physics = timed_physics
    t_total = time.perf_counter()
    for it in range(args.iterations + 1):
        if it == 1:  # first iteration is warm-up
            timing = dict.fromkeys(timing, 0.0)
            t_total = time.perf_counter()
        for t in range(cfg.steps_per_env):
            t0 = time.perf_counter()
            action, log_prob, value, mu, sigma, obs_n, crit_n = ppo.act(torch.from_numpy(obs), torch.from_numpy(crit))
            t1 = time.perf_counter()
            phys_before = timing['physics']
            obs, crit, reward, term, trunc, info = env.step(action.numpy())
            t2 = time.perf_counter()
            timing['policy'] += t1 - t0
            timing['envPython'] += (t2 - t1) - (timing['physics'] - phys_before)
            storage.obs[t], storage.critic_obs[t], storage.actions[t] = obs_n, crit_n, action
            storage.log_prob[t], storage.values[t] = log_prob, value
            storage.rewards[t] = torch.from_numpy(reward)
            storage.dones[t] = torch.from_numpy((term | trunc).astype(np.float32))
            storage.mu[t], storage.sigma[t] = mu, sigma
        t3 = time.perf_counter()
        storage.compute_returns(ppo.value(torch.from_numpy(crit)), cfg.gamma, cfg.lam)
        ppo.update(storage)
        timing['update'] += time.perf_counter() - t3
    elapsed = time.perf_counter() - t_total
    env.close()
    steps = args.iterations * cfg.steps_per_env * args.envs
    result['fullLoop'] = {'threads': threads, 'torchThreads': torch.get_num_threads(), 'envStepsPerSecond': round(steps / elapsed),
                          'secondsPerIteration': round(elapsed / args.iterations, 3),
                          'breakdownSecondsPerIteration': {k: round(v / args.iterations, 4) for k, v in timing.items()}}
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
