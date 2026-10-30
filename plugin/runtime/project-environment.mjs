import {getBridgeConfig} from './bridge-config.mjs';
// Local configuration is interpreted here. Credentials and provider settings never leave Windows.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnOwnedProcess,stopProcessTree} from './process-tree.mjs';
import {parse as parseYaml} from 'yaml';
import picomatch from 'picomatch';
import {mcpOperation} from './mcp-runtime.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const slash=value=>value.replaceAll('\\','/');
const missing=error=>{if(error.code==='ENOENT')return null;throw error;};
const error=(code,message)=>{throw Object.assign(new Error(message),{code});};
const maxText=512*1024;
const sensitive=/ANTHROPIC|OPENAI|API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BASE_URL|AUTH|CODEXHOST|CLAUDE_CODE|NODE_OPTIONS|NODE_PATH|PYTHONPATH/i;
export const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
async function textFile(file){const b=await fs.readFile(file).catch(missing);if(b===null)return null;if(b.length>maxText)error('CONFIG_TOO_LARGE',file+' exceeds 512 KiB; split the rule instead of silently truncating');return new TextDecoder('utf-8',{fatal:true}).decode(b);}
export function frontmatter(text){const match=text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);if(!match)return {meta:{},body:text};const meta=parseYaml(match[1],{maxAliasCount:20});if(meta!==null&&(typeof meta!=='object'||Array.isArray(meta)))error('INVALID_FRONTMATTER','Expected a YAML mapping');return {meta:meta??{},body:text.slice(match[0].length)};}
async function markdownFiles(root,seen=new Set()){
  const actual=await fs.realpath(root).catch(missing);if(!actual||seen.has(actual))return [];seen.add(actual);
  const results=[];for(const entry of (await fs.readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(root,entry.name);if(entry.isDirectory()||entry.isSymbolicLink()){const st=await fs.stat(file).catch(missing);if(st?.isDirectory())results.push(...await markdownFiles(file,seen));else if(st?.isFile()&&file.endsWith('.md'))results.push(file);}else if(entry.isFile()&&file.endsWith('.md'))results.push(file);if(results.length>500)error('CONFIG_TOO_MANY_FILES','More than 500 rule files in '+root);}
  return results;
}
// Root and scoped rules share resolution, metadata, cycle and depth semantics.
function ruleLoader(home,rules){
  const visited=new Set();
  async function rule(file,scope,paths=[],depth=0){
    const text=await textFile(file);if(text===null){if(depth>0)error('RULE_IMPORT_MISSING','Imported rule does not exist: '+file);return;}const actual=await fs.realpath(file),key=actual+'\0'+scope+'\0'+JSON.stringify(paths);if(visited.has(key))return;visited.add(key);
    if(depth>5)error('RULE_IMPORT_DEPTH','Rule import depth exceeds 5: '+file);
    const {meta,body}=frontmatter(text);const filters=meta.paths===undefined?paths:meta.paths;if(!Array.isArray(filters)||filters.some(p=>typeof p!=='string'))error('INVALID_RULE_PATHS','paths must be a YAML string list: '+file);
    rules.push({path:actual,scope,paths:filters,content:body,sha256:sha(text)});
    let fenced=false;for(const line of body.split(/\r?\n/)){if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue;}if(fenced)continue;for(const match of line.matchAll(/(?:^|\s)@((?:~\/|[A-Za-z]:[\\/]|\.{0,2}[\\/])?[^\s`]+\.(?:md|txt))(?=\s|$)/g)){let imported=match[1];if(imported.startsWith('~/'))imported=path.join(home,imported.slice(2));else imported=path.resolve(path.dirname(file),imported);await rule(imported,scope,filters,depth+1);}}
  }
  return rule;
}
export async function projectEnvironment(cwd,{home=os.homedir()}={}){
  cwd=await fs.realpath(cwd);home=path.resolve(home);const user=path.join(home,'.claude'),rules=[],capabilities=new Map(),settings=[],warnings=[];
  const rule=ruleLoader(home,rules);
  async function config(file){const text=await textFile(file);if(text===null)return;const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))error('INVALID_SETTINGS','Expected an object: '+file);settings.push({path:file,sha256:sha(text),value});}
  async function catalog(dir,kind){
    const entries=await fs.readdir(dir,{withFileTypes:true}).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){let file;if(kind==='skill')file=path.join(dir,entry.name,'SKILL.md');else if(entry.name.endsWith('.md'))file=path.join(dir,entry.name);else continue;
      let text;try{text=await textFile(file);}catch(e){if(e.code==='ENOTDIR')continue;throw e;}if(text===null)continue;
      const {meta}=frontmatter(text),name=typeof meta.name==='string'?meta.name:(kind==='skill'?entry.name:path.basename(entry.name,'.md'));
      const actual=await fs.realpath(file),id=kind+':'+name;
      capabilities.set(id,{id,kind,name,description:typeof meta.description==='string'?meta.description:'',path:actual,root:path.dirname(actual),sha256:sha(text),disableModelInvocation:meta['disable-model-invocation']===true,metadata:meta});
    }
  }
  await rule(path.join(user,'CLAUDE.md'),cwd);for(const file of await markdownFiles(path.join(user,'rules')))await rule(file,cwd);
  await config(path.join(user,'settings.json'));await config(path.join(user,'settings.local.json'));
  for(const [dir,kind] of [['skills','skill'],['commands','command'],['agents','agent']])await catalog(path.join(user,dir),kind);
  const parents=[];for(let dir=cwd;;dir=path.dirname(dir)){parents.unshift(dir);if(path.dirname(dir)===dir)break;}
  for(const dir of parents){
    for(const name of ['AGENTS.md','CLAUDE.md','CLAUDE.local.md','.claude/CLAUDE.md'])await rule(path.join(dir,name),dir);
    for(const file of await markdownFiles(path.join(dir,'.claude','rules')))await rule(file,dir);
    // Native project settings belong to the selected project, not arbitrary ancestor projects.
    if(dir===cwd){await config(path.join(dir,'.claude','settings.json'));await config(path.join(dir,'.claude','settings.local.json'));}
    for(const [sub,kind] of [['skills','skill'],['commands','command'],['agents','agent']])await catalog(path.join(dir,'.claude',sub),kind);
  }
  const permissions={allow:[],ask:[],deny:[]},hooks={},unsupportedHooks={},env={};let defaultMode,disableAllHooks=false;
  const events=new Set(['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','SessionEnd']);
  for(const s of settings){
    if(s.value.sandbox?.enabled===true||s.value.allowManagedHooksOnly===true)error('UNSUPPORTED_EXECUTION_SETTING',s.path+': requested execution isolation or managed-only hooks cannot be enforced by this bridge');
    for(const key of Object.keys(s.value))if(!['permissions','hooks','env','disableAllHooks'].includes(key))warnings.push({path:s.path,key,reason:'Not imported into the VPS runtime; native provider/model/plugin settings are separate'});
    if(s.value.disableAllHooks!==undefined){if(typeof s.value.disableAllHooks!=='boolean')error('INVALID_SETTINGS',s.path+': disableAllHooks must be a boolean');disableAllHooks=s.value.disableAllHooks;}
    for(const [key,value] of Object.entries(s.value.env??{})){if(sensitive.test(key)){warnings.push({path:s.path,key:'env.'+key,kind:'local-only',reason:'Provider, credential or runtime variable remains local and is not applied by this bridge'});continue;}if(typeof value==='string')env[key]=value;}
    const p=s.value.permissions??{};
    for(const kind of ['allow','ask','deny']){if(p[kind]!==undefined&&(!Array.isArray(p[kind])||p[kind].some(x=>typeof x!=='string')))error('INVALID_PERMISSIONS',s.path+': '+kind+' must be a string list');permissions[kind].push(...(p[kind]??[]).map(pattern=>({pattern,base:path.dirname(path.dirname(s.path)),source:s.path})));}
    if(p.defaultMode)defaultMode=p.defaultMode;
    for(const key of Object.keys(p))if(!['allow','ask','deny','defaultMode'].includes(key)){
      if(key!=='additionalDirectories')error('UNSUPPORTED_PERMISSION_SETTING',s.path+': permissions.'+key+' is not enforced by this bridge; no operation was authorized');
      warnings.push({path:s.path,key:'permissions.'+key,reason:'Not mapped; no additional directory or permission is silently granted'});
    }
    for(const [event,groups] of Object.entries(s.value.hooks??{})){
      if(!events.has(event)){warnings.push({path:s.path,key:'hooks.'+event,reason:'This native lifecycle event is not available through the bridge'});continue;}
      if(!Array.isArray(groups))error('INVALID_HOOKS','Expected hook groups: '+s.path);
      for(const group of groups){for(const hook of group.hooks??[]){if(hook.type!=='command'||hook.async||!['powershell','pwsh','bash',undefined].includes(hook.shell)){(unsupportedHooks[event]??=[]).push({matcher:group.matcher??'',source:s.path});warnings.push({path:s.path,key:'hooks.'+event,blocking:true,reason:'Only synchronous command hooks with PowerShell or explicit Bash are supported; matching operations stop rather than skipping this hook'});continue;}if(typeof hook.command!=='string')error('INVALID_HOOK','Missing command: '+s.path);(hooks[event]??=[]).push({...hook,matcher:group.matcher??'',source:s.path});}}
    }
  }
  for(const c of capabilities.values())for(const key of ['allowed-tools','model','context','agent','hooks','memory','isolation','permissionMode','tools','disallowedTools'])if(c.metadata[key]!==undefined)warnings.push({path:c.path,key,blocking:key!=='model',reason:key==='model'?'The native model preference is not automatically applied by the bridge.':'This execution/permission option is not implemented; invocation stops rather than silently dropping it. Use explicit supported local execution/delegation.'});
  const result={cwd,home,rules,capabilities:[...capabilities.values()],settings:settings.map(({path,sha256})=>({path,sha256})),permissions,hooks,unsupportedHooks,disableAllHooks,env,defaultMode,warnings};
  result.fingerprint=sha(JSON.stringify({...result,env:Object.keys(env).sort()}));
  return result;
}
export async function applicableRules(environment,target='.'){
  const absolute=path.resolve(environment.cwd,target);if(!inside(environment.cwd,absolute))error('PATH_OUTSIDE_PROJECT','Rule target is outside the workspace');
  const collected=[...environment.rules];let dir=(await fs.stat(absolute).catch(missing))?.isDirectory()?absolute:path.dirname(absolute);
  const nestedRule=ruleLoader(environment.home??os.homedir(),collected);
  const sub=[];while(inside(environment.cwd,dir)&&dir!==environment.cwd){sub.unshift(dir);dir=path.dirname(dir);}
  for(const root of sub){for(const name of ['AGENTS.md','CLAUDE.md','CLAUDE.local.md','.claude/CLAUDE.md'])await nestedRule(path.join(root,name),root);for(const file of await markdownFiles(path.join(root,'.claude','rules')))await nestedRule(file,root);}
  return collected.filter(r=>inside(r.scope,absolute)&&(!r.paths.length||r.paths.some(pattern=>picomatch(pattern,{dot:true})(slash(path.relative(r.scope,absolute))))));
}
export async function environmentContext(environment,{target='.',includeRules=true}={}){
  const rules=includeRules?await applicableRules(environment,target):[];
  const lines=['Windows workspace context (configuration, not a new task).','Project: '+environment.cwd,'Configuration fingerprint: '+environment.fingerprint,'Rules apply only within their stated scope; deeper project rules refine parent rules. The current user request remains authoritative.'];
  for(const rule of rules)lines.push('\nRule '+rule.path+' (scope '+rule.scope+'):\n'+rule.content);
  const conditional=environment.rules.filter(r=>r.paths.length);if(conditional.length)lines.push('\nConditional rules (loaded before matching file operations):\n'+JSON.stringify(conditional.map(({path,scope,paths})=>({path,scope,paths}))));
  lines.push('\nAvailable local capabilities (read via action capability, id; scripts run on Windows):\n'+JSON.stringify(environment.capabilities.map(({id,name,description,path,disableModelInvocation})=>({id,name,description,path,disableModelInvocation}))));
  if(environment.warnings.some(w=>w.kind==='local-only'))lines.push('\nLocal provider, credential and model environment settings intentionally remain local. This is expected isolation, not a compatibility failure; inspect localOnlySettings with info only when needed.');
  const compatibility=environment.warnings.filter(w=>w.kind!=='local-only');
  if(compatibility.length)lines.push('\nConfiguration compatibility notices (do not claim these are active):\n'+JSON.stringify(compatibility));
  lines.push('Do not announce routine configuration loads or repeat unchanged configuration notices. Explain compatibility limits when they affect the requested operation or when the user asks.');
  const text=lines.join('\n');if(Buffer.byteLength(text)>1024*1024)error('CONTEXT_TOO_LARGE','Project context exceeds 1 MiB; reduce applicable rules');return text;
}
export async function capability(environment,id,relative){
  const item=environment.capabilities.find(c=>c.id===id);if(!item)error('CAPABILITY_NOT_FOUND','Unknown local capability: '+id);
  const unsupported=['allowed-tools','context','agent','hooks','memory','isolation','permissionMode','tools','disallowedTools'].filter(key=>item.metadata[key]!==undefined);
  if(unsupported.length)error('CAPABILITY_OPTION_UNSUPPORTED',item.path+': cannot apply '+unsupported.join(', ')+'; this capability was not invoked. Use explicitly supported local execution/delegation with the workspace permission policy.');
  const candidate=relative?path.resolve(item.root,relative):item.path;if(!inside(item.root,candidate))error('PATH_OUTSIDE_CAPABILITY','Capability asset escapes its configured directory');const file=await fs.realpath(candidate);if(!inside(item.root,file))error('PATH_OUTSIDE_CAPABILITY','Capability asset escapes its configured directory');
  return {...item,path:file,content:await textFile(file)};
}
export function operation(request,cwd){
  if(request.action==='mcp-call')return mcpOperation(request);
  if(request.action==='isolation'){const mutating=request.operation!=='status',command='windows-workspace isolation '+(request.operation??'');return {tool:mutating?'Bash':'Read',command,file:cwd,mutating,input:mutating?{command}:{file_path:cwd}};}
  const action=request.action,argv=request.argv??[];const mutatingAgent=action==='agent'&&((argv[0]==='delegate'&&argv[1]==='start')||(argv[0]==='thread'&&['send','cancel'].includes(argv[1])));
  const tool=({read:'Read',list:'Glob',search:'Grep',write:'Write',edit:'Edit',run:'Bash',agent:'Agent',capability:'Skill',media:'Read'})[action]??'Read';
  const command=request.script??(request.executable?[request.executable,...(request.args??[])].join(' '):'');
  const file=typeof request.path==='string'?path.resolve(cwd,request.path):cwd;
  return {tool,command,file,mutating:['write','edit','run'].includes(action)||mutatingAgent||(action==='job'&&request.operation==='cancel'),input:tool==='Bash'?{command}:tool==='Agent'?{argv}:tool==='Skill'?{skill:request.id}:{file_path:file,...(request.pattern?{pattern:request.pattern}:{})}};
}
// Entries belong to one loaded environment. Weak keys do not retain old project
// configurations, and a changed pattern invalidates even an in-place update.
const permissionMatchers=new WeakMap();
function permissionMatcher(entry){
  let compiled=permissionMatchers.get(entry);
  if(!compiled||compiled.pattern!==entry.pattern){compiled={pattern:entry.pattern,match:entry.pattern.match(/^([^()]+)(?:\((.*)\))?$/s)};permissionMatchers.set(entry,compiled);}
  return compiled;
}
export function permissionDecision(environment,request,mode='default'){
  const op=operation(request,environment.cwd);
  if(mode==='plan'&&op.mutating)return {decision:'deny',reason:'Plan mode permits inspection only. Switch mode before writes, programs, cancellation or delegation.'};
  const matches=entry=>{const compiled=permissionMatcher(entry),m=compiled.match;if(!m)return false;const [,tool,pattern]=m;if(tool!==op.tool&&tool!=='*'&&!(op.tool.startsWith('mcp__')&&(tool===op.tool.split('__').slice(0,2).join('__')||(compiled.tool??=picomatch(tool))(op.tool))))return false;if(pattern===undefined)return true;
    if(op.tool==='Bash')return pattern.endsWith(':*')?(op.command===pattern.slice(0,-2)||op.command.startsWith(pattern.slice(0,-2)+' ')):(compiled.command??=picomatch(pattern,{dot:true}))(op.command);
    if(op.tool==='Agent'||op.tool==='Skill')return (compiled.capability??=picomatch(pattern))(request.id??request.argv?.[request.argv.indexOf('--harness')+1]??'');
    const candidate=pattern.startsWith('//')?slash(op.file):slash(path.relative(entry.base,op.file));return (compiled.file??=picomatch(pattern.replace(/^\/\//,'').replace(/^\//,'').replace(/^\.\//,''),{dot:true,nocase:true}))(candidate);
  };
  for(const kind of ['deny','ask','allow']){const matched=environment.permissions[kind].find(matches);if(matched)return {decision:kind,reason:kind+' rule '+matched.pattern+' in '+matched.source};}
  if(!op.mutating)return {decision:'allow',reason:'Read-only Windows workspace operation'};
  if(mode==='acceptEdits'&&['Write','Edit'].includes(op.tool))return {decision:'allow',reason:'Native acceptEdits mode'};
  return {decision:'inherit',reason:'Use the native Claude approval mode'};
}
export async function runHooks(environment,event,payload){
  if(environment.disableAllHooks)return [];
  const unsupported=(environment.unsupportedHooks?.[event]??[]).find(hook=>!hook.matcher||new RegExp(hook.matcher).test(payload.tool_name??payload.source??''));
  if(unsupported)error('HOOK_UNSUPPORTED','A matching '+event+' hook in '+unsupported.source+' requires unsupported execution semantics; it was not silently skipped');
  const results=[];for(const hook of environment.hooks[event]??[]){if(hook.matcher&&!new RegExp(hook.matcher).test(payload.tool_name??payload.source??''))continue;
    const shell=hook.shell==='bash'?'bash':getBridgeConfig().pwshExecutable;
    const command=hook.command.replaceAll('$CLAUDE_PROJECT_DIR',environment.cwd).replaceAll('${CLAUDE_PROJECT_DIR}',environment.cwd);
    const args=hook.shell==='bash'?['-c',command]:['-NoLogo','-NoProfile','-NonInteractive','-Command',command];
    const env={...process.env,...environment.env,CLAUDE_PROJECT_DIR:environment.cwd};for(const key of Object.keys(env))if(sensitive.test(key)&&key!=='CLAUDE_PROJECT_DIR')delete env[key];
    const result=await new Promise((resolve,reject)=>{
      const child=spawnOwnedProcess(shell,args,{cwd:environment.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let settled=false,stopping=false,totalBytes=0,stdoutBytes=0,stderr=Buffer.alloc(0);const stdout=[];
      const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timeout);err?reject(err):resolve(value);};
      const stop=(code,message)=>{
        if(stopping||settled)return;stopping=true;clearTimeout(timeout);
        void stopProcessTree(child).then(killed=>{
          if(!killed){finish(Object.assign(new Error(message+'; the root process had already exited, descendant termination was not confirmed'),{code:'HOOK_TERMINATION_UNCONFIRMED'}));return;}
          finish(Object.assign(new Error(message),{code}));
        },e=>finish(Object.assign(new Error(message+'; process-tree termination was not confirmed: '+e.message,{cause:e}),{code:'HOOK_TERMINATION_UNCONFIRMED'})));
      };
      const timeout=setTimeout(()=>stop('HOOK_TIMEOUT','Hook timeout: '+hook.source),Math.min(120000,Math.max(1000,(hook.timeout??30)*1000)));
      function output(bytes,isError){
        if(stopping||settled)return;const buffer=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);totalBytes+=buffer.length;
        if(totalBytes>maxText){stop('HOOK_OUTPUT_LIMIT','Hook output exceeds 512 KiB: '+hook.source);return;}
        if(isError)stderr=Buffer.concat([stderr,buffer]).subarray(-8192);else{stdout.push(buffer);stdoutBytes+=buffer.length;}
      }
      child.stdout.on('data',b=>output(b,false));child.stderr.on('data',b=>output(b,true));
      child.on('error',e=>{if(!stopping)finish(e);});
      child.on('close',code=>{if(!stopping)finish(null,{code,stdout:Buffer.concat(stdout,stdoutBytes).toString('utf8'),stderr:stderr.toString('utf8')});});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...payload,cwd:environment.cwd,hook_event_name:event}));
    });
    if(result.code===2)error('HOOK_BLOCKED',result.stderr||result.stdout||'Blocked by '+hook.source);
    if(result.code!==0)error('HOOK_FAILED','Hook failed in '+hook.source+': '+result.stderr);
    let value={};try{value=JSON.parse(result.stdout.trim()||'{}');}catch{value={additionalContext:result.stdout};}
    if(value.continue===false||value.decision==='block')error('HOOK_BLOCKED',value.stopReason||value.reason||'Blocked by '+hook.source);
    if(value.hookSpecificOutput?.updatedInput)error('HOOK_INPUT_REWRITE_UNSUPPORTED','A local hook requested input replacement; no operation ran. Update the bridge mapping before using this hook.');
    results.push({source:hook.source,...value});
  }return results;
}
