"""Check distributed source syntax and plugin entry files without deployment."""
from pathlib import Path
import ast, json, re, shutil, subprocess

ROOT = Path(__file__).resolve().parents[1]
PLUGIN, REMOTE, INSTALLER = ROOT / 'plugin', ROOT / 'remote', ROOT / 'installer'
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js 24 must be on PATH')

python_files = [*REMOTE.glob('*.py'), *INSTALLER.glob('*.py'), *(ROOT / 'scripts').glob('*.py')]
python_files += [REMOTE / 'windows-agent', REMOTE / 'windows-workspace']
for file in python_files:
    if not file.name.startswith('test-'):
        ast.parse(file.read_text(encoding='utf-8-sig'), filename=str(file))
for file in [*PLUGIN.glob('*.mjs'), *(PLUGIN / 'runtime').glob('*.mjs'), *REMOTE.glob('*.mjs'), *INSTALLER.glob('*.mjs')]:
    if not file.name.startswith(('test-', 'benchmark-')):
        subprocess.run([node, '--check', str(file)], check=True, cwd=ROOT)

# The optional Desktop extension ships separately but must stay loadable.
EXTENSION = ROOT / 'extension'
extension = json.loads((EXTENSION / 'manifest.json').read_text(encoding='utf-8'))
if extension.get('manifestVersion') != 1 or extension.get('desktopApi') != 1:
    raise SystemExit('extension/manifest.json must target manifestVersion 1 and desktopApi 1')
for resource in (extension['desktop']['script'], extension['desktop']['style'], extension['backend']['script']):
    file = EXTENSION / resource
    if not file.is_file():
        raise SystemExit('Missing extension file: extension/' + resource)
    if file.suffix in ('.js', '.mjs'):
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

# Remote metadata is generated from these same source files during deployment.
for name in ('bridge-manifest.json','workspace-request-schema.json'):
    if "payload['"+name+"']" not in deploy:raise SystemExit('Missing generated metadata: '+name)
if 'bridgeVersion:' in (REMOTE / 'remote-server.mjs').read_text(encoding='utf-8'):
    raise SystemExit('Remote version must come from the deployed manifest')
print('PASS Source syntax, plugin entry, shared transport and install manifest; runtime acceptance was not run')
