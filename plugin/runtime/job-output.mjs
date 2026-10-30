import fs from 'node:fs/promises';
import path from 'node:path';

const maxBytes=65536;
const invalid=()=>Object.assign(new Error('Expected stdout/stderr, segment 0/1, a non-negative byte offset and a limit of 4–65536 bytes'),{code:'INVALID_LOG_REQUEST'});
export async function readJobOutput(directory,{stream='stdout',segment=0,offset=0,limit=maxBytes,tail=false,segmentId,complete=false,encoding='utf-8'}={}){
  if(!['stdout','stderr'].includes(stream)||![0,1].includes(segment)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<4||limit>maxBytes||!['utf-8','base64'].includes(encoding))throw invalid();
  const file=path.join(directory,stream+'.log'+(segment?'.1':''));
  const handle=await fs.open(file,'r');
  try{
    const stat=await handle.stat();
    if(!stat.isFile())throw invalid();
    const identity=stat.dev+':'+stat.ino+':'+stat.birthtimeMs;
    if(segmentId!==undefined&&segmentId!==identity)throw Object.assign(new Error('Log segment changed; reread its status before continuing'),{code:'LOG_SEGMENT_CHANGED'});
    const start=tail?Math.max(0,stat.size-limit):Math.min(offset,stat.size);
    // A few lookahead bytes identify a character cut by the page boundary.
    const buffer=Buffer.alloc(Math.min(stat.size-start,limit+3));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,start);
    let first=0,end=Math.min(bytesRead,limit);const rawEnd=end;
    const raw=()=>({stream,segment,segmentId:identity,encoding:'base64',totalBytes:stat.size,offset:start,nextOffset:start+rawEnd,bytes:rawEnd,hasMore:start+rawEnd<stat.size,truncated:start>0||start+rawEnd<stat.size,content:buffer.subarray(0,rawEnd).toString('base64')});
    if(encoding==='base64')return raw();
    const continuation=byte=>(byte&0xc0)===0x80;
    if(tail)while(first<end&&continuation(buffer[first]))first++;
    if(end<bytesRead)while(end>first&&continuation(buffer[end]))end--;
    // A running process may have written only part of its last UTF-8 character.
    if(end===bytesRead&&end>first){
      let lead=end-1;while(lead>first&&continuation(buffer[lead]))lead--;
      const byte=buffer[lead],width=byte>=0xf0&&byte<=0xf4?4:byte>=0xe0&&byte<=0xef?3:byte>=0xc2&&byte<=0xdf?2:1;
      if(end-lead<width){
        if(complete&&start+bytesRead===stat.size)return {...raw(),decodeError:'INCOMPLETE_UTF8',note:'The task has ended. These are the original bytes, not a text conversion.'};
        end=lead;
      }
    }
    let content;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(first,end));}
    catch{return {...raw(),decodeError:'INVALID_UTF8',note:'Original bytes returned as base64. Choose an explicit decoder if this program uses another encoding.'};}
    if(first===end&&rawEnd>0&&complete)return {...raw(),decodeError:'INVALID_UTF8'};
    return {stream,segment,segmentId:identity,encoding:'utf-8',totalBytes:stat.size,offset:start+first,nextOffset:start+end,bytes:end-first,hasMore:start+end<stat.size,truncated:start+first>0||start+end<stat.size,content};
  }finally{await handle.close();}
}

export async function jobOutputTail(directory,stream,complete=false){
  try{return await readJobOutput(directory,{stream,tail:true,complete});}
  catch(error){if(error.code!=='ENOENT')throw error;return {stream,available:false,totalBytes:0,offset:0,nextOffset:0,bytes:0,hasMore:false,truncated:false,content:''};}
}
