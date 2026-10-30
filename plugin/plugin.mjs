import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectInfo, control, handle } from './runtime/workspace-runtime.mjs';
import {SshTransport} from './runtime/ssh-transport.mjs';
import {referencedMedia} from './runtime/media-input.mjs';
import {decodeHostInput} from './runtime/input-boundary.mjs';
import {observeModel} from './runtime/model-observation.mjs';
import {closeMcpSession} from './runtime/mcp-runtime.mjs';

import {getBridgeConfig} from './runtime/bridge-config.mjs';
import {createBridgePreflight} from './runtime/bridge-preflight.mjs';
import {SessionChannel,SessionRequests} from './runtime/session-buffer.mjs';
const ID = 'claude-vps';
const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime');
const EXPORT = path.join(RUNTIME,'Export-CodexHostBridgeContext.ps1');

const exec = promisify(execFile);
function remap(value, from, to) {
  if (Array.isArray(value)) return value.map(x => remap(x, from, to));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, k === 'harnessId' && v === from ? to : remap(v, from, to)]));
}
export function createHarnessAdapter(context) {
  let accountSnapshot=null,accountPending=null,accountRefreshAfter=0;
  const channels=new Map(), localBindings=new Map();
  const controlActions=new Set(['bind','turn','prepare-turn','prepare-steer','events','history-events','cancel-jobs','environment','permission','capability-context','attachments','lifecycle','preflight','media-export','mcp']);
  const toolActions=new Set(['status','info','capability','context','read','list','search','write','edit','artifact','run','job','jobs','agent','media-export','batch','isolation']);
  const timing=value=>{try{context.onBridgeTiming?.(value);}catch{}};
  // Transient reconnects stay silent; only an unavailable bridge is reported.
  // Contract: adapter and session methods settle with a result or fallback and
  // never reject on transport loss. The Host does not await every call, and an
  // unhandled rejection terminates the whole Host Runtime.
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
  }
  const errorResult = message => ({ok:false,error:{code:'unavailable',message,retryable:true}});
  function failed(message) {
    for(const channel of channels.values()){channel.push({kind:'event',event:{type:'session.faulted',error:errorResult(message).error}});channel.end();} channels.clear();
    localBindings.clear();
  }
  const transport=new SshTransport({
    onIdleReset(){if([...localBindings.values()].some(b=>b.activeTurn||b.submitting))return false;for(const b of localBindings.values()){b.needsRebind=true;b.requests.clear();}return true;},
    onFrame(frame){
      if(frame.controlId){void localRequest(frame);return;}
      if(frame.timing){timing(frame.timing);return;}
      if(frame.sessionId){
        if(frame.closed){closeMcpSession(frame.sessionId);channels.get(frame.sessionId)?.end();channels.delete(frame.sessionId);localBindings.delete(frame.sessionId);return;}
        if(frame.closeError){timing({phase:'session-cleanup',status:'unconfirmed',message:frame.closeError});return;}
        const channel=channels.get(frame.sessionId),binding=localBindings.get(frame.sessionId);
        const output=remap(frame.output,'claude-code',ID);
        if(binding&&output?.kind==='event'){
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
    onState(state){if(['connecting','reconnecting','idle-restoring','unavailable'].includes(state.state))preflight.invalidate();timing({phase:'transport-state',...state});if(state.state==='unavailable')failed(state.message);}
  });
  const config=getBridgeConfig();
  const preflight=createBridgePreflight({
    connect:()=>transport.connect(),connectionKey:()=>transport.epoch,
    probe:()=>rpc('health',{},15000),timing,
    ...(config.legacy?.enabled&&config.legacy.tunnelScript?{recoverLegacy:()=>exec(config.pwshExecutable,['-NoLogo','-NoProfile','-File',config.legacy.tunnelScript],{windowsHide:true,timeout:90000})}:{})
  });
  async function rpc(method,params,timeout=120000){return remap(await transport.rpc(method,remap(params,ID,'claude-code'),timeout),'claude-code',ID);}
  async function readAccount(force=false){
    if(accountPending)return accountPending;
    if(!force&&Date.now()<accountRefreshAfter)return accountSnapshot;
    accountPending=(async()=>{
      try{accountSnapshot=await rpc('account',{},11000);accountRefreshAfter=Date.now()+60000;return accountSnapshot;}
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
    // Only a successful response replaces it; a successful empty response clears it.
    credits(){return accountSnapshot?.credits??null;},
    async refreshCredits(){await readAccount();return adapter.credits();},
    async inspect(input={}){try{return await rpc('inspect',{refresh:input.refresh});}catch(error){return {status:'unavailable',error:errorResult(error.message).error};}},
    async open(input){
      let sessionId, channel;
      try{
        if(!path.win32.isAbsolute(input.cwd)||!(await stat(input.cwd)).isDirectory())throw new Error('Select an existing local Windows project');
        const health=await preflight.health();
        if(input.kind==='fork'&&!health.capabilities.includes('native-fork'))throw new Error('Remote bridge has not loaded native fork support; reconnect after installing both sides.');
        const parent=input.environment?.CODEXHOST_THREAD_ID || input.environment?.CODEX_THREAD_ID;
        const env={...process.env,...context.environment,...input.environment};
        if(parent && env.CODEXHOST_RUNTIME_ENDPOINT && env.CODEXHOST_RUNTIME_TOKEN){
          await exec(getBridgeConfig().pwshExecutable,['-NoLogo','-NoProfile','-File',EXPORT],{env:{...env,CODEX_THREAD_ID:parent},windowsHide:true,timeout:15000});
        }
        sessionId=randomUUID();channel=new SessionChannel(reason=>faultSession(sessionId,reason)); channels.set(sessionId,channel);
        const {environment,...safeInput}=input;
        const workspace=await projectInfo(input.cwd);
        localBindings.set(sessionId,{cwd:workspace.cwd,projectId:workspace.projectId,parentThread:parent,requests:new SessionRequests()});
        const opened=await rpc('open',{sessionId,input:safeInput,localCwd:input.cwd,parentThread:parent,workspace,localFeatures:['prepare-turn'],localControl:health.capabilities.includes('duplex-control'),localTools:health.capabilities.includes('duplex-tools')},input.kind==='fork'?180000:60000);
        if(!opened.ok){channel.end();channels.delete(sessionId);localBindings.delete(sessionId);return opened;}
        const metadata=opened.value;
        const binding=localBindings.get(sessionId);binding.nativeState??=metadata.initialState;
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
        async function readSnapshot(){
          const result=await rpc('snapshot',{sessionId});
          if(!result.ok||!result.value.state)return result;
          binding.nativeState=result.value.state;
          return result;
        }
        const session={
          harnessId:ID, get capabilities(){return binding.capabilities??metadata.capabilities;}, initialState:metadata.initialState,
          nativeWriterRef:metadata.nativeWriterRef, initialUsage:metadata.initialUsage, outputs:channel,
          workspace:metadata.workspace,remoteCwd:metadata.remoteCwd,
          commands:{
            async list(){try{await ensureSession();return await rpc('commands-list',{sessionId});}catch(e){return errorResult(e.message);}},
            async execute(command){try{if(binding.faulted)throw new Error(binding.faulted);await ensureSession();return await rpc('commands-execute',{sessionId,command});}catch(e){return errorResult(e.message);}}
          },
          async readCapabilities(){try{await ensureSession();binding.capabilities=await rpc('capabilities',{sessionId});}catch(e){timing({phase:'capabilities',status:'unavailable',message:e.message});}return binding.capabilities??metadata.capabilities;},
          async execute(command){let submitting=false;try{if(binding.faulted&&command.type!=='turn.cancel')throw new Error(binding.faulted);if(['turn.start','turn.steer'].includes(command.type)){command={...command,input:await decodeHostInput(command.input)};await preflight.health();}if(command.type==='turn.steer'&&binding.activeTurn!==command.turnId)throw Error('追加指令目标不是当前活动轮次；未提交。');await ensureSession();binding.submitting=(binding.submitting??0)+1;submitting=true;return await rpc('execute',{sessionId,command,...(['turn.start','turn.steer'].includes(command.type)?{attachments:referencedMedia(command.input)}:{})},['turn.start','turn.steer'].includes(command.type)?180000:60000);}catch(e){return {...errorResult(e.message),error:{...errorResult(e.message).error,retryable:false}};}finally{if(submitting)binding.submitting=Math.max(0,(binding.submitting??0)-1);}},
          async readSnapshot(){try{await ensureSession();return await readSnapshot();}catch(e){if(e.code==='IDLE_RESTORE'){try{await ensureSession();return await readSnapshot();}catch(error){return errorResult(error.message);}}return errorResult(e.message);}},
          async refreshUsage(){try{await ensureSession();await rpc('usage',{sessionId});}catch(e){timing({phase:'usage',status:'unavailable',message:e.message});}},
          async close(){binding.closing=true;try{const closed=await rpc('close',{sessionId},15000);if(closed===null||closed?.closed===true){closeMcpSession(sessionId);localBindings.delete(sessionId);}}catch(e){timing({phase:'session-cleanup',status:'unconfirmed',message:e.message});}finally{channel.end();channels.delete(sessionId);}},
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
    async close(){for(const id of localBindings.keys())closeMcpSession(id);await transport.close();for(const c of channels.values())c.end();},
  };
  return adapter;
}
