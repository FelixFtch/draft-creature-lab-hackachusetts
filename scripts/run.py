#!/usr/bin/env python3
"""Start the local lab. No VLM model or training process is launched."""
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
            raise SystemExit(f'Port {port} is already occupied. Stop that server yourself or choose another --port/--api-port. No process was stopped.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18381)
    parser.add_argument('--api-port', type=int, default=18382)
    parser.add_argument('--with-vision', action='store_true', help='Start the optional CPU adapter using --vision-config; never starts a model.')
    parser.add_argument('--vision-config', type=Path, default=ROOT/'vlm-service/config.json')
    args = parser.parse_args()
    if args.port == args.api_port or not all(1024 <= p <= 65535 for p in (args.port,args.api_port)):
        parser.error('Choose two distinct ports from 1024 to 65535.')
    if not (ROOT/'play/node_modules').is_dir():
        raise SystemExit('Run ./setup.sh first (missing frontend dependencies).')
    port_available(args.port)
    port_available(args.api_port)
    env = dict(os.environ, DRAFT_API_PORT=str(args.api_port), LAB_PORT=str(args.port))
    children = []
    if args.with_vision:
        if not args.vision_config.is_file():
            raise SystemExit('Copy vlm-service/config.example.json to config.json and configure your existing local provider first.')
        config = json.loads(args.vision_config.read_text())
        port_available(config['port'])
        env['VLM_ADAPTER_PORT'] = str(config['port'])
    subprocess.run(['npm','run','build'],cwd=ROOT/'play',env=env,check=True)
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    def spawn(command):
        child = subprocess.Popen(command,cwd=ROOT,env=env,start_new_session=True)
        children.append(child)
        return child
    try:
        api = spawn([sys.executable,str(ROOT/'draft-service/server.py'),'--port',str(args.api_port)])
        for _ in range(120):
            if api.poll() is not None:
                raise RuntimeError('Generator exited before becoming ready.')
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{args.api_port}/api/health',timeout=1) as response:
                    if json.load(response).get('service') == 'draft-generator':
                        break
            except (OSError,ValueError):
                pass
            time.sleep(.25)
        else:
            raise RuntimeError('Generator did not become ready within 30 seconds.')
        if args.with_vision:
            spawn([sys.executable,str(ROOT/'vlm-service/server.py'),'--config',str(args.vision_config.resolve())])
        front = spawn(['npm','--prefix',str(ROOT/'play'),'run','preview','--','--host','127.0.0.1','--port',str(args.port),'--strictPort'])
        print(f'\nDraft Creature Lab: http://127.0.0.1:{args.port}/\nManual joystick ready. VLM model is not started. Ctrl+C stops these lab services.\n',flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(.25)
        failed = [(child.pid,child.returncode) for child in children if child.poll() is not None]
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
