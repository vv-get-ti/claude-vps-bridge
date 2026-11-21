import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {bridgeRoot} from './remote-config.mjs';

const messages={SESSION_ARCHIVED:'该会话已归档，请在会话管理中恢复后再打开。',
  SESSION_MANAGED:'会话管理正在操作相关会话，请稍后重新打开。',
  PROJECT_MISMATCH:'无法确认该 Claude 会话属于当前 Windows 项目。',
  STATE_UNKNOWN:'无法确认 VPS 会话租约状态，未打开会话。'};
const leaseError=code=>Object.assign(new Error(messages[code]??messages.STATE_UNKNOWN),{code});

export async function openSessionLease(first,onLost){
  // Windows runs local adapter fixtures; the remote deployment is Linux.
  if(process.platform==='win32')return {async send(){},close(){},assertHeld(){}};
  const child=spawn('python3',['-B',path.join(bridgeRoot,'session_lease.py')],{stdio:['pipe','pipe','ignore']});
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  let pending,closed=false,accepted=false,released=false;
  function settled(error){if(!pending)return;const wait=pending;pending=null;clearTimeout(wait.timer);if(error)wait.reject(error);else wait.resolve();}
  function lost(){if(closed)return;closed=true;settled(leaseError('STATE_UNKNOWN'));if(accepted&&!released)onLost?.();}
  child.on('error',lost);child.stdin.on('error',lost);child.on('exit',lost);lines.on('close',lost);
  lines.on('line',line=>{
    try{const {code}=JSON.parse(line);if(code!==null)released=true;settled(code===null?null:leaseError(code));}
    catch{lost();}
  });
  const lease={
    assertHeld(){if(closed)throw leaseError('STATE_UNKNOWN');},
    send(command){
      lease.assertHeld();
      if(pending)throw leaseError('STATE_UNKNOWN');
      return new Promise((resolve,reject)=>{
        pending={resolve,reject,timer:setTimeout(()=>{lost();child.kill();},5000)};
        child.stdin.write(JSON.stringify(command)+'\n');
      });
    },
    close(){released=true;child.stdin.end();},
  };
  try{await lease.send(first);accepted=true;return lease;}catch(error){lease.close();throw error;}
}
