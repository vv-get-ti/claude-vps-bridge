"""Prepare locked local dependencies without requiring the optional browser."""
from pathlib import Path
import argparse,json,shutil,subprocess,tempfile,os
from bridge_config import PLUGIN,load_config

def prepare(directory,config,with_playwright=False):
    lock=json.loads((directory/'package-lock.json').read_text())
    selected={name:entry for name,entry in lock['packages'].items() if name and (with_playwright or not entry.get('optional'))}
    missing=[]
    for name,entry in selected.items():
        target=directory/name
        if not target.exists():missing.append(name);continue
        package=target/'package.json'
        if not package.is_file() or json.loads(package.read_text()).get('version')!=entry['version']:
            raise RuntimeError('Existing dependency differs from the lock; preserved for inspection: '+name)
    if not missing:return {'prepared':True,'downloaded':False,'optionalBrowserRequested':with_playwright}
    npm=shutil.which('npm.cmd') or shutil.which('npm')
    candidates=[Path(npm).parent/'node_modules/npm/bin/npm-cli.js',Path(npm).resolve().parent.parent/'lib/node_modules/npm/bin/npm-cli.js'] if npm else []
    npm_cli=next((p for p in candidates if p.is_file()),None)
    if not npm_cli:raise RuntimeError('Install Node.js with npm on Windows to prepare local dependencies')
    stage=Path(tempfile.mkdtemp(prefix='claude-vps-dependencies-'))
    for name in ['package.json','package-lock.json']:shutil.copyfile(directory/name,stage/name)
    node=Path(config['hostRoot'])/'runtime/node.exe'
    args=[str(node),str(npm_cli),'ci','--ignore-scripts','--no-audit','--no-fund']+([] if with_playwright else ['--omit=optional'])
    env={**os.environ,'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD':'1'}
    env['PATH']=str(node.parent)+os.pathsep+env.get('PATH','')
    result=subprocess.run(args,cwd=stage,env=env,capture_output=True,text=True,timeout=180)
    if result.returncode:raise RuntimeError('Locked dependency download failed; installed runtime unchanged. Staging directory: '+str(stage))
    # Copy only missing locked packages. Existing source and installed modules are never removed.
    for name in missing:
        package=stage/name/'package.json'
        if not package.is_file() or json.loads(package.read_text()).get('version')!=selected[name]['version']:
            raise RuntimeError('Required selected dependency was not installed: '+name)
    for name in missing:
        target=directory/name
        if target.exists():raise RuntimeError('Dependency appeared concurrently; no overwrite: '+name)
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(stage/name,target)
    return {'prepared':True,'downloaded':True,'optionalBrowserRequested':with_playwright,'packages':missing,'stage':str(stage)}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--with-playwright',action='store_true');a=p.parse_args()
    print(json.dumps(prepare(PLUGIN/'runtime',load_config(),a.with_playwright)))
