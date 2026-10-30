"""Prepare both ends first; compensate code changes on failure, retaining state."""
from pathlib import Path
import os,json,subprocess,datetime,hashlib,argparse
from bridge_config import load_config,remote_python,INSTALLED,INSTALLER,PLUGIN,REMOTE,SOURCE
def sha(data):return hashlib.sha256(data).hexdigest()
def replace(dest,data):
    dest.parent.mkdir(parents=True,exist_ok=True);tmp=dest.with_name(dest.name+'.transaction.tmp');tmp.write_bytes(data);os.replace(tmp,dest)
def remote(request,config=None):
    config=config or load_config()
    code=(INSTALLER/'deploy-remote.py').read_text()+'\nROOT=pathlib.Path('+repr(config['remoteRoot'])+')\nprint(json.dumps(main(json.loads('+repr(json.dumps(request))+'))))\n'
    return json.loads(remote_python(config,code))
def restore_local(stage,journal,check_only=False):
    # Old transaction journals may contain Host bundles. They are never restored.
    if any(Path(row['path']).name=='host-runtime.mjs' for row in journal['files']):raise RuntimeError('旧事务包含宿主文件，拒绝回滚；请重装或升级 CodexHost 清除旧补丁')
    for row in journal['files']:
        p=Path(row['path']);current=sha(p.read_bytes()) if p.exists() else None
        if current not in (row['beforeHash'],row['sha256']):raise RuntimeError('Rollback conflict: '+str(p))
        if row['beforeHash'] is not None and sha((stage/(row['key']+'.old')).read_bytes())!=row['beforeHash']:raise RuntimeError('Rollback backup fingerprint mismatch: '+str(p))
    if check_only:return
    for row in journal['files']:
        p=Path(row['path'])
        if row['beforeHash'] is None:
            if p.exists():p.unlink()
        else:replace(p,(stage/(row['key']+'.old')).read_bytes())
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rollback');parser.add_argument('--fail-after-local',action='store_true',help=argparse.SUPPRESS);args=parser.parse_args()
    if os.environ.get('CODEXHOST_PLUGIN_DIRECTORY') or os.environ.get('CODEXHOST_DATA_DIR'):raise RuntimeError('Custom plugin/data roots require explicit configuration')
    if args.rollback:
        stage=Path(args.rollback).resolve()
        if stage.parent!=SOURCE/'transactions':raise RuntimeError('Rollback must reference a transaction under this installer')
        journal=json.loads((stage/'journal.json').read_text());restore_local(stage,journal,check_only=True);remote({'action':'check-rollback','id':journal['id']},journal.get('connection'));remote({'action':'rollback','id':journal['id']},journal.get('connection'));restore_local(stage,journal)
        previous=stage/'installation-workspace.previous.json'
        if previous.exists():replace(SOURCE/'installation-workspace.json',previous.read_bytes())
        journal['phase']='rolled-back';(stage/'journal.json').write_text(json.dumps(journal,indent=2));print(json.dumps({'rolledBack':True,'restartRequired':True}));return
    tx=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ');stage=SOURCE/'transactions'/tx;stage.mkdir(parents=True)
    config=load_config();target=INSTALLED;hostRoot=Path(config['hostRoot']);node=hostRoot/'runtime/node.exe'
    pairs=[(PLUGIN/n,target/n) for n in ('plugin.mjs','manifest.json','icon.svg','transport-streams.mjs','diagnose.mjs','maintenance.mjs')]
    pairs += [(p,target/'runtime'/p.relative_to(PLUGIN/'runtime')) for p in (PLUGIN/'runtime').rglob('*') if p.is_file() and (p.parent==PLUGIN/'runtime' and p.suffix in ('.mjs','.json','.ps1') or 'node_modules' in p.relative_to(PLUGIN/'runtime').parts)]
    data=[(dest,src.read_bytes()) for src,dest in pairs]+[(target/'bridge-config.json',json.dumps(config,indent=2).encode())]
    # Retired plugin code only; deletion has the same backup/conflict/rollback checks.
    data.append((target/'runtime'/'media-config.mjs',None))
    enabledPath=target.parent/'enabled.json';enabled=json.loads(enabledPath.read_text()) if enabledPath.exists() else {'version':1,'enabled':[]}
    if enabled.get('version')!=1 or not isinstance(enabled.get('enabled'),list):raise RuntimeError('Invalid plugin registry')
    if 'claude-vps' not in enabled['enabled']:enabled['enabled'].append('claude-vps')
    data.append((enabledPath,json.dumps(enabled,ensure_ascii=False,indent=2).encode()))
    rows=[]
    for i,(dest,content) in enumerate(data):
        before=dest.read_bytes() if dest.exists() else None;key=str(i)
        if content is not None:(stage/(key+'.new')).write_bytes(content)
        if before is not None:(stage/(key+'.old')).write_bytes(before)
        rows.append({'path':str(dest),'key':key,'beforeHash':sha(before) if before is not None else None,'sha256':sha(content) if content is not None else None})
        if content is not None and dest.suffix=='.mjs':
            check=stage/(key+'.mjs');check.write_bytes(content);subprocess.run([str(node),'--check',str(check)],check=True,capture_output=True)
    names=('remote-config.mjs','bridge_paths.py','windows-agent','remote-server.mjs','mcp-local.py','remote-transport.mjs','relay-lock.py','transport-streams.mjs','relay-ledger.mjs','tool-bridge.mjs','context-delta.mjs','context-notice.mjs','prompt-cache.mjs','compact-context.py','workspace-request.py','workspace-map.mjs','fork-state.mjs','workspace-guard.py','workspace-settings.json','bridge-instructions.md','claude-windows','media-transfer.py','adapter-loader.mjs','start-transport','check-health','windows-workspace')
    payload={n:(REMOTE/n).read_text(encoding='utf8') for n in names}
    policy=json.loads((INSTALLER/'dependency-policy.json').read_text())
    if policy['package']!='@codexhost/cli' or not __import__('re').fullmatch(r'\d+\.\d+\.\d+',policy['version']):raise RuntimeError('Invalid dependency policy')
    version=policy['version']
    prepared=remote({'action':'prepare','id':tx,'files':payload,'remoteNodeExecutable':config.get('remoteNodeExecutable'),'adapterVersion':version,'adapterPath':config['remoteRoot']+'/dependencies/codexhost-'+version+'/node_modules/@codexhost/cli-linux-x64/app/plugins/claude-code/plugin.mjs','remoteConfig':{'workspaceRoot':config['remoteWorkspaceRoot'],'claudeExecutable':config['remoteClaudeExecutable'],'legacy':config.get('legacy',{})}},config)
    journal={'id':tx,'connection':config,'phase':'prepared','files':rows,'remote':prepared,'hostVersion':json.loads((hostRoot/'app/codexhost-distribution.json').read_text())['version']};(stage/'journal.json').write_text(json.dumps(journal,indent=2))
    # Only code/enablement participate. runtime/state and runtime-context are never replaced.
    reportPath=SOURCE/'installation-workspace.json';oldReport=reportPath.read_bytes() if reportPath.exists() else None
    if oldReport:(stage/'installation-workspace.previous.json').write_bytes(oldReport)
    try:
        for row in rows:
            p=Path(row['path']);current=sha(p.read_bytes()) if p.exists() else None
            if current!=row['beforeHash']:raise RuntimeError('Concurrent local modification: '+str(p))
        journal['phase']='committing';(stage/'journal.json').write_text(json.dumps(journal,indent=2))
        remote({'action':'commit','id':tx},config)
        for row in rows:
            if row['sha256'] is None:Path(row['path']).unlink(missing_ok=True)
            else:replace(Path(row['path']),(stage/(row['key']+'.new')).read_bytes())
        if args.fail_after_local:raise RuntimeError('Injected transaction failure')
        report={'connection':config,'installedAt':tx,'localBackup':str(stage),'localPlugin':str(target),'selfContained':True,'remote':{'backup':prepared['stage'],'hashes':prepared['hashes'],'adapter':prepared['adapter']},'files':rows,'hostVersion':journal['hostVersion'],'transaction':str(stage)}
        replace(reportPath,json.dumps(report,ensure_ascii=False,indent=2).encode())
        subprocess.run([str(node),str(INSTALLER/'verify-upgrade.mjs')],check=True,timeout=100)
        journal['phase']='verified';(stage/'journal.json').write_text(json.dumps(journal,indent=2));print(json.dumps({'success':True,'transaction':str(stage),'restartRequired':True}))
    except Exception as error:
        problems=[]
        try:remote({'action':'rollback','id':tx},config)
        except Exception as e:problems.append('Remote recovery: '+str(e))
        try:restore_local(stage,journal)
        except Exception as e:problems.append('Local recovery: '+str(e))
        if oldReport:replace(reportPath,oldReport)
        journal.update(phase='recovery-required' if problems else 'rolled-back',error=str(error),recoveryErrors=problems);(stage/'journal.json').write_text(json.dumps(journal,indent=2));raise RuntimeError(json.dumps({'error':str(error),'recoveryErrors':problems,'transaction':str(stage)}))
if __name__=='__main__':main()
