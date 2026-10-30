// Windows refuses to rename over a file another handle has open, even a
// reader (EPERM/EACCES/EBUSY). Status readers and antivirus scanners hold such
// handles briefly, so retry within a bound instead of failing a finished job.
import fs from 'node:fs/promises';
const BUSY=new Set(['EPERM','EACCES','EBUSY']);
export async function replaceFile(temp,target,{timeoutMs=5000}={}){
  const deadline=Date.now()+timeoutMs;
  for(let delay=10;;delay=Math.min(delay*2,200)){
    try{await fs.rename(temp,target);return;}
    catch(error){
      if(!BUSY.has(error.code)||Date.now()>=deadline){await fs.rm(temp,{force:true}).catch(()=>{});throw error;}
      await new Promise(resolve=>setTimeout(resolve,delay));
    }
  }
}
