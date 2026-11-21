import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {getBridgeConfig,shellQuote} from './bridge-config.mjs';
import {SshRoutes,routeFailureReason,classifySshFailure} from './ssh-routes.mjs';
import {BRIDGE_PROTOCOL} from '../bridge-protocol.mjs';
import {deliveryError} from './delivery-outcome.mjs';
import {FlowReceiver,FlowSender,flowLimits,JsonWriter,readJsonLines,jsonFrame,transportError,MAX_QUEUE_BYTES} from '../transport-streams.mjs';

const RECOVERABLE_READS=new Set(['inspect','snapshot']);
const SAFE_DURING_READ_RECOVERY=new Set(['inspect','snapshot','health','background-status','capabilities','account','usage']);
const unknownIngress=()=>({kind:'unknown',process:null});
const fatal=(code,message)=>Object.assign(deliveryError(code,message,'unknown'),{fatal:true});

export class SshTransport{
  constructor({onFrame,onState,onIdleReset,canRecoverRead=()=>true,slowReadMs=30000,recoveryProbeMs=8000,
    handshakeMs=18000,spawnProcess=spawn,maxPending=256,maxRetainedBytes=MAX_QUEUE_BYTES}){
    Object.assign(this,{onFrame,onState,onIdleReset,canRecoverRead,slowReadMs,recoveryProbeMs,handshakeMs,
      spawnProcess,maxPending,maxRetainedBytes});
    this.id=randomUUID();this.pending=new Map();this.controlReplies=new Map();this.abandoned=new Set();
    this.pendingBytes=0;this.replyBytes=0;this.requestNo=0;this.cursor=0;this.closed=false;this.ready=false;
  }
  state(state,extra={}){
    if(this.observedState!==state){this.observedState=state;this.stateSince=new Date().toISOString();}
    if(state!=='connected')this.stopHeartbeat();
    this.onState?.({state,route:this.routes?.current.name,routeType:this.routes?.current.proxy?.type??'direct',lastSwitchReason:this.routes?.lastSwitchReason,lastSwitchDetail:this.routes?.lastSwitchDetail,lastSwitchAt:this.routes?.lastSwitchAt,
      since:this.stateSince,lastSwitchFrom:this.routes?.lastSwitchFrom,lastSwitchTo:this.routes?.lastSwitchTo,
      ...(state==='connected'?{ingress:this.ingress,relayId:this.id,relayEpoch:this.epoch}:{}),...extra});
  }
  stopHeartbeat(){clearInterval(this.heartbeat);this.heartbeat=null;}
  startHeartbeat(){
    this.stopHeartbeat();
    this.heartbeat=setInterval(()=>{
      if(this.ready&&!this.closed&&!this.proc?.killed)this.state('connected',{heartbeat:true});
    },30000);
    this.heartbeat.unref();
  }
  forget(id){
    const p=this.pending.get(id);
    if(p){
      this.pending.delete(id);this.pendingBytes-=p.bytes;clearTimeout(p.timer);clearTimeout(p.recoveryTimer);
      p.signal?.removeEventListener('abort',p.abort);
    }
    return p;
  }
  abandon(id,message){
    const p=this.forget(id);if(!p)return;
    this.abandoned.add(id);
    p.reject(deliveryError('OUTCOME_UNKNOWN',message,'unknown'));
    if(this.protocol===BRIDGE_PROTOCOL){
      // A cancellation must follow admission of its own request, even when
      // the upload has not completed yet. Other responses may be discarded.
      try{this.out.enqueue({cancelRequest:id},{lane:this.out.has(id)?'requests':undefined,terminal:true});}
      catch(error){this.fail(fatal(error.code,'Cannot retain the cancellation; pending outcomes are unknown'));this.proc?.kill();}
    }
  }
  fail(error){
    this.fatalError=error;this.ready=false;this.state('unavailable',{code:error.code,message:error.message});
    for(const id of this.pending.keys())this.forget(id).reject(error);
    this.releaseFlow();
  }
  releaseFlow(){
    this.out?.detach();this.out=null;this.input=null;
    this.abandoned.clear();this.controlReplies.clear();this.replyBytes=0;
  }
  async connect(){
    if(this.closed)throw new Error('Adapter closed');
    if(this.fatalError)throw this.fatalError;
    if(this.ready)return;
    if(!this.connecting)this.connecting=this.reconnect().finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async reconnect(){
    const config=getBridgeConfig(),started=Date.now();
    this.routes??=new SshRoutes(config);
    const attempts=this.routes.length===1?4:this.routes.length;
    this.state(this.epoch?'reconnecting':'connecting');
    let error;
    for(let attempt=0;attempt<attempts&&!this.closed;attempt++){
      try{
        await this.start(config);
        this.state('connected',{recovered:!!this.wasDisconnected,ms:Date.now()-started,localPid:this.proc?.pid,remotePid:this.remotePid});
        this.startHeartbeat();
        this.wasDisconnected=false;return;
      }catch(e){
        error=e;if(e.fatal||this.closed)break;
        if(this.routes.length>1){
          const probing=[...this.pending.values()].filter(p=>p.probed.size);
          for(const p of probing)p.probed.add(this.routes.current.name);
          if(probing.some(p=>p.probed.size===this.routes.length))break;
        }
        if(attempt+1<attempts){
          this.routes.advance(routeFailureReason(e),e.sshFailure);
          await new Promise(r=>setTimeout(r,250*(attempt+1)));
        }
      }
    }
    error??=new Error('Transport closed');
    if(!this.closed&&!this.fatalError){
      if(error.fatal)this.fail(error);
      else{
        for(const id of this.pending.keys())this.abandon(id,'Transport unavailable; operation outcome unknown');
        this.state('unavailable',{message:error.message});
      }
    }
    throw error;
  }
  resetFlow(limits){this.out=new FlowSender(limits);this.input=new FlowReceiver(limits);}
  start(config){return new Promise((resolve,reject)=>{
    const env={...process.env};
    for(const key of Object.keys(env))if(/ANTHROPIC|CLAUDE|CODEXHOST_RUNTIME|API_KEY|TOKEN|SECRET/i.test(key))delete env[key];
    const args=this.routes.args(shellQuote(config.remoteRoot+'/start-transport')+' '+this.id,{connectTimeout:10,keepAlive:true});
    const proc=this.spawnProcess(config.sshExecutable,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.proc=proc;this.ingress=unknownIngress();
    let established=false,settled=false,reader,peerProtocol,peerEpoch;
    // Bounded stderr tail, kept in memory only for classifying a failed attempt.
    let stderrTail='';
    const rejectOnce=e=>{if(!settled){settled=true;clearTimeout(timer);if(e&&typeof e==='object'&&e.sshFailure===undefined)e.sshFailure=classifySshFailure(stderrTail);reject(e);}};
    const timer=setTimeout(()=>{rejectOnce(transportError('HANDSHAKE_TIMEOUT','SSH handshake timed out'));proc.kill();},this.handshakeMs);
    proc.stderr.on('data',chunk=>{stderrTail=(stderrTail+chunk).slice(-4096);}); // Classified only; never stored or reported.
    const lost=error=>{
      if(this.proc!==proc)return;
      this.ready=false;this.proc=null;this.out?.detach();writer.dispose();reader?.dispose();this.wasDisconnected=true;
      this.stopHeartbeat();
      rejectOnce(error);
      this.drained?.();
      if(this.exhaustedProcess===proc){
        this.exhaustedProcess=null;this.stallProcess=null;this.routes=null;
      }else if(established&&!this.closed&&!this.fatalError){
        this.routes.advance(this.stallProcess===proc?'read-stalled':'connection-failed');
        this.stallProcess=null;
        setImmediate(()=>void this.connect().catch(()=>{}));
      }
    };
    const writer=new JsonWriter(proc.stdin,{onError:error=>{lost(error);proc.kill();}});this.writer=writer;
    proc.on('error',lost);proc.on('exit',code=>lost(new Error('SSH connection closed ('+code+')')));proc.stdin.on('error',lost);
    const rejectConnection=e=>{
      if(e.fatal&&established)this.fail(e);
      rejectOnce(e);proc.kill();
    };
    reader=readJsonLines(proc.stdout,frame=>{
      if(this.proc!==proc||(this.closed&&!this.ready))return;
      try{
        if(frame.fatal)throw fatal(frame.code??'REMOTE_RELAY_UNAVAILABLE',frame.fatal);
        if(frame.ingress&&!established&&!peerEpoch){
          const {kind,process:name}=frame.ingress;
          if(['direct','local-proxy','unknown'].includes(kind))
            this.ingress={kind,process:kind==='local-proxy'&&typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_+-]{0,63}$/.test(name)?name:null};
          return;
        }
        if(frame.hello){
          if(peerEpoch)throw fatal('INVALID_FRAME','Duplicate relay greeting');
          peerProtocol=frame.hello.protocol??2;peerEpoch=frame.hello.epoch;this.remotePid=frame.hello.pid;
          if(!peerEpoch||![2,BRIDGE_PROTOCOL].includes(peerProtocol))throw fatal('BRIDGE_PROTOCOL_INCOMPATIBLE','Unsupported relay protocol');
          if(this.epoch&&this.epoch!==peerEpoch){
            if(this.pending.size||this.abandoned.size||this.controlReplies.size||this.input?.buffered||
              !this.canRecoverRead()||!this.onIdleReset?.())
              throw fatal('REMOTE_RELAY_REPLACED','Relay changed; outstanding outcomes are unknown. No request was replayed.');
            this.cursor=0;this.out=null;this.input=null;this.protocol=null;this.state('idle-restoring');
          }
          if(this.protocol&&this.protocol!==peerProtocol)throw fatal('BRIDGE_PROTOCOL_INCOMPATIBLE','Protocol changed within the same relay epoch');
          const attach={attach:this.id,epoch:peerEpoch,cursor:this.cursor};
          if(peerProtocol===BRIDGE_PROTOCOL){
            const limits=flowLimits({chunkBytes:config.transportChunkBytes,windowBytes:config.transportWindowBytes});
            if(!this.out)this.resetFlow(limits);
            Object.assign(attach,{protocol:BRIDGE_PROTOCOL,limits});
          }
          writer.send(attach);return;
        }
        if(frame.ready){
          if(established||!peerEpoch||frame.ready.epoch!==peerEpoch)throw fatal('INVALID_FRAME','Unexpected relay attachment');
          if(peerProtocol===BRIDGE_PROTOCOL){
            if(frame.ready.protocol!==BRIDGE_PROTOCOL)throw fatal('BRIDGE_PROTOCOL_INCOMPATIBLE','Relay did not confirm the negotiated protocol');
            this.out.attach(frame.ready.cursor,buffer=>{
              try{writer.sendBuffer(buffer);}catch(error){lost(error);proc.kill();}
            });
            if(this.proc!==proc)return;
          }
          this.protocol=peerProtocol;this.epoch=peerEpoch;this.ready=true;established=true;clearTimeout(timer);
          if(peerProtocol===2){
            // A pre-upgrade relay completes its own journal in its native wire
            // format. The health gate controls admission of new model turns.
            for(const p of this.pending.values())writer.send(p.frame);
            for(const reply of this.controlReplies.values()){reply.sent=true;writer.send(reply.frame);}
          }
          for(const p of this.pending.values())this.armProbe(p);
          settled=true;resolve();return;
        }
        if(peerProtocol===BRIDGE_PROTOCOL){
          if(!established)throw fatal('INVALID_FRAME','Data before relay attachment');
          if(frame.ack!==undefined)this.out.acknowledge(frame.ack);
          else{
            this.input.accept(frame,value=>this.deliver(value),id=>{
              const p=this.pending.get(id);
              if(!p)return;
              if(p.idleDeadline){clearTimeout(p.timer);p.timer=setTimeout(p.expire,p.timeout);}
              if(p.recoveryTimer)this.armProbe(p);
            });
            this.cursor=this.input.cursor;writer.send({ack:this.cursor});
            if(!this.abandoned.size&&!this.controlReplies.size)this.drained?.();
          }
        }else if(peerProtocol===2&&Number.isSafeInteger(frame.seq)){
          if(frame.seq>this.cursor){
            if(frame.seq!==this.cursor+1)throw fatal('REPLAY_GAP','Missing legacy transport event');
            this.deliver(frame.payload);this.cursor=frame.seq;
          }
          writer.send({ack:this.cursor});
        }else throw fatal('INVALID_FRAME','Unexpected bridge message');
      }catch(error){rejectConnection(error.fatal?error:fatal(error.code??'INVALID_FRAME',error.message));}
    },{onError:e=>rejectConnection(['INVALID_FRAME','FRAME_TOO_LARGE'].includes(e.code)?fatal(e.code,e.message):e)});
  });}
  deliver(value){
    if(value.id){
      this.abandoned.delete(value.id);
      const p=this.forget(value.id);if(!p)return;
      if(value.error)p.reject(deliveryError(value.error.code,typeof value.error==='string'?value.error:value.error.message,value.error.delivery));
      else if(p.frame.method==='health'&&value.value?.protocol){
        p.resolve({...value.value,protocol:this.protocol===2?2:value.value.protocol,ingress:this.ingress});
      }else p.resolve(value.value);
    }else if(value.controlAck){
      const reply=this.controlReplies.get(value.controlAck);
      if(reply){this.replyBytes-=reply.bytes;this.controlReplies.delete(value.controlAck);}
    }else if(this.closed&&value.controlId){
      this.write({controlId:value.controlId,error:'Adapter closed before local execution'});
    }else if(!this.closed)this.onFrame?.(value);
  }
  write(frame){
    if(this.protocol===BRIDGE_PROTOCOL)this.out.enqueue(frame,{key:frame.id,lane:frame.id?'requests':undefined});
    else if(this.ready)this.writer.send(frame);
  }
  armProbe(p){
    if(!RECOVERABLE_READS.has(p.frame.method)||p.timeout<=this.slowReadMs+this.recoveryProbeMs||
      p.probed.has(this.routes.current.name))return;
    clearTimeout(p.recoveryTimer);
    const proc=this.proc;
    p.recoveryTimer=setTimeout(()=>void this.recoverSlowRead(p.frame.id,proc).catch(()=>{}),this.slowReadMs);
  }
  async recoverSlowRead(id,proc){
    const safe=()=>!this.closed&&this.ready&&this.proc===proc&&!proc.killed&&this.pending.has(id)&&
      !this.controlReplies.size&&this.canRecoverRead()&&[...this.pending.values()].every(p=>SAFE_DURING_READ_RECOVERY.has(p.frame.method));
    if(this.readProbeProcess===proc||!safe())return;
    const pending=this.pending.get(id),startCursor=this.cursor;
    this.readProbeProcess=proc;
    let repeat=this.protocol===BRIDGE_PROTOCOL;
    try{await this.rpc('health',{},this.recoveryProbeMs);}
    catch(error){
      if(error.code==='OUTCOME_UNKNOWN'&&safe()&&this.cursor===startCursor){
        repeat=false;pending.probed.add(this.routes.current.name);
        if(this.routes.length>1&&pending.probed.size===this.routes.length){
          this.exhaustedProcess=proc;
          for(const requestId of this.pending.keys())this.abandon(requestId,'All configured SSH routes stalled; operation outcome unknown');
          this.state('unavailable',{code:'TRANSPORT_UNAVAILABLE',message:'All configured SSH routes stalled'});
        }
        this.stallProcess=proc;proc.kill();
      }
    }finally{
      if(this.readProbeProcess===proc)this.readProbeProcess=null;
      if(repeat&&safe())this.armProbe(pending);
    }
  }
  async rpc(method,params,timeout,signal){
    const idleDeadline=timeout===undefined&&RECOVERABLE_READS.has(method);
    timeout??=120000;
    let stopWaiting;
    try{
      signal?.throwIfAborted();
      const connecting=this.connect();
      if(signal){
        const cancelled=new Promise((_,reject)=>{stopWaiting=()=>reject(new Error('Caller abandoned the connection wait'));signal.addEventListener('abort',stopWaiting,{once:true});});
        await Promise.race([connecting,cancelled]);signal.throwIfAborted();
      }else await connecting;
      if(this.closed||this.fatalError)throw this.fatalError??new Error('Adapter closed');
    }catch(error){throw deliveryError(error.code??'TRANSPORT_UNAVAILABLE',error.message,'not-sent');}
    finally{if(stopWaiting)signal.removeEventListener('abort',stopWaiting);}
    const id=randomUUID(),frame={id,requestNo:++this.requestNo,method,params};
    let bytes;
    try{bytes=jsonFrame(frame).length;}
    catch(error){throw deliveryError(error.code??'INVALID_FRAME',error.message,'not-sent');}
    if(this.pending.size+this.abandoned.size>=this.maxPending||this.pendingBytes+this.replyBytes+bytes>this.maxRetainedBytes)
      throw deliveryError('TRANSPORT_CAPACITY','Too many outstanding bridge operations; no operation was submitted','not-sent');
    return new Promise((resolve,reject)=>{
      const abort=()=>this.abandon(id,'Remote '+method+' was abandoned; operation outcome unknown');
      const expire=()=>this.abandon(id,'Remote '+method+' timed out; outcome unknown, no retry was sent');
      const p={resolve,reject,timer:setTimeout(expire,timeout),expire,frame,bytes,timeout,idleDeadline,abort,signal,probed:new Set()};
      this.pending.set(id,p);this.pendingBytes+=bytes;signal?.addEventListener('abort',abort,{once:true});
      this.armProbe(p);
      try{this.write(frame);}catch(error){
        this.forget(id);
        reject(deliveryError(error.code,error.message,['TRANSPORT_CAPACITY','TRANSPORT_BACKPRESSURE','FRAME_TOO_LARGE','TRANSPORT_CLOSED'].includes(error.code)?'not-sent':'unknown'));
      }
    });
  }
  async reply(frame){
    const id=frame.controlId,existing=this.controlReplies.get(id);
    if(existing?.sent)return;
    const bytes=jsonFrame(frame).length;
    if((!existing&&this.controlReplies.size>=this.maxPending)||this.pendingBytes+this.replyBytes-(existing?.bytes??0)+bytes>this.maxRetainedBytes)
      throw transportError('TRANSPORT_CAPACITY','Bridge result retention is full; result was not queued');
    const reply={frame,bytes,sent:false};
    this.controlReplies.set(id,reply);this.replyBytes+=bytes-(existing?.bytes??0);
    await this.connect();
    if(!reply.sent&&this.controlReplies.get(id)===reply){this.write(frame);reply.sent=true;}
  }
  close(){return this.closing??=this.finishClose();}
  async finishClose(){
    this.closed=true;
    for(const id of this.pending.keys())this.abandon(id,'Adapter closed; pending outcome unknown');
    try{
      if(this.ready){
        const outstanding=this.abandoned.size||this.controlReplies.size;
        if(outstanding&&this.protocol===BRIDGE_PROTOCOL){
          // Give credited cancellations and the final ACK a chance to drain.
          // If the path is gone the detached relay still owns accepted writes.
          let timer;
          await new Promise(resolve=>{this.drained=resolve;timer=setTimeout(resolve,10000);});
          clearTimeout(timer);this.drained=null;
        }
        if(!outstanding&&this.ready)this.writer.send({shutdown:true});
        this.writer.end();
      }else this.proc?.kill();
    }catch{this.proc?.kill();}
    this.ready=false;this.releaseFlow();this.state('closed');
  }
}
