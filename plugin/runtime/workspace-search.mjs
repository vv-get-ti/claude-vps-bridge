import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {finished} from 'node:stream/promises';
import {boundedLog} from './bounded-log.mjs';
import {readJobOutput} from './job-output.mjs';
import {permissionDecision,inside} from './project-environment.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function rg(args,cwd){
  const child=spawn('rg',args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';
  child.stderr.on('data',b=>stderr=(stderr+b.toString('utf8')).slice(-4096));
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0||code===1?resolve():reject(new Error('Search failed ('+code+'): '+stderr)));});
  // Enumeration may await filesystem permissions while the process exits.
  done.catch(()=>{});return {child,done};
}
async function* candidates(root,cwd){
  const stat=await fs.stat(root);if(stat.isFile()){yield root;return;}
  const {child,done}=rg(['--files','--null','--',root],cwd);let pending=Buffer.alloc(0);
  try{
    for await(const bytes of child.stdout){
      pending=Buffer.concat([pending,bytes]);let end;
      while((end=pending.indexOf(0))!==-1){yield pending.subarray(0,end).toString('utf8');pending=pending.subarray(end+1);}
      if(pending.length>1024*1024)fail('INVALID_SEARCH_PATH','Unbounded filename from file enumeration');
    }
    await done;if(pending.length)fail('INVALID_SEARCH_PATH','Incomplete file enumeration');
  }finally{if(child.exitCode===null)child.kill();}
}

// Snapshot once to disk; subsequent pages never rerun the search or silently
// change the result set. Permission checks happen before rg can read a file.
export async function searchWorkspace({state,info,environment,mode,root},request){
  const searchId=request.searchId??randomUUID();
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(searchId))fail('INVALID_SEARCH_ID','Invalid search snapshot identity');
  const directory=path.join(state,'searches',info.projectId,searchId),metadataFile=path.join(directory,'result.json');
  let metadata;
  if(request.searchId){
    metadata=await fs.readFile(metadataFile,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')fail('SEARCH_NOT_FOUND','No complete search snapshot in this project');throw e;});
    if(metadata.fingerprint!==environment.fingerprint)fail('SEARCH_POLICY_CHANGED','Workspace rules or permissions changed. Start a new search before reading saved results.');
    if(request.pattern!==undefined&&request.pattern!==metadata.pattern)fail('SEARCH_MISMATCH','This snapshot belongs to a different search');
    // Recheck the original root, not just the path supplied for pagination.
    if(permissionDecision(environment,{action:'search',path:metadata.path},mode).decision==='deny')fail('PERMISSION_DENIED','Search permission changed');
  }else{
    if(typeof request.pattern!=='string'||/[\r\n\0]/.test(request.pattern))fail('INVALID_ARGUMENT','search requires a single-line literal pattern');
    await fs.mkdir(directory,{recursive:true});
    const patternFile=path.join(directory,'pattern.txt');await fs.writeFile(patternFile,request.pattern+'\n',{flag:'wx'});
    const writer=boundedLog(path.join(directory,'stdout.log'));let writeError;
    const drained=finished(writer).catch(e=>{writeError=e;});
    let active;
    writer.on('error',()=>active?.kill());
    const skipped={denied:0,approvalRequired:0,outsideProject:0};let searchedFiles=0,batch=[],chars=0;
    const flush=async()=>{
      if(!batch.length)return;if(writeError)throw writeError;
      const process=rg(['--with-filename','--line-number','--no-heading','--color','never','--fixed-strings','--file',patternFile,'--',...batch],info.cwd);active=process.child;
      active.stdout.pipe(writer,{end:false});
      await process.done;active=null;if(writeError)throw writeError;
      searchedFiles+=batch.length;batch=[];chars=0;
    };
    const direct=(await fs.stat(root)).isFile();
    const rootDecision=permissionDecision(environment,{action:'search',path:root},mode);
    try{
      let pending=[];
      const inspect=async()=>{
        const checked=await Promise.all(pending.map(async file=>({file,canonical:await fs.realpath(file)})));pending=[];
        for(const {file,canonical} of checked){
          if(!inside(info.cwd,canonical)){skipped.outsideProject++;continue;}
          const decisions=[...new Set([file,canonical])].map(p=>permissionDecision(environment,{action:'search',path:p,pattern:request.pattern},mode));
          if(decisions.some(d=>d.decision==='deny')){skipped.denied++;continue;}
          if(!direct&&decisions.some(d=>d.decision==='ask'&&d.reason!==rootDecision.reason)){skipped.approvalRequired++;continue;}
          // Relative argv avoids repeating the project prefix and spawning rg
          // for tiny batches, while remaining below Windows' command-line cap.
          const argument=path.relative(info.cwd,canonical);
          if(batch.length>=4096||chars+argument.length+3>20000)await flush();
          batch.push(argument);chars+=argument.length+3;
        }
      };
      for await(const file of candidates(root,info.cwd)){pending.push(file);if(pending.length>=64)await inspect();}
      await inspect();
      await flush();writer.end();await drained;if(writeError)throw writeError;
      metadata={searchId,path:root,pattern:request.pattern,fingerprint:environment.fingerprint,searchedFiles,skipped};
      await fs.writeFile(metadataFile,JSON.stringify(metadata),{flag:'wx'});
      await fs.writeFile(path.join(directory,'status.json'),JSON.stringify({status:'succeeded',requestId:searchId,completedAt:new Date().toISOString()}),{flag:'wx'});
    }catch(e){active?.kill();writer.destroy();await drained;throw e;}
  }
  const page=await readJobOutput(directory,{offset:request.offset??0,limit:request.limit??65536,segmentId:request.segmentId,encoding:request.encoding??'utf-8',complete:true});
  const {content,...range}=page;
  return {...metadata,...range,output:content,snapshot:true,...(page.totalBytes===0?{matches:0}:{}),nextAction:page.hasMore?'Continue this searchId at nextOffset; do not rerun the search.':metadata.skipped.approvalRequired?'Some files require direct approval; search those paths explicitly if needed.':'Search snapshot fully read.'};
}
