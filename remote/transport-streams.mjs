// Limits apply before an unterminated frame or a slow peer can grow memory.
export const MAX_FRAME_BYTES=48*1024*1024;
export const MAX_QUEUE_BYTES=64*1024*1024;
export function transportError(code,message){return Object.assign(new Error(message),{code});}

export function readJsonLines(stream,onFrame,{maxBytes=MAX_FRAME_BYTES,onError,onEnd}={}){
  let storage=null,bytes=0,closed=false;
  const fail=error=>{if(closed)return;dispose();onError?.(error);};
  function data(chunk){
    if(closed)return;
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);let offset=0;
    try{
      while(offset<buffer.length){
        const newline=buffer.indexOf(10,offset),end=newline<0?buffer.length:newline;
        const piece=buffer.subarray(offset,end);
        if(bytes+piece.length>maxBytes)throw transportError('FRAME_TOO_LARGE','Bridge frame exceeds the configured byte limit');
        if(piece.length){
          const required=bytes+piece.length;
          if(!storage||storage.length<required){const next=Buffer.allocUnsafe(Math.min(maxBytes,Math.max(required,(storage?.length??32768)*2)));storage?.copy(next,0,0,bytes);storage=next;}
          piece.copy(storage,bytes);bytes=required;
        }
        if(newline<0)break;
        const line=storage?.toString('utf8',0,bytes)??'';bytes=0;if(storage?.length>1024*1024)storage=null;
        let value;try{value=JSON.parse(line);}catch{throw transportError('INVALID_FRAME','Invalid bridge JSON frame');}
        onFrame(value);if(closed)return;offset=newline+1;
      }
    }catch(error){fail(error);}
  }
  function end(){if(closed)return;if(bytes){fail(transportError('TRUNCATED_FRAME','Bridge closed during a JSON frame'));return;}dispose();onEnd?.();}
  function dispose(){if(closed)return;closed=true;storage=null;bytes=0;stream.off('data',data);stream.off('end',end);stream.off('error',fail);}
  stream.on('data',data);stream.on('end',end);stream.on('error',fail);
  return {dispose,get bufferedBytes(){return bytes;}};
}

export function jsonFrame(value,maxBytes=MAX_FRAME_BYTES){
  const text=JSON.stringify(value);
  if(Buffer.byteLength(text)>maxBytes)throw transportError('FRAME_TOO_LARGE','Bridge frame exceeds the configured byte limit');
  return Buffer.from(text+'\n');
}

export class JsonWriter{
  constructor(stream,{maxBytes=MAX_FRAME_BYTES,maxQueueBytes=MAX_QUEUE_BYTES,maxQueuedFrames=4096,onError}={}){
    this.stream=stream;this.maxBytes=maxBytes;this.maxQueueBytes=maxQueueBytes;this.maxQueuedFrames=maxQueuedFrames;this.onError=onError;
    this.queue=[];this.bytes=0;this.blocked=false;this.closed=false;this.ending=false;
    this.drain=()=>{this.blocked=false;this.flush();};
    stream.on('drain',this.drain);
  }
  get bufferedBytes(){return this.bytes+(this.stream.writableLength??0);}
  send(value){return this.sendBuffer(jsonFrame(value,this.maxBytes));}
  sendBuffer(buffer){
    if(this.closed||this.ending||this.stream.destroyed||this.stream.writableEnded)throw transportError('TRANSPORT_CLOSED','Bridge output is closed');
    if(this.bufferedBytes+buffer.length>this.maxQueueBytes||this.queue.length>=this.maxQueuedFrames)throw transportError('TRANSPORT_BACKPRESSURE','Bridge output queue is full; operation was not queued');
    this.queue.push(buffer);this.bytes+=buffer.length;this.flush();
  }
  flush(){
    try{
      while(!this.closed&&!this.blocked&&this.queue.length){
        const buffer=this.queue.shift();this.bytes-=buffer.length;this.blocked=!this.stream.write(buffer);
      }
      if(this.ending&&!this.queue.length&&!this.blocked&&!this.closed){this.dispose();this.stream.end();}
    }catch(error){this.dispose();this.onError?.(error);}
  }
  end(){if(this.closed)return;this.ending=true;this.flush();}
  dispose(){if(this.closed)return;this.closed=true;this.stream.off('drain',this.drain);this.queue=[];this.bytes=0;}
}
