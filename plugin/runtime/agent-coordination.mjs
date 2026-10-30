import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acquireWriter,releaseWriter,writerStatus} from './task-coordination.mjs';
const terminal=new Set(['completed','failed','interrupted','cancelled']);
const ref=value=>typeof value==='string'?value.replace(/^codex:\/\/threads\//,''):null;
function threadOf(value){return ref(value?.thread??value?.threadId);}
async function childDrained(root,projectId,thread){
 const scope=createHash('sha256').update(projectId+'\n'+thread).digest('hex');
 if((await writerStatus(root,scope)).locked)return false;
 const jobs=path.join(root,'jobs',projectId),names=await fs.readdir(jobs).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 for(const name of names){const dir=path.join(jobs,name);let spec;try{spec=JSON.parse(await fs.readFile(path.join(dir,'request.json'),'utf8'));}catch{return false;}
  if(ref(spec.parentThread)!==thread)continue;
  const state=await fs.readFile(path.join(dir,'status.json'),'utf8').then(JSON.parse,()=>null);
  if(!['succeeded','failed','cancelled'].includes(state?.status))return false;
 }
 return true;
}
export async function writerScope(root,projectId,hostThread){
 const owner=await writerStatus(root,projectId);
 if(owner.kind!=='agent'||!hostThread)return projectId;
 const file=path.join(root,'delegations',projectId,owner.requestId+'.json');
 const saved=await fs.readFile(file,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
 // The bound Host child may write beneath its own reservation; other sessions cannot.
 return saved?.thread&&saved.thread===ref(hostThread)?createHash('sha256').update(projectId+'\n'+saved.thread).digest('hex'):projectId;
}
export async function coordinatedAgent(root,info,argv,execute,{requestId:bridgeRequestId}={}){
 const starts=argv[0]==='delegate'&&argv[1]==='start',sends=argv[0]==='thread'&&argv[1]==='send';
 const mutation=(starts||sends)&&!argv.includes('--help')&&!argv.includes('-h');
 if(!mutation){
  const result=await execute(argv);
  // Cancellation acknowledgement is not proof of termination: read/wait only.
  if(argv[0]==='thread'&&['read','wait'].includes(argv[1])&&terminal.has(result?.status)){
   const owner=await writerStatus(root,info.projectId);
   if(owner.kind==='agent'){
    const file=path.join(root,'delegations',info.projectId,owner.requestId+'.json');
    const saved=await fs.readFile(file,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
    if(saved&&saved.thread===ref(argv[2])&&threadOf(result)===saved.thread){
      if(!await childDrained(root,info.projectId,saved.thread))return {...result,writerRetained:true,writerReason:'The agent ended but its managed local jobs or writer are not confirmed stopped. Inspect those tasks before modifying this workspace.'};
      await releaseWriter(root,info.projectId,owner.token);saved.status=result.status;await fs.writeFile(file,JSON.stringify(saved));
    }
   }
  }
  return result;
 }
 const requestIndex=argv.indexOf('--request-id');
 const requestId=requestIndex>=0?argv[requestIndex+1]:bridgeRequestId;
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId??''))throw new Error('Invalid delegation request ID');
 if(starts&&requestIndex<0)argv=[...argv,'--request-id',requestId];
 const file=path.join(root,'delegations',info.projectId,requestId+'.json');
 const saved=await fs.readFile(file,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
 if(saved){if(JSON.stringify(saved.argv)!==JSON.stringify(argv))throw new Error('Delegation request ID belongs to different work');if(saved.result)return saved.result;throw new Error('Delegation outcome unknown. Inspect the saved request and original Host task; do not resubmit');}
 const lease=await acquireWriter(root,info.projectId,{kind:'agent',requestId});
 const record={requestId,argv,thread:sends?ref(argv[2]):null,status:'submitting',createdAt:new Date().toISOString()};
 try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(record),{flag:'wx'});}catch(e){await lease.release();throw e;}
 try{
  const result=await execute(argv);record.thread=threadOf(result)??record.thread;if(!record.thread)throw new Error('Host accepted delegation but returned no recognized thread identity; outcome must be inspected');record.result=result;record.status='accepted';await fs.writeFile(file,JSON.stringify(record));
  // Retain ownership until a subsequent authenticated read/wait confirms terminal.
  return result;
 }catch(e){record.status='unknown';await fs.writeFile(file,JSON.stringify(record));throw e;}
}
