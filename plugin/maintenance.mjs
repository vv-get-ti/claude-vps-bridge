// Conservative retention: preview by default, delete only revalidated terminal-job logs.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const here=path.dirname(fileURLToPath(import.meta.url));
const terminal=new Set(['succeeded','failed','cancelled']);
const logNames=['stdout.log','stderr.log','stdout.log.1','stderr.log.1'];
const normalize=p=>process.platform==='win32'?p.toLowerCase():p;
const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function within(base,file){const relative=path.relative(base,file);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('OUTSIDE_STATE');return relative;}
async function checked(state,file){
  const base=path.resolve(state),target=path.resolve(file),relative=within(base,target);
  const root=await fs.lstat(base);if(!root.isDirectory()||root.isSymbolicLink()||normalize(await fs.realpath(base))!==normalize(base))throw Error('REDIRECTED_STATE');
  let current=base,last=root;
  for(const part of relative.split(path.sep).filter(Boolean)){
    current=path.join(current,part);last=await fs.lstat(current);
    if(last.isSymbolicLink()||normalize(await fs.realpath(current))!==normalize(current))throw Error('REDIRECTED_PATH');
  }
  return last;
}
async function entries(state,dir){await checked(state,dir);return fs.readdir(dir,{withFileTypes:true});}
async function statusAt(state,dir){
  const file=path.join(dir,'status.json'),stat=await checked(state,file);if(!stat.isFile()||stat.size>65536)throw Error('INVALID_STATUS');
  const bytes=await fs.readFile(file),value=JSON.parse(bytes);return {value,hash:sha(bytes)};
}

export async function planMaintenance(state,{ageDays=30,maxBytes=0,now=Date.now()}={}){
  if(!Number.isFinite(ageDays)||ageDays<1||ageDays>36500||!Number.isSafeInteger(maxBytes)||maxBytes<0)throw Error('INVALID_RETENTION_OPTIONS');
  const base=path.resolve(state),cutoff=now-ageDays*86400000,candidates=[],summary={eligibleFiles:0,eligibleBytes:0,selectedFiles:0,selectedBytes:0,protectedJobs:0,skippedPaths:0};
  for(const category of ['jobs','searches']){
  const root=path.join(base,category);
  let projects;try{projects=await entries(base,root);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const project of projects){
    if(!project.isDirectory()||project.isSymbolicLink()||!/^[a-f0-9]{64}$/.test(project.name)){summary.skippedPaths++;continue;}
    let jobs;try{jobs=await entries(base,path.join(root,project.name));}catch{summary.skippedPaths++;continue;}
    for(const job of jobs){
      if(!job.isDirectory()||job.isSymbolicLink()||!/^[a-zA-Z0-9_-]{1,100}$/.test(job.name)){summary.skippedPaths++;continue;}
      const dir=path.join(root,project.name,job.name);let status;
      try{status=await statusAt(base,dir);}catch{summary.protectedJobs++;continue;}
      const completed=Date.parse(status.value.completedAt);
      if(!terminal.has(status.value.status)||!Number.isFinite(completed)||completed>cutoff){summary.protectedJobs++;continue;}
      const artifacts=new Set((status.value.artifacts??[]).filter(x=>typeof x?.path==='string').map(x=>normalize(path.resolve(x.path))));
      for(const name of logNames){
        const file=path.join(dir,name);
        try{
          const stat=await checked(base,file);if(!stat.isFile()||stat.nlink!==1||stat.mtimeMs>cutoff||artifacts.has(normalize(file))){summary.skippedPaths++;continue;}
          const hash=await digest(file);if(identity(await checked(base,file))!==identity(stat)){summary.skippedPaths++;continue;}
          candidates.push({file,statusFile:path.join(dir,'status.json'),statusHash:status.hash,identity:identity(stat),hash,bytes:stat.size,mtimeMs:stat.mtimeMs});
          summary.eligibleFiles++;summary.eligibleBytes+=stat.size;
        }catch(error){if(error.code!=='ENOENT')summary.skippedPaths++;}
      }
    }
  }
  }
  candidates.sort((a,b)=>a.mtimeMs-b.mtimeMs||a.file.localeCompare(b.file));
  let retained=summary.eligibleBytes;const selected=[];
  for(const row of candidates){if(retained<=maxBytes)break;selected.push(row);retained-=row.bytes;summary.selectedFiles++;summary.selectedBytes+=row.bytes;}
  return {state:base,ageDays,maxBytes,cutoff,candidates:selected,summary};
}

export async function applyMaintenance(plan){
  const result={deletedFiles:0,deletedBytes:0,skippedChanged:0};
  for(const row of plan.candidates){
    try{
      const relative=within(plan.state,path.resolve(row.file));
      if(!/^(jobs|searches)[\\/][a-f0-9]{64}[\\/][a-zA-Z0-9_-]{1,100}[\\/](stdout|stderr)\.log(\.1)?$/.test(relative))throw Error('INVALID_CANDIDATE');
      const stat=await checked(plan.state,row.file);if(!stat.isFile()||stat.nlink!==1||identity(stat)!==row.identity||await digest(row.file)!==row.hash)throw Error('LOG_CHANGED');
      const status=await statusAt(plan.state,path.dirname(row.file));
      if(status.hash!==row.statusHash||!terminal.has(status.value.status)||Date.parse(status.value.completedAt)>plan.cutoff)throw Error('JOB_CHANGED');
      if(identity(await checked(plan.state,row.file))!==row.identity)throw Error('LOG_CHANGED');
      await fs.unlink(row.file);result.deletedFiles++;result.deletedBytes+=row.bytes;
    }catch{result.skippedChanged++;}
  }
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let apply=false,ageDays=30,maxBytes=0,valid=true;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--apply')apply=true;
    else if(args[i]==='--dry-run')apply=false;
    else if(args[i]==='--age-days')ageDays=Number(args[++i]);
    else if(args[i]==='--max-bytes')maxBytes=Number(args[++i]);
    else valid=false;
  }
  if(!valid){console.error('Usage: node maintenance.mjs [--dry-run|--apply] [--age-days 30] [--max-bytes 0]');process.exitCode=2;}
  else try{
    const plan=await planMaintenance(path.join(here,'runtime','state'),{ageDays,maxBytes});
    console.log(JSON.stringify({mode:apply?'apply':'dry-run',ageDays,maxBytes,...plan.summary,...(apply?await applyMaintenance(plan):{}),preserved:['task metadata','active and unknown jobs','artifacts','media and input attachment caches','native history','installation transactions and backups']},null,2));
  }catch{console.error('Maintenance refused: invalid options, redirected state or unreadable metadata. No further cleanup was attempted.');process.exitCode=1;}
}
