// Node backend for the Claude VPS Sessions extension.
// Host kills a backend whose invoke exceeds 10 s and caps each reply at 2 MiB,
// while one SSH round trip to the VPS can take longer. Every bridge call is
// therefore a job: `start` returns at once, `poll` reads the finished JSON in
// bounded chunks. The bridge is reached only through its admin.mjs contract.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const API_VERSION=1;
const METHODS=new Set(['info','sessions.list','sessions.archive','sessions.restore','sessions.delete']);
const MUTATING=new Set(['sessions.archive','sessions.restore','sessions.delete']);
const MAX_REQUEST_BYTES=1024*1024;      // admin.mjs reads at most 1 MiB
const MAX_OUTPUT_BYTES=64*1024*1024;
const CHUNK_CHARS=256*1024;             // stays under the 2 MiB IPC cap even when escaped
const READ_TIMEOUT_MS=5*60*1000;        // reads only; writes are never killed
const JOB_TTL_MS=10*60*1000;
const MAX_JOBS=16;

function fail(code,message){return Object.assign(new Error(message),{code});}

export async function activate(ctx){
  const jobs=new Map();
  let mutation=null;
  const dataRoot=process.env.CODEXHOST_DATA_DIR||path.resolve(ctx.extensionDir,'..','..');

  async function locate(){
    const settings=await ctx.readSettings().catch(()=>({}));
    const configured=typeof settings?.pluginDir==='string'?settings.pluginDir.trim():'';
    const directory=configured||path.join(dataRoot,'plugins','claude-vps');
    const file=path.join(directory,'admin.mjs');
    return {directory,file,configured:Boolean(configured),exists:fs.statSync(file,{throwIfNoEntry:false})?.isFile()===true};
  }

  function prune(){
    const now=Date.now();
    for(const [id,job] of jobs)if(job.state!=='running'&&now-job.endedAt>JOB_TTL_MS)jobs.delete(id);
  }

  function run(file,request){
    const job={id:randomUUID(),method:request.method,state:'running',startedAt:Date.now(),endedAt:0,text:'',error:null};
    const child=spawn(process.execPath,[file],{cwd:path.dirname(file),stdio:['pipe','pipe','ignore'],windowsHide:true,env:{...process.env,NODE_OPTIONS:undefined}});
    const chunks=[];let size=0,overflow=false;
    const finish=(state,error=null)=>{
      if(job.state!=='running')return;
      clearTimeout(timer);
      job.state=state;job.error=error;job.endedAt=Date.now();job.child=null;
      if(mutation===job)mutation=null;
    };
    // Reads may be abandoned safely. A write keeps running until admin.mjs
    // reports, because killing it would only turn the outcome into unknown.
    const timer=MUTATING.has(request.method)?null:setTimeout(()=>{child.kill();finish('failed',{code:'TIMEOUT',message:'读取超时，请稍后重试。'});},READ_TIMEOUT_MS);
    child.stdout.on('data',chunk=>{
      size+=chunk.length;
      if(size>MAX_OUTPUT_BYTES){overflow=true;child.kill();return;}
      chunks.push(chunk);
    });
    child.on('error',error=>finish('failed',{code:'SPAWN_FAILED',message:'无法启动桥接管理入口：'+error.message}));
    child.on('close',()=>{
      if(overflow)return finish('failed',{code:'OUTPUT_TOO_LARGE',message:'管理入口返回的数据过大。'});
      const text=Buffer.concat(chunks).toString('utf8').trim();
      let response;try{response=JSON.parse(text);}catch{}
      if(response?.apiVersion!==API_VERSION||typeof response.ok!=='boolean')return finish('failed',{code:'BAD_RESPONSE',message:'管理入口没有返回有效结果。'});
      job.text=text;finish('done');
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(request));
    job.child=child;
    return job;
  }

  ctx.handle('locate',async()=>{const found=await locate();return {directory:found.directory,configured:found.configured,exists:found.exists};});

  ctx.handle('start',async params=>{
    prune();
    const method=params?.method,body=params?.params??{};
    if(!METHODS.has(method)||body===null||typeof body!=='object'||Array.isArray(body))throw fail('INVALID_ARGUMENT','请求无效。');
    if(MUTATING.has(method)&&mutation)throw fail('BUSY','另一项操作仍在进行，请等待它完成。');
    if([...jobs.values()].filter(job=>job.state==='running').length>=MAX_JOBS)throw fail('BUSY','进行中的请求过多，请稍后重试。');
    const request={apiVersion:API_VERSION,method,params:body};
    if(Buffer.byteLength(JSON.stringify(request))>MAX_REQUEST_BYTES)throw fail('INVALID_ARGUMENT','一次选择的会话过多。');
    const found=await locate();
    if(!found.exists)throw fail('BRIDGE_NOT_FOUND','找不到 Claude VPS Bridge 的管理入口：'+found.file+'。请安装 0.16.0 或更新版本，或在扩展设置中填写插件目录。');
    const job=run(found.file,request);
    jobs.set(job.id,job);
    if(MUTATING.has(method))mutation=job;
    return {jobId:job.id};
  });

  ctx.handle('poll',async params=>{
    const job=jobs.get(params?.jobId);
    if(!job)throw fail('JOB_NOT_FOUND','请求记录已过期，请刷新列表。');
    if(job.state==='running')return {state:'running',method:job.method,elapsedMs:Date.now()-job.startedAt};
    if(job.state==='failed')return {state:'failed',method:job.method,error:job.error};
    const offset=Number.isSafeInteger(params?.offset)&&params.offset>=0?params.offset:0;
    const nextOffset=Math.min(job.text.length,offset+CHUNK_CHARS);
    const result={state:'done',method:job.method,total:job.text.length,offset,nextOffset,chunk:job.text.slice(offset,nextOffset)};
    if(nextOffset>=job.text.length)jobs.delete(job.id);
    return result;
  });

  return ()=>{
    for(const job of jobs.values())if(job.state==='running'&&!MUTATING.has(job.method))job.child?.kill();
    jobs.clear();
  };
}
