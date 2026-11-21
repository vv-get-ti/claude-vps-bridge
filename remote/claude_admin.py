"""One-shot version checks and the configured Claude Code's official updater."""
import json
from http.client import HTTPException
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
from tempfile import TemporaryFile
from urllib.request import urlopen

from bridge_paths import ROOT
from session_files import SessionError
from session_lease import lock

NUMBER = r'(?:0|[1-9][0-9]*)'
SEMVER = rf'{NUMBER}\.{NUMBER}\.{NUMBER}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?'
READY = 'CLAUDE_VPS_SESSION_ADMIN_READY_V1'
MESSAGES = {
    'INVALID_ARGUMENT': 'Claude Code 管理请求无效。',
    'CLAUDE_UNAVAILABLE': '无法读取已配置的 Claude Code 版本。',
    'UPDATE_IN_PROGRESS': '此 VPS 桥接安装已有 Claude Code 更新正在运行。',
    'STATE_UNKNOWN': '无法核实 Claude Code 更新锁，未启动更新。',
    'RESULT_UNKNOWN': 'Claude Code 更新结果未确认。请重新检查版本。',
}


def parse_version(output, *, claude=False):
    pattern = rf'({SEMVER}) \(Claude Code\)' if claude else SEMVER
    values = []
    for line in output.splitlines():
        line = line.strip()
        if len(line) > 128:
            continue
        match = re.fullmatch(pattern, line)
        if match:
            values.append(match[1] if claude else match[0])
    return values[0] if len(values) == 1 else None


def version_key(version):
    core, _, pre = version.split('+', 1)[0].partition('-')
    precedence = tuple((0, int(part)) if part.isdecimal() else (1, part) for part in pre.split('.')) if pre else ((2, 0),)
    return tuple(map(int, core.split('.'))), precedence


def run(args, timeout, env=None, *, capture=True, pass_fds=()):
    # SSH loss must not release the update lock while the updater is still
    # running. Its subprocess group is also independent of the SSH session.
    with TemporaryFile() as output:
        with subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              stdout=output if capture else subprocess.DEVNULL, start_new_session=True,
                              pass_fds=pass_fds) as child:
            try:
                status = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
                raise
            if status:
                raise subprocess.CalledProcessError(status, args)
        output.seek(0)
        return output.read(4096).decode('utf8', errors='replace')


def installation_method(executable):
    try:
        target = Path(executable).resolve(strict=True)
    except (OSError, RuntimeError):
        return 'unknown', None
    if target.parts[-4:-1] == ('node_modules', '@anthropic-ai', 'claude-code') and target.name == 'cli.js':
        modules = target.parents[2]
        if modules.parent.name == 'lib':
            return 'npm', str(modules.parent.parent)
        return 'npm', str(modules.parent)
    data = {Path.home() / '.local' / 'share'}
    if os.environ.get('XDG_DATA_HOME'):
        data.add(Path(os.environ['XDG_DATA_HOME']))
    if parse_version(target.name) and any(target.parent == (base / 'claude' / 'versions').resolve() for base in data):
        return 'native', None
    return 'unknown', None


def installed_version(executable):
    try:
        output = run([executable, '--version'], 8, {**os.environ, 'DISABLE_AUTOUPDATER': '1'})
        value = parse_version(output, claude=True)
        if value:
            return value
    except (OSError, subprocess.SubprocessError):
        pass
    raise SessionError('CLAUDE_UNAVAILABLE')


def update_channel():
    config = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude')
    channel = 'latest'
    for file in (config / 'settings.json', Path('/etc/claude-code/managed-settings.json')):
        try:
            with file.open('rb') as stream:
                settings = json.loads(stream.read(1024 * 1024 + 1))
            channel = settings.get('autoUpdatesChannel', channel)
        except FileNotFoundError:
            continue
        except (OSError, ValueError, AttributeError):
            return None
    return channel if channel in ('latest', 'stable') else None


def latest_version():
    channel = update_channel()
    if channel is None:
        return None
    # Same official channel endpoints as the upstream Claude Harness.
    try:
        with urlopen('https://downloads.claude.ai/claude-code-releases/' + channel, timeout=8) as response:
            value = parse_version(response.read(4096).decode('utf8'))
        if value:
            return value
    except (OSError, ValueError, HTTPException):
        pass
    if channel == 'stable':
        return None  # npm latest cannot establish the stable-channel version
    try:
        return parse_version(run(['npm', 'view', '@anthropic-ai/claude-code', 'version',
                                  '--fetch-retries=0', '--fetch-timeout=8000'], 12))
    except (OSError, subprocess.SubprocessError):
        return None


def status(version, method, before=None):
    latest = latest_version()
    result = {'installed': version, 'latest': latest, 'method': method,
              'updateAvailable': bool(latest and version_key(latest) > version_key(version))}
    if before is not None:
        result['output'] = ('Claude Code ' + before + ' → ' + version if version != before else 'Claude Code ' + version)
    return result


def dispatch(executable, request):
    if not isinstance(request, dict) or set(request) != {'action'} or request['action'] not in ('check', 'update'):
        raise SessionError('INVALID_ARGUMENT')
    if request['action'] == 'check':
        return status(installed_version(executable), installation_method(executable)[0])
    try:
        with lock(ROOT / 'run' / 'claude-update.lock', yield_fd=True) as lock_fd:
            if lock_fd is False:
                raise SessionError('UPDATE_IN_PROGRESS')
            before = installed_version(executable)
            _, prefix = installation_method(executable)
            env = {**os.environ, **({'npm_config_prefix': prefix, 'NPM_CONFIG_PREFIX': prefix} if prefix else {})}
            try:
                run([executable, 'update'], 300, env, capture=False, pass_fds=(lock_fd,))
                after = installed_version(executable)
            except (OSError, subprocess.SubprocessError, SessionError):
                raise SessionError('RESULT_UNKNOWN') from None
            result = status(after, installation_method(executable)[0], before)
            if after == before and result['latest'] is None:
                raise SessionError('RESULT_UNKNOWN')
            return result
    except OSError:
        raise SessionError('STATE_UNKNOWN') from None


def main():
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    print(READY, file=sys.stderr, flush=True)
    try:
        if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
            raise SessionError('INVALID_ARGUMENT')
        result = dispatch(sys.argv[1], json.loads(sys.stdin.buffer.read(4097)))
        response = {'apiVersion': 1, 'ok': True, 'result': result}
    except (SessionError, ValueError, UnicodeError) as error:
        code = error.code if isinstance(error, SessionError) else 'INVALID_ARGUMENT'
        response = {'apiVersion': 1, 'ok': False, 'error': {'code': code, 'message': MESSAGES.get(code, MESSAGES['STATE_UNKNOWN']), 'details': {}}}
    print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
