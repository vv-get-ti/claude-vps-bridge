import {Writable} from 'node:stream';
import fs from 'node:fs/promises';
// Bound memory, not retained output. Backpressure reaches the child pipes.
// Keep the file stable so byte cursors remain valid while the job is running.
export function boundedLog(file){
  let handle,size=0,failed=false;
  const stream=new Writable({highWaterMark:64*1024,
    construct(callback){fs.open(file,'w').then(h=>{handle=h;callback();},callback);},
    write(chunk,encoding,callback){void(async()=>{
      let bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding);
      while(bytes.length){
        const count=bytes.length;let written=0;
        while(written<count){const r=await handle.write(bytes,written,count-written);if(!r.bytesWritten)throw new Error('Log write made no progress');written+=r.bytesWritten;}
        size+=count;bytes=bytes.subarray(count);
      }
    })().then(()=>callback(),error=>{failed=true;callback(error);});},
    final(callback){Promise.resolve(handle?.close()).then(()=>{handle=null;callback();},callback);},
    destroy(error,callback){if(error)failed=true;Promise.resolve(handle?.close()).then(()=>{handle=null;callback(error);},callback);}
  });
  stream.stats=()=>({mode:'complete-file',bytes:size,segments:1,rotations:0,truncated:failed});return stream;
}
