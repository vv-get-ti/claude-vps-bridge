import {spawn} from 'node:child_process';
import {getBridgeConfig,shellQuote} from './bridge-config.mjs';
import {randomUUID} from 'node:crypto';
import {JsonWriter,readJsonLines,jsonFrame,transportError,MAX_QUEUE_BYTES} from '../transport-streams.mjs';

export class SshTransport{
  constructor({onFrame,onState,onIdleReset,spawnProcess=spawn,maxPending=256,maxRetainedBytes=MAX_QUEUE_BYTES}){this.onFrame=onFrame;this.onState=onState;this.onIdleReset=onIdleReset;this.spawnProcess=spawnProcess;this.id=randomUUID();this.pending=new Map();this.controlReplies=new Map();this.pendingBytes=0;this.replyBytes=0;this.maxPending=maxPending;this.maxRetainedBytes=maxRetainedBytes;this.requestNo=0;this.cursor=0;this.closed=false;this.ready=false;}
  forget(id){const p=this.pending.get(id);if(p){this.pending.delete(id);this.pendingBytes-=p.bytes;clearTimeout(p.timer);}return p;}
  async connect(){
    if(this.closed)throw new Error('Adapter closed');if(this.fatalError)throw this.fatalError;if(this.ready)return;if(this.connecting)return this.connecting;
    this.connecting=this.reconnect().finally(()=>{this.connecting=null;});return this.connecting;
  }
  async reconnect(){
    const started=Date.now();let error;
    this.onState?.({state:this.epoch?'reconnecting':'connecting'});
    for(let attempt=0;attempt<4&&!this.closed;attempt++){
      try{await this.start();this.onState?.({state:'connected',recovered:!!this.wasDisconnected,ms:Date.now()-started,localPid:this.proc?.pid,remotePid:this.remotePid});this.wasDisconnected=false;return;}
      catch(e){error=e;if(e.fatal)break;if(attempt<3)await new Promise(r=>setTimeout(r,250*(attempt+1)));}
    }
    this.onState?.({state:'unavailable',message:error?.message});
    for(const [id,p] of this.pending){this.forget(id);p.reject(transportError(error?.code??'TRANSPORT_UNAVAILABLE','Transport unavailable during '+p.frame.method+'; outcome unknown, no new request was submitted. '+error?.message));}
    throw error??new Error('Transport closed');
  }
  start(){return new Promise((resolve,reject)=>{
    const env={...process.env};for(const key of Object.keys(env))if(/ANTHROPIC|CLAUDE|CODEXHOST_RUNTIME|API_KEY|TOKEN|SECRET/i.test(key))delete env[key];
    const config=getBridgeConfig();
    const proc=this.spawnProcess(config.sshExecutable,['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',config.sshHost,shellQuote(config.remoteRoot+'/start-transport')+' '+this.id],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.proc=proc;let established=false,settled=false,stderr='',reader;
    const timer=setTimeout(()=>{rejectOnce(new Error('SSH handshake timed out'));proc.kill();},18000);
    const rejectOnce=e=>{if(settled)return;settled=true;clearTimeout(timer);reject(e);};
    proc.stderr.on('data',b=>stderr=(stderr+b).slice(-1500));
    const lost=e=>{if(this.proc!==proc)return;this.ready=false;this.proc=null;this.writer?.dispose();reader?.dispose();this.wasDisconnected=true;rejectOnce(e);if(established&&!this.closed&&!this.fatalError)queueMicrotask(()=>void this.connect().catch(()=>{}));};
    proc.on('error',lost);proc.on('exit',code=>lost(new Error('SSH closed ('+code+'). '+stderr)));proc.stdin.on('error',lost);
    const writer=new JsonWriter(proc.stdin,{onError:error=>{lost(error);proc.kill();}});this.writer=writer;
    reader=readJsonLines(proc.stdout,frame=>{
      if(this.proc!==proc)return;
      try{
        if(frame.fatal){const e=Object.assign(transportError(frame.code??'REMOTE_RELAY_UNAVAILABLE',frame.fatal),{fatal:true});this.fatalError=e;rejectOnce(e);if(established){this.onState?.({state:'unavailable',message:e.message,code:e.code});for(const [id,p] of this.pending){this.forget(id);p.reject(e);}}proc.kill();return;}
        if(frame.hello){
          this.remotePid=frame.hello.pid;
          if(this.epoch&&this.epoch!==frame.hello.epoch&&![...this.pending.values()].some(p=>!['health','inspect','snapshot','usage','close','capabilities'].includes(p.frame.method))&&this.controlReplies.size===0&&this.onIdleReset?.()){
            this.epoch=frame.hello.epoch;this.cursor=0;this.onState?.({state:'idle-restoring'});
            for(const [id,p] of this.pending)if(!['health','inspect'].includes(p.frame.method)){this.forget(id);p.reject(Object.assign(new Error('Idle relay restarted; restore the native session before reading'),{code:'IDLE_RESTORE'}));}
          }
          writer.send({attach:this.id,epoch:this.epoch,cursor:this.cursor});return;
        }
        if(frame.ready){this.epoch=frame.ready.epoch;this.ready=true;established=true;clearTimeout(timer);
          // Same relay epoch deduplicates these exact RPC IDs. A replaced relay
          // refuses attachment before receiving any outstanding operation.
          for(const p of this.pending.values())this.write(p.frame);for(const reply of this.controlReplies.values())this.write(reply.frame);settled=true;resolve();return;}
        if(Number.isSafeInteger(frame.seq)&&frame.seq>this.cursor){if(frame.seq!==this.cursor+1)throw new Error('Transport event gap');this.cursor=frame.seq;const value=frame.payload;
          if(value.id&&this.pending.has(value.id)){const p=this.forget(value.id);value.error?p.reject(Object.assign(new Error(typeof value.error==='string'?value.error:value.error.message),{code:value.error.code})):p.resolve(value.value);}
          else if(value.controlAck){const reply=this.controlReplies.get(value.controlAck);if(reply){this.replyBytes-=reply.bytes;this.controlReplies.delete(value.controlAck);}}
          else this.onFrame(value);
        }
        if(frame.seq)writer.send({ack:this.cursor});
      }catch(e){rejectOnce(e);proc.kill();}
    },{onError:e=>{rejectOnce(e);proc.kill();}});
  });}
  write(frame){if(this.proc&&!this.proc.stdin.destroyed)this.writer.send(frame);}
  async rpc(method,params,timeout=120000){await this.connect();const id=randomUUID(),frame={id,requestNo:++this.requestNo,method,params},bytes=jsonFrame(frame).length;
    if(this.pending.size>=this.maxPending||this.pendingBytes+this.replyBytes+bytes>this.maxRetainedBytes)throw transportError('TRANSPORT_CAPACITY','Too many outstanding bridge operations; no operation was submitted');
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.forget(id);reject(transportError('OUTCOME_UNKNOWN','Remote '+method+' timed out; outcome unknown, no retry was sent'));},timeout);this.pending.set(id,{resolve,reject,timer,frame,bytes});this.pendingBytes+=bytes;try{this.write(frame);}catch(error){this.forget(id);reject(error);}});
  }
  async reply(frame){const previous=this.controlReplies.get(frame.controlId),bytes=jsonFrame(frame).length;
    if((!previous&&this.controlReplies.size>=this.maxPending)||this.pendingBytes+this.replyBytes-(previous?.bytes??0)+bytes>this.maxRetainedBytes)throw transportError('TRANSPORT_CAPACITY','Bridge result retention is full; result was not queued');
    this.controlReplies.set(frame.controlId,{frame,bytes});this.replyBytes+=bytes-(previous?.bytes??0);await this.connect();this.write(frame);
  }
  async close(){this.closed=true;try{this.write({shutdown:true});this.writer?.end();}catch{this.proc?.kill();}this.ready=false;for(const [id,p] of this.pending){this.forget(id);p.reject(transportError('OUTCOME_UNKNOWN','Adapter closed; pending outcome unknown'));}this.controlReplies.clear();this.replyBytes=0;}
}
