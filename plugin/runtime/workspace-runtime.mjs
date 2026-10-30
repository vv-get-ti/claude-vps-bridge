import {getBridgeConfig} from './bridge-config.mjs';
import {boundAgentArguments} from './agent-binding.mjs';
// Windows owns project files, operation records, and persistent command jobs.
import fs from 'node:fs/promises';
import {finished} from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { brokerRequest, ensureBroker } from './job-broker.mjs';
import {acquireWriter,withWriter,withWriters,writerStatus} from './task-coordination.mjs';
import {boundedLog} from './bounded-log.mjs';
import {readJobOutput,jobOutputTail} from './job-output.mjs';
import {searchWorkspace} from './workspace-search.mjs';
import {workspaceIsolation} from './workspace-isolation.mjs';
import {coordinatedAgent,writerScope} from './agent-coordination.mjs';
import {spawnOwnedProcess,stopProcessTree} from './process-tree.mjs';
import {boundedRead} from './bounded-file.mjs';
import {projectEnvironment,environmentContext,applicableRules,capability,permissionDecision,operation,runHooks,inside} from './project-environment.mjs';
import {exportMedia} from './media-input.mjs';
import {mcpRequest} from './mcp-runtime.mjs';
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const state = path.join(here, 'state');
const pwsh = getBridgeConfig().pwshExecutable;
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}
function safeId(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_ID', 'Expected a stable request/session identifier'); return value; }
export async function projectInfo(cwd) {
  if (!path.win32.isAbsolute(cwd)) fail('INVALID_PROJECT', 'Select an absolute Windows project directory');
  const real = await fs.realpath(cwd).catch(() => fail('PROJECT_MISSING', 'The selected Windows project does not exist'));
  if (!(await fs.stat(real)).isDirectory()) fail('INVALID_PROJECT', 'The selected Windows project is not a directory');
  await fs.mkdir(state, { recursive: true });
  const machineFile = path.join(state, 'machine-id');
  try { await fs.writeFile(machineFile, randomUUID(), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const machineId = (await fs.readFile(machineFile, 'utf8')).trim();
  const key = real.replace(/[\\/]+$/, '').toLowerCase();
  const projectId = hash(machineId + '\n' + key);
  return { machineId, machine: os.hostname(), projectId, cwd: real, key, name: path.basename(real) };
}
export async function verifyProject(cwd, expected) {
  const actual = await projectInfo(cwd);
  if (expected && actual.projectId !== expected) fail('PROJECT_MISMATCH', 'Windows machine/project identity differs from the bound remote workspace');
  return actual;
}
async function projectPath(info, value = '.') {
  if (typeof value !== 'string' || value.includes('\0')) fail('INVALID_PATH', 'Invalid project path');
  const target = path.resolve(info.cwd, value);
  const relative = path.relative(info.cwd, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('PATH_OUTSIDE_PROJECT', 'Path is outside the selected project');
  let existing = target;
  while (true) {
    try { const canonical = await fs.realpath(existing); const rel = path.relative(info.cwd, canonical); if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) fail('PATH_OUTSIDE_PROJECT', 'A link resolves outside the selected project'); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; const parent = path.dirname(existing); if (parent === existing) throw e; existing = parent; }
  }
  return target;
}
export async function bindSession(sessionId, info, parentThread) {
  await atomic(path.join(state, 'sessions', safeId(sessionId) + '.json'), { ...info, sessionId, parentThread,attachments:[] });
}
export async function setTurn(sessionId, turnId) {
  const file = path.join(state, 'sessions', safeId(sessionId) + '.json');
  const value = await json(file); value.turnId = turnId; delete value.modelObservation; await atomic(file, value);
}
async function setMode(sessionId,mode){const file=path.join(state,'sessions',safeId(sessionId)+'.json');const value=await json(file);value.permissionMode=mode;await atomic(file,value);}
async function contextFor(request, info) {
  if (!request.sessionId) return {};
  const ctx = await json(path.join(state, 'sessions', safeId(request.sessionId) + '.json'));
  if (ctx.projectId !== info.projectId) fail('PROJECT_MISMATCH', 'Session is bound to a different local project');
  if (request.parentThread && ctx.parentThread && request.parentThread !== ctx.parentThread) fail('PARENT_MISMATCH','Session is bound to a different parent thread');
  return ctx;
}
async function record(ctx, info, value) {
  if (!ctx.sessionId || !ctx.turnId) return;
  const directory = path.join(state, 'events', safeId(ctx.sessionId), safeId(ctx.turnId));
  await fs.mkdir(directory, { recursive: true });
  await atomic(path.join(directory, randomUUID() + '.json'), { ...value, projectId: info.projectId, at: Date.now() });
}
export async function turnItems(sessionId, turnId) {
  const directory = path.join(state, 'events', safeId(sessionId), safeId(turnId));
  const names = await fs.readdir(directory).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  return (await Promise.all(names.filter(n => n.endsWith('.json')).map(n => json(path.join(directory, n))))).sort((a,b) => a.at-b.at);
}
function wholeDiff(file, before, after) {
  const relative = file.replaceAll('\\', '/');
  const lines = text => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const old = before ?? '', a = lines(old), b = lines(after);
  // One hunk around the changed region with 3 context lines. A whole-file
  // replacement made every small edit look like a rewrite and bloated replies.
  const noEol = text => text !== '' && !text.endsWith('\n');
  const eolChanged = noEol(old) !== noEol(after);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start] && !(eolChanged && (start === endA - 1 || start === endB - 1))) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1] && !(eolChanged && endA === a.length)) { endA--; endB--; }
  const from = Math.max(0, start - 3), toA = Math.min(a.length, endA + 3);
  const marker = '\\ No newline at end of file', out = [];
  for (let i = from; i < start; i++) out.push(' ' + a[i]);
  for (let i = start; i < endA; i++) out.push('-' + a[i]);
  if (endA > start && endA === a.length && noEol(old)) out.push(marker);
  for (let i = start; i < endB; i++) out.push('+' + b[i]);
  if (endB > start && endB === b.length && noEol(after)) out.push(marker);
  for (let i = endA; i < toA; i++) out.push(' ' + a[i]);
  if (toA > endA && toA === a.length && noEol(old)) out.push(marker);
  const lenA = toA - from, lenB = (start - from) + (endB - start) + (toA - endA);
  const range = (n, len) => (len ? n + 1 : n) + ',' + len;
  return `--- ${before === null ? '/dev/null' : 'a/' + relative}\n+++ b/${relative}\n@@ -${range(from, lenA)} +${range(from, lenB)} @@\n` + out.join('\n') + '\n';
}
function textFile(bytes) {
  if (bytes.includes(0)) fail('BINARY_FILE', 'Use a local program for binary files; text operations accept UTF-8 only');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('INVALID_TEXT_ENCODING', 'This file is not UTF-8; use an explicit local conversion without overwriting the original'); }
}
async function saveFile(info, ctx, request) {
  const target = await projectPath(info, request.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const lock = target + '.claude-bridge-lock';
  try { await fs.mkdir(lock); } catch (e) { if (e.code === 'EEXIST') fail('WRITE_BUSY', 'Another bridge write is in progress'); throw e; }
  try {
    const bytes = await boundedRead(target,2*1024*1024).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (bytes && bytes.length > 2 * 1024 * 1024) fail('FILE_TOO_LARGE', 'Use a local program for files over 2 MiB');
    const expected = bytes === null ? 'absent' : hash(bytes);
    if (request.expectedHash !== expected) fail('FILE_CHANGED', 'Read the current file and use its SHA256 before writing; a new file requires expectedHash=absent');
    const before = bytes === null ? null : textFile(bytes);
    let content = request.content;
    if (request.action === 'edit') {
      if (typeof request.oldText !== 'string' || !request.oldText || typeof request.newText !== 'string' || before === null) fail('INVALID_EDIT', 'edit requires oldText/newText and an existing file');
      if (before.split(request.oldText).length !== 2) fail('AMBIGUOUS_EDIT', 'oldText must match exactly once');
      content = before.replace(request.oldText, () => request.newText);
    }
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2*1024*1024) fail('INVALID_CONTENT', 'Expected UTF-8 text up to 2 MiB');
    if (before === content) return { path: target, sha256: expected, unchanged: true };
    const temp = target + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temp, content);
    const current = await boundedRead(target,2*1024*1024).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if ((current === null ? 'absent' : hash(current)) !== expected) { await fs.unlink(temp); fail('FILE_CHANGED', 'File changed during the write'); }
    await fs.rename(temp, target);
    const change = { path: target, kind: before === null ? 'add' : 'update', unifiedDiff: wholeDiff(path.relative(info.cwd,target), before, content) };
    // The id lets the VPS show this card immediately and skip it at turn end.
    const changeId = randomUUID();
    await record(ctx, info, { kind: 'change', change, id: changeId });
    return { path: target, sha256: hash(content), change, changeId };
  } finally { await fs.rmdir(lock); }
}
const media = new Set(['.mp4','.webm','.mov','.m4v','.mp3','.wav','.ogg','.png','.jpg','.jpeg','.webp','.gif']);
async function artifact(info, ctx, file) {
  const target = await projectPath(info,file), details = await fs.stat(target);
  if (!details.isFile()) fail('INVALID_ARTIFACT', 'Artifact is not a file');
  const label = path.basename(target).replace(/[\[\]]/g,'');
  const destination = target.replaceAll('\\','/');
  const preview = media.has(path.extname(target).toLowerCase());
  const value = { path: target, bytes: details.size, preview, markdown: `${preview ? '!' : ''}[${label}](<${destination}>)`, link: `[打开 ${label}](<${destination}>)` };
  await record(ctx,info,{kind:'artifact',artifact:value});
  return value;
}
async function jobStatus(directory,{includeLogs=true}={}) {
  const value = await json(path.join(directory,'status.json')).catch(e=>e.code==='ENOENT'?{status:'starting'}:Promise.reject(e));
  if (['running','queued'].includes(value.status) && value.runnerPid) {
    // OpenSSH logons can deny PROCESS_TERMINATE even for signal 0. EPERM is
    // not proof of exit. A runner-owned heartbeat also prevents PID reuse from
    // being mistaken for the original task's continued execution.
    const heartbeat=value.runnerToken?await fs.stat(path.join(directory,'heartbeat-'+safeId(value.runnerToken))).catch(()=>null):null;
    if(!heartbeat||Date.now()-heartbeat.mtimeMs>10000){
      try {process.kill(value.runnerPid,0);if(value.runnerToken){value.status='unresponsive';value.error='Local runner heartbeat is stale; execution outcome is unknown. Do not replay the task';}}
      catch(e){if(e.code==='ESRCH'){value.status='interrupted';value.error='Local task runner exited; no replay was submitted';}else{value.liveness='unconfirmed';if(value.runnerToken){value.status='unresponsive';value.error='Local runner heartbeat is stale and process access is unavailable; execution outcome is unknown';}}}
    }
  }
  const uncertain=['unresponsive','interrupted'].includes(value.status);
  let logs={};
  if(includeLogs){const complete=['succeeded','failed','cancelled','interrupted'].includes(value.status);const [out,err]=await Promise.all([jobOutputTail(directory,'stdout',complete),jobOutputTail(directory,'stderr',complete)]);const {content:stdout,...stdoutInfo}=out,{content:stderr,...stderrInfo}=err;logs={stdout,stderr,output:{stdout:stdoutInfo,stderr:stderrInfo}};}
  return {...value,...logs,logs:{stdout:path.join(directory,'stdout.log'),stderr:path.join(directory,'stderr.log')},nextAction:uncertain?'Inspect this task and its output files; do not resubmit':logs.output?.stdout.truncated||logs.output?.stderr.truncated?'Output is a preview only. Use job operation=output with stream and offset=0, then nextOffset, to read the saved output without rerunning. New jobs retain the entire stream; legacy rotated jobs may have missing history.':value.status==='succeeded'?'Open artifacts or read output':['running','starting','queued'].includes(value.status)?'Query or cancel this same requestId':'Read output before deciding on a new task'};
}
async function projectJobs(info){const root=path.join(state,'jobs',info.projectId),ids=await fs.readdir(root).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));const result=[];for(let i=0;i<ids.length;i+=20)result.push(...await Promise.all(ids.slice(i,i+20).map(id=>jobStatus(path.join(root,id),{includeLogs:false}))));return result;}
async function startJob(info,ctx,request) {
  const id=safeId(request.requestId), directory=path.join(state,'jobs',info.projectId,id);
  const environment=await projectEnvironment(info.cwd);
  const workingDirectory=await projectPath(info,request.workingDirectory??'.');
  const spec={project:info,sessionId:ctx.sessionId,parentThread:ctx.parentThread,turnId:ctx.turnId,requestId:id,script:request.script,executable:request.executable,args:request.args,artifacts:request.artifacts ?? [],workingDirectory,environment:environment.env};
  if (!(typeof spec.script==='string' && spec.script.length) && !(typeof spec.executable==='string' && Array.isArray(spec.args) && spec.args.every(x=>typeof x==='string'))) fail('INVALID_COMMAND','run requires a PowerShell script or executable and string args');
  // Session/turn ownership is retained on the job, but reconnecting does not
  // change the identity of the command or cause it to run a second time.
  const fingerprint=hash(JSON.stringify({projectId:info.projectId,requestId:id,script:spec.script,executable:spec.executable,args:spec.args,artifacts:spec.artifacts,...(request.workingDirectory?{workingDirectory}:{} )}));
  await ensureBroker().catch(()=>fail('LOCAL_RUNNER_UNAVAILABLE','The persistent Windows task runner is unavailable; no command was submitted'));
  await fs.mkdir(path.dirname(directory),{recursive:true});
  let created=false;
  try {await fs.mkdir(directory);created=true;} catch(e){if(e.code!=='EEXIST')throw e;}
  if(created){
    await atomic(path.join(directory,'request.json'),{...spec,fingerprint});
    await atomic(path.join(directory,'status.json'),{requestId:id,status:'starting',cwd:info.cwd});
    await brokerRequest('start',{directory});
  }else{
    const saved=await json(path.join(directory,'request.json')).catch(()=>fail('JOB_START_UNKNOWN','Job reservation exists; inspect status instead of resubmitting'));
    if(saved.fingerprint!==fingerprint)fail('REQUEST_ID_CONFLICT','Request ID already belongs to different work');
  }
  const deadline=Date.now()+Math.min(Math.max(Number(request.waitMs)||0,0),30000);
  let result;
  do {result=await jobStatus(directory);if(!['starting','queued','running'].includes(result.status)||Date.now()>=deadline)break;await sleep(150);}while(true);
  return {...result,requestId:id,reused:!created};
}
function cleanEnv(){const env={...process.env};for(const key of Object.keys(env))if(/^CODEXHOST_RUNTIME_|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key))delete env[key];return env;}
async function runJob(directory){
  const spec=await json(path.join(directory,'request.json'));
  const info=await verifyProject(spec.project.cwd,spec.project.projectId);
  const startedAt=new Date().toISOString();
  let status={requestId:spec.requestId,status:'running',cwd:info.cwd,runnerPid:process.pid,runnerToken:randomUUID(),startedAt};
  if (await fs.access(path.join(directory,'cancel')).then(()=>true,()=>false)) {
    await atomic(path.join(directory,'status.json'), {...status,status:'cancelled',completedAt:new Date().toISOString()}); return;
  }
  const heartbeat=path.join(directory,'heartbeat-'+status.runnerToken);await fs.writeFile(heartbeat,'');
  const beat=setInterval(()=>{const now=new Date();void fs.utimes(heartbeat,now,now).catch(()=>{});},1000);
  let queued=false,lease;
  try{lease=await acquireWriter(state,await writerScope(state,info.projectId,spec.parentThread),{kind:'job',requestId:spec.requestId,waitMs:24*60*60*1000,
    isCancelled:()=>fs.access(path.join(directory,'cancel')).then(()=>true,()=>false),
    onWait:async()=>{if(!queued){queued=true;await atomic(path.join(directory,'status.json'),{...status,status:'queued',reason:'Waiting for the current project writer'});}}
  });}catch(e){clearInterval(beat);if(e.code==='CANCELLED'){await atomic(path.join(directory,'status.json'),{...status,status:'cancelled',completedAt:new Date().toISOString()});return;}throw e;}
  let child,ending,termination,terminationReason,terminationConfirmed=false,terminationError,processFinished=false;
  function terminate(reason){
    if(termination)return termination;terminationReason=reason;
    termination=stopProcessTree(child).then(killed=>{terminationConfirmed=killed;},e=>{terminationError=e;});return termination;
  }
  try{
  const out=boundedLog(path.join(directory,'stdout.log')),err=boundedLog(path.join(directory,'stderr.log'));
  const args=spec.script ? ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $LASTEXITCODE=0; trap { [Console]::Error.WriteLine($_.ToString()); exit 1 };\n"+spec.script+"\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",'utf16le').toString('base64')] : spec.args;
  child=spawnOwnedProcess(spec.script?pwsh:spec.executable,args,{cwd:spec.workingDirectory??info.cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...cleanEnv(),...spec.environment}});
  let logError;const logDone=Promise.all([finished(out),finished(err)]).catch(async e=>{logError=e;await terminate('log-failure');});
  child.stdout.pipe(out);child.stderr.pipe(err);
  let killPending=false;
  ending=new Promise(resolve=>{child.once('error',e=>resolve({code:-1,error:e.message}));child.once('close',(code,signal)=>{processFinished=true;resolve({code,signal});});});
  status.childPid=child.pid;
  await atomic(path.join(directory,'status.json'),status);
  const poll=setInterval(async()=>{if(killPending)return;try{await fs.access(path.join(directory,'cancel'));}catch{return;}killPending=true;await terminate('cancel');},150);
  const result=await ending;clearInterval(poll);clearInterval(beat);
  await logDone;await termination;
  status={...status,status:terminationReason==='cancel'&&terminationConfirmed?'cancelled':result.code===0&&!logError?'succeeded':'failed',exitCode:result.code,completedAt:new Date().toISOString(),logRetention:{stdout:out.stats(),stderr:err.stats()},...(terminationError?{cancellationWarning:'Process-tree termination was not confirmed: '+terminationError.message}:{}),...(result.error||logError?{error:result.error??logError.message}:{})};
  if(status.status==='succeeded'){
    try { status.artifacts=[];for(const file of spec.artifacts)status.artifacts.push(await artifact(info,spec,file)); }
    catch(e){status.artifactStatus='unavailable';status.artifactError='Command succeeded, but output verification failed: '+e.message;}
  }
  await atomic(path.join(directory,'status.json'),status);
  }finally{
    clearInterval(beat);
    if(child&&!processFinished){await terminate('runner-failure');if(terminationConfirmed){let timer;try{await Promise.race([ending,new Promise(resolve=>timer=setTimeout(resolve,10000))]);}finally{clearTimeout(timer);}}}
    // Retain uncertain ownership; a dead runner is not proof its children stopped.
    if(!child||processFinished||(!child.pid&&child.exitCode!==null))await lease.release();
  }
}
export async function cancelSessionJobs(sessionId,turnId){
  const ctx=await json(path.join(state,'sessions',safeId(sessionId)+'.json'));
  const root=path.join(state,'jobs',ctx.projectId), cancelled=[];
  const ids=await fs.readdir(root).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));
  for(const id of ids){const directory=path.join(root,id),spec=await json(path.join(directory,'request.json'));if(spec.sessionId!==sessionId||(turnId&&spec.turnId!==turnId))continue;const before=await jobStatus(directory);if(['running','starting','queued','unresponsive'].includes(before.status)){await fs.writeFile(path.join(directory,'cancel'),'cancel');cancelled.push(id);}}
  const deadline=Date.now()+12000;
  while(cancelled.length&&Date.now()<deadline){const states=await Promise.all(cancelled.map(id=>jobStatus(path.join(root,id))));if(states.every(s=>!['running','starting','queued','unresponsive'].includes(s.status)))return states;await sleep(150);}
  const states=await Promise.all(cancelled.map(id=>jobStatus(path.join(root,id))));
  if(states.some(s=>['running','starting','queued','unresponsive'].includes(s.status)))fail('CANCEL_UNCONFIRMED','Some Windows jobs have not confirmed cancellation');
  return states;
}
export async function handle(request){
  if(request.action==='batch'){
    const requests=readBatch(request);
    return {bridge:'windows-workspace-v1',ok:true,data:await Promise.all(requests.map(r=>handle({...r,cwd:request.cwd,projectId:request.projectId,sessionId:request.sessionId})))};
  }
  const info=await verifyProject(request.cwd||process.cwd(),request.projectId),ctx=await contextFor(request,info);
  const environment=await projectEnvironment(info.cwd);
  const decision=permissionDecision(environment,request,ctx.permissionMode??environment.defaultMode??'default');
  if(decision.decision==='deny')fail('PERMISSION_DENIED',decision.reason);
  let data;
  try{
  switch(request.action){
    case 'status': {const {token,...writer}=await writerStatus(state,info.projectId);data={project:info,writer,permissionMode:ctx.permissionMode??environment.defaultMode??'default',configurationFingerprint:environment.fingerprint,loadedRules:(await applicableRules(environment)).map(r=>r.path),capabilities:environment.capabilities.map(({id,description,path})=>({id,description,path})),compatibilityNotices:environment.warnings.filter(w=>w.kind!=='local-only'),localOnlySettings:environment.warnings.filter(w=>w.kind==='local-only'),jobs:await projectJobs(info),runner:await brokerRequest('ping').then(r=>({available:true,pid:r.pid}),e=>({available:false,error:e.message})),connection:'This response arrived through the current bridge; jobs persist independently of it.'};break;}
    case 'info': {
      data={...info,instructions:await applicableRules(environment,request.path??'.'),capabilities:environment.capabilities,compatibility:environment.warnings.filter(w=>w.kind!=='local-only'),localOnlySettings:environment.warnings.filter(w=>w.kind==='local-only'),fingerprint:environment.fingerprint,permissionMode:ctx.permissionMode??environment.defaultMode??'default'};break;
    }
    case 'capability': data=await capability(environment,request.id,request.path);if(data.disableModelInvocation&&!(ctx.invokedCapabilities??[]).includes(request.id))fail('USER_INVOCATION_REQUIRED','This capability requires an explicit /'+data.name+' user invocation');break;
    case 'context': data={text:await environmentContext(environment,{target:request.path??'.'}),fingerprint:environment.fingerprint};break;
    case 'read': {const file=await projectPath(info,request.path),bytes=await boundedRead(file,2*1024*1024);const lines=textFile(bytes).split('\n');const offset=Math.max(0,Number(request.offset)||0),limit=Math.min(1000,Math.max(1,Number(request.limit)||300));data={path:file,sha256:hash(bytes),offset,totalLines:lines.length,content:lines.slice(offset,offset+limit).join('\n'),truncated:offset+limit<lines.length};break;}
    case 'list': {const root=await projectPath(info,request.path);const entries=await fs.readdir(root,{withFileTypes:true});const visible=entries.filter(x=>{const d=permissionDecision(environment,{...request,path:path.join(root,x.name)},ctx.permissionMode??environment.defaultMode);return d.decision!=='deny'&&(d.decision!=='ask'||d.reason===decision.reason);});data={path:root,entries:visible.map(x=>({name:x.name,kind:x.isDirectory()?'directory':x.isFile()?'file':'link'})),excludedEntries:entries.length-visible.length};break;}
    case 'search': {const root=await projectPath(info,request.path);data=await searchWorkspace({state,info,environment,mode:ctx.permissionMode??environment.defaultMode,root},request);break;}
    case 'write': case 'edit': data=await withWriter(state,await writerScope(state,info.projectId,ctx.parentThread),{kind:request.action,requestId:request.requestId},()=>saveFile(info,ctx,request));break;
    case 'artifact': data=await artifact(info,ctx,request.path);break;
    case 'run': data=await startJob(info,ctx,request);break;
    case 'job': {
      if(!['status','cancel','output'].includes(request.operation??'status'))fail('INVALID_JOB_OPERATION','Use status, cancel or output');
      const directory=path.join(state,'jobs',info.projectId,safeId(request.requestId));
      await fs.access(path.join(directory,'request.json')).catch(()=>fail('JOB_NOT_FOUND','No task with this request ID exists in this project'));
      if(request.operation==='output'){const status=await jobStatus(directory,{includeLogs:false});data=await readJobOutput(directory,{...request,complete:['succeeded','failed','cancelled','interrupted'].includes(status.status)});break;}
      if(request.operation==='cancel')await fs.writeFile(path.join(directory,'cancel'),'cancel');
      const deadline=Date.now()+Math.min(30000,Math.max(0,Number(request.waitMs)||0));
      do{data=await jobStatus(directory);if(!['running','starting','queued'].includes(data.status)||Date.now()>=deadline)break;await sleep(150);}while(true);
      if(data.status==='succeeded')for(const value of data.artifacts??[])await artifact(info,ctx,value.path);break;
    }
    case 'jobs': data=await projectJobs(info);break;
    case 'isolation': {
      if(request.operation==='status'){data=await workspaceIsolation(state,info,request);break;}
      const ids=[info.projectId];
      if(request.operation==='apply'){const candidate=await workspaceIsolation(state,info,{...request,operation:'status'});ids.push((await projectInfo(candidate.cwd)).projectId);}
      data=await withWriters(state,ids,{kind:'isolation',requestId:request.requestId},()=>workspaceIsolation(state,info,request));break;
    }
    case 'agent': {
      if(request.nativeAction&&!['resolve','native-read'].includes(request.nativeAction))fail('INVALID_ARGUMENT','nativeAction accepts only explicit read-only history operations');
      let argv=[...(request.argv??[])];
      let agentInfo=info,agentEnvironment=environment;
      if(request.isolationId){const isolated=await workspaceIsolation(state,info,{operation:'status',requestId:request.isolationId});agentInfo=await projectInfo(isolated.cwd);agentEnvironment=await projectEnvironment(agentInfo.cwd);}
      const bound=boundAgentArguments(argv,{parentThread:ctx.parentThread,cwd:agentInfo.cwd});argv=bound.argv;
      const taskFlag=argv[0]==='delegate'&&argv[1]==='start'?'--task':argv[0]==='thread'&&argv[1]==='send'?'--message':null;
      if(taskFlag&&!argv.includes('--help')){
        const index=argv.indexOf(taskFlag);if(index<0||typeof argv[index+1]!=='string')fail('INVALID_ARGUMENT','A delegation requires an explicit task');
        let context=await environmentContext(agentEnvironment);if(request.id){const definition=await capability(agentEnvironment,request.id);if(definition.kind!=='agent')fail('INVALID_AGENT','Expected an agent definition');context+='\nLocal agent definition:\n'+definition.content;}
        argv[index+1]=context+'\n\nDelegated task (execute locally and report files, checks, and unresolved issues):\n'+argv[index+1];
      }
      const execute=async actualArgv=>{const payload={action:request.nativeAction??'cli',argv:actualArgv,parentThread:bound.parentThread,...(request.nativeAction?{harness:request.harness,nativeSessionId:request.nativeSessionId,view:request.view,cursor:request.cursor,limit:request.limit}:{})};const encoded=Buffer.from(JSON.stringify(payload)).toString('base64');const result=await exec(pwsh,['-NoLogo','-NoProfile','-File',path.join(here,'runtime-context','Invoke-CodexHostBridge.ps1'),'-RequestBase64',encoded],{cwd:agentInfo.cwd,windowsHide:true,timeout:65000,maxBuffer:2*1024*1024});return request.argv?.some(arg=>['--help','-h'].includes(arg))||(!request.argv?.length&&!request.nativeAction)?{text:result.stdout}:JSON.parse(result.stdout);};
      data=request.nativeAction?await execute(argv):await coordinatedAgent(state,agentInfo,argv,execute,{requestId:request.bridgeRequestId??request.requestId});
      if(request.isolationId)data={...data,isolationId:request.isolationId,workspace:agentInfo.cwd};
      if(taskFlag)await record(ctx,info,{kind:'delegation',harness:argv[argv.indexOf('--harness')+1],result:data});break;
    }
    default:fail('UNKNOWN_ACTION','Use info/read/list/search/write/edit/run/job/jobs/artifact/agent');
  }
  }catch(error){await runHooks(environment,'PostToolUseFailure',{session_id:ctx.sessionId,tool_name:operation(request,info.cwd).tool,tool_input:operation(request,info.cwd).input,error:error.message}).catch(()=>{});throw error;}
  const hooks=await runHooks(environment,'PostToolUse',{session_id:ctx.sessionId,tool_name:operation(request,info.cwd).tool,tool_input:operation(request,info.cwd).input,tool_response:data}).catch(error=>[{warning:'Operation completed, but PostToolUse hook failed: '+error.message}]);
  return {bridge:'windows-workspace-v1',ok:true,projectId:info.projectId,cwd:info.cwd,data,...(hooks.length?{hookResults:hooks}:{})};
}
export async function control(request){
  const info=await verifyProject(request.cwd,request.projectId);
  if(request.action==='prepare-steer'){
    const ctx=await contextFor(request,info);if(!ctx.sessionId||ctx.turnId!==request.turnId)fail('INVALID_STEER_TARGET','追加指令不属于当前本机轮次');
    const environment=await control({...request,action:'environment'});
    const hooks=await control({...request,action:'lifecycle',event:'UserPromptSubmit',payload:{prompt:request.prompt}});
    return {environment,hooks};
  }
  if(request.action==='prepare-turn'){
    // Same ordered operations and refusal points, one network request. A hook
    // failure leaves the native turn unsubmitted just as in the separate path.
    await control({...request,action:'turn'});
    const environment=await control({...request,action:'environment'});
    const hooks=await control({...request,action:'lifecycle',event:'UserPromptSubmit',payload:{prompt:request.prompt}});
    return {environment,hooks};
  }
  if(request.action==='mcp'){
    const ctx=await contextFor(request,info);if(!ctx.sessionId)fail('SESSION_MISSING','MCP requires a bound session');
    const call=request.frame?.method==='tools/call',environment=call?await projectEnvironment(info.cwd):null;
    const op=call?{action:'mcp-call',tool:'mcp__playwright__'+request.frame.params?.name,arguments:request.frame.params?.arguments}:null;
    if(call&&permissionDecision(environment,op,ctx.permissionMode??'default').decision==='deny')fail('PERMISSION_DENIED','Current project policy denies this MCP call');
    const result=await mcpRequest(request,info);
    if(call)await runHooks(environment,result.error||result.result?.isError?'PostToolUseFailure':'PostToolUse',{session_id:ctx.sessionId,tool_name:op.tool,tool_input:op.arguments,tool_response:result.result??result.error});
    if(call&&op.tool==='mcp__playwright__browser_take_screenshot'&&op.arguments?.filename&&!result.error&&!result.result?.isError){
      const saved=await artifact(info,ctx,op.arguments.filename);result.result.content.push({type:'text',text:'Verified Windows screenshot: '+saved.markdown+'\n'+saved.link});
    }
    return result;
  }
  if(request.action==='bind'){if(request.resume){const ctx=await contextFor(request,info);if(!ctx.sessionId)fail('SESSION_MISSING','No persisted local session to restore');if(!ctx.parentThread&&request.parentThread){ctx.parentThread=request.parentThread;await atomic(path.join(state,'sessions',safeId(request.sessionId)+'.json'),ctx);}}else await bindSession(request.sessionId,info,request.parentThread);return info;}
  if(request.action==='turn'){await contextFor(request,info);await setTurn(request.sessionId,request.turnId);return info;}
  if(request.action==='model-observation'){
    const ctx=await contextFor(request,info),value=request.observation;
    if(!ctx.sessionId||!ctx.turnId||value?.turnId!==ctx.turnId||value.source!=='remote-response-usage'||!Array.isArray(value.models)||!value.models.length||value.models.length>32||value.models.some(m=>typeof m!=='string'||!m||m.length>512||/[\r\n\0]/.test(m)))fail('INVALID_MODEL_OBSERVATION','模型记录不属于当前轮次');
    await atomic(path.join(state,'models',safeId(ctx.sessionId)+'.json'),value);return {saved:true};
  }
  if(request.action==='events'){await contextFor(request,info);return turnItems(request.sessionId,request.turnId);}
  if(request.action==='history-events'){
    await contextFor(request,info);
    await contextFor({...request,sessionId:safeId(request.sourceSessionId)},info);
    return turnItems(request.sourceSessionId,request.turnId);
  }
  if(request.action==='cancel-jobs'){await contextFor(request,info);return cancelSessionJobs(request.sessionId,request.turnId);}
  if(request.action==='environment'){
    const environment=await projectEnvironment(info.cwd),ctx=await contextFor(request,info);
    const rules=await applicableRules(environment);
    ctx.presentedRules=rules.map(r=>r.path+':'+r.sha256);await atomic(path.join(state,'sessions',safeId(request.sessionId)+'.json'),ctx);
    const entries=[{id:'workspace',text:'Project: '+info.cwd+'\nRules apply within their scope; the current user request is authoritative.'},...rules.map(r=>({id:'rule:'+r.path+'|'+r.scope,text:'Rule '+r.path+' (scope '+r.scope+'):\n'+r.content})),{id:'catalog',text:(await environmentContext(environment,{includeRules:false})).replace(/^Configuration fingerprint: .*\n/m,'')}];
    const contextEntries=entries.map(e=>({...e,sha:hash(e.text)}));
    return {fingerprint:environment.fingerprint,text:await environmentContext(environment),contextEntries,capabilities:environment.capabilities,defaultMode:environment.defaultMode,warnings:environment.warnings,ruleFiles:environment.rules.map(({path,paths,scope,sha256})=>({path,paths,scope,sha256})),jobs:await projectJobs(info)};
  }
  if(request.action==='permission'){await contextFor(request,info);await setMode(request.sessionId,request.mode);return {mode:request.mode};}
  if(request.action==='capability-context'){const ctx=await contextFor(request,info);ctx.invokedCapabilities=[...new Set([...(ctx.invokedCapabilities??[]),request.id])];await atomic(path.join(state,'sessions',safeId(request.sessionId)+'.json'),ctx);return capability(await projectEnvironment(info.cwd),request.id);}
  if(request.action==='attachments'){const ctx=await contextFor(request,info);ctx.attachments=[...new Set([...(ctx.attachments??[]),...await Promise.all((request.paths??[]).map(p=>fs.realpath(p)))])];await atomic(path.join(state,'sessions',safeId(request.sessionId)+'.json'),ctx);return {count:ctx.attachments.length};}
  if(request.action==='media-export'){const ctx=await contextFor(request,info),environment=await projectEnvironment(info.cwd),decision=permissionDecision(environment,{action:'media',path:request.path},ctx.permissionMode);if(decision.decision==='deny')fail('PERMISSION_DENIED',decision.reason);return exportMedia(info,ctx,request);}
  if(request.action==='preflight'){
    if(request.request?.action==='batch'){
      const decisions=[];for(const item of readBatch(request.request))decisions.push(await control({...request,request:item}));
      const priority=['deny','ask','inherit','allow'];const decision=priority.find(d=>decisions.some(v=>v.decision===d))??'deny';
      return {decision,reason:decisions.filter(d=>d.decision===decision).map(d=>d.reason).join('\n'),additionalContext:[...new Set(decisions.map(d=>d.additionalContext??'').filter(Boolean))].join('\n')};
    }
    const ctx=await contextFor(request,info),environment=await projectEnvironment(info.cwd),operationRequest=request.request;
    if(!operationRequest||typeof operationRequest.action!=='string')fail('INVALID_OPERATION','Missing structured Windows operation');
    const mode=request.permissionMode??ctx.permissionMode??environment.defaultMode??'default';
    await setMode(request.sessionId,mode);
    const decision=permissionDecision(environment,operationRequest,mode);if(decision.decision==='deny')return decision;
    const op=operation(operationRequest,info.cwd),hooks=await runHooks(environment,'PreToolUse',{session_id:ctx.sessionId,permission_mode:mode,tool_name:op.tool,tool_input:op.input});
    for(const h of hooks){const d=h.hookSpecificOutput?.permissionDecision;if(d==='deny')return {decision:'deny',reason:h.hookSpecificOutput.permissionDecisionReason??'Local hook denied the operation'};if(d==='ask')decision.decision='ask';}
    const rules=typeof operationRequest.path==='string'&&inside(info.cwd,path.resolve(info.cwd,operationRequest.path))?await applicableRules(environment,operationRequest.path):[];
    const unseen=rules.filter(r=>!(ctx.presentedRules??[]).includes(r.path+':'+r.sha256));
    if(unseen.length){const latest=await contextFor(request,info);latest.presentedRules=[...new Set([...(latest.presentedRules??[]),...unseen.map(r=>r.path+':'+r.sha256)])];await atomic(path.join(state,'sessions',safeId(request.sessionId)+'.json'),latest);if(op.mutating)return {decision:'deny',reason:'New or changed applicable rules must be considered before changing this file. No operation ran. Read these rules, revise the operation if needed, then submit it again:\n'+unseen.map(r=>r.path+'\n'+r.content).join('\n')};}
    // Turn start resets presentedRules, so each rule reaches the model once per
    // turn instead of riding along with every tool call.
    return {...decision,additionalContext:[...unseen.map(r=>'Applicable local rule '+r.path+':\n'+r.content),...hooks.map(h=>h.hookSpecificOutput?.additionalContext??h.additionalContext??'')].filter(Boolean).join('\n')};
  }
  if(request.action==='lifecycle'){await contextFor(request,info);return runHooks(await projectEnvironment(info.cwd),request.event,{session_id:request.sessionId,...request.payload});}
  fail('UNKNOWN_CONTROL','Unsupported bridge control operation');
}
function readBatch(request){
  if(!Array.isArray(request.requests)||request.requests.length<1||request.requests.length>20)fail('INVALID_BATCH','Read batch requires 1 to 20 operations');
  for(const r of request.requests)if(!r||!['read','list','search','info'].includes(r.action)||['cwd','projectId','sessionId','parentThread'].some(key=>key in r))fail('INVALID_BATCH','Batch accepts only bound read/list/search/info operations');
  return request.requests;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv[2]==='--job'){await runJob(process.argv[3]);}else{const internal=process.argv[2]==='--control';const request=JSON.parse(Buffer.from(process.argv[internal?3:2],'base64').toString('utf8'));console.log(JSON.stringify(internal?await control(request):await handle(request)));}}
  catch(e){if(process.argv[2]==='--job')await atomic(path.join(process.argv[3],'status.json'),{requestId:path.basename(process.argv[3]),status:'failed',error:e.message,completedAt:new Date().toISOString()}).catch(()=>{});console.error(JSON.stringify({bridge:'windows-workspace-v1',ok:false,error:{code:e.code||'EXECUTION_FAILED',message:e.message}}));process.exitCode=1;}
}
