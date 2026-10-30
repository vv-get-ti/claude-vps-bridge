"""Check distributed source syntax and plugin entry files without deployment."""
from pathlib import Path
import ast, json, re, shutil, subprocess

ROOT = Path(__file__).resolve().parents[1]
PLUGIN, REMOTE, INSTALLER = ROOT / 'plugin', ROOT / 'remote', ROOT / 'installer'
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js 24 must be on PATH')

python_files = [*REMOTE.glob('*.py'), *INSTALLER.glob('*.py'), *(ROOT / 'scripts').glob('*.py'), *(ROOT / 'compatibility').rglob('*.py')]
python_files += [REMOTE / 'windows-agent', REMOTE / 'windows-workspace']
for file in python_files:
    if not file.name.startswith('test-'):
        ast.parse(file.read_text(encoding='utf-8-sig'), filename=str(file))
for file in [*PLUGIN.glob('*.mjs'), *(PLUGIN / 'runtime').glob('*.mjs'), *REMOTE.glob('*.mjs'), *INSTALLER.glob('*.mjs')]:
    if not file.name.startswith(('test-', 'benchmark-')):
        subprocess.run([node, '--check', str(file)], check=True, cwd=ROOT)

manifest = json.loads((PLUGIN / 'manifest.json').read_text(encoding='utf-8'))
for field in ('entry', 'icon'):
    if not (PLUGIN / manifest[field]).is_file():
        raise SystemExit('Missing plugin file: ' + manifest[field])

# Both ends load the same stream framing; the two copies must not drift.
if (PLUGIN / 'transport-streams.mjs').read_bytes() != (REMOTE / 'transport-streams.mjs').read_bytes():
    raise SystemExit('plugin/transport-streams.mjs and remote/transport-streams.mjs differ')

# Every file the installer copies to the VPS must exist in remote/.
deploy = (INSTALLER / 'deploy-transaction.py').read_text(encoding='utf-8')
names = re.search(r"names=\(([^)]*)\)", deploy).group(1)
for name in re.findall(r"'([^']+)'", names):
    if not (REMOTE / name).is_file():
        raise SystemExit('Installer copies a missing remote file: remote/' + name)

# The plugin and remote copies of the version must match.
version = re.search(r"bridgeVersion:'([^']+)'", (REMOTE / 'remote-server.mjs').read_text(encoding='utf-8')).group(1)
if version != manifest['version']:
    raise SystemExit('Version mismatch: manifest ' + manifest['version'] + ', remote ' + version)
print('PASS Source syntax, plugin entry, shared transport and install manifest; runtime acceptance was not run')
