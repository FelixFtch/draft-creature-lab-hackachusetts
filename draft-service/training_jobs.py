"""Local training jobs for draft-service: start, watch and cancel creature_gym runs.

One job at a time. A job is ``python -m creature_gym.train`` launched with the
training venv's interpreter (default ``<repo>/.venv-train/bin/python``, override
with ``CREATURE_TRAIN_PYTHON``) as an argument list (never a shell), in its own
process group so cancel can stop it. The trainer writes
``<bodyDir>/policies/<skill>/progress.json`` every iteration; status reads it.

Bodies are resolved by id through the morphology module's ``body_dir(body_id)``
(injectable for tests). Responses never contain absolute paths or PIDs.

Wire into server.py with ``ROUTES = [(method, path_regex, handler)]`` where
``handler(match, payload) -> (status, dict)``; bind the server to 127.0.0.1 only.
Environment: CREATURE_TRAIN_PYTHON, CREATURE_TRAIN_THREADS (physics threads),
CREATURE_TRAIN_TORCH_THREADS, CREATURE_TRAIN_ENVS.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import threading
import time

SERVICE = Path(__file__).resolve().parent
PROJECT = SERVICE.parent
TRAINING = PROJECT / 'training'
SKILLS = ('walk', 'jump')
BUDGETS = ('quick', 'standard', 'long')
BODY_ID = re.compile(r'^[a-z0-9][a-z0-9-]{0,95}$')
JOB_ID = re.compile(r'^[a-f0-9]{12}$')
SAFE_FILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
MAX_JSON = 4 * 1024 * 1024
CANCEL_GRACE_S = 20.0
POLICY_SCHEMA = 'creature-policy/1'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> dict | None:
    try:
        if not path.is_file() or path.stat().st_size > MAX_JSON:
            return None
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


ABSOLUTE_PATH = re.compile(r'(?:[A-Za-z]:)?(?:[/\\][^\s/\\\'"<>:]+){2,}')


def _scrub(text: object) -> str:
    """Remove local paths from messages that reach the browser (keep only the last name)."""
    value = str(text or '')
    value = ABSOLUTE_PATH.sub(lambda m: '…/' + re.split(r'[/\\]', m.group(0))[-1], value)
    return value[:500]


def default_resolver(body_id: str) -> Path:
    from designs import body_dir  # morphology agent's module (draft-service/designs.py)
    return Path(body_dir(body_id))


def bundle_readiness(body_dir: Path, skill: str, body_assets: dict | None) -> dict:
    """Readiness of ``<body>/policies/<skill>``: hashes verify and eval passes."""
    directory = body_dir / 'policies' / skill
    progress = _read_json(directory / 'progress.json')
    info = {'skill': skill, 'present': (directory / 'manifest.json').is_file(), 'ready': False, 'reasons': [],
            'progress': _progress_summary(progress)}
    manifest = _read_json(directory / 'manifest.json')
    if manifest is None:
        info['reasons'].append('no bundle yet' if not info['present'] else 'manifest unreadable')
        return info
    reasons = info['reasons']
    if manifest.get('schema') != POLICY_SCHEMA or manifest.get('skill') != skill:
        reasons.append('manifest schema/skill mismatch')
        return info

    def verify(name: object, digest: object, label: str) -> None:
        if not isinstance(name, str) or not SAFE_FILE.match(name):
            reasons.append(f'{label}: unsafe file name')
        elif not (directory / name).is_file():
            reasons.append(f'{label}: missing')
        elif _sha256(directory / name) != digest:
            reasons.append(f'{label}: hash mismatch')

    verify(manifest.get('sceneXml'), manifest.get('sceneSha256'), 'scene.xml')
    verify(manifest.get('policy'), manifest.get('policySha256'), 'policy.onnx')
    for asset in manifest.get('assets') or []:
        verify(asset.get('name'), asset.get('sha256'), str(asset.get('name')))
    evaluation = manifest.get('evaluation') or {}
    verify(evaluation.get('evalFile', 'eval.json'), evaluation.get('evalSha256'), 'eval.json')
    report = _read_json(directory / 'eval.json') or {}
    if report.get('pass') is not True:
        reasons.append('validation did not pass')
    if report.get('policySha256') != manifest.get('policySha256') or report.get('sceneSha256') != manifest.get('sceneSha256'):
        reasons.append('evaluation belongs to a different policy/scene')
    if body_assets is not None and manifest.get('bodyAssetSha256') != body_assets:
        reasons.append('trained on a different version of this body (stale)')
    info.update(
        ready=not reasons, bodyId=manifest.get('bodyId'), policySha256=manifest.get('policySha256'),
        evalPass=report.get('pass'), rows=[{'name': r.get('name'), 'pass': r.get('pass')} for r in report.get('rows', [])],
        training={k: (manifest.get('training') or {}).get(k) for k in ('envSteps', 'iterations', 'wallSeconds', 'budget')},
        honesty=manifest.get('honesty'))
    if skill == 'jump':
        info['handoffWalkPolicySha256'] = (manifest.get('handoff') or {}).get('walkPolicySha256')
    return info


def _progress_summary(progress: dict | None) -> dict | None:
    if not progress:
        return None
    keys = ('phase', 'running', 'done', 'iteration', 'envSteps', 'envStepsTarget', 'fraction', 'stepsPerSecond',
            'meanReward', 'meanEpisodeLengthS', 'tracking', 'etaSeconds', 'wallSeconds', 'updatedAt', 'evalPass',
            'budget', 'chunks')
    out = {k: progress.get(k) for k in keys}
    out['message'] = _scrub(progress.get('message'))
    machine = progress.get('machine') or {}
    out['machine'] = {k: machine.get(k) for k in ('machine', 'cpu', 'cpuCount', 'threads')}
    return out


class JobManager:
    def __init__(self, *, python: str | Path | None = None, resolver=None, training_root: Path = TRAINING,
                 popen=subprocess.Popen, threads: int | None = None):
        self.python = Path(python or os.environ.get('CREATURE_TRAIN_PYTHON') or PROJECT / '.venv-train/bin/python')
        self.resolver = resolver or default_resolver
        self.training_root = Path(training_root)
        self.popen = popen
        self.threads = threads or int(os.environ.get('CREATURE_TRAIN_THREADS', '0') or 0) or max(1, min(8, os.cpu_count() or 1))
        self.lock = threading.Lock()
        self.job: dict | None = None

    # ------------------------------------------------------------------ helpers
    def _body(self, body_id: object) -> tuple[Path, dict]:
        if not isinstance(body_id, str) or not BODY_ID.match(body_id):
            raise ValueError('bodyId must be lowercase letters, digits and dashes')
        try:
            directory = Path(self.resolver(body_id)).resolve()
        except (KeyError, LookupError, FileNotFoundError, ValueError) as error:
            raise LookupError(f'unknown body {body_id}') from error
        contract = _read_json(directory / 'body.json')
        if contract is None or contract.get('id') != body_id:
            raise LookupError(f'unknown body {body_id}')
        return directory, contract

    def _running(self) -> bool:
        job = self.job
        return bool(job and job['process'].poll() is None)

    def _public(self, job: dict | None) -> dict:
        if job is None:
            return {'job': None}
        code = job['process'].poll()
        progress = _read_json(job['out'] / 'progress.json')
        if code is None:
            status = 'cancelling' if job.get('cancelRequested') else 'running'
        elif job.get('cancelRequested'):
            status = 'cancelled'
        elif code == 0 and progress and progress.get('phase') == 'done':
            status = 'finished'
        elif code == 0:
            status = 'paused'      # chunk ended (wall limit); start again to resume
        else:
            status = 'failed'
        public = {k: job[k] for k in ('id', 'bodyId', 'skill', 'budget', 'seed', 'startedAt')}
        public.update(status=status, exitCode=code, progress=_progress_summary(progress), endedAt=job.get('endedAt'))
        if status == 'failed':
            public['error'] = _scrub((progress or {}).get('error') or (progress or {}).get('message') or f'trainer exited with code {code}')
        if code is not None and not job.get('endedAt'):
            job['endedAt'] = public['endedAt'] = _now()
        return {'job': public}

    # ------------------------------------------------------------------ actions
    def start(self, payload: dict | None) -> tuple[int, dict]:
        payload = payload or {}
        skill = payload.get('skill', 'walk')
        budget = payload.get('budget', 'quick')
        seed = payload.get('seed', 0)
        if skill not in SKILLS:
            return 400, {'error': f'skill must be one of {SKILLS}'}
        if budget not in BUDGETS:
            return 400, {'error': f'budget must be one of {BUDGETS}'}
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2 ** 31:
            return 400, {'error': 'seed must be an integer 0..2^31-1'}
        try:
            body_dir, contract = self._body(payload.get('bodyId'))
        except ValueError as error:
            return 400, {'error': str(error)}
        except LookupError as error:
            return 404, {'error': str(error)}
        if skill == 'jump':
            walk = bundle_readiness(body_dir, 'walk', (contract.get('provenance') or {}).get('assetSha256'))
            if not walk['ready']:
                return 409, {'error': 'train a ready walk policy first (the jump hands back to it)', 'walk': walk['reasons']}
        if not self.python.is_file():
            return 503, {'error': 'training environment missing; run training/setup-train-env.sh'}
        with self.lock:
            if self._running():
                return 409, {'error': 'a training job is already running', **self._public(self.job)}
            out = body_dir / 'policies' / skill
            (out / '.work').mkdir(parents=True, exist_ok=True)
            command = [str(self.python), '-m', 'creature_gym.train', '--body', str(body_dir), '--skill', skill,
                       '--budget', budget, '--out', str(out), '--seed', str(seed), '--resume',
                       '--threads', str(self.threads)]
            torch_threads = os.environ.get('CREATURE_TRAIN_TORCH_THREADS')
            if torch_threads and torch_threads.isdigit():
                command += ['--torch-threads', torch_threads]
            envs = os.environ.get('CREATURE_TRAIN_ENVS')
            if envs and envs.isdigit():
                command += ['--envs', envs]
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT')}
            env['PYTHONPATH'] = str(self.training_root)
            env['PYTHONUNBUFFERED'] = '1'
            log = open(out / '.work' / 'train.log', 'ab')
            try:
                process = self.popen(command, cwd=str(self.training_root), env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
            finally:
                log.close()
            self.job = {'id': secrets.token_hex(6), 'bodyId': contract['id'], 'skill': skill, 'budget': budget,
                        'seed': seed, 'startedAt': _now(), 'process': process, 'out': out}
            return 202, self._public(self.job)

    def status(self, job_id: str | None = None) -> tuple[int, dict]:
        with self.lock:
            if job_id is not None and (self.job is None or self.job['id'] != job_id):
                return 404, {'error': 'unknown job'}
            return 200, self._public(self.job)

    def cancel(self, job_id: str) -> tuple[int, dict]:
        with self.lock:
            job = self.job
            if job is None or job['id'] != job_id:
                return 404, {'error': 'unknown job'}
            if job['process'].poll() is not None:
                return 200, self._public(job)
            job['cancelRequested'] = True
            process = job['process']
        # The trainer checkpoints on SIGTERM after its current iteration; escalate if it hangs.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, AttributeError):
            process.terminate()

        def escalate():
            deadline = time.monotonic() + CANCEL_GRACE_S
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    return
                time.sleep(0.2)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, AttributeError):
                process.kill()

        threading.Thread(target=escalate, daemon=True).start()
        with self.lock:
            return 202, self._public(job)

    def policies(self, body_id: str) -> tuple[int, dict]:
        try:
            body_dir, contract = self._body(body_id)
        except ValueError as error:
            return 400, {'error': str(error)}
        except LookupError as error:
            return 404, {'error': str(error)}
        assets = (contract.get('provenance') or {}).get('assetSha256')
        skills = {skill: bundle_readiness(body_dir, skill, assets) for skill in SKILLS}
        if skills['jump']['ready'] and skills['walk']['ready'] and \
                skills['jump'].get('handoffWalkPolicySha256') != skills['walk'].get('policySha256'):
            skills['jump']['ready'] = False
            skills['jump']['reasons'].append('jump handoff was validated with a different walk policy')
        with self.lock:
            active = self.job if self._running() and self.job['bodyId'] == body_id else None
        return 200, {'bodyId': body_id, 'skills': skills,
                     'activeJob': self._public(active)['job'] if active else None}


MANAGER = JobManager()


def _start(match, payload):
    return MANAGER.start(payload if isinstance(payload, dict) else None)


def _current(match, payload):
    return MANAGER.status()


def _status(match, payload):
    return MANAGER.status(match.group('job_id'))


def _cancel(match, payload):
    return MANAGER.cancel(match.group('job_id'))


def _policies(match, payload):
    return MANAGER.policies(match.group('body_id'))


ROUTES = [
    ('POST', r'^/api/training/jobs$', _start),
    ('GET', r'^/api/training/jobs/current$', _current),
    ('GET', r'^/api/training/jobs/(?P<job_id>[a-f0-9]{12})$', _status),
    ('POST', r'^/api/training/jobs/(?P<job_id>[a-f0-9]{12})/cancel$', _cancel),
    ('GET', r'^/api/creatures/(?P<body_id>[a-z0-9][a-z0-9-]{0,95})/policies$', _policies),
]
