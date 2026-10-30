"""Read-only executable discovery, also embedded into remote Python requests."""
import os
import pathlib
import shutil
import subprocess


def discover_remote(overrides=None, required=('node', 'npm', 'claude')):
    overrides = overrides or {}
    # bash -lc alone does not load nvm in distributions with an early .bashrc return.
    script = r'''
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1; fi
if command -v fnm >/dev/null 2>&1; then eval "$(fnm env --shell bash)"; fi
if command -v npm >/dev/null 2>&1; then prefix=$(npm config get prefix 2>/dev/null); [ -z "$prefix" ] || export PATH="$PATH:$prefix/bin"; fi
for name in node npm claude; do printf '\nBRIDGE_EXEC_%s=' "$name"; command -v "$name" || true; done
'''
    found = {}
    bash = shutil.which('bash')
    if bash:
        result = subprocess.run([bash, '-lc', script], capture_output=True, text=True, timeout=30)
        for line in result.stdout.splitlines():
            if line.startswith('BRIDGE_EXEC_') and '=' in line:
                key, value = line[len('BRIDGE_EXEC_'):].split('=', 1)
                found[key] = value.strip()
    for name in required:
        value = overrides.get(name) or found.get(name) or shutil.which(name)
        if not value or not pathlib.Path(value).is_absolute() or not pathlib.Path(value).is_file() or not os.access(value, os.X_OK):
            hint = '；请用 --remote-claude 指定实际路径' if name == 'claude' else '；可用 --remote-node 指定 Node 路径' if name == 'node' else '；请安装 npm 并检查登录 shell 的 PATH'
            raise RuntimeError('远端 '+name+' 不存在或不可执行'+hint)
        found[name] = str(pathlib.Path(value).absolute())
    # npm and npm-installed Claude may use /usr/bin/env node.
    os.environ['PATH'] = os.pathsep.join(dict.fromkeys([str(pathlib.Path(found[n]).parent) for n in required]+[os.environ.get('PATH', '')]))
    return {name: found[name] for name in required}
