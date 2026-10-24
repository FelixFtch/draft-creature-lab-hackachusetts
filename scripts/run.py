#!/usr/bin/env python3
"""Start the local lab: Draft generator API, ai-service (Tinker + vision) and the web app.

No AI model or training process is launched here. Tinker answers with its
built-in offline designer until a local model (scripts/setup-local-ai.sh) or a
cloud key (ai-service/README.md) is configured; training starts only when you
ask for it in the app.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def port_available(port):
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit(f'Port {port} is already occupied. Stop that server yourself or choose other --port/--api-port/--ai-port values. No process was stopped.')


def wait_for(url, service, child, label, seconds=30):
    for _ in range(int(seconds / .25)):
        if child.poll() is not None:
            raise RuntimeError(f'{label} exited before becoming ready.')
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if json.load(response).get('service') == service:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    raise RuntimeError(f'{label} did not become ready within {seconds} seconds.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=18381, help='web app (default 18381)')
    parser.add_argument('--api-port', type=int, default=18382, help='Draft generator API (default 18382)')
    parser.add_argument('--ai-port', type=int, default=18383, help='ai-service: Tinker + vision (default 18383)')
    parser.add_argument('--ai-config', type=Path, default=None, help='ai-service config (default ai-service/config.json; optional)')
    parser.add_argument('--with-vision', action='store_true', help=argparse.SUPPRESS)  # kept for old scripts: ai-service always runs
    parser.add_argument('--vision-config', type=Path, default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()
    ports = (args.port, args.api_port, args.ai_port)
    if len(set(ports)) != 3 or not all(1024 <= p <= 65535 for p in ports):
        parser.error('Choose three distinct ports from 1024 to 65535.')
    if not (ROOT/'play/node_modules').is_dir():
        raise SystemExit('Run ./setup.sh first (missing frontend dependencies).')
    for port in ports:
        port_available(port)
    ai_config = args.ai_config or args.vision_config
    if ai_config is None and not (ROOT/'ai-service/config.json').is_file() and (ROOT/'vlm-service/config.json').is_file():
        ai_config = ROOT/'vlm-service/config.json'  # earlier vision setups keep working as the "eyes" role
    env = dict(os.environ, DRAFT_API_PORT=str(args.api_port), LAB_PORT=str(args.port),
               AI_SERVICE_PORT=str(args.ai_port), VLM_ADAPTER_PORT=str(args.ai_port))
    children = []
    subprocess.run(['npm', 'run', 'build'], cwd=ROOT/'play', env=env, check=True)

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

    def spawn(command):
        child = subprocess.Popen(command, cwd=ROOT, env=env, start_new_session=True)
        children.append(child)
        return child
    try:
        api = spawn([sys.executable, str(ROOT/'draft-service/server.py'), '--port', str(args.api_port)])
        wait_for(f'http://127.0.0.1:{args.api_port}/api/health', 'draft-generator', api, 'The Draft generator', 60)
        ai_command = [sys.executable, str(ROOT/'ai-service/server.py'), '--port', str(args.ai_port)]
        if ai_config is not None:
            ai_command += ['--config', str(Path(ai_config).resolve())]
        ai = spawn(ai_command)
        wait_for(f'http://127.0.0.1:{args.ai_port}/health', 'draft_ai_service', ai, 'The ai-service')
        spawn(['npm', '--prefix', str(ROOT/'play'), 'run', 'preview', '--', '--host', '127.0.0.1', '--port', str(args.port), '--strictPort'])
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{args.ai_port}/health', timeout=2) as response:
                health = json.load(response)
            brain = health.get('roles', {}).get('brain') or {}
            tinker = f"{brain.get('provider')} · {brain.get('model')}" if brain.get('configured') else 'offline designer (no AI model configured)'
        except (OSError, ValueError):
            tinker = 'starting'
        print(f'\nDraft Creature Lab: http://127.0.0.1:{args.port}/\nTinker: {tinker}\nCtrl+C stops these lab services.\n', flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(.25)
        failed = [(child.pid, child.returncode) for child in children if child.poll() is not None]
        raise RuntimeError(f'A lab process exited: {failed}')
    except KeyboardInterrupt:
        pass
    finally:
        # Only process groups created by this launcher are stopped.
        for child in reversed(children):
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()


if __name__ == '__main__':
    main()
