"""Remote half of the code-only transaction. Never copies or rolls back user state."""
import pathlib,json,hashlib,os,subprocess,shutil,base64
ROOT=pathlib.Path.home()/'.codexhost/windows-bridge'
def sha(data):return hashlib.sha256(data).hexdigest()
def replace(dest,data,mode):
    temp=dest.with_name(dest.name+'.switch.tmp');temp.write_bytes(data);temp.chmod(mode);os.replace(temp,dest)
def main(request):
    if not ROOT.is_absolute() or ROOT==pathlib.Path('/') or '..' in ROOT.parts:raise ValueError('Unsafe installation root')
    action=request['action'];tx=request['id']
    if not tx.replace('-','').isalnum():raise ValueError('Invalid transaction ID')
    stage=ROOT/'transactions'/tx
    if action=='prepare':
        paths=discover_remote({'node':request.get('remoteNodeExecutable'),'claude':request['remoteConfig']['claudeExecutable']},required=('node','claude'))
        stage.mkdir(parents=True,exist_ok=False)
        rows=[]
        for name,text in request['files'].items():
            if '/' in name or name.startswith('.'):raise ValueError('Invalid code filename')
            dest=ROOT/name
            before=dest.read_bytes() if dest.exists() else None;data=text.encode()
            mode=0o700 if name in ('windows-agent','windows-workspace','claude-windows','workspace-guard.py','start-transport','check-health') else 0o600
            row={'dest':str(dest),'name':name,'beforeHash':sha(before) if before is not None else None,'afterHash':sha(data),'mode':mode,'beforeMode':dest.stat().st_mode&0o777 if before is not None else None}
            (stage/(name+'.new')).write_bytes(data)
            if before is not None:(stage/(name+'.old')).write_bytes(before)
            rows.append(row)
        node=paths['node']
        selected=pathlib.Path(request['adapterPath'])
        # The selection is inside a separately installed complete npm dependency tree.
        if not selected.is_file() or '/dependencies/' not in str(selected):raise RuntimeError('Managed adapter missing; prepare its exact npm version first')
        package=selected.parents[3]/'package.json'
        if json.loads(package.read_text()).get('version')!=request['adapterVersion']:raise RuntimeError('Managed adapter package version mismatch')
        config={'schemaVersion':1,'version':request['adapterVersion'],'modulePath':str(selected),'sha256':sha(selected.read_bytes())}
        for name,text in {'node-path':node+'\n','adapter-selection.json':json.dumps(config),**({'claude-path':request['remoteConfig']['claudeExecutable']+'\n','remote-config.json':json.dumps(request['remoteConfig'])} if 'remoteConfig' in request else {})}.items():
            dest=ROOT/name;before=dest.read_bytes() if dest.exists() else None;data=text.encode()
            (stage/(name+'.new')).write_bytes(data)
            if before is not None:(stage/(name+'.old')).write_bytes(before)
            rows.append({'dest':str(dest),'name':name,'beforeHash':sha(before) if before is not None else None,'afterHash':sha(data),'mode':0o600,'beforeMode':dest.stat().st_mode&0o777 if before is not None else None})
        for row in rows:
            if row['name'].endswith('.mjs'):
                check=stage/row['name'];check.write_bytes((stage/(row['name']+'.new')).read_bytes());subprocess.run([node,'--check',str(check)],check=True,capture_output=True)
            if row['name'].endswith('.py'):compile((stage/(row['name']+'.new')).read_text(),row['name'],'exec')
        subprocess.run([node,'--input-type=module','-e','const m=await import('+json.dumps(selected.as_uri())+');if(typeof m.createHarnessAdapter!=="function")throw Error("Adapter factory missing")'],check=True,capture_output=True,timeout=30)
        journal={'id':tx,'phase':'prepared','rows':rows,'node':node,'adapter':config};(stage/'journal.json').write_text(json.dumps(journal))
        return {'stage':str(stage),'adapter':config,'node':node,'hashes':{r['dest']:r['afterHash'] for r in rows}}
    journal=json.loads((stage/'journal.json').read_text());rows=journal['rows']
    if action=='commit':
        for row in rows:
            p=pathlib.Path(row['dest']);current=sha(p.read_bytes()) if p.exists() else None
            if current!=row['beforeHash']:raise RuntimeError('Concurrent remote modification: '+str(p))
        journal['phase']='committing';(stage/'journal.json').write_text(json.dumps(journal))
        try:
            for row in rows:replace(pathlib.Path(row['dest']),(stage/(row['name']+'.new')).read_bytes(),row['mode'])
        except Exception:
            main({'action':'rollback','id':tx});raise
        journal['phase']='committed';(stage/'journal.json').write_text(json.dumps(journal))
        return {'committed':True}
    if action in ('rollback','check-rollback'):
        for row in rows:
            p=pathlib.Path(row['dest']);current=sha(p.read_bytes()) if p.exists() else None
            if current not in (row['beforeHash'],row['afterHash']):raise RuntimeError('Remote rollback conflict: '+str(p))
        if action=='check-rollback':return {'ready':True}
        for row in rows:
            p=pathlib.Path(row['dest'])
            if row['beforeHash'] is None:
                if p.exists():p.unlink()
            else:replace(p,(stage/(row['name']+'.old')).read_bytes(),row['beforeMode'])
        journal['phase']='rolled-back';(stage/'journal.json').write_text(json.dumps(journal));return {'rolledBack':True}
    raise ValueError('Unknown action')
