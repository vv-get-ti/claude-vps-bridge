import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectInfo, control, handle, workspaceHasBackgroundWork } from './runtime/workspace-runtime.mjs';
import {SshTransport} from './runtime/ssh-transport.mjs';
import {recordRouteState} from './runtime/ssh-routes.mjs';
import {recordLoadedInstall} from './runtime/activation.mjs';
import {referencedMedia} from './runtime/media-input.mjs';
import {decodeHostInput} from './runtime/input-boundary.mjs';
import {observeModel} from './runtime/model-observation.mjs';
import {closeMcpSession,hasMcpSession} from './runtime/mcp-runtime.mjs';
import {submissionFailure} from './runtime/delivery-outcome.mjs';

import {getBridgeConfig} from './runtime/bridge-config.mjs';
import {createBridgePreflight} from './runtime/bridge-preflight.mjs';
import {SessionChannel,SessionRequests} from './runtime/session-buffer.mjs';
import {SessionReads} from './runtime/session-reads.mjs';
import {createSessionImport,rememberNativeBinding} from './runtime/session-admin.mjs';
import {createClaudeInstallation} from './runtime/claude-installation.mjs';
const SHARED_READS=new Set(['inspect','snapshot','capabilities','commands-list','background-status']);
const ID = 'claude-vps';
// The official adapter catalog lives on the VPS; draft inspection stays local.
const commandCatalog={commands:[{
  id:'claude.compact',invocation:'/compact',label:'Compact context',
  description:'Compact the current conversation context',argumentMode:'text',
  localizations:{'zh-CN':{label:'压缩上下文',description:'压缩当前对话上下文'}},
}]};
const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime');
const STATE = path.join(RUNTIME,'state');
const EXPORT = path.join(RUNTIME,'Export-CodexHostBridgeContext.ps1');

const exec = promisify(execFile);
function remap(value, from, to) {
  if (Array.isArray(value)) return value.map(x => remap(x, from, to));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k,v]) => {
    // Item payloads and updates can contain arbitrary tool data, including harnessId keys.
    if(k==='item'||k==='update')return [k,v];
    return [k,k==='harnessId'&&v===from?to:remap(v,from,to)];
  }));
}
export function createHarnessAdapter(context) {
  // Lets diagnose tell whether this Host process runs the installed code.
  void recordLoadedInstall(path.join(RUNTIME,'state')).catch(()=>{});
  const account={snapshot:null};
  let current=createConnectionAdapter(context,account),closed=false;
  function active(){
    if(!closed&&current.replaced)current=createConnectionAdapter(context,account);
    return current;
  }
  return {
    harnessId:ID,
    commandCatalog,
    sessionImport:createSessionImport({getConfig:getBridgeConfig,state:STATE,projectInfo:cwd=>projectInfo(cwd,{readOnly:true})}),
    installation:createClaudeInstallation(getBridgeConfig),
    async inspect(input){
      const connection=active();
      const result=await connection.adapter.inspect(input);
      // Independent catalog reads may cross this boundary once. Session
      // handles and in-flight writes keep their original transport forever.
      if(result?.status==='unavailable'&&connection.replaced&&!closed&&!input?.signal?.aborted){
        return active().adapter.inspect(input);
      }
      return result;
    },
    open:(...args)=>active().adapter.open(...args),
    inspectAccount:()=>active().adapter.inspectAccount(),
    credits:()=>current.adapter.credits(),
    refreshCredits:()=>active().adapter.refreshCredits(),
    close(){closed=true;return current.adapter.close();},
  };
}

function createConnectionAdapter(context,account) {
  let accountPending=null,accountRefreshAfter=0;
  const channels=new Map(), localBindings=new Map();
  const reads=new SessionReads((...args)=>transport.rpc(...args));
  const controlActions=new Set(['bind','turn','prepare-turn','prepare-steer','events','history-events','cancel-jobs','environment','permission','capability-context','attachments','lifecycle','preflight','media-export','mcp']);
  const toolActions=new Set(['status','info','capability','context','read','list','search','write','edit','artifact','run','job','jobs','agent','media-export','batch','isolation']);
  const timing=value=>{try{context.onBridgeTiming?.(value);}catch{}};
  function invalidateBackground(binding){binding.backgroundCheckedAt=0;binding.backgroundRevision=(binding.backgroundRevision??0)+1;}
  // Link state is shown from this local plugin, so it reaches the desktop even
  // while SSH is down. Short reconnects stay silent; a reconnect still running
  // after outageNoticeMs is shown in active turns, and recovery is confirmed once.
  const outageNoticeMs=context.outageNoticeMs??8000;let outageTimer=null,outageShown=false;
  function turnNotice(text){for(const [sessionId,binding] of localBindings){if(!binding.activeTurn)continue;const item={type:'agentMessage',itemId:'bridge-link-'+randomUUID(),phase:'commentary',text};const channel=channels.get(sessionId);channel?.push({kind:'event',event:{type:'item.started',turnId:binding.activeTurn,item}});channel?.push({kind:'event',event:{type:'item.completed',turnId:binding.activeTurn,snapshot:{item,outcome:{status:'succeeded'}}}});}}
  function linkNotice(state){
    if(state.state==='reconnecting'&&!outageTimer&&!outageShown)outageTimer=setTimeout(()=>{outageTimer=null;outageShown=true;turnNotice('与 VPS 的连接中断，正在重连。本机正在运行的任务不受影响。');},outageNoticeMs);
    if(state.state==='connected'){clearTimeout(outageTimer);outageTimer=null;if(outageShown){outageShown=false;turnNotice('连接已恢复，继续当前任务。');}}
    if(state.state==='unavailable'){clearTimeout(outageTimer);outageTimer=null;outageShown=false;}
  }
  // Operational methods return results/fallbacks. close is different: awaiting
  // callers must observe unconfirmed cleanup. Its returned promise has a rejection
  // handler as well, so a fire-and-forget Host cannot crash on transport loss.
  function observeOutput(sessionId,output){
    const binding=localBindings.get(sessionId),event=output?.kind==='event'?output.event:null;
    if(!binding||!event)return;
    const observation=observeModel(binding.modelObservation,event,binding.activeTurn);
    if(!observation)return;
    binding.modelObservation=observation;
    binding.observationSave=(binding.observationSave??Promise.resolve()).then(()=>control({action:'model-observation',cwd:binding.cwd,projectId:binding.projectId,sessionId,parentThread:binding.parentThread,observation})).catch(()=>{timing({phase:'model-observation',status:'save-failed'});});
  }
  function faultSession(sessionId,reason){
    const binding=localBindings.get(sessionId);if(!binding||binding.faulted)return;
    binding.faulted=reason+' New operations are blocked. Cancellation of the active turn was requested when known, but task termination is not confirmed. Inspect original jobs and resume native history before continuing.';
    channels.get(sessionId)?.fault(binding.faulted);
    if(binding.activeTurn)void rpc('execute',{sessionId,command:{type:'turn.cancel',turnId:binding.activeTurn}},15000).catch(()=>{});
  }
  async function localRequest(frame){
    const binding=localBindings.get(frame.sessionId);
    if(binding){invalidateBackground(binding);binding.localOperations=(binding.localOperations??0)+1;}
    try{
      if(!binding)throw new Error('Unknown local session binding');
      const recovery=frame.lane==='tool'?['status','job','jobs'].includes(frame.request?.action):['cancel-jobs','events','history-events'].includes(frame.request?.action);
      if(binding.faulted&&!recovery)throw new Error(binding.faulted);
      if(binding.closing&&!recovery&&!(frame.lane!=='tool'&&frame.request?.action==='lifecycle'&&frame.request?.event==='SessionEnd'))throw new Error('Session is closing; new local work was not submitted');
      try{binding.requests.accept(frame.controlId,{recovery,sequence:frame.controlNo,epoch:frame.controlEpoch});}catch(error){if(error.code==='SESSION_REQUEST_LIMIT')faultSession(frame.sessionId,error.message);throw error;}
      if(!(frame.lane==='tool'?toolActions:controlActions).has(frame.request?.action))throw new Error('Unsupported local operation');
      for(const [key,value] of Object.entries({cwd:binding.cwd,projectId:binding.projectId,sessionId:frame.sessionId,parentThread:binding.parentThread,bridgeRequestId:frame.controlId}))if(key in frame.request&&frame.request[key]!==value)throw new Error('Control request cannot override the bound '+key);
      const started=performance.now();
      const request={...frame.request,cwd:binding.cwd,projectId:binding.projectId,sessionId:frame.sessionId,parentThread:binding.parentThread,bridgeRequestId:frame.controlId};
      timing({phase:'local-operation-start',action:request.action,lane:frame.lane??'control'});
      const value=await (frame.lane==='tool'&&request.action!=='media-export'?handle(request):control(request));
      timing({phase:'local-control',action:frame.request.action,ms:performance.now()-started});
      await transport.reply({controlId:frame.controlId,value});
    }catch(error){await transport.reply({controlId:frame.controlId,error:error.message}).catch(()=>{});}
    finally{if(binding){invalidateBackground(binding);binding.localOperations--;}}
  }
  const errorResult = message => ({ok:false,error:{code:'unavailable',message,retryable:true}});
  function failed(message) {
    const text='与 VPS 的连接中断，多次重连仍未成功（'+message+'）。网络恢复后重新打开此会话即可继续，VPS 上的对话记录不会丢失。';
    turnNotice(text);
    for(const channel of channels.values()){channel.push({kind:'event',event:{type:'session.faulted',error:errorResult(text).error}});channel.end();} channels.clear();
    // The transport still owns pending failures, including relay replacement.
    for(const sessionId of localBindings.keys()){
      reads.forget(sessionId);
      if(transport.fatalError?.code==='REMOTE_RELAY_REPLACED')closeMcpSession(sessionId);
    }
    localBindings.clear();
  }
  const transport=new SshTransport({
    canRecoverRead:()=>![...localBindings.values()].some(b=>b.activeTurn||b.submitting||b.closing||b.localOperations),
    onIdleReset(){if([...localBindings.values()].some(b=>b.activeTurn||b.submitting))return false;for(const b of localBindings.values()){b.needsRebind=true;b.requests.clear();}return true;},
    onFrame(frame){
      if(frame.controlId){void localRequest(frame);return;}
      if(frame.timing){timing(frame.timing);return;}
      if(frame.sessionId){
        if(frame.closed){const binding=localBindings.get(frame.sessionId);if(binding){binding.remoteClosed=true;binding.readLifetime.abort();binding.confirmClosed?.();}reads.close(frame.sessionId);closeMcpSession(frame.sessionId);channels.get(frame.sessionId)?.end();channels.delete(frame.sessionId);localBindings.delete(frame.sessionId);return;}
        if(frame.closeError){timing({phase:'session-cleanup',status:'unconfirmed',message:frame.closeError});return;}
        const channel=channels.get(frame.sessionId),binding=localBindings.get(frame.sessionId);
        const output=remap(frame.output,'claude-code',ID);
        if(binding&&output?.kind==='event'){
          invalidateBackground(binding);
          const event=output.event;
          if(event.type==='turn.started'){binding.activeTurn=event.turnId;binding.modelObservation=null;}
          if(event.type==='turn.completed')binding.activeTurn=null;
          if(event.type==='session.state.changed'){
            binding.nativeState=event.state;
          }
        }
        if(output){channel?.push(output);observeOutput(frame.sessionId,output);}
        if(frame.ended)channel?.end();
      }
    },
    onState(state){if(state.route)void recordRouteState(path.join(RUNTIME,'state'),state).catch(()=>{});
      if(state.heartbeat)return;
      if(['connecting','reconnecting','idle-restoring','unavailable'].includes(state.state)){preflight.invalidate();for(const binding of localBindings.values())invalidateBackground(binding);}timing({phase:'transport-state',...state});linkNotice(state);if(state.state==='unavailable')failed(state.message);}
  });
  const config=getBridgeConfig();
  const preflight=createBridgePreflight({
    connect:()=>transport.connect(),connectionKey:()=>transport.epoch,
    probe:()=>rpc('health',{},15000),timing,
    ...(config.legacy?.enabled&&config.legacy.tunnelScript?{recoverLegacy:()=>exec(config.pwshExecutable,['-NoLogo','-NoProfile','-File',config.legacy.tunnelScript],{windowsHide:true,timeout:90000})}:{})
  });
  async function rpc(method,params,timeout,signal){
    const wire=remap(params,ID,'claude-code');
    const result=SHARED_READS.has(method)?await reads.read(method,wire,timeout,signal):await transport.rpc(method,wire,timeout,signal);
    return remap(result,'claude-code',ID);
  }
  async function readAccount(force=false){
    if(accountPending)return accountPending;
    if(!force&&Date.now()<accountRefreshAfter)return account.snapshot;
    accountPending=(async()=>{
      try{const value=await rpc('account',{},11000);if(value!==null&&typeof value==='object'){account.snapshot=value;accountRefreshAfter=Date.now()+60000;return value;}accountRefreshAfter=Date.now()+15000;return null;}
      catch{accountRefreshAfter=Date.now()+15000;return null;}
      finally{accountPending=null;}
    })();
    return accountPending;
  }
  const adapter={
    harnessId:ID,
    // Host discovers this optional method to populate its native account panel.
    // Account inspection is independent of a workspace, model turn and tunnel probe.
    async inspectAccount(){return readAccount(true);},
    // The composer ring reads these separate optional APIs synchronously.
    // Keep the last observed quota while refreshing, including across resets.
    // Only an account object replaces it. Null and failures preserve the snapshot.
    credits(){return account.snapshot?.credits??null;},
    async refreshCredits(){await readAccount();return adapter.credits();},
    async inspect(input={}){try{return await rpc('inspect',{refresh:input.refresh,purpose:input.purpose},undefined,input.signal);}catch(error){return {status:'unavailable',error:errorResult(error.message).error};}},
    async open(input,options){
      let sessionId, channel;
      try{
        (options?.signal??input.signal)?.throwIfAborted();
        if(!path.win32.isAbsolute(input.cwd)||!(await stat(input.cwd)).isDirectory())throw new Error('Select an existing local Windows project');
        const health=await preflight.health();
        if(input.kind==='fork'&&!health.capabilities.includes('native-fork'))throw new Error('Remote bridge has not loaded native fork support; reconnect after installing both sides.');
        const parent=input.environment?.CODEXHOST_THREAD_ID || input.environment?.CODEX_THREAD_ID;
        const env={...process.env,...context.environment,...input.environment};
        if(parent && env.CODEXHOST_RUNTIME_ENDPOINT && env.CODEXHOST_RUNTIME_TOKEN){
          await exec(getBridgeConfig().pwshExecutable,['-NoLogo','-NoProfile','-File',EXPORT],{env:{...env,CODEX_THREAD_ID:parent},windowsHide:true,timeout:15000});
        }
        sessionId=randomUUID();channel=new SessionChannel(reason=>faultSession(sessionId,reason)); channels.set(sessionId,channel);
        const {environment,signal,...safeInput}=input;
        const workspace=await projectInfo(input.cwd);
        localBindings.set(sessionId,{cwd:workspace.cwd,projectId:workspace.projectId,parentThread:parent,requests:new SessionRequests(),readLifetime:new AbortController()});
        const opened=await rpc('open',{sessionId,input:safeInput,localCwd:input.cwd,parentThread:parent,workspace,localFeatures:['prepare-turn'],localControl:health.capabilities.includes('duplex-control'),localTools:health.capabilities.includes('duplex-tools')},input.kind==='fork'?180000:60000,options?.signal??signal);
        if(!opened.ok){channel.end();channels.delete(sessionId);localBindings.delete(sessionId);return opened;}
        const metadata=opened.value;
        if(parent)await rememberNativeBinding(STATE,metadata.nativeWriterRef?.nativeSessionId,parent,workspace.projectId)
          .catch(()=>timing({phase:'native-binding',status:'save-failed'}));
        const binding=localBindings.get(sessionId);binding.nativeState??=metadata.initialState;
        binding.closedSignal=new Promise(resolve=>{binding.confirmClosed=resolve;});
        function hasBackgroundWork(){
          if(binding.remoteClosed)return false;
          if(binding.closing||binding.faulted||binding.activeTurn||binding.submitting||binding.localOperations||binding.needsRebind||hasMcpSession(sessionId))return true;
          if(binding.backgroundCheckedAt&&performance.now()-binding.backgroundCheckedAt<5000)return binding.backgroundBusy!==false;
          // Host's predicate is synchronous. Refresh only when it asks, never
          // poll every idle chat in the background or let a Promise mean false.
          if(!binding.backgroundCheck){
            const epoch=transport.epoch,revision=binding.backgroundRevision;
            binding.backgroundCheck=Promise.all([rpc('background-status',{sessionId},5000),workspaceHasBackgroundWork(workspace)])
              .then(([remote,local])=>{binding.backgroundBusy=remote?.busy!==false||local!==false;if(epoch===transport.epoch&&revision===binding.backgroundRevision)binding.backgroundCheckedAt=performance.now();})
              .catch(()=>{binding.backgroundBusy=true;binding.backgroundCheckedAt=performance.now();})
              .finally(()=>{binding.backgroundCheck=null;});
          }
          return true;
        }
        function closeSession(){
          if(binding.closePromise)return binding.closePromise;
          binding.closing=true;
          binding.readLifetime.abort();
          reads.close(sessionId);
          const task=(async()=>{
            if(!binding.remoteClosed){
              let response;
              try{response=await rpc('close',{sessionId},15000);}
              catch(error){if(!binding.remoteClosed)throw error;timing({phase:'session-cleanup',status:'closed-with-hook-error',message:error.message});}
              if(response===null||response?.closed===true){binding.remoteClosed=true;binding.confirmClosed();}
              if(!binding.remoteClosed){
                if(response?.pending!==true)throw new Error('Remote session cleanup was not confirmed');
                let timer;try{await Promise.race([binding.closedSignal,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Remote session cleanup is still pending')),15000);})]);}finally{clearTimeout(timer);}
              }
            }
            closeMcpSession(sessionId);localBindings.delete(sessionId);channel.end();channels.delete(sessionId);
          })();
          binding.closePromise=task;
          // Keep output/binding alive on failure for late confirmation and hooks.
          task.catch(error=>{binding.closePromise=null;if(!binding.remoteClosed)binding.readLifetime=new AbortController();timing({phase:'session-cleanup',status:'unconfirmed',message:error.message});});
          return task;
        }
        async function ensureSession(){
          await transport.connect();if(!binding.needsRebind)return;
          if(!binding.rebinding)binding.rebinding=(async()=>{
            const nativeRef=remap(binding.nativeState?.nativeRef??metadata.nativeWriterRef,'claude-code',ID);
            if(!nativeRef)throw new Error('The previous native session identity is unknown; no replacement conversation was created');
            const restored=await rpc('open',{sessionId,rebind:true,input:{kind:'resume',cwd:input.cwd,nativeRef,model:binding.nativeState?.effectiveModel??input.model,thinkingOptionId:binding.nativeState?.effectiveThinkingOptionId??input.thinkingOptionId,permissionModeId:binding.nativeState?.effectivePermissionModeId??input.permissionModeId},localCwd:input.cwd,parentThread:binding.parentThread,workspace,localFeatures:['prepare-turn'],localControl:true,localTools:true});
            if(!restored.ok)throw new Error(restored.error.message);binding.capabilities=restored.value.capabilities;if(restored.value.initialUsage)channel.push({kind:'event',event:{type:'session.usage.changed',usage:restored.value.initialUsage}});binding.needsRebind=false;timing({phase:'native-session-restored',nativeSessionId:nativeRef.nativeSessionId});
          })().finally(()=>{binding.rebinding=null;});
          return binding.rebinding;
        }
        async function sessionRead(method,signal){
          const lifetime=binding.readLifetime.signal;
          const until=signal?AbortSignal.any([signal,lifetime]):lifetime;
          until.throwIfAborted();
          await ensureSession();
          return rpc(method,{sessionId},undefined,until);
        }
        async function readSnapshot(signal){
          const result=await sessionRead('snapshot',signal);
          if(!result.ok||!result.value.state)return result;
          binding.nativeState=result.value.state;
          return result;
        }
        const session={
          harnessId:ID, get capabilities(){return binding.capabilities??metadata.capabilities;}, initialState:metadata.initialState,
          nativeWriterRef:metadata.nativeWriterRef, initialUsage:metadata.initialUsage, outputs:channel,
          workspace:metadata.workspace,remoteCwd:metadata.remoteCwd,
          hasBackgroundWork,
          commands:{
            async list(options){try{return await sessionRead('commands-list',options?.signal);}catch(e){return errorResult(e.message);}},
            execute(command,options){
              const task=(async()=>{
                let submitted=false;
                try{
                  options?.signal?.throwIfAborted();
                  if(binding.faulted)throw new Error(binding.faulted);
                  await ensureSession();submitted=true;
                  return await rpc('commands-execute',{sessionId,command},undefined,options?.signal);
                }catch(error){return submissionFailure(error,{submitted});}
              })();
              task.catch(()=>{});return task;
            }
          },
          async readCapabilities(options){try{binding.capabilities=await sessionRead('capabilities',options?.signal);}catch(e){timing({phase:'capabilities',status:'unavailable',message:e.message});}return binding.capabilities??metadata.capabilities;},
          execute(command,options){
            const task=(async()=>{
              let submitting=false;
              try{
                options?.signal?.throwIfAborted();
                if(binding.faulted&&command.type!=='turn.cancel')throw new Error(binding.faulted);
                if(['turn.start','turn.steer'].includes(command.type)){
                  command={...command,input:await decodeHostInput(command.input)};
                  await preflight.health();
                }
                if(command.type==='turn.steer'&&binding.activeTurn!==command.turnId)throw Error('追加指令目标不是当前活动轮次；未提交。');
                await ensureSession();
                const attachments=['turn.start','turn.steer'].includes(command.type)?{attachments:referencedMedia(command.input)}:{};
                binding.submitting=(binding.submitting??0)+1;submitting=true;
                return await rpc('execute',{sessionId,command,...attachments},['turn.start','turn.steer'].includes(command.type)?180000:60000,options?.signal);
              }catch(error){return submissionFailure(error,{submitted:submitting});}
              finally{if(submitting)binding.submitting=Math.max(0,(binding.submitting??0)-1);}
            })();
            // Host may fire and forget cancellation. Awaiters still see unknown outcomes.
            task.catch(()=>{});
            return task;
          },
          async readSnapshot(options){try{return await readSnapshot(options?.signal);}catch(e){return errorResult(e.message);}},
          async refreshUsage(){try{await ensureSession();await rpc('usage',{sessionId});}catch(e){timing({phase:'usage',status:'unavailable',message:e.message});}},
          close:closeSession,
        };
        return {ok:true,value:session};
      }catch(e){
        channel?.end();
        if(sessionId){
          const binding=localBindings.get(sessionId);if(binding)binding.closing=true;
          channels.delete(sessionId);
          try{const closed=await rpc('close',{sessionId},15000);if(closed===null||closed?.closed===true){closeMcpSession(sessionId);localBindings.delete(sessionId);}}
          catch(cleanupError){timing({phase:'session-cleanup',status:'unconfirmed',message:cleanupError.message});}
          // Keep the binding until remote cleanup is confirmed. Existing local
          // hooks may still need to return after an open RPC times out.
        }
        return {...errorResult(e.message),error:{...errorResult(e.message).error,retryable:false}};
      }
    },
    async close(){for(const [id,binding] of localBindings){binding.readLifetime.abort();closeMcpSession(id);}reads.close();await transport.close();for(const c of channels.values())c.end();},
  };
  return {
    adapter,
    get replaced(){return Boolean(transport.epoch)&&transport.fatalError?.code==='REMOTE_RELAY_REPLACED';},
  };
}
