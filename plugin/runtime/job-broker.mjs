// Windows SSH sessions can terminate their descendant processes when they end.
// This small local broker is launched by the desktop plugin, outside SSH. It
// only starts validated, persisted workspace jobs; it is not a second agent.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const protocol=2,build='durable-launch-v2';
const descriptor=path.join(here,'runtime-context','job-broker-v2.json');
const pipe='\\\\.\\pipe\\codexhost-windows-jobs-v2-'+createHash('sha256').update(os.homedir().toLowerCase()+here.toLowerCase()).digest('hex').slice(0,20);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function brokerRequest(action,more={}){
  const config=JSON.parse(await fs.readFile(descriptor,'utf8'));
  if(config.pipe!==pipe||config.protocol!==protocol||config.build!==build)throw new Error('Unexpected local job broker identity or protocol; reopen the updated plugin');
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(pipe);let buffer='';
    const timer=setTimeout(()=>socket.destroy(new Error('Local job broker timed out; no replay was submitted')),8000);
    socket.once('connect',()=>socket.write(JSON.stringify({token:config.token,action,...more})+'\n'));
    socket.on('data',data=>{buffer+=data;if(buffer.length>65536){socket.destroy(new Error('Invalid broker reply'));return;}if(buffer.includes('\n')){try{const reply=JSON.parse(buffer.split('\n')[0]);clearTimeout(timer);socket.end();if(reply.ok)resolve(reply);else reject(new Error(reply.error));}catch(e){socket.destroy(e);}}});
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
    socket.once('end',()=>{clearTimeout(timer);if(!buffer.includes('\n'))reject(new Error('Local job broker closed without a result'));});
  });
}
function cleanEnv(){const env={...process.env};for(const key of Object.keys(env))if(/TOKEN|SECRET|API_KEY|ANTHROPIC|CLAUDE|CODEXHOST_RUNTIME/i.test(key))delete env[key];return env;}
let starting;
export async function ensureBroker(){
  if(!starting)starting=startBroker().finally(()=>{starting=null;});
  return starting;
}
async function startBroker(){
  try{return await brokerRequest('ping');}catch{}
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve'],{cwd:here,windowsHide:true,detached:true,stdio:'ignore',env:cleanEnv()});child.unref();
  let last;
  for(let i=0;i<40;i++){await sleep(200);try{return await brokerRequest('ping');}catch(e){last=e;}}
  throw new Error('The local persistent task runner could not start: '+last?.message);
}
async function serve(){
  const token=randomBytes(32).toString('hex'),jobs=new Set();let lastActivity=Date.now();
  const server=net.createServer(socket=>{
    let buffer='';socket.on('error',()=>{});socket.setTimeout(10000,()=>socket.destroy());
    socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>65536){socket.destroy();return;}if(!buffer.includes('\n'))return;socket.removeAllListeners('data');void (async()=>{
      const request=JSON.parse(buffer.split('\n')[0]),candidate=Buffer.from(String(request.token??''));
      if(candidate.length!==64||!timingSafeEqual(candidate,Buffer.from(token)))throw new Error('Local runner authentication failed');
      lastActivity=Date.now();
      if(request.action==='ping')return {pid:process.pid,protocol,build};
      if(request.action!=='start')throw new Error('Unsupported local runner request');
      const directory=await fs.realpath(request.directory),root=await fs.realpath(path.join(here,'state','jobs')),relative=path.relative(root,directory);
      if(!/^[a-f0-9]{64}[\\/][a-zA-Z0-9_-]{1,100}$/.test(relative))throw new Error('Invalid persisted job directory');
      const spec=JSON.parse(await fs.readFile(path.join(directory,'request.json'),'utf8'));
      if(path.basename(directory)!==spec.requestId||path.basename(path.dirname(directory))!==spec.project.projectId)throw new Error('Persisted job identity mismatch');
      if(jobs.has(directory))return {alreadyAccepted:true};
      const status=JSON.parse(await fs.readFile(path.join(directory,'status.json'),'utf8'));if(status.status!=='starting')throw new Error('Job is already started; query its original result');
      if(jobs.size>=64)throw new Error('Local runner capacity reached; no new process was started');
      // Survives broker restarts, including the interval before a child writes
      // running status. An uncertain launch must never be silently replayed.
      const claim=path.join(directory,'launch.json');
      try{await fs.writeFile(claim,JSON.stringify({brokerPid:process.pid,acceptedAt:new Date().toISOString()}),{flag:'wx'});}catch(error){if(error.code==='EEXIST')throw new Error('Job launch was already accepted; inspect its original status instead of restarting');throw error;}
      jobs.add(directory);
      const worker=spawn(process.execPath,[path.join(here,'workspace-runtime.mjs'),'--job',directory],{cwd:spec.project.cwd,windowsHide:true,detached:true,stdio:'ignore',env:cleanEnv()});
      worker.once('exit',()=>jobs.delete(directory));
      try{await new Promise((resolve,reject)=>{worker.once('spawn',resolve);worker.once('error',reject);});}catch(error){jobs.delete(directory);await fs.unlink(claim);throw error;}
      worker.unref();return {accepted:true};
    })().then(value=>socket.end(JSON.stringify({ok:true,...value})+'\n'),error=>socket.end(JSON.stringify({ok:false,error:error.message})+'\n'));});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
  await fs.mkdir(path.dirname(descriptor),{recursive:true});
  const temp=descriptor+'.'+process.pid+'.tmp';await fs.writeFile(temp,JSON.stringify({pipe,token,pid:process.pid,protocol,build}));await fs.rename(temp,descriptor);
  const idle=setInterval(()=>{if(jobs.size===0&&Date.now()-lastActivity>15*60*1000){clearInterval(idle);server.close();}},30000);idle.unref();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='--serve')await serve();else console.log(JSON.stringify(await ensureBroker()));
}
