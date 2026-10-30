import {spawn,execFile} from 'node:child_process';
import path from 'node:path';
const ownedGroups=new WeakSet(),stopping=new WeakMap();
const failure=(message,cause)=>Object.assign(new Error(message,{cause}),{code:'PROCESS_TREE_TERMINATION_UNCONFIRMED'});

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
