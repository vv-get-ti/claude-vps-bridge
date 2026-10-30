// Read-only diagnostics. Never imports an agent session or submits a model turn.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {attachmentNotice} from './runtime/input-boundary.mjs';
import {validateConfig,shellQuote} from './runtime/bridge-config.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const exec=promisify(execFile);
const version=value=>typeof value==='string'&&/^\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(value)?value:null;
const exists=file=>fs.stat(file).then(s=>s.isFile(),()=>false);
async function json(file){const size=(await fs.stat(file)).size;if(size>65536)throw Error('Oversized metadata');return JSON.parse(await fs.readFile(file,'utf8'));}
const directories=dir=>fs.readdir(dir,{withFileTypes:true}).then(rows=>rows.filter(r=>r.isDirectory()&&!r.isSymbolicLink()).map(r=>r.name),error=>{if(error.code==='ENOENT')return [];throw error;});
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return null;try{process.kill(pid,0);return true;}catch(e){return e.code==='ESRCH'?false:null;}};

export async function probeSshVersion(config,{execute=exec}={}){
  const result=await execute(config.sshExecutable,['-V'],{windowsHide:true,timeout:5000,maxBuffer:16384});
  return (result.stderr||result.stdout).trim();
}
export async function remoteExecutables(config,{execute=exec}={}){
  // python3 can diagnose a stale node-path even when check-health cannot start Node.
  const code=`import pathlib,os,json\np=pathlib.Path(${JSON.stringify(config.remoteRoot)})/'node-path'\nnode=p.read_text().strip() if p.is_file() else ''\nclaude=${JSON.stringify(config.remoteClaudeExecutable)}\nprint(json.dumps({k:bool(v and pathlib.Path(v).is_file() and os.access(v,os.X_OK)) for k,v in {'node':node,'claude':claude}.items()}))`;
  const result=await execute(config.sshExecutable,['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12',config.sshHost,'python3 -c '+shellQuote(code)],{windowsHide:true,timeout:20000,maxBuffer:16384});
  const value=JSON.parse(result.stdout);
  if(typeof value.node!=='boolean'||typeof value.claude!=='boolean')throw Error('Invalid executable probe');
  return {node:value.node,claude:value.claude};
}

export async function modelSummary(state,{limit=1000}={}){
  const directory=path.join(state,'sessions');
  const names=await fs.readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const sessions=[];
  for(const name of names.filter(n=>/^[a-zA-Z0-9_-]{1,100}\.json$/.test(n)).slice(0,limit)){
    const row=await json(path.join(directory,name)).catch(()=>null);if(!row?.turnId)continue;
    const observation=await json(path.join(state,'models',name)).catch(()=>null);
    const valid=observation?.turnId===row.turnId&&observation.source==='remote-response-usage'&&Array.isArray(observation.models)&&observation.models.length<=32&&observation.models.every(m=>typeof m==='string'&&m.length>0&&m.length<=512&&!/[\r\n\0]/.test(m));
    sessions.push({sessionId:name.slice(0,-5),turnId:row.turnId,actualModels:valid?observation.models:[],source:valid?'remote-response-usage':'not-observed',...(valid?{observedAt:observation.observedAt}:{})});
  }
  return {catalogDefault:'selection-only; not an observed model',sessions,truncated:names.length>limit};
}

export async function stateSummary(state,{limit=10000,now=Date.now()}={}){
  const result={jobs:{active:0,queued:0,unknown:0,completed:0,scanned:0,truncated:false},writers:{owned:0,unknown:0},worktrees:{ready:0,preparing:0,unknown:0}};
  const projects=await directories(path.join(state,'jobs'));
  jobs:for(const project of projects){if(!/^[a-f0-9]{64}$/.test(project))continue;
    for(const id of await directories(path.join(state,'jobs',project))){
      if(result.jobs.scanned>=limit){result.jobs.truncated=true;break jobs;}result.jobs.scanned++;
      const dir=path.join(state,'jobs',project,id);
      try{
        const value=await json(path.join(dir,'status.json'));
        if(value.status==='queued')result.jobs.queued++;
        else if(value.status==='starting')result.jobs.unknown++; // acceptance is not proof of a live runner
        else if(value.status==='running'){
          const token=typeof value.runnerToken==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value.runnerToken)?value.runnerToken:null;
          const beat=token?await fs.stat(path.join(dir,'heartbeat-'+token)).catch(()=>null):null;
          if(beat&&now-beat.mtimeMs<=10000&&alive(value.runnerPid)!==false)result.jobs.active++;else result.jobs.unknown++;
        }else if(['succeeded','failed','cancelled'].includes(value.status))result.jobs.completed++;
        else result.jobs.unknown++;
      }catch{result.jobs.unknown++;}
    }
  }
  for(const id of (await directories(path.join(state,'writers'))).slice(0,limit)){
    if(!/^[a-f0-9]{64}$/.test(id))continue;
    try{const owner=await json(path.join(state,'writers',id,'owner.json'));if(alive(owner.pid)===true)result.writers.owned++;else result.writers.unknown++;}catch{result.writers.unknown++;}
  }
  let scanned=0;
  worktrees:for(const project of await directories(path.join(state,'worktrees'))){if(!/^[a-f0-9]{64}$/.test(project))continue;for(const id of await directories(path.join(state,'worktrees',project))){if(scanned++>=limit)break worktrees;try{const row=await json(path.join(state,'worktrees',project,id,'record.json'));if(['ready','preparing'].includes(row.state))result.worktrees[row.state]++;else result.worktrees.unknown++;}catch{result.worktrees.unknown++;}}}
  return result;
}

export function remoteHealth(config,{spawnProcess=spawn,timeoutMs=20000}={}){
  return new Promise((resolve,reject)=>{
    const env={...process.env};for(const key of Object.keys(env))if(/ANTHROPIC|CLAUDE|CODEXHOST_RUNTIME|API_KEY|TOKEN|SECRET/i.test(key))delete env[key];
    const child=spawnProcess(config.sshExecutable,['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',config.sshHost,shellQuote(config.remoteRoot+'/check-health')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',value,settled=false;
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Object.assign(Error('Remote health timeout'),{code:'REMOTE_HEALTH_TIMEOUT'}));},timeoutMs);
    child.on('error',()=>finish(Object.assign(Error('SSH could not start'),{code:'SSH_START_FAILED'})));
    child.stdin.on('error',()=>finish(Object.assign(Error('SSH input unavailable'),{code:'SSH_INPUT_FAILED'})));
    child.stderr.on('data',()=>{}); // error text may contain usernames, hostnames or private paths
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>65536){child.kill();finish(Object.assign(Error('Invalid health response'),{code:'REMOTE_HEALTH_INVALID'}));return;}
      while(buffer.includes('\n')){
        const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        try{const frame=JSON.parse(line);if(frame.id==='diagnostic-health'){
          if(frame.error){child.stdin.end();finish(Object.assign(Error('Remote bridge rejected health'),{code:'REMOTE_HEALTH_FAILED'}));return;}
          value=frame.value;child.stdin.end();
        }}catch{child.kill();finish(Object.assign(Error('Invalid health response'),{code:'REMOTE_HEALTH_INVALID'}));return;}
      }
    });
    child.on('exit',code=>finish(code===0&&value?null:Object.assign(Error('Remote health did not complete'),{code:'REMOTE_HEALTH_FAILED'})));
    child.stdin.write(JSON.stringify({id:'diagnostic-health',method:'health',params:{}})+'\n');
  });
}

export async function diagnose({root=here,installedRoot=path.join(os.homedir(),'.codexhost','plugins','claude-vps'),configFile=process.env.CLAUDE_VPS_CONFIG,local=false,probeRemote=remoteHealth,probeExecutables=remoteExecutables,probeSsh=probeSshVersion,pingBroker,runnerAlive=alive}={}){
  const checks=[];
  const add=(stage,status,details={},required=false)=>checks.push({stage,status,required,...details});
  const source=await json(path.join(root,'manifest.json')).catch(()=>null),installed=await json(path.join(installedRoot,'manifest.json')).catch(()=>null);
  add('versions','info',{source:version(source?.version),installed:version(installed?.version),desktopLoadedVersion:'unverified'});
  const candidates=configFile?[configFile]:[path.join(root,'bridge-config.json'),path.join(root,'bridge-config.local.json'),path.join(installedRoot,'bridge-config.json')];
  let config;
  try{const selected=await Promise.all(candidates.map(exists)).then(found=>candidates[found.indexOf(true)]);if(!selected)throw Error('Missing configuration');config=validateConfig(await json(selected));add('configuration','ok',{},true);}
  catch{add('configuration','unavailable',{reason:'missing-or-invalid',next:'Configure the bridge or set CLAUDE_VPS_CONFIG to your private configuration file.'},true);}
  const runtime=installed?'installed':'source'; // label only; never expose installation paths
  const target=installed?installedRoot:root,state=path.join(target,'runtime','state');
  add('host-attachments','limited',{next:attachmentNotice});
  await Promise.all([
    (async()=>{try{add('actual-models','info',await modelSummary(state));}catch{add('actual-models','unavailable',{reason:'metadata-unreadable'});}})(),
    (async()=>{try{add('task-state','ok',{scope:runtime,...await stateSummary(state)});}catch{add('task-state','unavailable',{reason:'metadata-unreadable'});}})(),
    (async()=>{
      const descriptor=path.join(target,'runtime','runtime-context','job-broker-v2.json');
      if(!await exists(descriptor)){
        const legacy=await exists(path.join(target,'runtime','runtime-context','job-broker.json'));
        add('local-task-runner',legacy?'legacy':'idle',{reason:legacy?'legacy-descriptor-only':'not-started',next:'Protocol v2 starts when an updated local command job needs it. Existing legacy tasks are not interrupted.'});return;
      }
      let metadata;
      try{metadata=await json(descriptor);if(!Number.isSafeInteger(metadata.pid)||metadata.pid<=0||metadata.protocol!==2||metadata.build!=='durable-launch-v2')throw Error('Invalid runner metadata');}
      catch{add('local-task-runner','unavailable',{reason:'invalid-descriptor',next:'Inspect the runner installation and original task state; no process was started.'});return;}
      // The broker intentionally leaves its descriptor after idle exit. A missing
      // process proves only that this broker stopped, never that its tasks finished.
      if(runnerAlive(metadata.pid)===false){add('local-task-runner','stopped',{reason:'process-not-running',scope:'descriptor process only; exit cause and task outcomes are not inferred',next:'New command jobs start the runner on demand. Inspect original IDs for any unknown tasks; do not replay them.'});return;}
      try{const ping=pingBroker??(async()=>{const module=await import(pathToFileURL(path.join(target,'runtime','job-broker.mjs')));return module.brokerRequest('ping');});const reply=await ping();if(reply.protocol!==2||reply.build!=='durable-launch-v2')throw Error('Unexpected runner protocol');add('local-task-runner','ok',{protocol:2});}
      catch{add('local-task-runner','unavailable',{reason:'ping-failed',next:'Inspect original task state before restarting or resubmitting.'});}
    })(),
    (async()=>{const present=await exists(path.join(target,'runtime','node_modules','@playwright','mcp','cli.js'));add('optional-playwright',present?'ok':'not-installed',{execution:'windows',scope:'dependency-only'});})(),
    (async()=>{if(!config)return;
      const [ssh,pwsh,hostVersion]=await Promise.all([exists(config.sshExecutable),exists(config.pwshExecutable),json(path.join(config.hostRoot,'app','codexhost-distribution.json')).catch(()=>null)]);
      let sshVersion=null;try{if(ssh)sshVersion=await probeSsh(config);}catch{}
      add('ssh-executable',ssh&&sshVersion?'ok':'unavailable',{path:config.sshExecutable,version:sshVersion},true);add('powershell-executable',pwsh?'ok':'unavailable',{},true);add('host-version','info',{version:version(hostVersion?.version)});
    })(),
    (async()=>{if(!config||local){add('remote-executables','not-checked');return;}
      try{const paths=await probeExecutables(config);add('remote-executables',paths.node&&paths.claude?'ok':'unavailable',{nodePathExecutable:paths.node,remoteClaudeExecutable:paths.claude,...(!paths.node||!paths.claude?{next:'远端 node-path 或 remoteClaudeExecutable 已失效。核对实际路径，必要时修改 --remote-node / --remote-claude 对应配置后重新安装插件。'}:{})},true);}
      catch{add('remote-executables','unavailable',{reason:'probe-failed',next:'检查 SSH 与远端 python3；尚未确认 Node/Claude 路径是否有效。'},true);}
    })(),
    (async()=>{if(!config||local){add('remote-bridge','not-checked',{reason:local?'local-only':'configuration-unavailable'});return;}
      try{const health=await probeRemote(config),capabilities=Array.isArray(health?.capabilities)?health.capabilities:[];const core=health?.protocol===2&&['project-context','duplex-control','duplex-tools'].every(c=>capabilities.includes(c));add('remote-bridge',core?'ok':'unavailable',{protocol:Number.isInteger(health?.protocol)?health.protocol:null,bridgeVersion:version(health?.bridgeVersion),adapterVersion:version(health?.dependencyVersion),capabilities:['project-context','duplex-control','duplex-tools','native-fork','local-mcp','account-usage'].filter(c=>capabilities.includes(c)),scope:'fresh health process; no model, task or reverse tunnel'},true);}
      catch(error){add('remote-bridge','unavailable',{reason:['SSH_START_FAILED','SSH_INPUT_FAILED','REMOTE_HEALTH_TIMEOUT','REMOTE_HEALTH_INVALID'].includes(error.code)?error.code:'remote-health-failed',next:'Check the configured SSH connection and remote bridge installation.'},true);}
    })()
  ]);
  add('quota-freshness','not-checked',{reason:'Current Host quota schema has no observation timestamp; no quota or credentials were queried.'});
  add('optional-mcp-configuration','not-checked',{reason:'Private MCP configuration is intentionally not read.'});
  return {schemaVersion:1,checkedAt:new Date().toISOString(),readOnly:true,modelSubmitted:false,overall:checks.some(c=>c.required&&c.status==='unavailable')?'attention':'ok',checks:checks.sort((a,b)=>a.stage.localeCompare(b.stage))};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.some(a=>!['--local','--json','--help'].includes(a))){console.error('Usage: node diagnose.mjs [--local] [--json]');process.exitCode=2;}
  else if(args.includes('--help'))console.log('node diagnose.mjs [--local] [--json]\nRead-only checks, no model turns. --local performs no network requests. Set CLAUDE_VPS_CONFIG for a specific private config.');
  else {const report=await diagnose({local:args.includes('--local')});console.log(args.includes('--json')?JSON.stringify(report,null,2):report.checks.map(c=>c.stage+': '+c.status+(c.reason?' ('+c.reason+')':'')+(c.path?'\n  '+c.path+' '+(c.version??'版本未知'):'')+(c.sessions?'\n  '+JSON.stringify(c.sessions):'')+(c.next?'\n  '+c.next:'')).join('\n'));process.exitCode=report.overall==='ok'?0:1;}
}
