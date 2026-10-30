import {JsonWriter,readJsonLines} from './transport-streams.mjs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareWorkspace } from './workspace-map.mjs';
import {forkPrefix,inheritMedia,pairForkTurns} from './fork-state.mjs';
import {createToolBridge} from './tool-bridge.mjs';
import {contextUpdate} from './context-delta.mjs';
import {contextNotice,validNoticeState} from './context-notice.mjs';
import {mergePromptCache} from './prompt-cache.mjs';
const exec = promisify(execFile);

import {bridgeRoot,workspaceRoot,workspaceCommand,agentCommand,remoteConfig} from './remote-config.mjs';
const root = workspaceRoot;
import {loadClaudeAdapter} from './adapter-loader.mjs';
const {createHarnessAdapter,modulePath,dependencyVersion} = await loadClaudeAdapter();
const adapter = await createHarnessAdapter({ environment: { ...process.env, CODEXHOST_CLAUDE_COMMAND: path.join(bridgeRoot,'claude-windows') }, platform: 'linux', managedRemoteHost: false });
const sessions = new Map();
let streamClosing=false;
const output=new JsonWriter(process.stdout,{onError:()=>void closeStream(2)});
const send=value=>{try{output.send(value);}catch{void closeStream(2);}};
const fail = message => ({ ok: false, error: { code: 'unavailable', message, retryable: false } });
const limitedCapabilities = c => ({ ...c, history: { fork: c.history?.fork===true, forkAcrossCwd: false, rollbackLastTurn: false }, subagents: { observe: true, readTranscript: false } });
const bindings = new Map();
let accountInspection=null,cacheCapabilityUnknown=false;
async function inspectAccount(){
  if(accountInspection)return accountInspection;
  accountInspection=(async()=>{const value=await adapter.inspectAccount?.()??null;cacheCapabilityUnknown=value?.credits===undefined;return value;})().finally(()=>{accountInspection=null;});
  return accountInspection;
}
async function cacheUsage(binding,usage,{initial=false}={}){
  if(accountInspection)await accountInspection.catch(()=>{});
  const previous=binding.promptCache;
  const merged=mergePromptCache(usage,previous,{capabilityUnknown:dependencyVersion==='0.15.0'&&(cacheCapabilityUnknown||initial&&usage==null)});
  binding.promptCache=merged.indicator;
  if(binding.cacheFile&&JSON.stringify(previous)!==JSON.stringify(merged.indicator)){
    try{await saveJson(binding.cacheFile,{projectId:binding.projectId,indicator:merged.indicator});}catch{send({timing:{phase:'prompt-cache',status:'save-failed'}});}
  }
  return merged.usage;
}
const displayedText = new Map();
const localPending = new Map();
const controlEpoch=randomUUID();let controlNo=0;
function assertOpening(binding){if(binding.openingState?.cancelled)throw Object.assign(new Error('Session open was cancelled; no late session was accepted'),{code:'OPEN_CANCELLED'});}
function duplexControl(binding,action,more,lane='control'){
  assertOpening(binding);
  if(localPending.size>=256)return Promise.reject(Object.assign(new Error('Too many local operations are pending; no operation was submitted'),{code:'LOCAL_CAPACITY'}));
  const controlId=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{localPending.delete(controlId);reject(new Error('Local operation timed out; outcome unknown, no retry was sent'));},110000);
    localPending.set(controlId,{resolve,reject,timer});
    send({controlId,controlNo:++controlNo,controlEpoch,sessionId:binding.sessionId,lane,request:{action,...more}});
  });
}
const toolBridge=await createToolBridge(async(binding,request,internal)=>{
  if(!binding.duplexTools)throw new Error('This session has no persistent tool channel');
  const {action,...more}=request;
  // The tool call item already shows running work; extra chat text here is
  // noise and reads like delegation.
  const started=performance.now();
  try{const result=await duplexControl(binding,action,more,internal?'control':'tool');if(!internal)liveChange(binding,result);return result;}
  finally{send({timing:{phase:'tool-roundtrip',action,internal,ms:performance.now()-started}});}
});
async function saveJson(file,value){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,file);}
function safeId(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw new Error('Invalid native session/turn identity');return value;}
async function claimNativeSession(ref,binding,verifyOnly=false){
  if(!ref)return;
  const file=path.join(root,'.bridge-sessions',safeId(ref.nativeSessionId)+'.json');
  const saved=await readFile(file,'utf8').then(JSON.parse,e=>e.code==='ENOENT'?null:Promise.reject(e));
  if(saved && saved.projectId!==binding.projectId)throw new Error('Native Claude session belongs to a different Windows project; open a new chat in this project');
  if(saved?.mediaKey)binding.mediaKey=saved.mediaKey;
  if(!saved&&!verifyOnly){
    await mkdir(path.dirname(file),{recursive:true,mode:0o700});
    try{await writeFile(file,JSON.stringify({projectId:binding.projectId,localCwd:binding.localCwd,remoteCwd:binding.remoteCwd,mediaKey:binding.mediaKey}),{flag:'wx',mode:0o600});}
    catch(e){if(e.code!=='EEXIST')throw e;await claimNativeSession(ref,binding,true);}
  }
  return Boolean(saved);
}
async function loadNoticeState(ref,binding){
  if(!ref)return;
  binding.noticeFile=path.join(root,'.bridge-notices',safeId(ref.nativeSessionId)+'.json');
  try{
    const saved=JSON.parse(await readFile(binding.noticeFile,'utf8'));
    if(saved.projectId===binding.projectId&&validNoticeState(saved))binding.noticeState=saved;
    else send({timing:{phase:'context-notice-state',status:'ignored-invalid-state'}});
  }catch(error){if(error.code!=='ENOENT')send({timing:{phase:'context-notice-state',status:'unreadable',code:error.code??'INVALID_JSON'}});}
}
async function acceptNotice(binding,notice){
  binding.noticeState=notice.state;
  if(notice.changed&&binding.noticeFile){
    try{await saveJson(binding.noticeFile,{...notice.state,projectId:binding.projectId});}
    catch(error){send({timing:{phase:'context-notice-state',status:'save-failed',code:error.code??'UNKNOWN'}});}
  }
}
async function localControl(binding, action, more={}) {
  const started=performance.now();
  try{
  assertOpening(binding);
  if(binding.duplexControl){const result=await duplexControl(binding,action,more);assertOpening(binding);return result;}
  const env={...process.env,WINDOWS_PROJECT_CWD:binding.localCwd,...(binding.projectId?{WINDOWS_PROJECT_ID:binding.projectId}:{}),WINDOWS_BRIDGE_SESSION:binding.sessionId};
  const {stdout}=await exec(workspaceCommand,['--internal',JSON.stringify({action,...more,parentThread:binding.parentThread})],{env,timeout:45000,maxBuffer:4*1024*1024});
  assertOpening(binding);return JSON.parse(stdout);
  }finally{send({timing:{phase:'control-roundtrip',action,ms:performance.now()-started,transport:binding.duplexControl?'persistent-ssh':'reverse-ssh'}});}
}
async function localMedia(binding,file){
  const env={...process.env,...binding.toolEnvironment,WINDOWS_PROJECT_CWD:binding.localCwd,WINDOWS_PROJECT_ID:binding.projectId,WINDOWS_BRIDGE_SESSION:binding.sessionId,WINDOWS_MEDIA_SESSION:binding.mediaKey};
  const {stdout}=await exec(workspaceCommand,[JSON.stringify({action:'media',path:file})],{env,timeout:90000,maxBuffer:2*1024*1024});return JSON.parse(stdout);
}
// Native Codex shows a file change where it happens in the turn; the host adds
// its own summary card at the end. Send the card as soon as the write returns.
function changeItemId(record){return record.id?'windows-change-'+record.id:'windows-'+createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0,24);}
function liveChange(binding,result){
  const data=result?.data;
  if(!binding.activeTurn||!data?.changeId||!data.change)return;
  const item={type:'fileChange',itemId:changeItemId({id:data.changeId}),changes:[data.change]};
  (binding.liveItems??=new Set()).add(item.itemId);
  emitItems(binding.sessionId,binding.activeTurn,[{item,outcome:{status:'succeeded'}}]);
}
function presentationItems(records,binding,turnId,shown=''){
  const items=[];
  for(const record of records){
    if(record.projectId!==binding.projectId)throw new Error('Artifact belongs to a different Windows project');
    if(record.kind==='change')items.push({type:'fileChange',itemId:changeItemId(record),changes:[record.change]});
  }
  const artifacts=[...new Map(records.filter(r=>r.kind==='artifact').map(r=>[r.artifact.path,r.artifact])).values()].filter(a=>!shown.includes(a.markdown));
  if(artifacts.length)items.push({type:'agentMessage',itemId:'windows-artifacts-'+turnId,phase:'commentary',text:artifacts.map(a=>a.markdown+(a.preview?'\n\n'+a.link:'')).join('\n\n')});
  return items.map(item=>({item,outcome:{status:'succeeded'}}));
}
function presentationFile(binding,ref){return path.join(binding.remoteCwd,'.bridge-presentation',safeId(ref.nativeSessionId),safeId(ref.nativeTurnKey)+'.json');}
function emitItems(sessionId,turnId,items){for(const snapshot of items){send({sessionId,output:{kind:'event',event:{type:'item.started',turnId,item:snapshot.item}}});send({sessionId,output:{kind:'event',event:{type:'item.completed',turnId,snapshot}}});}}
async function presentation(sessionId, output) {
  const binding=bindings.get(sessionId);
  if(!binding || output.kind!=='event')return;
  const event=output.event;
  const key=sessionId+':'+event.turnId;
  // This is only a duplicate-preview hint, not conversation history. Native
  // history retains the complete answer even when this bounded tail rolls.
  if(event.type==='item.completed'&&event.snapshot.item.type==='agentMessage')displayedText.set(key,((displayedText.get(key)??'')+'\n'+event.snapshot.item.text).slice(-128*1024));
  if(event.type!=='turn.completed')return;
  // Codex marks the last plain agent message of a succeeded turn as the final
  // answer. Trailing bridge text would demote Claude's answer, so only facts
  // the user must act on are added here.
  if(binding.cancelResult){const cancelled=await binding.cancelResult;delete binding.cancelResult;const stopped=cancelled.ok?cancelled.jobs.filter(j=>j.status==='cancelled').length:0;const text=!cancelled.ok?'本机任务可能仍在运行：'+cancelled.error:stopped?'已停止 '+stopped+' 个本机任务。':'';if(text)emitItems(sessionId,event.turnId,[{item:{type:'agentMessage',itemId:'windows-cancel-'+event.turnId,phase:'commentary',text},outcome:{status:'succeeded'}}]);}
  try{await localControl(binding,'lifecycle',{event:'Stop',payload:{stop_hook_active:false}});}catch(error){emitItems(sessionId,event.turnId,[{item:{type:'agentMessage',itemId:'windows-stop-hook-'+event.turnId,phase:'commentary',text:'本机 Stop hook 出错：'+error.message},outcome:{status:'succeeded'}}]);}
  const file=event.nativeTurnRef?presentationFile(binding,event.nativeTurnRef):null;
  const extra={source:{localCwd:binding.localCwd,projectId:binding.projectId,sessionId:binding.sessionId,parentThread:binding.parentThread,remoteCwd:binding.remoteCwd,duplexControl:false,turnId:event.turnId},pending:true,items:[],displayedText:displayedText.get(key)??''};displayedText.delete(key);
  try{
    if(file)await saveJson(file,extra);
    extra.items=presentationItems(await localControl(binding,'events',{turnId:event.turnId}),binding,event.turnId,extra.displayedText);
    extra.pending=false;
    if(file)await saveJson(file,extra);
    // History replay keeps every card; the live turn skips cards already shown.
    const live=binding.liveItems??new Set();delete binding.liveItems;
    emitItems(sessionId,event.turnId,extra.items.filter(x=>!live.has(x.item.itemId)));
  }catch(error){
    // A display transport failure is not a failed model/Windows command. Keep
    // the native completion and a recoverable source pointer for history reads.
    // Never take the final-answer slot from Claude's reply.
    emitItems(sessionId,event.turnId,[{item:{type:'agentMessage',itemId:'windows-presentation-warning-'+event.turnId,phase:'commentary',text:'文件改动卡片未能同步：'+error.message+(file?'。重新打开会话后会补上。':'。')},outcome:{status:'succeeded'}}]);
  }
}
async function snapshotWithPresentation(s,binding,channelBinding=binding){
  const result=await s.readSnapshot();if(!result.ok)return result;
  for(const turn of result.value.turns){const ref=turn.nativeTurnRef;if(!ref)continue;try{const file=presentationFile(binding,ref),extra=JSON.parse(await readFile(file,'utf8'));if(extra.pending&&extra.source){if(extra.source.projectId!==binding.projectId)throw new Error('Presentation project mismatch');const records=channelBinding.duplexControl?await localControl(channelBinding,'history-events',{sourceSessionId:extra.source.sessionId,turnId:extra.source.turnId}):await localControl(extra.source,'events',{turnId:extra.source.turnId});extra.items=presentationItems(records,binding,extra.source.turnId,extra.displayedText??'');extra.pending=false;await saveJson(file,extra);}const ids=new Set(turn.items.map(x=>x.item.itemId));turn.items.push(...extra.items.filter(x=>!ids.has(x.item.itemId)));}catch(e){if(e.code!=='ENOENT')return fail('Native history exists, but Windows presentation could not be recovered: '+e.message);}}
  return result;
}

const openingSessions=new Map(),closingSessions=new Map();
async function releaseOpening(sessionId,opening){
  if(opening.releasing)return opening.releasing;
  opening.releasing=Promise.resolve().then(async()=>{
    try{if(opening.session)await opening.session.close();openingSessions.delete(sessionId);send({sessionId,closed:true});}
    catch(error){opening.closeError=error.message;send({sessionId,closeError:error.message});throw error;}
    finally{opening.releasing=null;}
  });return opening.releasing;
}
async function request(method, params) {
  if(method==='health')return {protocol:2,bridgeVersion:'0.13.6',dependencyVersion,capabilities:['project-context','local-policy','local-hooks','media-cache','agent-context','job-recovery','native-fork','duplex-control','live-reverse-probe','duplex-tools','context-delta','local-mcp','account-usage'],adapterSha256:createHash('sha256').update(await readFile(modulePath)).digest('hex')};
  if(method==='account')return inspectAccount();
  if(method==='reverse-health'){
    const legacy=remoteConfig.legacy;if(!legacy?.enabled)return false;
    try{const {stdout}=await exec('ssh',['-T','-p',String(legacy.port),'-i',legacy.identity,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+legacy.knownHosts,'-o','ConnectTimeout=8',legacy.user+'@127.0.0.1','echo CODEXHOST_BRIDGE_READY'],{timeout:12000,maxBuffer:4096});return stdout.trim()==='CODEXHOST_BRIDGE_READY';}catch{return false;}
  }
  if (method === 'inspect') {
    const result = await adapter.inspect({ refresh: params?.refresh });
    if (result.capabilities) result.capabilities = limitedCapabilities(result.capabilities);
    return result;
  }
  if (method === 'open') {
    const { sessionId, input, localCwd, parentThread } = params;
    if (sessions.has(sessionId)||openingSessions.has(sessionId)) throw new Error('Duplicate session handle');
    if(sessions.size+openingSessions.size>=64)return fail('This bridge connection already has 64 open sessions; close unused sessions before opening another');
    if (!['create', 'resume','fork'].includes(input.kind)) return fail('Only create, resume and native fork are supported by this bridge');
    const opening={cancelled:false,session:null,finished:false};openingSessions.set(sessionId,opening);
    let accepted=false;
    try{
    const binding={localCwd,sessionId,mediaKey:sessionId,openingState:opening,parentThread,prepareTurn:params.localFeatures?.includes('prepare-turn')===true,duplexControl:params.localControl===true,duplexTools:params.localTools===true,...(params.workspace?.projectId?{projectId:params.workspace.projectId}:{})};
    const verified=await localControl(binding,'bind',{resume:params.rebind===true});
    if(params.workspace && verified.projectId!==params.workspace.projectId)throw new Error('Windows/VPS project identity mismatch');
    const prepared=await prepareWorkspace(verified,root);
    const cwd=prepared.directory;
    Object.assign(binding,{projectId:verified.projectId,localCwd:verified.cwd,remoteCwd:cwd});
    let forkSource;
    if(input.kind==='fork'){
      if(input.sourceRef?.harnessId!=='claude-code')return fail('Fork source is not a Claude session');
      const sourceBinding=await readFile(path.join(root,'.bridge-sessions',safeId(input.sourceRef.nativeSessionId)+'.json'),'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
      if(!sourceBinding||sourceBinding.projectId!==binding.projectId||sourceBinding.remoteCwd!==cwd)return fail('Fork source is not bound to this Windows project; cross-project fork is not supported');
      // Reading source history does not start a model or run any Windows lifecycle hook.
      const opened=await adapter.open({kind:'resume',nativeRef:input.sourceRef,cwd});if(!opened.ok)return opened;
      try{const history=await snapshotWithPresentation(opened.value,sourceBinding,binding);if(!history.ok)return history;forkSource={binding:sourceBinding,turns:forkPrefix(history.value,input.sourceRef,input.checkpoint)};}finally{await opened.value.close();}
      await inheritMedia(root,sourceBinding,forkSource.turns,binding.mediaKey);
    }
    const environment=await localControl(binding,'environment');
    if(binding.duplexTools)binding.toolEnvironment=toolBridge.register(binding);
    const knownSession=input.kind==='resume'?await claimNativeSession(input.nativeRef,binding,true):false;
    const result = await adapter.open({ ...input, ...(!input.permissionModeId&&environment.defaultMode?{permissionModeId:environment.defaultMode}:{}), cwd, environment: {
      WINDOWS_PROJECT_CWD: verified.cwd,
      WINDOWS_PROJECT_ID: verified.projectId,
      WINDOWS_BRIDGE_SESSION: sessionId,
      WINDOWS_MEDIA_SESSION: binding.mediaKey,
      ...binding.toolEnvironment,
      CODEXHOST_CLI_PATH: agentCommand,
      WINDOWS_BRIDGE_ROOT: bridgeRoot,
      ...(parentThread ? { WINDOWS_PARENT_THREAD_ID: parentThread } : {}),
    } });
    if (!result.ok)return result;
    const s = opening.session = result.value;
    assertOpening(binding);
    if(s.nativeWriterRef){
      binding.cacheFile=path.join(root,'.bridge-cache',safeId(s.nativeWriterRef.nativeSessionId)+'.json');
      const saved=await readFile(binding.cacheFile,'utf8').then(JSON.parse,()=>null).catch(()=>null);
      if(saved?.projectId===binding.projectId)binding.promptCache=saved.indicator;
    }
    const initialUsage=await cacheUsage(binding,s.initialUsage,{initial:true});
    if(forkSource){
      try{
        const derived=await s.readSnapshot();if(!derived.ok)return derived;
        for(const pair of pairForkTurns(forkSource.turns,derived.value.turns)){
          const sourceFile=presentationFile(forkSource.binding,pair.source.nativeTurnRef);
          const extra=await readFile(sourceFile,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
          if(extra)await saveJson(presentationFile(binding,pair.derived.nativeTurnRef),{...extra,source:undefined,pending:false,inheritedFrom:pair.source.nativeTurnRef});
        }
      }catch(error){return fail('Native branch was created, but bridge inheritance failed for '+s.nativeWriterRef?.nativeSessionId+': '+error.message);}
    }
    binding.permissionMode=s.initialState?.effectivePermissionModeId??input.permissionModeId??environment.defaultMode??'default';
    await localControl(binding,'permission',{mode:binding.permissionMode});
    binding.startContext=await localControl(binding,'lifecycle',{event:'SessionStart',payload:{source:input.kind==='fork'?'fork':input.kind==='resume'?'resume':'startup'}});
    if(input.kind==='resume'&&!knownSession){const history=await s.readSnapshot();if(!history.ok)return history;}
    await claimNativeSession(s.nativeWriterRef,binding);
    await loadNoticeState(s.nativeWriterRef,binding);
    assertOpening(binding);
    sessions.set(sessionId, s);
    bindings.set(sessionId,binding);
    accepted=true;
    void (async () => {
      try { for await (let output of s.outputs) {
        if(output.kind==='event'){
          if(output.event.type==='turn.started')binding.activeTurn=output.event.turnId;
          if(output.event.type==='item.completed'&&output.event.snapshot.item.type==='contextCompaction')binding.contextState=null;
        }
        if(output.kind==='event'&&output.event.type==='session.usage.changed')output={...output,event:{...output.event,usage:await cacheUsage(binding,output.event.usage)}};
        await presentation(sessionId,output); send({ sessionId, output });
        if(output.kind==='event'&&output.event.type==='turn.completed'){binding.activeTurn=null;if(output.event.outcome.status!=='succeeded')binding.contextState=null;}
        // Host requires turn.started before every projected item, even notices.
        if(output.kind==='event'&&output.event.type==='turn.started'&&binding.contextNotice?.turnId===output.event.turnId){
          const notice=binding.contextNotice;delete binding.contextNotice;
          await acceptNotice(binding,notice);emitItems(sessionId,output.event.turnId,notice.items);
        }
      } }
      catch (error) { send({ sessionId, output: { kind: 'event', event: { type: 'session.faulted', error: fail(error.message).error } } }); }
      finally { send({ sessionId, ended: true }); }
    })();
    return { ok: true, value: { capabilities: limitedCapabilities(s.capabilities), initialState: s.initialState, initialUsage, nativeWriterRef: s.nativeWriterRef, remoteCwd: cwd, workspace:prepared.mapping,environment:{fingerprint:environment.fingerprint,warnings:environment.warnings,ruleFiles:environment.ruleFiles,capabilities:environment.capabilities} } };
    }finally{
      opening.finished=true;
      if(accepted)openingSessions.delete(sessionId);
      else{
        toolBridge.unregister(sessionId);sessions.delete(sessionId);bindings.delete(sessionId);
        await releaseOpening(sessionId,opening).catch(()=>{});
      }
    }
  }
  if(method==='close'){
    const opening=openingSessions.get(params?.sessionId);
    if(opening){opening.cancelled=true;if(opening.finished&&opening.closeError){await releaseOpening(params.sessionId,opening);return {closed:true};}return {closed:false,pending:true};}
    if(closingSessions.has(params?.sessionId))return closingSessions.get(params.sessionId);
  }
  const s = sessions.get(params?.sessionId);
  // A lost SSH transport destroys its handles. Closing an already released
  // handle must remain idempotent so Host can resume the durable native chat.
  if (!s) { if(method==='close')return {closed:true};throw new Error('Unknown session handle'); }
  switch (method) {
    case 'commands-list': {
      const listed=await s.commands?.list();if(!listed?.ok)return listed??fail('Native commands unavailable');
      return {...listed,value:{...listed.value,commands:listed.value.commands.filter(c=>c.id==='claude.compact')}};
    }
    case 'commands-execute': {
      if(params.command?.commandId!=='claude.compact')return fail('Only native compact is exposed for the Windows workspace');
      const binding=bindings.get(params.sessionId);await localControl(binding,'turn',{turnId:params.command.turnId});binding.contextState=null;
      return s.commands.execute(params.command);
    }
    case 'execute': {
      const binding=bindings.get(params.sessionId);let command=params.command;
      if(command.type==='turn.steer'){
        const reject=message=>({ok:false,error:{code:'invalidState',message,retryable:false}});
        if(binding.activeTurn!==command.turnId)return reject('追加指令目标不是当前活动轮次；未提交，也不会自动创建新轮次。');
        const capabilities=await (s.readCapabilities?.()??s.capabilities);
        if(capabilities.steer!==true)return reject('远端 Claude 当前未确认可接收运行中追加指令。');
        const prompt=command.input.filter(i=>i.type==='text').map(i=>i.text).join('\n');
        const {environment,hooks}=await localControl(binding,'prepare-steer',{turnId:command.turnId,prompt});
        if(params.attachments?.length){await localControl(binding,'attachments',{paths:params.attachments});}
        const media=[];for(const file of params.attachments??[])media.push('Explicitly attached local media:\n'+JSON.stringify(await localMedia(binding,file)));
        if(binding.activeTurn!==command.turnId)return reject('准备追加指令时原轮次已结束；未提交，请确认后发送新消息。');
        const context=[environment.text,'Current workspace permission mode: '+binding.permissionMode,...hooks.map(h=>h.hookSpecificOutput?.additionalContext??h.additionalContext??''),...media].filter(Boolean).join('\n\n');
        // Native adapter performs the final active-turn/race check; never retry as turn.start.
        return s.execute({...command,input:[{type:'text',text:context},...command.input]});
      }
      if(command.type==='turn.start'){
        const prompt=command.input.filter(i=>i.type==='text').map(i=>i.text).join('\n');
        let environment,hooks;
        if(binding.prepareTurn){({environment,hooks}=await localControl(binding,'prepare-turn',{turnId:command.turnId,prompt}));}
        else{await localControl(binding,'turn',{turnId:command.turnId});environment=await localControl(binding,'environment');hooks=await localControl(binding,'lifecycle',{event:'UserPromptSubmit',payload:{prompt}});}
        const update=contextUpdate(binding.contextState,environment);binding.pendingContext=update.state;
        send({timing:{phase:'context-injection',mode:update.mode,bytes:Buffer.byteLength(update.text),fullBytes:Buffer.byteLength(environment.text)}});
        const context=[update.text,'Current workspace permission mode: '+binding.permissionMode,...[...(binding.startContext??[]),...hooks].map(h=>h.hookSpecificOutput?.additionalContext??h.additionalContext??'')];binding.startContext=[];
        const slash=prompt.match(/^\s*\/([\w-]+)(?:\s+([\s\S]*))?$/);
        if(slash){const item=environment.capabilities.find(c=>['skill','command'].includes(c.kind)&&c.name===slash[1]);if(item){const value=await localControl(binding,'capability-context',{id:item.id});context.push('User explicitly invoked '+item.id+':\n'+value.content.replaceAll('$ARGUMENTS',slash[2]??''));command={...command,input:[{type:'text',text:'Execute the explicitly invoked local capability '+item.id+'. Arguments: '+(slash[2]??'')}]};}}
        const pending=(environment.jobs??[]).filter(j=>['starting','queued','running','unresponsive','interrupted'].includes(j.status));
        if(pending.length)context.push('Existing local tasks; query these IDs, never resubmit uncertain work:\n'+JSON.stringify(pending.map(({requestId,status,cwd,startedAt})=>({requestId,status,cwd,startedAt}))));
        if(params.attachments?.length){await localControl(binding,'attachments',{paths:params.attachments});for(const file of params.attachments){const media=await localMedia(binding,file);context.push('Explicitly attached local media (cached images/PDFs use native Read; local video remains a Windows file):\n'+JSON.stringify(media));}}
        command={...command,input:[{type:'text',text:context.join('\n\n')},...command.input]};
        const notice=contextNotice(binding.noticeState,environment);
        binding.contextNotice={...notice,turnId:command.turnId,items:notice.text?[{item:{type:'agentMessage',itemId:'windows-context-'+command.turnId,phase:'commentary',text:notice.text},outcome:{status:'succeeded'}}]:[]};
      }
      if(command.type==='turn.cancel'){
        binding.cancelResult=localControl(binding,'cancel-jobs',{turnId:command.turnId}).then(jobs=>({ok:true,jobs}),error=>({ok:false,error:error.message}));
        const results=await Promise.allSettled([s.execute(command),binding.cancelResult.then(r=>{if(!r.ok)throw new Error(r.error);return r.jobs;})]);
        for(const r of results)if(r.status==='rejected')throw r.reason;
        return results[0].value;
      }
      let result;
      try{result=await s.execute(command);}
      catch(error){if(command.type==='turn.start'){binding.contextState=null;delete binding.pendingContext;delete binding.contextNotice;}throw error;}
      if(command.type==='turn.start'){binding.contextState=result.ok?binding.pendingContext:null;delete binding.pendingContext;}
      if(command.type==='turn.start'&&!result.ok)delete binding.contextNotice;
      if(command.type==='permissionMode.select'&&result.ok){binding.permissionMode=command.permissionModeId;await localControl(binding,'permission',{mode:command.permissionModeId});}
      return result;
    }
    case 'snapshot': return snapshotWithPresentation(s,bindings.get(params.sessionId));
    case 'capabilities': return limitedCapabilities(await (s.readCapabilities?.()??s.capabilities));
    case 'usage': await s.refreshUsage?.(); return null;
    case 'close': {
      const closing=Promise.resolve().then(async()=>{let nativeClosed=false;try{await s.close();nativeClosed=true;await localControl(bindings.get(params.sessionId),'lifecycle',{event:'SessionEnd',payload:{reason:'closed'}});return {closed:true};}catch(error){if(!nativeClosed)send({sessionId:params.sessionId,closeError:error.message});throw error;}finally{closingSessions.delete(params.sessionId);if(nativeClosed){toolBridge.unregister(params.sessionId);sessions.delete(params.sessionId);bindings.delete(params.sessionId);send({sessionId:params.sessionId,closed:true});}}});
      closingSessions.set(params.sessionId,closing);return closing;
    }
    default: throw new Error('Unsupported bridge operation');
  }
}
readJsonLines(process.stdin,frame=>{
  if(frame.controlId){send({controlAck:frame.controlId});const pending=localPending.get(frame.controlId);if(!pending)return;localPending.delete(frame.controlId);clearTimeout(pending.timer);if(frame.error)pending.reject(new Error(frame.error));else pending.resolve(frame.value);return;}
  void request(frame.method, frame.params).then(value => send({ id: frame.id, value }), error => send({ id: frame.id, error: {code:error.code??'REMOTE_OPERATION_FAILED',message:String(error.message)} }));
},{onError:error=>{process.stderr.write(error.code+'\n');void closeStream(2);},onEnd:()=>void closeStream(0)});
async function closeStream(code){
  if(streamClosing)return;streamClosing=true;
  for(const p of localPending.values()){clearTimeout(p.timer);p.reject(new Error('Local transport closed; outcome unknown, no replay was sent'));}localPending.clear();
  const timer=setTimeout(()=>process.exit(code),5000);timer.unref();
  try{await toolBridge.close();await adapter.close();}finally{output.dispose();process.exit(code);}
}
