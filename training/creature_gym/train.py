"""Train one skill for one body on CPU, export a bundle and validate it.

    python -m creature_gym.train --body <bodyDir> --skill walk|jump \
        --budget quick|standard|long --out <bodyDir>/policies/<skill> \
        [--threads N] [--resume] [--seed S] [--max-wall-seconds N] [--envs N]

Chunked runs: ``--max-wall-seconds`` stops cleanly before the limit (checkpoint +
progress written); ``--resume`` continues from ``<out>/.work/checkpoint.pt`` with
policy, optimiser, normalisers, adaptive LR, counters, curriculum, the complete
env state (sim states, commands, clocks, DR pool) and all RNG states, so many
short chunks equal one continuous run. With ``--resume`` and no checkpoint a new
run starts, so a driver can always pass it. When training reaches the budget the
same command exports and evaluates the bundle (also resumable). Every chunk
prints one JSON line on stdout: iteration, env_steps, steps_per_s, mean_reward,
done, phase, eval_pass.

Files: ``<out>/progress.json`` (served by draft-service); checkpoints, logs and
caches live in ``<out>/.work/`` (never served).
"""
from __future__ import annotations

import time

T0 = time.monotonic()  # chunk wall clock starts before the heavy imports below

import argparse  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import platform  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402

from . import PROGRESS_SCHEMA  # noqa: E402

#: Env-step budgets per skill. ETA = remaining steps / measured steps per second.
BUDGETS = {
    'walk': {'quick': 6_000_000, 'standard': 30_000_000, 'long': 100_000_000},
    'jump': {'quick': 3_000_000, 'standard': 12_000_000, 'long': 40_000_000},
}
CHECKPOINT_EVERY = 10
EXPORT_RESERVE_S = 45.0     # wall time a chunk keeps free to export + evaluate


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def machine_info(threads: int) -> dict:
    cpu = platform.processor() or platform.machine()
    try:
        if sys.platform == 'darwin':
            cpu = subprocess.run(['sysctl', '-n', 'machdep.cpu.brand_string'], capture_output=True,
                                 text=True, timeout=2).stdout.strip() or cpu
        elif Path('/proc/cpuinfo').is_file():
            for line in Path('/proc/cpuinfo').read_text().splitlines():
                if line.startswith('model name'):
                    cpu = line.split(':', 1)[1].strip()
                    break
    except (OSError, subprocess.SubprocessError):
        pass
    return {'platform': platform.platform(), 'machine': platform.machine(), 'cpu': cpu,
            'cpuCount': os.cpu_count(), 'threads': threads, 'python': platform.python_version()}


def write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(data, indent=2) + '\n')
    os.replace(tmp, path)


class RunLock:
    """One trainer per output directory (pid file with stale-lock recovery)."""

    def __init__(self, path: Path):
        self.path = path
        self.held = False

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                self.held = True
                return self
            except FileExistsError:
                try:
                    pid = int(self.path.read_text().strip() or 0)
                    os.kill(pid, 0)
                except (ValueError, ProcessLookupError, PermissionError, OSError):
                    self.path.unlink(missing_ok=True)  # stale lock from a killed chunk
                    continue
                raise SystemExit(f'another trainer (pid {pid}) is using {self.path.parent}')
        raise SystemExit(f'could not lock {self.path}')

    def __exit__(self, *exc):
        if self.held:
            self.path.unlink(missing_ok=True)


class Stop(Exception):
    pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--body', type=Path, required=True)
    parser.add_argument('--skill', choices=('walk', 'jump'), required=True)
    parser.add_argument('--budget', choices=('quick', 'standard', 'long'), default='quick')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=None, help='physics threads (default: all cores, max 8)')
    parser.add_argument('--torch-threads', type=int, default=None,
                        help='torch threads for the PPO update (default: min(threads, 4); use 1 on a busy machine)')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--max-wall-seconds', type=float, default=None,
                        help='stop cleanly (checkpoint + progress) before this many seconds of wall time')
    parser.add_argument('--chunk-iterations', type=int, default=None,
                        help='stop cleanly after this many PPO iterations in this chunk (deterministic chunking)')
    parser.add_argument('--envs', type=int, default=256)
    parser.add_argument('--steps', type=int, default=None, help='override the budget (env steps)')
    parser.add_argument('--walk-bundle', type=Path, default=None,
                        help='jump only: walk bundle for slow-walk start states and handoff (default <out>/../walk)')
    parser.add_argument('--no-export', action='store_true', help='stop after training')
    parser.add_argument('--reexport', action='store_true',
                        help='with --resume on a finished run: export and evaluate again (e.g. after criteria changes)')
    args = parser.parse_args(argv)

    threads = args.threads or max(1, min(8, os.cpu_count() or 1))
    deadline = T0 + args.max_wall_seconds if args.max_wall_seconds else None
    out = args.out.resolve()
    work = out / '.work'
    out.mkdir(parents=True, exist_ok=True)

    import numpy as np
    import torch

    from .body import load_body
    from .envs import CreatureEnv
    from .ppo import PPO, ActorCritic, PPOConfig, Storage

    torch.set_num_threads(max(1, args.torch_threads or min(threads, 4)))
    body = load_body(args.body)
    target = int(args.steps or BUDGETS[args.skill][args.budget])
    machine = machine_info(threads)
    progress_path = out / 'progress.json'
    ckpt_path = work / 'checkpoint.pt'
    summary = {'iteration': 0, 'env_steps': 0, 'steps_per_s': 0.0, 'mean_reward': None, 'done': False,
               'phase': 'training', 'eval_pass': None}

    stop_requested = {'flag': False}

    def on_signal(signum, frame):  # noqa: ARG001
        stop_requested['flag'] = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    with RunLock(work / 'lock'):
        run_path = work / 'run.json'
        resumed = args.resume and ckpt_path.is_file()
        if resumed:
            run = json.loads(run_path.read_text())
            if run['bodyId'] != body.id or run['skill'] != args.skill:
                raise SystemExit('checkpoint belongs to a different body/skill; use a fresh --out')
            if run['bodyAssetSha256'] != body.asset_sha256:
                raise SystemExit('body files changed since this run started; start a fresh run')
            cfg = PPOConfig.from_dict(run['ppo'])
            n_envs = int(run['envs'])
        else:
            cfg = PPOConfig()
            n_envs = args.envs
            run = {'bodyId': body.id, 'skill': args.skill, 'seed': args.seed, 'envs': n_envs,
                   'ppo': cfg.to_dict(), 'bodyAssetSha256': body.asset_sha256, 'createdAt': now_iso(),
                   'chunks': 0}
        run['budget'] = args.budget
        run['targetEnvSteps'] = target
        run['chunks'] = int(run.get('chunks', 0)) + 1
        write_json_atomic(run_path, run)

        state = {'iteration': 0, 'env_steps': 0, 'wall': 0.0, 'phase': 'training', 'eval_pass': None,
                 'recent_reward': None, 'recent_length': None, 'tracking': {}}
        prev_progress = json.loads(progress_path.read_text()) if resumed and progress_path.is_file() else {}

        def progress(message: str, *, running: bool, steps_per_s: float | None = None, extra: dict | None = None):
            remaining = max(0, target - state['env_steps'])
            sps = steps_per_s if steps_per_s else prev_progress.get('stepsPerSecond')
            data = {
                'schema': PROGRESS_SCHEMA, 'bodyId': body.id, 'skill': args.skill, 'budget': args.budget,
                'phase': state['phase'], 'running': running, 'done': state['phase'] == 'done',
                'iteration': state['iteration'], 'envSteps': state['env_steps'], 'envStepsTarget': target,
                'fraction': round(min(1.0, state['env_steps'] / target), 4),
                'stepsPerSecond': round(sps, 1) if sps else None,
                'meanReward': state['recent_reward'], 'meanEpisodeLengthS': state['recent_length'],
                'tracking': state['tracking'],
                'etaSeconds': round(remaining / sps, 1) if sps and state['phase'] == 'training' else (0 if state['phase'] == 'done' else None),
                'wallSeconds': round(state['wall'], 1), 'machine': machine, 'updatedAt': now_iso(),
                'message': message, 'evalPass': state['eval_pass'], 'chunks': run['chunks'],
                'maxWallSeconds': args.max_wall_seconds,
            }
            if extra:
                data.update(extra)
            write_json_atomic(progress_path, data)

        bank = None
        if args.skill == 'jump':
            from .evaluate import walk_state_bank
            walk_dir = (args.walk_bundle or out.parent / 'walk').resolve()
            bank = walk_state_bank(body, walk_dir, work, seed=run['seed'])
            if bank is None:
                print(f'note: no ready walk bundle at {walk_dir}; jumps start from standing only', file=sys.stderr)

        torch.manual_seed(run['seed'])
        env = CreatureEnv(body, args.skill, n_envs=n_envs, threads=threads, seed=run['seed'],
                          cache_dir=work, state_bank=bank)
        n_obs, n_act = env.task.obs_size, env.nu
        obs = env.actor_obs()
        critic_obs = env.critic_obs()
        model = ActorCritic(n_obs, critic_obs.shape[1], n_act, cfg)
        ppo = PPO(model, cfg)
        if resumed:
            ckpt = torch.load(ckpt_path, map_location='cpu', weights_only=False)
            ppo.load_state_dict(ckpt['ppo'])
            torch.set_rng_state(ckpt['torch_rng'])
            for key in ('iteration', 'env_steps', 'wall', 'phase', 'eval_pass', 'recent_reward', 'recent_length', 'tracking'):
                state[key] = ckpt['state'].get(key, state[key])
            if env.load_state_dict(ckpt['env']) and ckpt.get('obs') is not None:
                obs, critic_obs = ckpt['obs'], ckpt['critic_obs']
            else:
                print('note: env state not restored (different env count); envs re-initialised', file=sys.stderr)
                obs, critic_obs = env.actor_obs(), env.critic_obs()
            env.set_progress(state['env_steps'] / target)
            if state['phase'] != 'training' and state['env_steps'] < target:
                # A larger budget on a finished run means "train more" (the old bundle stays
                # in place until the new export replaces it).
                state['phase'], state['eval_pass'] = 'training', None
            elif args.reexport and state['phase'] in ('done', 'evaluating'):
                state['phase'], state['eval_pass'] = 'exporting', None

        def save_checkpoint():
            work.mkdir(parents=True, exist_ok=True)
            tmp = ckpt_path.with_suffix('.tmp')
            torch.save({'ppo': ppo.state_dict(), 'torch_rng': torch.get_rng_state(), 'state': dict(state),
                        'env': env.state_dict(), 'obs': obs, 'critic_obs': critic_obs,
                        'config': {'obs_terms': env.task.terms, 'n_obs': n_obs, 'n_critic': critic_obs.shape[1],
                                   'n_act': n_act, 'ppo': cfg.to_dict()},
                        'savedAt': now_iso()}, tmp)
            os.replace(tmp, ckpt_path)

        storage = Storage(cfg.steps_per_env, n_envs, n_obs, critic_obs.shape[1], n_act)
        log_path = work / 'log.jsonl'
        iter_time = None
        chunk_steps, chunk_train_s, chunk_iterations = 0, 0.0, 0
        ep_returns, ep_lengths = [], []
        print(f'creature-gym {args.skill}: body {body.id} ({len(body.legs)} legs, {n_act} joints, '
              f'{body.mass_kg:.1f} kg), {n_envs} envs x {threads} threads, target {target:,} env steps'
              f'{" (resumed at " + format(state["env_steps"], ",") + ")" if resumed else ""}', file=sys.stderr)
        progress('training' if state['phase'] == 'training' else state['phase'], running=True)
        try:
            while state['phase'] == 'training' and state['env_steps'] < target:
                if stop_requested['flag']:
                    raise Stop('signal')
                if deadline is not None and iter_time is not None and time.monotonic() + 1.5 * iter_time + 3.0 > deadline:
                    raise Stop('wall')
                if args.chunk_iterations is not None and chunk_iterations >= args.chunk_iterations:
                    raise Stop('chunk-iterations')
                t_iter = time.monotonic()
                infos = []
                for t in range(cfg.steps_per_env):
                    obs_t = torch.from_numpy(obs)
                    crit_t = torch.from_numpy(critic_obs)
                    action, log_prob, value, mu, sigma, obs_n, crit_n = ppo.act(obs_t, crit_t)
                    obs, critic_obs, reward, terminated, truncated, info = env.step(action.numpy())
                    reward = torch.from_numpy(reward)
                    if info['terminal_critic_obs'] is not None:
                        ids = torch.from_numpy(info['truncated_ids'])
                        reward[ids] += cfg.gamma * ppo.value(torch.from_numpy(info['terminal_critic_obs']))
                    storage.obs[t], storage.critic_obs[t], storage.actions[t] = obs_n, crit_n, action
                    storage.log_prob[t], storage.values[t], storage.rewards[t] = log_prob, value, reward
                    storage.dones[t] = torch.from_numpy((terminated | truncated).astype(np.float32))
                    storage.mu[t], storage.sigma[t] = mu, sigma
                    ep_returns.extend(info['episode_returns'].tolist())
                    ep_lengths.extend(info['episode_lengths'].tolist())
                    infos.append(info)
                last_value = ppo.value(torch.from_numpy(critic_obs))
                storage.compute_returns(last_value, cfg.gamma, cfg.lam)
                stats = ppo.update(storage)
                state['iteration'] += 1
                chunk_iterations += 1
                state['env_steps'] += cfg.steps_per_env * n_envs
                env.iteration = state['iteration']
                env.set_progress(state['env_steps'] / target)
                if state['iteration'] % 50 == 0:
                    env.redraw_pool()
                dt = time.monotonic() - t_iter
                iter_time = dt if iter_time is None else 0.8 * iter_time + 0.2 * dt
                chunk_steps += cfg.steps_per_env * n_envs
                chunk_train_s += dt
                state['wall'] += dt
                if ep_returns:
                    state['recent_reward'] = round(float(np.mean(ep_returns[-200:])), 4)
                    state['recent_length'] = round(float(np.mean(ep_lengths[-200:])) * 0.02, 3)
                tracking = {k: round(float(np.mean([i['tracking'][k] for i in infos])), 4) for k in infos[0]['tracking']}
                state['tracking'] = tracking
                sps = chunk_steps / max(chunk_train_s, 1e-9)
                record = {'iteration': state['iteration'], 'envSteps': state['env_steps'], 'sps': round(sps),
                          'iterS': round(dt, 3), 'reward': state['recent_reward'], 'episodeS': state['recent_length'],
                          'falls': int(sum(i['falls'] for i in infos)), 'invalid': int(sum(i['invalid'] for i in infos)),
                          'tracking': tracking, 'curriculum': {k: round(v, 3) for k, v in env.curriculum.items()},
                          'terms': {k: round(float(np.mean([i['terms'][k] for i in infos])), 4) for k in infos[0]['terms']},
                          **{k: round(v, 5) for k, v in stats.items()}}
                with open(log_path, 'a') as handle:
                    handle.write(json.dumps(record) + '\n')
                if state['iteration'] % CHECKPOINT_EVERY == 0:
                    save_checkpoint()
                if state['iteration'] % 10 == 0 or state['iteration'] == 1:
                    eta = (target - state['env_steps']) / max(sps, 1e-9)
                    print(f"it {state['iteration']:5d} steps {state['env_steps']:>11,} sps {sps:7.0f} "
                          f"reward {state['recent_reward']} ep {state['recent_length']}s "
                          f"track {tracking} lr {stats['lr']:.1e} std {stats['std']:.3f} eta {eta / 60:.1f} min",
                          file=sys.stderr)
                progress('training', running=True, steps_per_s=sps)
            if state['phase'] == 'training':
                state['phase'] = 'exporting'
                save_checkpoint()
                progress('training finished; exporting', running=True)
            if args.no_export:
                raise Stop('no-export')
            if state['phase'] in ('exporting', 'evaluating'):
                if deadline is not None and time.monotonic() + EXPORT_RESERVE_S > deadline:
                    raise Stop('wall')
                from .export import export_and_evaluate
                result = export_and_evaluate(body=body, env=env, model=model, out=out, work=work,
                                             run=run, state=state, machine=machine, walk_bundle=args.walk_bundle,
                                             progress=lambda msg, phase: (state.__setitem__('phase', phase),
                                                                          progress(msg, running=True)))
                state['phase'] = 'done'
                state['eval_pass'] = bool(result['pass'])
                save_checkpoint()
                progress('done: validation ' + ('passed' if result['pass'] else 'FAILED (bundle not ready)'),
                         running=False)
        except Stop as reason:
            save_checkpoint()
            progress(f'paused ({reason}); resume with --resume', running=False,
                     steps_per_s=chunk_steps / chunk_train_s if chunk_train_s else None)
        except Exception as error:
            save_checkpoint()
            progress(f'failed: {type(error).__name__}: {error}', running=False, extra={'error': str(error)})
            summary.update(phase='failed', error=str(error))
            raise
        finally:
            env.close()
            summary.update(iteration=state['iteration'], env_steps=state['env_steps'],
                           steps_per_s=round(chunk_steps / chunk_train_s, 1) if chunk_train_s else 0.0,
                           mean_reward=state['recent_reward'], done=state['phase'] == 'done',
                           phase=summary.get('phase') if summary.get('phase') == 'failed' else state['phase'],
                           eval_pass=state['eval_pass'], chunk_wall_s=round(time.monotonic() - T0, 1))
            print(json.dumps(summary), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
