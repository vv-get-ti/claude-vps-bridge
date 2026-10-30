"""Non-secret installation settings shared by install commands. No account imports."""
from pathlib import Path, PurePosixPath
import json, os, re, subprocess

INSTALLER = Path(__file__).resolve().parent
# Repository root: local config, transactions and reports live here (git-ignored).
SOURCE = INSTALLER.parent
PLUGIN = SOURCE/'plugin'   # copied to the CodexHost plugin directory
REMOTE = SOURCE/'remote'   # copied flat to remoteRoot on the VPS
INSTALLED = Path.home()/'.codexhost/plugins/claude-vps'

def validate(value):
    if value.get('schemaVersion') != 1:
        raise ValueError('Unsupported bridge configuration version')
    if not isinstance(value.get('sshHost'), str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]*', value['sshHost']):
        raise ValueError('sshHost must be an SSH alias or user@host, not command options')
    for key in ('hostRoot', 'sshExecutable', 'pwshExecutable'):
        if not isinstance(value.get(key), str) or not Path(value[key]).is_absolute() or any(c in value[key] for c in '\r\n\0'):
            raise ValueError(key+' must be an absolute local path')
    for key in ('remoteRoot', 'remoteWorkspaceRoot', 'remoteClaudeExecutable', *(['remoteNodeExecutable'] if 'remoteNodeExecutable' in value else [])):
        p=value.get(key)
        if not isinstance(p,str) or not p.startswith('/') or p=='/' or '..' in PurePosixPath(p).parts or any(c in p for c in '\r\n\0'):
            raise ValueError(key+' must be an absolute remote path without parent traversal')
    return value

def load_config():
    explicit=os.environ.get('CLAUDE_VPS_CONFIG')
    candidates=[Path(explicit)] if explicit else [SOURCE/'bridge-config.local.json',INSTALLED/'bridge-config.json']
    for file in candidates:
        if file.is_file():return validate(json.loads(file.read_text(encoding='utf-8-sig')))
    raise RuntimeError('Bridge configuration missing. Run configure.py --ssh-host <alias> --host-root <CodexHost directory>.')

def ssh_args(config,command):
    return [config['sshExecutable'],'-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12',config['sshHost'],command]

def remote_python(config,code,timeout=120):
    code=(INSTALLER/'remote_discovery.py').read_text(encoding='utf-8')+'\n'+code
    result=subprocess.run(ssh_args(config,'python3 -'),input=code.encode(),capture_output=True,timeout=timeout)
    if result.returncode:raise RuntimeError(result.stderr.decode(errors='replace'))
    return result.stdout.decode()
