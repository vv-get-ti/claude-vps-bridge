"""Prepare the pinned VPS dependency without selecting it or changing global npm."""
from pathlib import Path
import json,re,subprocess
from bridge_config import load_config,remote_python
config=load_config()
policy=json.loads(Path(__file__).with_name('dependency-policy.json').read_text())
version=policy['version']
if policy['package']!='@codexhost/cli' or not re.fullmatch(r'\d+\.\d+\.\d+',version):raise RuntimeError('Invalid dependency policy')
script=r'''
import pathlib,json,subprocess,shutil,os,hashlib
version=VERSION
target=pathlib.Path(REMOTE_ROOT)/'dependencies'/('codexhost-'+version)
paths=discover_remote({'node':REMOTE_NODE},required=('node','npm'));node=paths['node'];npm=paths['npm']
if not target.exists():
    target.mkdir(parents=True)
    r=subprocess.run([npm,'install','--prefix',str(target),'--save-exact','--ignore-scripts','--no-audit','--no-fund','@codexhost/cli@'+version],capture_output=True,text=True,timeout=180)
    if r.returncode:raise RuntimeError(r.stderr[-1000:])
pkg=target/'node_modules/@codexhost/cli/package.json'
platform=target/'node_modules/@codexhost/cli-linux-x64/package.json'
if json.loads(pkg.read_text())['version']!=version or json.loads(platform.read_text())['version']!=version:raise RuntimeError('Dependency version mismatch; existing directory left untouched')
adapter=platform.parent/'app/plugins/claude-code/plugin.mjs'
subprocess.run([node,'--input-type=module','-e','const m=await import('+json.dumps(adapter.as_uri())+');if(typeof m.createHarnessAdapter!=="function")throw Error("Invalid adapter")'],check=True,capture_output=True,timeout=30)
print(json.dumps({'prepared':True,'selected':False,'version':version,'path':str(adapter),'sha256':hashlib.sha256(adapter.read_bytes()).hexdigest()}))
'''.replace('VERSION',repr(version)).replace('REMOTE_ROOT',repr(config['remoteRoot'])).replace('REMOTE_NODE',repr(config.get('remoteNodeExecutable')))
print(remote_python(config,script,timeout=220))
