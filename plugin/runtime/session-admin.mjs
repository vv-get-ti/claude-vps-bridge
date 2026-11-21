import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {replaceFile} from './atomic-file.mjs';
import {shellQuote} from './bridge-config.mjs';
import {SshRoutes} from './ssh-routes.mjs';

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const threadId=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f]/.test(value);
const stateFile=/^[a-zA-Z0-9_-]{1,100}\.json$/;
const ready='CLAUDE_VPS_SESSION_ADMIN_READY_V1';
const responseLimit=32*1024*1024;
const bindingWarning={code:'BINDINGS_UNAVAILABLE',message:'部分本机宿主绑定无法核实。旧版记录只能通过原始桥接句柄关联。'};

export async function rememberNativeBinding(state,nativeSessionId,thread,projectId){
  if(!uuid.test(nativeSessionId)||!threadId(thread))return;
  const directory=path.join(state,'native-bindings');
  await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,createHash('sha256').update(nativeSessionId+'\n'+thread).digest('hex')+'.json');
  const temporary=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify({nativeSessionId,thread,projectId}),{mode:0o600,flag:'wx'});
  await replaceFile(temporary,file);
}

export async function listBindings(state){
  const native=new Map(),legacy=new Map();let incomplete=false;
  try{if(!(await fs.lstat(state)).isDirectory())throw Error('Invalid state');}
  catch{return {native,legacy,incomplete:true};}
  async function read(directory,collect){
    const base=path.join(state,directory);
    try{
      const stat=await fs.lstat(base);if(!stat.isDirectory())throw Error('Invalid state directory');
      for(const entry of await fs.readdir(base,{withFileTypes:true})){
        if(!stateFile.test(entry.name))continue;
        try{
          const file=path.join(base,entry.name);const stat=await fs.lstat(file);
          if(!stat.isFile()||stat.nlink!==1||stat.size>4*1024*1024)throw Error('Invalid binding record');
          collect(entry.name.slice(0,-5),JSON.parse(await fs.readFile(file,'utf8')));
        }catch{incomplete=true;}
      }
    }catch(error){if(error.code!=='ENOENT')incomplete=true;}
  }
  await Promise.all([
    read('native-bindings',(_,row)=>{
      if(!uuid.test(row?.nativeSessionId)||!threadId(row.thread))throw Error('Invalid native binding');
      if(!native.has(row.nativeSessionId))native.set(row.nativeSessionId,new Set());
      native.get(row.nativeSessionId).add(row.thread);
    }),
    read('sessions',(handle,row)=>{
      if(row?.sessionId!==handle)throw Error('Invalid bridge binding');
      if(threadId(row.parentThread)&&/^[0-9a-f]{64}$/.test(row.projectId))legacy.set(handle,row);
    }),
  ]);
  return {native,legacy,incomplete};
}

function onRoute(config,route,command,request,{spawnProcess,timeoutMs,mutating}){
  return new Promise((resolve,reject)=>{
    const env={...process.env};for(const key of Object.keys(env))if(/ANTHROPIC|CLAUDE|CODEXHOST_RUNTIME|API_KEY|TOKEN|SECRET/i.test(key))delete env[key];
    const child=spawnProcess(config.sshExecutable,route.args(command,{connectTimeout:10}),{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let sent=false,settled=false,size=0,stderr='';const chunks=[];
    const finish=(value,error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const failed=()=>finish(null,Object.assign(Error('Session administration transport failed'),{code:mutating&&sent?'RESULT_UNKNOWN':'SSH_UNAVAILABLE'}));
    const timer=setTimeout(()=>{failed();child.kill();},timeoutMs);
    child.once('error',failed);
    child.stdin.on('error',failed);
    child.stderr.on('data',chunk=>{
      if(sent||settled)return;
      stderr+=chunk.toString('utf8');
      const lines=stderr.split('\n');stderr=lines.pop().slice(-4096);
      if(lines.some(line=>line.trim()===ready)){
        sent=true;child.stdin.end(JSON.stringify(request)+'\n');
      }
    });
    child.stdout.on('data',chunk=>{
      size+=chunk.length;if(size>responseLimit){failed();child.kill();return;}
      chunks.push(Buffer.from(chunk));
    });
    child.once('close',code=>{
      if(code!==0||!sent)return failed();
      try{
        const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
        if(value.apiVersion!==1||(value.ok===true?!value.result:value.ok!==false||typeof value.error?.code!=='string'))return failed();
        finish(value);
      }catch{failed();}
    });
  });
}

export async function remoteAdminRequest(config,command,request,{spawnProcess=spawn,timeoutMs=120000,mutating=false}={}){
  const routes=new SshRoutes(config);
  return routes.firstAvailable(route=>onRoute(config,route,command,request,{spawnProcess,timeoutMs,mutating}),
    error=>['SSH_UNAVAILABLE','ROUTE_HELPER_UNAVAILABLE'].includes(error.code));
}

export async function remoteSessionRequest(config,method,params,bindings,options={}){
  const mutating=Object.hasOwn(params,'items');
  const request={method,params};
  if(method==='sessions.archive'&&!params.confirmBound){
    request.boundIds=params.items.map(item=>item.id).filter(id=>bindings.native.has(id));
    request.boundKeys=Object.fromEntries([...bindings.legacy].map(([key,row])=>[key,row.projectId]));
  }
  let reply;
  try{
    const command='python3 -B '+shellQuote(config.remoteRoot+'/session-admin.py');
    reply=await remoteAdminRequest(config,command,request,{...options,mutating});
  }catch(error){
    const unknown=error.code==='RESULT_UNKNOWN';
    const code=unknown?'RESULT_UNKNOWN':'SSH_UNAVAILABLE';
    const message=unknown?'操作已发送，结果未确认。请刷新会话列表。':'无法连接 VPS 会话管理入口。';
    return mutating?{apiVersion:1,ok:true,result:{results:params.items.map(({id})=>({id,code,message,status:unknown?'unknown':'rejected'}))}}:{apiVersion:1,ok:false,error:{code,message,details:{}}};
  }
  if(reply.ok&&method==='sessions.list'){
    if(bindings.incomplete)reply.result.warnings.push(bindingWarning);
    for(const row of reply.result.sessions){
      const legacy=bindings.legacy.get(row.bindingKey);
      const threads=new Set(bindings.native.get(row.id));
      if(legacy&&legacy.projectId===row.project.projectId)threads.add(legacy.parentThread);
      if((row.hasBoundThread===true||row.hasBoundThread===null)&&!threads.size)reply.result.warnings.push({...bindingWarning,id:row.id});
      row.bound={threads:[...threads].sort()};
      delete row.bindingKey;delete row.hasBoundThread;
    }
  }
  return reply;
}

export function createSessionImport({getConfig,state,projectInfo,remote=remoteSessionRequest}){
  const miss=()=>({ok:false,error:{code:'sessionNotFound',message:'找不到可导入的空闲 VPS 会话。',retryable:false}});
  const unavailable=()=>({ok:false,error:{code:'unavailable',message:'无法核实 VPS 会话或本机绑定。',retryable:true}});
  async function sources(nativeSessionId){
    try{
      const bindings=await listBindings(state);
      if(bindings.incomplete)return unavailable();
      const reply=await remote(getConfig(),'sessions.list',{scope:'active'},bindings);
      if(!reply.ok)return unavailable();
      const projects=new Map(),values=[];
      const unresolved=new Set(reply.result.warnings.filter(w=>w.code==='BINDINGS_UNAVAILABLE'&&w.id).map(w=>w.id));
      for(const row of reply.result.sessions){
        if((nativeSessionId&&row.id!==nativeSessionId)||row.scope!=='active'||!row.project.mapped||row.state!=='idle'||row.bound.threads.length||unresolved.has(row.id)||!uuid.test(row.id))continue;
        const {localCwd,projectId}=row.project,updatedAt=Date.parse(row.lastActiveAt);
        if(!/^[A-Za-z]:[\\/]/.test(localCwd)||localCwd.length>16384||updatedAt<0||!Number.isFinite(updatedAt))continue;
        if(!projects.has(localCwd))projects.set(localCwd,projectInfo(localCwd).catch(()=>null));
        const local=await projects.get(localCwd);if(local?.projectId!==projectId)continue;
        values.push({candidate:{nativeSessionId:row.id,title:row.title,updatedAt,cwd:localCwd,running:false},nativeRef:{harnessId:'claude-vps',nativeSessionId:row.id,formatVersion:1}});
      }
      return {ok:true,value:values};
    }catch{return unavailable();}
  }
  async function resolveCandidate(id){
    if(typeof id!=='string'||!uuid.test(id))return miss();
    const result=await sources(id);
    return result.ok?(result.value.length===1?{ok:true,value:result.value[0]}:miss()):result;
  }
  return {
    async listCandidates(){const result=await sources();return result.ok?{ok:true,value:result.value.map(row=>row.candidate)}:result;},
    resolveCandidate,
    async prepareImport({source}){
      const result=await resolveCandidate(source?.nativeRef?.nativeSessionId);
      if(!result.ok)return result;
      const value=result.value;
      if(source.nativeRef.harnessId!==value.nativeRef.harnessId||source.candidate?.cwd!==value.candidate.cwd)return miss();
      return {ok:true,value:{nativeRef:value.nativeRef}};
    },
  };
}
