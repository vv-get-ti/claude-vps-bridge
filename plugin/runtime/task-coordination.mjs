// Cooperative project writers. Unknown owners are never silently evicted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function directory(root,id){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid project identity');return path.join(root,'writers',id);}
export async function writerStatus(root,id){
  const dir=directory(root,id);
  try{return {...JSON.parse(await fs.readFile(path.join(dir,'owner.json'),'utf8')),locked:true};}
  catch(e){if(e.code!=='ENOENT')throw e;return await fs.stat(dir).then(()=>({locked:true,status:'owner-unknown'}),e=>{if(e.code==='ENOENT')return {locked:false};throw e;});}
}
export async function releaseWriter(root,id,token){
  const dir=directory(root,id),owner=await writerStatus(root,id);
  if(!owner.locked)return;
  if(owner.token!==token)throw new Error('Writer ownership changed; lock was not released');
  await fs.unlink(path.join(dir,'owner.json'));await fs.rmdir(dir);
}
export async function acquireWriter(root,id,{kind='operation',requestId,waitMs=10000,isCancelled=()=>false,onWait=()=>{}}={}){
  const dir=directory(root,id),deadline=Date.now()+waitMs;await fs.mkdir(path.dirname(dir),{recursive:true});
  for(;;){
    if(await isCancelled())throw Object.assign(new Error('Cancelled while waiting for the project writer'),{code:'CANCELLED'});
    try{await fs.mkdir(dir);break;}catch(e){if(e.code!=='EEXIST')throw e;}
    const owner=await writerStatus(root,id);await onWait(owner);
    if(Date.now()>=deadline)throw Object.assign(new Error('Another managed task owns this project. Query its original task or use an isolated worktree; no write ran.'),{code:'PROJECT_WRITE_BUSY',owner});
    await sleep(Math.min(100,Math.max(1,deadline-Date.now())));
  }
  const owner={token:randomUUID(),pid:process.pid,kind,requestId,createdAt:new Date().toISOString()};
  try{await fs.writeFile(path.join(dir,'owner.json'),JSON.stringify(owner),{flag:'wx'});}catch(e){await fs.rmdir(dir).catch(()=>{});throw e;}
  return {...owner,release:()=>releaseWriter(root,id,owner.token)};
}
export async function withWriter(root,id,options,fn){const lease=await acquireWriter(root,id,options);try{return await fn();}finally{await lease.release();}}
export async function withWriters(root,ids,options,fn){
 const leases=[];
 try{for(const id of [...new Set(ids)].sort())leases.push(await acquireWriter(root,id,options));return await fn();}
 finally{const results=await Promise.allSettled(leases.reverse().map(lease=>lease.release()));const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'One or more project writer releases could not be confirmed');}
}
