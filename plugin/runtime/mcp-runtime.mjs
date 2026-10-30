// Session-scoped stdio MCP over the existing authenticated tool channel.
import {spawn,execFile} from 'node:child_process';
import {JsonWriter,readJsonLines} from '../transport-streams.mjs';
import {getBridgeConfig} from './bridge-config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const passive=new Set(['browser_snapshot','browser_console_messages','browser_network_requests']);
const excluded=new Set(['browser_run_code','browser_run_code_unsafe','browser_install']);
async function readSnapshotText(file){
  const handle=await fs.open(file,'r'),bytes=Buffer.allocUnsafe(128*1024+1);let used=0;
  try{while(used<bytes.length){const result=await handle.read(bytes,used,bytes.length-used,used);if(!result.bytesRead)break;used+=result.bytesRead;}return used>128*1024?null:bytes.subarray(0,used).toString('utf8');}
  finally{await handle.close();}
}
async function includeSnapshot(reply,cwd,output,maxBytes){
  let remaining=Math.max(0,maxBytes-Buffer.byteLength(JSON.stringify(reply))),snapshots=0;
  for(const block of reply.result?.content??[]){
    if(block.type!=='text')continue;
    const match=block.text.match(/\[Snapshot\]\(([^\r\n)]+)\)/);if(!match)continue;
    if(snapshots>=4||remaining<1024)continue;
    snapshots++;
    try{
      const file=await fs.realpath(path.resolve(cwd,match[1])),root=await fs.realpath(output),rel=path.relative(root,file);
      if(rel.startsWith('..')||path.isAbsolute(rel)||path.extname(file)!=='.yml')throw new Error('Snapshot path is outside the browser output directory');
      const st=await fs.stat(file);
      if(st.size>128*1024){const note='\nSnapshot is saved locally; use browser_snapshot with a depth limit to inspect a smaller view.';block.text+=note;remaining-=Buffer.byteLength(note);continue;}
      const text=await readSnapshotText(file);if(text===null)continue;
      const addition='\n### Current page snapshot\n```yaml\n'+text+'\n```';
      const size=Buffer.byteLength(JSON.stringify(addition));if(size>remaining)continue;block.text+=addition;remaining-=size;
    }catch(e){const note='\nSnapshot could not be included: '+String(e.message).slice(0,400),size=Buffer.byteLength(JSON.stringify(note));if(size<=remaining){block.text+=note;remaining-=size;}}
  }
  return reply;
}
export function mcpOperation(request){
  if(!/^mcp__(tavily|playwright)__[a-zA-Z0-9_]+$/.test(request.tool??''))throw new Error('Unconfigured MCP tool');
  const [,server,name]=request.tool.split('__');
  if(server==='tavily'&&!['tavily_search','tavily_extract','tavily_crawl','tavily_map','tavily_research'].includes(name))throw new Error('Unconfigured Tavily tool');
  if(server==='playwright'&&(!name.startsWith('browser_')||excluded.has(name)))throw new Error('Unsupported browser tool');
  return {tool:request.tool,input:request.arguments??{},mutating:server==='playwright'&&(!passive.has(name)||!!request.arguments?.filename),file:'',command:''};
}
const expired=()=>new Error('Browser connection expired; reconnect MCP before calling a tool. No call was replayed');
export function validateMcpLimits(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Browser lifecycle options must be an object');
  const defaults={idleTimeoutMs:600000,requestTimeoutMs:95000,maxClients:8,maxPendingPerClient:32,maxFrameBytes:8*1024*1024};
  const bounds={idleTimeoutMs:[0,86400000],requestTimeoutMs:[1,300000],maxClients:[1,64],maxPendingPerClient:[1,256],maxFrameBytes:[1024,48*1024*1024]};
  const result={...defaults,...value};
  for(const key of Object.keys(value))if(!Object.hasOwn(bounds,key))throw new Error('Unsupported browser lifecycle option: '+key);
  for(const [key,[min,max]] of Object.entries(bounds))if(!Number.isSafeInteger(result[key])||result[key]<min||result[key]>max)throw new Error('Invalid browser lifecycle option '+key+'; expected integer '+min+'..'+max);
  return result;
}
function killProcessTree(child){
  if(process.platform==='win32'&&child.pid)execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});
  else child.kill();
}
export function createMcpRuntime({spawnProcess=spawn,terminateProcess=killProcessTree,limits:settings={},runtimeDir=here,nodeExecutable=process.execPath}={}){
const limits=validateMcpLimits(settings),clients=new Map(),opening=new Map(),closing=new Set();
function idle(key,c){
  clearTimeout(c.idle);
  if(limits.idleTimeoutMs&&c.pending.size===0&&clients.get(key)===c){c.idle=setTimeout(()=>{if(c.pending.size===0)stop(key,new Error('Browser MCP idle connection expired; reconnect before calling a tool'),c);},limits.idleTimeoutMs);c.idle.unref();}
}
function stop(key,error=new Error('Browser MCP closed; pending outcome unknown, no operation was replayed'),expected,exited=false){
  const c=clients.get(key);if(!c||(expected&&c!==expected))return;
  clients.delete(key);clearTimeout(c.idle);c.reader?.dispose();c.writer?.dispose();
  for(const p of c.pending.values()){clearTimeout(p.timer);p.reject(error);}c.pending.clear();
  if(!exited&&c.child.exitCode===null){
    closing.add(c);try{c.child.stdin.end();}catch{}
    c.killTimer=setTimeout(()=>terminateProcess(c.child),3000);c.killTimer.unref();
  }
}
function closeSession(sessionId){
  for(const item of opening.values())if(item.sessionId===sessionId)item.cancelled=true;
  for(const [key,c] of clients)if(c.sessionId===sessionId)stop(key);
}
async function request(request,info){
  if(request.server!=='playwright'||!/^[-_a-zA-Z0-9]{1,100}$/.test(request.sessionId??'')||!/^[-a-zA-Z0-9]{1,100}$/.test(request.connectionId??''))throw new Error('Invalid MCP binding');
  const key=request.sessionId+':'+request.connectionId;
  if(clients.has(key)&&clients.get(key).projectId!==info.projectId)throw new Error('Browser project binding differs');
  if(request.close){const item=opening.get(key);if(item)item.cancelled=true;stop(key);return {};}
  const frame=request.frame;
  if(!frame||frame.jsonrpc!=='2.0'||!['initialize','notifications/initialized','ping','tools/list','tools/call','resources/list','resources/templates/list','prompts/list'].includes(frame.method))throw new Error('Unsupported MCP method');
  if(frame.method!=='notifications/initialized'&&!(typeof frame.id==='string'&&frame.id.length>0&&frame.id.length<=200||typeof frame.id==='number'&&Number.isSafeInteger(frame.id)))throw new Error('MCP requests require a bounded string or integer identity');
  if(['resources/list','resources/templates/list','prompts/list'].includes(frame.method))return {jsonrpc:'2.0',id:frame.id,result:{[frame.method==='resources/templates/list'?'resourceTemplates':frame.method.split('/')[0]]:[]}};
  let c=clients.get(key);
  if(!c){
    if(frame.method!=='initialize')throw expired();
    if(opening.has(key))throw new Error('Browser initialization already in progress; no duplicate process was started');
    if(clients.size+opening.size+closing.size>=limits.maxClients)throw new Error('Browser connection capacity reached; close an idle browser before creating another');
    const reservation={sessionId:request.sessionId};opening.set(key,reservation);
    try{
    const env={...process.env};for(const k of Object.keys(env))if(/TOKEN|SECRET|API_KEY|ANTHROPIC|CLAUDE|CODEXHOST|NODE_OPTIONS/i.test(k))delete env[k];
    const output=path.join(info.cwd,'.claude-vps','browser',request.sessionId);
    await fs.mkdir(output,{recursive:true});
    if(reservation.cancelled)throw new Error('Browser initialization was cancelled; no process was started');
    const child=spawnProcess(nodeExecutable,[path.join(runtimeDir,'node_modules','@playwright','mcp','cli.js'),'--browser','chrome','--isolated','--output-dir',output,'--timeout-navigation','45000'],{cwd:info.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    c={child,sessionId:request.sessionId,projectId:info.projectId,pending:new Map(),tools:new Set(),stderr:'',initialized:false};clients.set(key,c);
    child.stderr.on('data',b=>c.stderr=(c.stderr+b).slice(-2000));
    child.on('error',error=>stop(key,error,c,true));
    child.on('exit',()=>{clearTimeout(c.killTimer);closing.delete(c);stop(key,new Error('Browser MCP exited; pending outcome unknown, no operation was replayed'),c,true);});
    child.stdin.on('error',error=>stop(key,error,c));
    c.writer=new JsonWriter(child.stdin,{maxBytes:limits.maxFrameBytes,maxQueueBytes:limits.maxFrameBytes*2,onError:error=>stop(key,error,c)});
    c.reader=readJsonLines(child.stdout,reply=>{
      try{if(reply.jsonrpc!=='2.0')throw new Error('Invalid browser MCP response');const p=c.pending.get(reply.id);if(!p)return;
        if(p.method==='initialize'&&!reply.error)c.initialized=true;
        if(p.method==='tools/list'&&reply.result?.tools){reply.result.tools=reply.result.tools.filter(t=>!excluded.has(t.name));c.tools=new Set(reply.result.tools.map(t=>t.name));}
        void includeSnapshot(reply,info.cwd,output,limits.maxFrameBytes).then(value=>{if(c.pending.get(reply.id)!==p)return;c.pending.delete(reply.id);clearTimeout(p.timer);p.resolve(value);idle(key,c);},error=>stop(key,error,c));
      }catch(error){stop(key,error,c);}
    },{maxBytes:limits.maxFrameBytes,onError:error=>stop(key,error,c),onEnd:()=>stop(key,new Error('Browser MCP output closed; pending outcome unknown, no replay was submitted'),c)});
    }finally{opening.delete(key);}
  }else if(frame.method==='initialize'){
    throw new Error('Browser is already initialized or initializing; use a new connection identity');
  }
  if(c.projectId!==info.projectId)throw new Error('Browser project binding differs');
  if(frame.method!=='initialize'&&!c.initialized)throw new Error('Wait for browser initialization before issuing another request');
  if(frame.method==='tools/call'){
    if(!c.tools.has(frame.params?.name))throw new Error('Tool not present in the discovered browser catalog');
    mcpOperation({tool:'mcp__playwright__'+frame.params.name,arguments:frame.params.arguments});
  }
  // This proxy intentionally exposes tools only; do not advertise host callbacks.
  const outgoing=frame.method==='initialize'?{...frame,params:{...frame.params,capabilities:{}}}:frame;
  if(frame.id===undefined){try{clearTimeout(c.idle);c.writer.send(outgoing);idle(key,c);return {};}catch(error){stop(key,error,c);throw error;}}
  if(c.pending.has(frame.id))throw new Error('Duplicate MCP request id');
  if(c.pending.size>=limits.maxPendingPerClient){idle(key,c);throw new Error('Browser request capacity reached; no call was submitted');}
  clearTimeout(c.idle);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>stop(key,new Error('Browser MCP timed out; outcome unknown, connection closed and no replay was submitted'),c),limits.requestTimeoutMs);
    c.pending.set(frame.id,{resolve,reject,timer,method:frame.method});
    try{c.writer.send(outgoing);}catch(error){stop(key,error,c);}
  });
}
return {request,closeSession,close(){for(const item of opening.values())item.cancelled=true;for(const key of clients.keys())stop(key);},inspect(){return {clients:clients.size,opening:opening.size,closing:closing.size,pending:[...clients.values()].reduce((n,c)=>n+c.pending.size,0)};}};
}
let runtime;
export function mcpRequest(request,info){runtime??=createMcpRuntime({limits:getBridgeConfig().optionalTools?.playwright??{}});return runtime.request(request,info);}
export function closeMcpSession(sessionId){runtime?.closeSession(sessionId);}
