// Detached per-adapter relay. SSH is replaceable; the official Claude process,
// accepted RPC IDs and unacknowledged events survive an SSH disconnect.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {JsonWriter,readJsonLines} from './transport-streams.mjs';
import {RelayLedger} from './relay-ledger.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),id=process.argv.at(-1);
if(!/^[a-f0-9-]{36}$/.test(id??''))throw new Error('Invalid transport identity');
const directory=path.join(here,'run'),socketPath=path.join(directory,id+'.sock');
await fs.mkdir(directory,{recursive:true,mode:0o700});
const connect=()=>new Promise((resolve,reject)=>{const s=net.createConnection(socketPath);s.once('error',reject);s.once('connect',()=>{s.removeListener('error',reject);resolve(s);});});
const lockFile=socketPath+'.owner.lock';
const lockArgs=[path.join(here,'relay-lock.py'),lockFile,process.execPath,fileURLToPath(import.meta.url),id];
// Keep the old internal entry point usable during a rolling upgrade. New
// launchers start Python directly, so the steady-state relay has no extra parent.
if(process.argv[2]==='--serve'){
  const child=spawn('python3',lockArgs,{stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});process.exit(code);
}
if(process.argv[2]!=='--locked-serve'){
  let socket;try{socket=await connect();}catch(error){
    if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;
    const log=await fs.open(path.join(directory,id+'.log'),'a',0o600);
    // Only this adapter's relay diagnostics; never touch native history/state.
    if((await log.stat()).size>64*1024)await log.truncate(0);
    const child=spawn('python3',lockArgs,{detached:true,stdio:['ignore',log.fd,log.fd]});
    let launchError;child.once('error',error=>{launchError=error;});child.unref();await log.close();
    for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,100));if(launchError)throw new Error('Remote relay launcher failed: '+launchError.message);try{socket=await connect();break;}catch{}}
    if(!socket)throw new Error('Remote relay failed to start');
  }
  socket.on('error',e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});socket.on('close',()=>process.exit(process.exitCode??0));
  process.stdin.pipe(socket);socket.pipe(process.stdout);process.stdout.on('error',()=>socket.destroy());
}else{
  // The launcher publishes lock ownership in one kernel operation. A crash
  // releases it even if startup never wrote a PID; competing starters cannot
  // delete a new owner's lock. Native children must not inherit this descriptor.
  const lockFd=Number(process.env.CLAUDE_VPS_RELAY_LOCK_FD);
  if(!Number.isSafeInteger(lockFd)||lockFd<3)throw new Error('Relay must be started through its lock launcher');
  const held=await fs.stat('/proc/self/fd/'+lockFd),named=await fs.stat(lockFile);
  if(!held.isFile()||held.dev!==named.dev||held.ino!==named.ino)throw new Error('Relay lock descriptor does not match this transport');
  delete process.env.CLAUDE_VPS_RELAY_LOCK_FD;
  await fs.unlink(socketPath).catch(error=>{if(error.code!=='ENOENT')throw error;});
  const epoch=randomUUID(),accepted=new RelayLedger(),writers=new WeakMap(),sockets=new Set();let client=null,seq=0,acked=0,bytes=0,overflow=false,offlineSince=Date.now(),stopping=false;
  let journal=[];
  const worker=spawn(process.execPath,[path.join(here,'remote-server.mjs')],{stdio:['pipe','pipe','pipe']});
  let stderrTail='';worker.stderr.on('data',chunk=>{stderrTail=(stderrTail+chunk.toString()).slice(-8192);});
  const workerWriter=new JsonWriter(worker.stdin,{onError:()=>void stop()});
  const write=(s,value)=>{if(s&&!s.destroyed)try{writers.get(s).send(value);}catch{s.destroy();}};
  const output=value=>{const frame={seq:++seq,payload:value},size=Buffer.byteLength(JSON.stringify(frame));journal.push({frame,size});bytes+=size;
    while((bytes>32*1024*1024||journal.length>16384)&&journal.length){bytes-=journal.shift().size;overflow=true;}
    if(value.id)accepted.responded(value.id,seq);write(client,frame);
  };
  const workerReader=readJsonLines(worker.stdout,output,{onError:()=>void stop()});
  worker.stdin.on('error',()=>void stop());worker.on('error',()=>void stop());
  worker.on('exit',code=>{if(code&&!stopping)process.stderr.write('Remote worker exited ('+code+'). '+stderrTail+'\n');stderrTail='';void stop();});
  const server=net.createServer(socket=>{
    if(sockets.size>=8){socket.destroy();return;}
    let attached=false;socket.on('error',()=>{});sockets.add(socket);
    const writer=new JsonWriter(socket,{onError:()=>socket.destroy()});writers.set(socket,writer);
    socket.setTimeout(15000,()=>socket.destroy());
    write(socket,{hello:{epoch,pid:process.pid}});
    const reader=readJsonLines(socket,frame=>{
      if(!attached){
        if(frame.attach!==id||(frame.epoch&&frame.epoch!==epoch)){write(socket,{code:'REMOTE_RELAY_REPLACED',fatal:'REMOTE_RELAY_REPLACED: pending outcomes are unknown; no request was replayed'});writer.end();return;}
        if(!Number.isSafeInteger(frame.cursor)||frame.cursor<0||frame.cursor>seq||(overflow&&frame.cursor<(journal[0]?.frame.seq??seq+1)-1)){write(socket,{code:'REPLAY_GAP',fatal:'REPLAY_GAP: restore native history; no request was replayed'});writer.end();return;}
        if(client&&client!==socket)client.destroy();client=socket;attached=true;offlineSince=null;socket.setTimeout(0);
        for(const entry of journal)if(entry.frame.seq>frame.cursor)write(socket,entry.frame);
        write(socket,{ready:{epoch}});return;
      }
      if(socket!==client)return;
      if(frame.ack!==undefined){if(Number.isSafeInteger(frame.ack)&&frame.ack>acked&&frame.ack<=seq){acked=frame.ack;while(journal.length&&journal[0].frame.seq<=acked)bytes-=journal.shift().size;accepted.acknowledge(acked);}return;}
      if(frame.shutdown){void stop();return;}
      if(frame.id){const decision=accepted.accept(frame);if(decision==='duplicate')return;if(decision!=='accepted'){output({id:frame.id,error:{code:decision,message:'Relay refused this request before execution: '+decision}});return;}}
      try{workerWriter.send(frame);}catch(error){if(frame.id)output({id:frame.id,error:{code:error.code??'TRANSPORT_BACKPRESSURE',message:error.message}});else void stop();}
    },{onError:()=>socket.destroy()});
    socket.on('close',()=>{reader.dispose();writer.dispose();sockets.delete(socket);if(client===socket){client=null;offlineSince=Date.now();}});
  });
  async function stop(){if(stopping)return;stopping=true;clearInterval(idle);for(const socket of sockets){writers.get(socket)?.dispose();socket.destroy();}server.close();workerReader.dispose();workerWriter.end();const timer=setTimeout(()=>worker.kill(),5000);timer.unref();await fs.unlink(socketPath).catch(()=>{});setTimeout(()=>process.exit(0),5500).unref();}
  const idle=setInterval(()=>{if(offlineSince&&Date.now()-offlineSince>15*60*1000)void stop();},30000);idle.unref();
  process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
  server.on('error',()=>void stop());await new Promise(resolve=>server.listen(socketPath,resolve));await fs.chmod(socketPath,0o600);
}
