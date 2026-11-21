// Cooperative project writers. Unknown owners are never silently evicted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const projectIdPattern=/^[a-f0-9]{64}$/;
const requestIdPattern=/^[a-zA-Z0-9_-]{1,100}$/;
function directory(root,id){if(!projectIdPattern.test(id))throw new Error('Invalid project identity');return path.join(root,'writers',id);}
const readRecord=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}};
export function processPresence(pid){
  if(!Number.isInteger(pid)||pid<1||pid>0x7fffffff)return 'unconfirmed';
  try{process.kill(pid,0);return 'alive';}catch(error){return error.code==='ESRCH'?'missing':'unconfirmed';}
}
export async function writerStatus(root,id){
  const dir=directory(root,id);
  try{return {...JSON.parse(await fs.readFile(path.join(dir,'owner.json'),'utf8')),locked:true};}
  catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;return await fs.stat(dir).then(()=>({locked:true,status:'owner-unknown'}),e=>{if(e.code==='ENOENT')return {locked:false};throw e;});}
}
export async function releaseWriter(root,id,token){
  const dir=directory(root,id),owner=await writerStatus(root,id);
  if(!owner.locked)return;
  if(owner.token!==token)throw new Error('Writer ownership changed; lock was not released');
  await fs.unlink(path.join(dir,'owner.json'));await fs.rmdir(dir);
}
const recoveryDirectory=job=>path.join(job,'writer-recovered');
export async function writerRecovery(job){
  const dir=recoveryDirectory(job),owner=await readRecord(path.join(dir,'owner.json'));
  if(owner?.kind!=='job'||!owner.token||!owner.runnerToken||owner.requestId!==path.basename(job)||owner.projectId!==path.basename(path.dirname(job)))return null;
  const stat=await fs.stat(dir).catch(()=>null);
  return stat?{requestId:owner.requestId,at:stat.ctime.toISOString()}:null;
}
export async function reclaimJobWriter(root,scope,owner,{projectId=owner.projectId??scope,requestId=owner.requestId}={}){
  const retained=reason=>({status:'retained',reason});
  if(owner.status==='owner-unknown')return retained('The current writer owner is unconfirmed');
  if(owner.kind!=='job'||owner.requestId!==requestId||(owner.projectId!==undefined&&owner.projectId!==projectId))return {status:'not-held',reason:'This job does not own the current writer'};
  if(!projectIdPattern.test(projectId??'')||!requestIdPattern.test(requestId??'')||!owner.token)return retained('Writer identity is unconfirmed');
  const runner=processPresence(owner.pid);
  if(runner!=='missing')return retained(runner==='alive'?'The runner PID is still present':'Runner exit is unconfirmed');

  // Read the launch record after ESRCH. A snapshot from before the probe could
  // miss a launch that the runner authorized just before it died.
  const job=path.join(root,'jobs',projectId,requestId);
  const [spec,status]=await Promise.all([readRecord(path.join(job,'request.json')),readRecord(path.join(job,'status.json'))]);
  if(spec?.project?.projectId!==projectId||spec.requestId!==requestId||status?.requestId!==requestId||status.runnerPid!==owner.pid||
    !['running','queued','interrupted'].includes(status.status))return retained('No matching interrupted job record could be confirmed');
  if(Object.hasOwn(status,'childPid')){
    const child=processPresence(status.childPid);
    if(child!=='missing')return retained(child==='alive'?'The child PID is still present':'Child exit is unconfirmed');
  }
  if(!owner.runnerToken||owner.runnerToken!==status.runnerToken||owner.projectId!==projectId||status.writerScope!==scope||
    status.childLaunch!=='not-started'||Object.hasOwn(status,'childPid'))return retained('The job has no proof that its child process tree never started');

  const current=await writerStatus(root,scope).catch(()=>null);
  if(current?.kind!=='job'||current.token!==owner.token)return retained('Writer ownership changed before reclamation');
  try{
    // The nonempty destination stays with the job. If another process wins,
    // a late rename cannot overwrite it or move a new writer into its place.
    await fs.rename(directory(root,scope),recoveryDirectory(job));
    return {status:'released'};
  }catch{
    const released=await readRecord(path.join(recoveryDirectory(job),'owner.json'));
    if(released?.token===owner.token)return {status:'already-released'};
    return retained('Writer reclamation could not be confirmed');
  }
}
export async function acquireWriter(root,id,{kind='operation',requestId,job,waitMs=10000,isCancelled=()=>false,onWait=()=>{}}={}){
  const dir=directory(root,id),deadline=Date.now()+waitMs;await fs.mkdir(path.dirname(dir),{recursive:true});
  for(;;){
    if(await isCancelled())throw Object.assign(new Error('Cancelled while waiting for the project writer'),{code:'CANCELLED'});
    try{await fs.mkdir(dir);break;}catch(e){if(e.code!=='EEXIST')throw e;}
    const owner=await writerStatus(root,id);
    if(owner.kind==='job'&&owner.runnerToken){
      const recovery=await reclaimJobWriter(root,id,owner);
      if(['released','already-released'].includes(recovery.status))continue;
    }
    await onWait(owner);
    if(Date.now()>=deadline)throw Object.assign(new Error('Another managed task owns this project. Query its original task or use an isolated worktree; no write ran.'),{code:'PROJECT_WRITE_BUSY',owner});
    await sleep(Math.min(100,Math.max(1,deadline-Date.now())));
  }
  const owner={token:randomUUID(),pid:process.pid,kind,requestId,createdAt:new Date().toISOString(),...(kind==='job'&&job?{projectId:job.projectId,runnerToken:job.runnerToken}:{})};
  try{await fs.writeFile(path.join(dir,'owner.json'),JSON.stringify(owner),{flag:'wx'});}catch(e){await fs.rmdir(dir).catch(()=>{});throw e;}
  return {...owner,release:()=>releaseWriter(root,id,owner.token)};
}
export async function withWriter(root,id,options,fn){const lease=await acquireWriter(root,id,options);try{return await fn();}finally{await lease.release();}}
export async function withWriters(root,ids,options,fn){
 const leases=[];
 try{for(const id of [...new Set(ids)].sort())leases.push(await acquireWriter(root,id,options));return await fn();}
 finally{const results=await Promise.allSettled(leases.reverse().map(lease=>lease.release()));const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'One or more project writer releases could not be confirmed');}
}
