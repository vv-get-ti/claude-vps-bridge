import {spawn,execFile} from 'node:child_process';
import path from 'node:path';
const ownedGroups=new WeakSet(),stopping=new WeakMap();
const failure=(message,cause)=>Object.assign(new Error(message,{cause}),{code:'PROCESS_TREE_TERMINATION_UNCONFIRMED'});

const windowsProcessQuery=`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object {
  @{pid=$_.ProcessId; parentPid=$_.ParentProcessId; name=$_.Name;
    createdAt=if ($null -ne $_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }}
})
ConvertTo-Json -InputObject $processes -Compress
`;
const validPid=pid=>Number.isInteger(pid)&&pid>=0&&pid<=0xffffffff;
const clockMarginMs=2000;
export async function traceWindowsDescendants(runnerPid,childPid,startedAt){
  const start=typeof startedAt==='string'?Date.parse(startedAt):NaN;
  if(process.platform!=='win32'||!Number.isFinite(start)||start>Date.now()+clockMarginMs)return null;
  const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsProcessQuery,'utf16le').toString('base64')];
  const rows=await new Promise(resolve=>{
    execFile(powershell,args,{windowsHide:true,timeout:4000,maxBuffer:2*1024*1024},(error,stdout,stderr)=>{
      if(error||stderr.trim())return resolve(null);
      try{resolve(JSON.parse(stdout));}catch{resolve(null);}
    });
  });
  if(!Array.isArray(rows)||!rows.length)return null;
  const children=new Map(),byPid=new Map();
  for(const row of rows){
    if(!row||!validPid(row.pid)||!validPid(row.parentPid)||!Number.isSafeInteger(row.createdAt)||Math.abs(row.createdAt)>8640000000000000||
      typeof row.name!=='string'||!row.name.trim()||byPid.has(row.pid))return null;
    byPid.set(row.pid,row);
    if(!row.pid||row.createdAt<start-clockMarginMs)continue;
    if(!children.has(row.parentPid))children.set(row.parentPid,[]);
    children.get(row.parentPid).push(row);
  }
  // The direct child is a second root even after it and its parent vanish.
  // Windows retains the parent PID, including for detached children.
  const visited=new Set([runnerPid]),queue=[runnerPid],descendants=[];
  const add=row=>{
    if(visited.has(row.pid))return;
    visited.add(row.pid);queue.push(row.pid);
    descendants.push({pid:row.pid,name:path.win32.basename(row.name),createdAt:new Date(row.createdAt).toISOString()});
  };
  if(childPid&&childPid!==runnerPid){
    const child=byPid.get(childPid);
    if(child&&child.createdAt>=start-clockMarginMs)add(child);
    else{visited.add(childPid);queue.push(childPid);}
  }
  for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])??[])add(child);
  return descendants.sort((a,b)=>a.pid-b.pid);
}

// Only processes launched here have a process group we may signal on POSIX.
// Windows taskkill uses the child's process tree; no detached console is opened.
export function spawnOwnedProcess(file,args,options={}){
  const child=spawn(file,args,{...options,...(process.platform==='win32'?{}:{detached:true})});
  if(process.platform!=='win32')ownedGroups.add(child);
  return child;
}
export function stopProcessTree(child,{timeoutMs=10000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)return Promise.reject(new Error('Invalid process-tree termination timeout'));
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return Promise.resolve(false);
  if(stopping.has(child))return stopping.get(child);
  if(process.platform!=='win32'&&!ownedGroups.has(child))return Promise.reject(failure('Refusing to signal an unowned POSIX process group'));
  const pending=new Promise((resolve,reject)=>{
    let closed=false,killed=false,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.off('close',onClose);error?reject(error):resolve(value);};
    const onClose=()=>{closed=true;if(killed)finish(null,true);};
    const timer=setTimeout(()=>finish(failure('Process tree did not confirm closure before the deadline')),timeoutMs);
    child.once('close',onClose);
    if(process.platform==='win32'){
      const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe');
      execFile(executable,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:timeoutMs,maxBuffer:64*1024},error=>{
        if(error){finish(failure('Windows process-tree termination failed; closure was not confirmed',error));return;}
        killed=true;if(closed)finish(null,true);
      });
    }else{
      try{process.kill(-child.pid,'SIGKILL');killed=true;if(closed)finish(null,true);}
      catch(error){finish(failure('POSIX process-group termination failed; closure was not confirmed',error));}
    }
  });
  stopping.set(child,pending);return pending;
}
