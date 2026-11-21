// Claude VPS Sessions: settings page and sidebar status for Claude VPS Bridge.
// Classic script for CodexHost Desktop extension API v1. All data comes from
// the extension backend, which only calls the bridge admin.mjs contract.
// Features appear only when the installed bridge lists their methods.
// The page mirrors the Host settings pages (layout, --settings-* colors, lucide
// icons) with its own cvb-* classes, so Host class renames cannot break it.
(function(){
'use strict';
const REASONS={
  'zh-CN':{'dns-failed':'域名解析失败','connection-refused':'连接被拒绝','connection-timeout':'连接超时','network-unreachable':'网络不可达',
    'host-key-mismatch':'主机密钥不匹配','auth-failed':'认证失败','socks-failed':'SOCKS 代理失败','cloudflared-error':'cloudflared 出错',
    'proxy-closed':'代理连接关闭','closed-by-remote':'远端关闭连接','connection-failed':'连接失败',stalled:'连接停滞',unclassified:'未分类错误'},
  en:{'dns-failed':'DNS failed','connection-refused':'connection refused','connection-timeout':'connection timeout','network-unreachable':'network unreachable',
    'host-key-mismatch':'host key mismatch','auth-failed':'authentication failed','socks-failed':'SOCKS proxy failed','cloudflared-error':'cloudflared error',
    'proxy-closed':'proxy closed','closed-by-remote':'closed by remote','connection-failed':'connection failed',stalled:'stalled',unclassified:'unclassified error'},
};
const TEXT={
  'zh-CN':{
    title:'VPS 会话',description:'管理 VPS 上 Claude Code 的会话与存储。归档的会话可以恢复，永久删除只在归档中提供；正在运行或无法确认已停止的会话不会被处理。',
    active:'会话',archived:'归档',storage:'存储清理',refresh:'刷新',refreshing:'正在刷新…',loading:'正在读取 VPS…',working:'正在处理…',
    connection:'连接',usage:'占用',
    allProjects:'全部项目',unmapped:'未对应 Windows 项目',search:'搜索标题、项目或 ID',anyAge:'任意时间',olderThan:n=>'超过 '+n+' 天未活动',
    selectAll:'全选当前筛选结果',empty:'没有符合条件的会话。',noTitle:'（无标题）',
    storageLine:(a,b,c)=>'活动 '+a+' · 归档 '+b+' · 桥接缓存 '+c,
    running:'运行中',unknown:'状态未知',bound:'已关联聊天',maybeBound:'可能关联聊天',
    phase:{archiving:'归档未完成',restoring:'恢复未完成',deleting:'删除未完成'},resume:'继续',
    notSelectable:'正在运行或无法确认已停止，不能操作',
    archive:n=>'归档（'+n+'）',restore:n=>'恢复（'+n+'）',remove:n=>'永久删除（'+n+'）',clean:n=>'清理（'+n+'）',clear:'取消选择',
    selectedSummary:(n,s)=>'已选 '+n+' 项 · '+s,
    lastActive:'最后活动',archivedAt:'归档于',modified:'修改于',
    confirmArchive:(n,s)=>'归档 '+n+' 个会话（'+s+'）？',archiveHint:'归档后 Claude 无法续接这些会话，数据保留，可在归档列表中恢复。',
    boundCheck:k=>'我知道其中 '+k+' 个会话关联了 CodexHost 聊天，恢复前这些聊天无法继续。',
    confirmRestore:(n,s)=>'恢复 '+n+' 个会话（'+s+'）？',restoreHint:'会话会回到原位置，原位置已有同名会话时不会覆盖。',
    confirmDelete:(n,s)=>'永久删除 '+n+' 个会话（'+s+'）？',deleteHint:'删除后无法恢复，相关的图片缓存和桥接记录会一并删除。',
    deleteCheck:'我确认永久删除这些会话',
    confirmClean:(n,s)=>'清理 '+n+' 项（'+s+'）？',cleanHint:'这些数据没有对应的会话或已过保留期，清理后无法恢复。执行前会再次核对，条件变化的项会跳过。',
    cleanCheck:'我确认永久删除这些文件',
    confirmUpdate:(a,b)=>'把 VPS 上的 Claude Code 从 '+a+' 更新到 '+b+'？',updateHint:'使用官方 claude update。已打开的会话继续使用当前进程，新会话使用新版本。',
    actions:{archive:'归档',restore:'恢复',delete:'永久删除',clean:'清理',update:'更新'},
    cancel:'取消',
    resultDone:n=>n+' 个已完成',resultFailed:n=>n+' 个未处理',resultUnknown:n=>n+' 个结果未知',
    unknownHint:'结果未知的项没有自动重试。列表已刷新，请按其中显示的状态决定下一步。',dismiss:'关闭',
    days:n=>n+' 天前',hours:n=>n+' 小时前',minutes:n=>n+' 分钟前',now:'刚刚',inMinutes:n=>n+' 分钟后',
    conn:{connected:'已连接',reconnecting:'正在重连',unavailable:'连接不可用',unknown:'连接状态未知',stale:'新版本待生效'},
    unknownConnHint:'当前没有活动连接，或状态记录已过期。',staleHint:'已安装新版本，执行 codexhost stop 后重新打开 CodexHost 生效。',
    route:(n,k)=>'线路 '+n+(k&&k!==n?'（'+k+'）':''),mismatch:'实际入口与线路不一致',
    switched:(a,b,r,w)=>'最近切换：'+(a||'?')+' → '+(b||'?')+(r?'（'+r+'）':'')+'，'+w,
    claude:'Claude Code',checking:'正在检查版本…',upToDate:'已是最新',updateTo:v=>'可更新到 '+v,latestUnknown:'无法获取最新版本',update:'更新',
    updated:(a,b)=>'已从 '+a+' 更新到 '+b+'。',updateUnknown:'更新结果未确认，请重新检查版本。',
    totals:(a,b)=>'可清理：VPS '+a+' · Windows '+b,storageEmpty:'没有需要清理的数据。',
    kinds:{'session-claim':'会话绑定记录','prompt-cache':'提示词缓存','context-notice':'上下文通知记录',presentation:'展示记录',media:'图片缓存',
      'archive-completed':'归档残留','archive-plan':'归档预备目录','archive-move':'归档移动暂存','task-log':'本机任务日志'},
    files:n=>n+' 个文件',
    relays:'VPS 上的 relay',relaysHint:'relay 是 VPS 上为桥接连接服务的后台进程。断开的 relay 离线 15 分钟后会自动退出。',
    relayCurrent:'当前连接',relaySessions:n=>n+' 个会话',relayRequests:n=>n+' 个请求',relayIdle:'空闲 ',relayBusy:'活动中',relayExpires:'将在 ',relayExpiresTail:'自动退出',noRelays:'没有运行中的 relay。',
  },
  en:{
    title:'VPS Sessions',description:'Manage Claude Code sessions and storage on the VPS. Archived sessions can be restored; permanent deletion is only offered in the archive. Running sessions, or sessions not confirmed stopped, are never touched.',
    active:'Sessions',archived:'Archive',storage:'Storage',refresh:'Refresh',refreshing:'Refreshing…',loading:'Reading the VPS…',working:'Working…',
    connection:'Connection',usage:'Usage',
    allProjects:'All projects',unmapped:'No Windows project',search:'Search title, project or ID',anyAge:'Any time',olderThan:n=>'Inactive for over '+n+' days',
    selectAll:'Select all filtered',empty:'No sessions match.',noTitle:'(untitled)',
    storageLine:(a,b,c)=>'Active '+a+' · Archive '+b+' · Bridge cache '+c,
    running:'Running',unknown:'State unknown',bound:'Linked chat',maybeBound:'May be linked',
    phase:{archiving:'Archive incomplete',restoring:'Restore incomplete',deleting:'Delete incomplete'},resume:'Continue',
    notSelectable:'Running or not confirmed stopped',
    archive:n=>'Archive ('+n+')',restore:n=>'Restore ('+n+')',remove:n=>'Delete permanently ('+n+')',clean:n=>'Clean up ('+n+')',clear:'Clear selection',
    selectedSummary:(n,s)=>n+' selected · '+s,
    lastActive:'Last active',archivedAt:'Archived',modified:'Modified',
    confirmArchive:(n,s)=>'Archive '+n+' session(s) ('+s+')?',archiveHint:'Claude cannot resume archived sessions. Data is kept and can be restored from the archive.',
    boundCheck:k=>'I understand '+k+' of them are linked to CodexHost chats, which cannot continue until restored.',
    confirmRestore:(n,s)=>'Restore '+n+' session(s) ('+s+')?',restoreHint:'Sessions return to their original location. Existing sessions are never overwritten.',
    confirmDelete:(n,s)=>'Permanently delete '+n+' session(s) ('+s+')?',deleteHint:'This cannot be undone. Related image caches and bridge records are deleted too.',
    deleteCheck:'I confirm permanent deletion',
    confirmClean:(n,s)=>'Clean up '+n+' item(s) ('+s+')?',cleanHint:'These have no owning session or are past retention. This cannot be undone; items that changed are skipped.',
    cleanCheck:'I confirm permanent deletion of these files',
    confirmUpdate:(a,b)=>'Update Claude Code on the VPS from '+a+' to '+b+'?',updateHint:'Runs the official claude update. Open sessions keep their current process; new sessions use the new version.',
    actions:{archive:'Archive',restore:'Restore',delete:'Delete permanently',clean:'Clean up',update:'Update'},
    cancel:'Cancel',
    resultDone:n=>n+' done',resultFailed:n=>n+' not processed',resultUnknown:n=>n+' unknown',
    unknownHint:'Unknown outcomes were not retried. The list was refreshed; decide from the state it shows.',dismiss:'Dismiss',
    days:n=>n+' d ago',hours:n=>n+' h ago',minutes:n=>n+' min ago',now:'just now',inMinutes:n=>'in '+n+' min',
    conn:{connected:'Connected',reconnecting:'Reconnecting',unavailable:'Unavailable',unknown:'Connection unknown',stale:'Update pending'},
    unknownConnHint:'No active connection, or the status record is stale.',staleHint:'A newer version is installed. Run codexhost stop and reopen CodexHost.',
    route:(n,k)=>'Route '+n+(k&&k!==n?' ('+k+')':''),mismatch:'Observed ingress differs from the route',
    switched:(a,b,r,w)=>'Last switch: '+(a||'?')+' → '+(b||'?')+(r?' ('+r+')':'')+', '+w,
    claude:'Claude Code',checking:'Checking version…',upToDate:'Up to date',updateTo:v=>'Update to '+v+' available',latestUnknown:'Latest version unknown',update:'Update',
    updated:(a,b)=>'Updated from '+a+' to '+b+'.',updateUnknown:'Update outcome unconfirmed; check the version again.',
    totals:(a,b)=>'Reclaimable: VPS '+a+' · Windows '+b,storageEmpty:'Nothing to clean up.',
    kinds:{'session-claim':'Session binding','prompt-cache':'Prompt cache','context-notice':'Context notice',presentation:'Presentation record',media:'Image cache',
      'archive-completed':'Archive leftover','archive-plan':'Archive plan','archive-move':'Archive staging','task-log':'Local task log'},
    files:n=>n+' file(s)',
    relays:'Relays on the VPS',relaysHint:'A relay is the VPS background process serving bridge connections. Disconnected relays exit after 15 minutes offline.',
    relayCurrent:'Current',relaySessions:n=>n+' session(s)',relayRequests:n=>n+' request(s)',relayIdle:'Idle ',relayBusy:'Busy',relayExpires:'Exits ',relayExpiresTail:'',noRelays:'No relays running.',
  },
};
const BATCH=200,POLL_MS=600,STATUS_MS=15000;
const PHASE_METHOD={archiving:'sessions.archive',restoring:'sessions.restore',deleting:'sessions.delete'};
const HARNESS='claude-vps';
const SVG='http://www.w3.org/2000/svg';
// Lucide icons (ISC), the set the Host settings pages use.
const ICONS={
  refresh:[['path',{d:'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'}],['path',{d:'M21 3v5h-5'}],['path',{d:'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'}],['path',{d:'M8 16H3v5'}]],
  archive:[['rect',{width:'20',height:'5',x:'2',y:'3',rx:'1'}],['path',{d:'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8'}],['path',{d:'M10 12h4'}]],
  restore:[['path',{d:'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'}],['path',{d:'M3 3v5h5'}]],
  trash:[['path',{d:'M3 6h18'}],['path',{d:'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'}],['path',{d:'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'}],['line',{x1:'10',x2:'10',y1:'11',y2:'17'}],['line',{x1:'14',x2:'14',y1:'11',y2:'17'}]],
  alert:[['path',{d:'m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'}],['path',{d:'M12 9v4'}],['path',{d:'M12 17h.01'}]],
  download:[['path',{d:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'}],['polyline',{points:'7 10 12 15 17 10'}],['line',{x1:'12',x2:'12',y1:'15',y2:'3'}]],
  check:[['path',{d:'M20 6 9 17l-5-5'}]],
  search:[['circle',{cx:'11',cy:'11',r:'8'}],['path',{d:'m21 21-4.3-4.3'}]],
  server:[['rect',{width:'20',height:'8',x:'2',y:'2',rx:'2',ry:'2'}],['rect',{width:'20',height:'8',x:'2',y:'14',rx:'2',ry:'2'}],['line',{x1:'6',x2:'6.01',y1:'6',y2:'6'}],['line',{x1:'6',x2:'6.01',y1:'18',y2:'18'}]],
};
function icon(name,size=15){
  const svg=document.createElementNS(SVG,'svg');
  for(const [k,v] of Object.entries({class:'cvb-icon',width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(k,String(v));
  for(const [tag,attrs] of ICONS[name]||[]){const child=document.createElementNS(SVG,tag);for(const [k,v] of Object.entries(attrs))child.setAttribute(k,v);svg.append(child);}
  return svg;
}
function el(tag,props,...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props||{})){
    if(value===undefined||value===null||value===false)continue;
    if(key==='class')node.className=value;
    else if(key==='text')node.textContent=value;
    else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);
    else if(key in node&&typeof value!=='string')node[key]=value;
    else node.setAttribute(key,value===true?'':String(value));
  }
  for(const child of children.flat(Infinity))if(child!==null&&child!==undefined&&child!==false)node.append(child);
  return node;
}
const badge=(tone,text)=>el('span',{class:'cvb-badge','data-tone':tone,text});
const button=(variant,text,onclick,{iconName,disabled,action}={})=>el('button',{type:'button',class:'cvb-btn'+(variant?' cvb-btn--'+variant:''),disabled,'data-action':action,onclick},iconName?icon(iconName):null,text);
const notice=(tone,iconName,text,...extra)=>el('div',{class:'cvb-status','data-tone':tone,role:tone==='danger'?'alert':'status'},icon(iconName,16),el('div',{class:'cvb-status__body'},el('span',{text}),extra));
function bytes(n){
  if(!Number.isFinite(n))return '-';
  const units=['B','KB','MB','GB','TB'];let i=0,v=n;
  while(v>=1024&&i<units.length-1){v/=1024;i++;}
  return (i?v.toFixed(v<10?1:0):String(v))+' '+units[i];
}
function basename(p){return String(p||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop()||String(p||'');}
const localeKey=value=>String(value||'').toLowerCase().startsWith('zh')?'zh-CN':'en';
function ago(t,iso){
  const ms=Date.now()-Date.parse(iso);
  if(!Number.isFinite(ms))return '-';
  if(ms<0)return t.inMinutes(Math.max(1,Math.round(-ms/60000)));
  if(ms<60000)return t.now;
  if(ms<3600000)return t.minutes(Math.floor(ms/60000));
  if(ms<86400000)return t.hours(Math.floor(ms/3600000));
  return t.days(Math.floor(ms/86400000));
}
const absolute=(locale,iso)=>{const d=new Date(iso);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(d):'';};

// start + poll through the backend. After start, any failure leaves a write's outcome unknown.
async function call(backend,method,params,alive=()=>true){
  const {jobId}=await backend.invoke('start',{method,params});
  try{
    let text='',offset=0;
    for(;;){
      if(!alive())throw new Error('disposed');
      const reply=await backend.invoke('poll',{jobId,offset});
      if(reply.state==='running'){await new Promise(resolve=>setTimeout(resolve,POLL_MS));continue;}
      if(reply.state==='failed')throw Object.assign(new Error(reply.error?.message||'failed'),{code:reply.error?.code});
      text+=reply.chunk;offset=reply.nextOffset;
      if(offset>=reply.total)return JSON.parse(text);
    }
  }catch(error){throw Object.assign(error,{afterStart:true});}
}

// Connection summary shared by the sidebar dot and the settings overview.
function describeStatus(status,locale){
  if(!status)return null;
  const t=TEXT[locale],reasons=REASONS[locale];
  const stale=status.activation?.state==='stale';
  const state=stale?'stale':status.connection?.state||'unknown';
  const kind={connected:'ok',reconnecting:'warn',unavailable:'bad',stale:'warn'}[state]||'idle';
  const details=[];
  if(stale)details.push(t.staleHint);
  if(state==='unknown')details.push(t.unknownConnHint);
  const route=status.route||{};
  if(route.name)details.push(t.route(route.name,route.kind));
  if(route.match===false)details.push(t.mismatch);
  const sw=route.lastSwitch;
  if(sw?.at&&Date.now()-Date.parse(sw.at)<86400000)details.push(t.switched(sw.from,sw.to,reasons[sw.reason]||sw.reason,ago(t,sw.at)));
  return {kind,label:t.conn[state]||t.conn.unknown,details};
}
const TONE={ok:'success',warn:'warning',bad:'danger',idle:'neutral'};

async function readMethods(backend,alive){
  const reply=await call(backend,'info',{},alive);
  return new Set(reply.ok?reply.result.methods||[]:[]);
}

// Sidebar: a status dot on local Claude VPS rows only, refreshed from bridge.status.
function startBadges(api){
  const locale=localeKey(document.documentElement.lang||navigator.language);
  const dots=new Map();
  let tree=null,rows=[],status=null,supported=null,timer=null,polling=false,stopped=false,polled=false;
  const alive=()=>!stopped;
  const relevant=()=>rows.filter(row=>row.isLocal&&row.threadId&&row.isConnected()&&tree?.nodes?.[row.threadId]?.harnessId===HARNESS);
  function paint(dot){
    const view=describeStatus(status,locale);
    dot.hidden=!view;
    if(!view)return;
    dot.className='cvb-dot cvb-dot-'+view.kind;
    dot.title=[view.label,...view.details].join('\n');
    dot.setAttribute('aria-label',view.label);
  }
  function sync(){
    if(stopped)return;
    const live=new Set();
    for(const row of supported===false?[]:relevant()){
      live.add(row.element);
      let dot=dots.get(row.element);
      if(!dot||!dot.isConnected){dot=el('span',{class:'cvb-dot',role:'img',hidden:true});api.dom.mount(dot,row.element,'append');dots.set(row.element,dot);}
      paint(dot);
    }
    for(const [element,dot] of dots)if(!live.has(element)){dot.remove();dots.delete(element);}
    schedule(live.size>0);
  }
  function schedule(needed){
    if(timer||polling||stopped||!needed||supported===false)return;
    // Poll at once the first time, then at a steady pace even after failures.
    timer=setTimeout(poll,polled?STATUS_MS:0);
  }
  async function poll(){
    timer=null;polled=true;
    if(stopped||document.hidden){if(!stopped)timer=setTimeout(poll,STATUS_MS);return;}
    polling=true;
    try{
      if(supported===null)supported=(await readMethods(api.backend,alive)).has('bridge.status');
      if(supported){const reply=await call(api.backend,'bridge.status',{},alive);status=reply.ok?reply.result:null;}
    }catch{status=null;}
    finally{polling=false;}
    sync();
  }
  const unTree=api.threads.watchTree(snapshot=>{tree=snapshot;sync();});
  const unRows=api.sidebar.observeRows(next=>{rows=next;sync();});
  return ()=>{stopped=true;clearTimeout(timer);unTree();unRows();for(const dot of dots.values())dot.remove();dots.clear();};
}

// The Host renders Settings inside a shadow root but adopts desktop.css only
// into the main document, so page rules would not reach this container. Load
// the same packaged stylesheet and scope it to the shadow tree we live in.
function adoptPageStyle(container,ctx,alive){
  const scope=container.getRootNode?.();
  if(!scope||scope===document||typeof ctx.assets?.readDataUrl!=='function')return;
  const previous=container.style.visibility;
  container.style.visibility='hidden';
  const reveal=()=>{if(alive())container.style.visibility=previous;};
  const fallback=setTimeout(reveal,1500);
  ctx.assets.readDataUrl('desktop.css').then(({dataUrl})=>{
    if(!alive())return;
    const encoded=String(dataUrl).slice(String(dataUrl).indexOf(',')+1);
    // Percent-decoding the bytes is a UTF-8 decode without relying on TextDecoder.
    const text=decodeURIComponent(Array.from(atob(encoded),c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join(''));
    container.prepend(el('style',{'data-cvb-style':'page',text}));
  }).catch(()=>{}).finally(()=>{clearTimeout(fallback);reveal();});
}

function mountPage(container,ctx){
  const locale=localeKey(ctx.locale);
  const t=TEXT[locale];
  const state={tab:'active',lists:{active:null,archived:null},loading:false,busy:false,error:null,
    selected:new Set(),project:'',query:'',age:0,dialog:null,report:null,
    methods:new Set(),status:null,claude:{loading:false,value:null,error:null,note:null},
    storage:{plan:null,relays:null}};
  let disposed=false;
  const alive=()=>!disposed;
  const has=method=>state.methods.has(method);
  const run=(method,params)=>call(ctx.backend,method,params,alive);
  const root=el('div',{class:'cvb'});
  // The dialog lives outside the re-rendered tree so status refreshes do not
  // reset its focus or checkbox while it is open.
  const dialog=el('dialog',{class:'cvb-dialog','aria-modal':'true'});
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  container.replaceChildren(root,dialog);
  adoptPageStyle(container,ctx,alive);

  const current=()=>state.lists[state.tab];
  function warningsFor(list,id){return (list?.warnings||[]).filter(w=>w.id===id);}
  function info(row,list){
    const warnings=warningsFor(list,row.id);
    const incomplete=warnings.find(w=>w.code==='ARCHIVE_INCOMPLETE')?.phase;
    const bound=(row.bound?.threads?.length||0)>0;
    const maybeBound=!bound&&warnings.some(w=>w.code==='BINDINGS_UNAVAILABLE');
    return {incomplete,bound,maybeBound,selectable:row.state==='idle'&&!incomplete};
  }
  function visible(){
    const list=current();if(!list)return [];
    const query=state.query.trim().toLowerCase(),cutoff=state.age?Date.now()-state.age*86400000:null;
    return list.sessions.filter(row=>{
      if(state.project&&(row.project?.projectId||'')!==state.project)return false;
      if(cutoff!==null&&!(Date.parse(row.lastActiveAt)<cutoff))return false;
      if(!query)return true;
      return [row.title,row.id,row.project?.localCwd,row.project?.remoteCwd].some(v=>String(v||'').toLowerCase().includes(query));
    });
  }

  async function loadStatus(){
    if(!has('bridge.status'))return;
    try{const reply=await run('bridge.status',{});state.status=reply.ok?reply.result:null;}catch{state.status=null;}
    render();
  }
  async function loadClaude(){
    if(!has('claude.status')||state.claude.loading)return;
    state.claude.loading=true;state.claude.error=null;render();
    try{const reply=await run('claude.status',{});if(reply.ok)state.claude.value=reply.result;else state.claude.error=reply.error?.message;}
    catch(error){if(!disposed)state.claude.error=error.message;}
    finally{state.claude.loading=false;render();}
  }
  async function loadSessions(){
    const [active,archived]=await Promise.all(['active','archived'].map(scope=>run('sessions.list',{scope})));
    for(const [scope,reply] of [['active',active],['archived',archived]]){
      if(!reply.ok)throw new Error(reply.error?.message||reply.error?.code);
      state.lists[scope]=reply.result;
    }
  }
  async function loadStorage(){
    const [plan,relays]=await Promise.all([run('storage.plan',{}),has('relays.list')?run('relays.list',{}).catch(()=>null):null]);
    if(!plan.ok)throw new Error(plan.error?.message||plan.error?.code);
    state.storage.plan=plan.result;state.storage.relays=relays?.ok?relays.result:null;
  }
  async function refresh(){
    if(state.loading)return;
    state.loading=true;state.error=null;render();
    try{
      void loadStatus();
      if(state.tab==='storage')await loadStorage();else await loadSessions();
      const ids=new Set(selectableRows().map(row=>row.id));
      for(const id of [...state.selected])if(!ids.has(id))state.selected.delete(id);
    }catch(error){if(!disposed)state.error=error.message;}
    finally{state.loading=false;if(!disposed)render();}
  }
  function selectableRows(){
    if(state.tab==='storage')return state.storage.plan?.items||[];
    const list=current();return list?list.sessions.filter(row=>info(row,list).selectable):[];
  }

  async function apply(method,rows,extra){
    state.busy=true;closeDialog();state.report=null;render();
    const results=[];
    try{
      for(let i=0;i<rows.length;i+=BATCH){
        const items=rows.slice(i,i+BATCH).map(row=>({id:row.id,revision:row.revision}));
        try{
          const reply=await run(method,{items,...extra});
          if(!reply.ok)throw Object.assign(new Error(reply.error?.message||reply.error?.code),{afterStart:true,known:true});
          results.push(...reply.result.results);
        }catch(error){
          const unknown=error.afterStart&&!error.known;
          for(const item of items)results.push({id:item.id,status:unknown?'unknown':'rejected',code:error.code||'ERROR',message:error.message});
          if(!error.afterStart)break;
        }
      }
    }finally{
      const titles=new Map(rows.map(row=>[row.id,row.title||(row.kind?t.kinds[row.kind]||row.kind:row.id)]));
      state.report={results:results.map(r=>({...r,title:titles.get(r.id)||r.id}))};
      state.selected.clear();state.busy=false;
      if(!disposed){render();await refresh();}
    }
  }

  async function updateClaude(){
    const before=state.claude.value?.installed;
    state.busy=true;closeDialog();state.claude.note=null;render();
    try{
      const reply=await run('claude.update',{});
      if(reply.ok){state.claude.value=reply.result;state.claude.note=t.updated(before,reply.result.installed);}
      else state.claude.note=reply.error?.code==='RESULT_UNKNOWN'?t.updateUnknown:reply.error?.message;
    }catch(error){state.claude.note=error.afterStart?t.updateUnknown:error.message;}
    finally{state.busy=false;if(!disposed){render();void loadClaude();}}
  }

  function openDialog(kind){
    if(kind==='update'){state.dialog={kind,rows:[],checked:true};showDialog();return;}
    const pool=state.tab==='storage'?state.storage.plan?.items||[]:current().sessions;
    const rows=pool.filter(row=>state.selected.has(row.id));
    if(!rows.length)return;
    const total=bytes(rows.reduce((sum,row)=>sum+(row.bytes||0),0));
    const list=current();
    const bound=kind==='archive'?rows.filter(row=>{const i=info(row,list);return i.bound||i.maybeBound;}).length:0;
    state.dialog={kind,rows,total,bound,checked:false};showDialog();
  }
  function closeDialog(){
    state.dialog=null;
    if(dialog.open){if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}
    dialog.replaceChildren();
  }
  function showDialog(){
    const d=state.dialog;
    const danger=d.kind==='delete'||d.kind==='clean';
    const needCheck=danger||(d.kind==='archive'&&d.bound>0);
    const claude=state.claude.value||{};
    const copy={
      archive:[t.confirmArchive(d.rows.length,d.total),t.archiveHint],restore:[t.confirmRestore(d.rows.length,d.total),t.restoreHint],
      delete:[t.confirmDelete(d.rows.length,d.total),t.deleteHint],clean:[t.confirmClean(d.rows.length,d.total),t.cleanHint],
      update:[t.confirmUpdate(claude.installed,claude.latest),t.updateHint],
    }[d.kind];
    const confirm=button(danger?'danger':'',t.actions[d.kind],()=>{
      if(d.kind==='update')return void updateClaude();
      const method={archive:'sessions.archive',restore:'sessions.restore',delete:'sessions.delete',clean:'storage.clean'}[d.kind];
      void apply(method,d.rows,d.kind==='archive'&&d.bound>0?{confirmBound:true}:{});
    },{iconName:{archive:'archive',restore:'restore',delete:'trash',clean:'trash',update:'download'}[d.kind],disabled:needCheck&&!d.checked,action:'confirm'});
    const checkText=d.kind==='delete'?t.deleteCheck:d.kind==='clean'?t.cleanCheck:t.boundCheck(d.bound);
    const label=row=>(row.kind?(t.kinds[row.kind]||row.kind):(row.title||t.noTitle))+' · '+bytes(row.bytes);
    dialog.replaceChildren(
      el('h2',{text:copy[0]}),
      el('p',{class:danger?'cvb-dialog__warn':'',text:copy[1]}),
      d.rows.length?el('ul',{class:'cvb-dialog__list'},d.rows.slice(0,8).map(row=>el('li',{text:label(row)})),d.rows.length>8?el('li',{text:'… +'+(d.rows.length-8)}):null):null,
      needCheck?el('label',{class:'cvb-check'},el('input',{type:'checkbox',checked:d.checked,onchange:e=>{d.checked=e.target.checked;confirm.disabled=!d.checked;}}),el('span',{text:checkText})):null,
      el('div',{class:'cvb-dialog__actions'},button('secondary',t.cancel,closeDialog,{action:'cancel'}),confirm));
    if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}
  }

  function renderReport(){
    const results=state.report.results;
    const done=results.filter(r=>r.status==='done'),unknown=results.filter(r=>r.status==='unknown'),failed=results.filter(r=>r.status!=='done'&&r.status!=='unknown');
    const summary=[done.length?t.resultDone(done.length):null,failed.length?t.resultFailed(failed.length):null,unknown.length?t.resultUnknown(unknown.length):null].filter(Boolean).join(' · ');
    const tone=unknown.length||failed.length?'warning':'success';
    return el('div',{class:'cvb-report'},notice(tone,tone==='success'?'check':'alert',summary,
      unknown.length?el('p',{text:t.unknownHint}):null,
      [...failed,...unknown].length?el('ul',{},[...failed,...unknown].slice(0,20).map(r=>el('li',{text:r.title+'：'+r.message}))):null,
      el('button',{type:'button',class:'cvb-link',text:t.dismiss,onclick:()=>{state.report=null;render();}})));
  }

  function renderOverview(){
    const view=describeStatus(state.status,locale);
    const claude=state.claude,value=claude.value;
    const usage=(state.lists.active||state.lists.archived)?.storage;
    const cells=[];
    if(view)cells.push(el('div',{class:'cvb-overview__item',title:view.details.join('\n')},
      el('span',{class:'cvb-overview__label',text:t.connection}),
      el('div',{class:'cvb-overview__value'},badge(TONE[view.kind],view.label)),
      view.details.length?el('span',{class:'cvb-overview__hint',text:view.details[0]}):null));
    if(has('claude.status')){
      let line,tag=null,action=null;
      if(claude.loading&&!value)line=t.checking;
      else if(value){
        line=value.installed;
        tag=value.updateAvailable?badge('warning',t.updateTo(value.latest)):value.latest?badge('success',t.upToDate):badge('neutral',t.latestUnknown);
        if(value.updateAvailable&&value.method!=='unknown'&&has('claude.update'))
          action=button('secondary',t.update,()=>openDialog('update'),{iconName:'download',disabled:state.busy,action:'update'});
      }else line=claude.error||'-';
      cells.push(el('div',{class:'cvb-overview__item'},
        el('span',{class:'cvb-overview__label',text:t.claude}),
        el('div',{class:'cvb-overview__value'},el('strong',{text:line}),tag,action),
        claude.note?el('span',{class:'cvb-overview__hint',text:claude.note}):null));
    }
    if(usage)cells.push(el('div',{class:'cvb-overview__item'},
      el('span',{class:'cvb-overview__label',text:t.usage}),
      el('div',{class:'cvb-overview__value'},el('strong',{text:bytes(usage.activeBytes)})),
      el('span',{class:'cvb-overview__hint',text:t.storageLine(bytes(usage.activeBytes),bytes(usage.archivedBytes),bytes(usage.cacheBytes))})));
    return cells.length?el('section',{class:'cvb-overview'},cells):null;
  }

  function selectBox(id,disabled,title){
    return el('label',{class:'cvb-row__select',title},el('input',{type:'checkbox',checked:state.selected.has(id),disabled:disabled||state.busy,
      'aria-label':t.selectAll,onchange:e=>{e.target.checked?state.selected.add(id):state.selected.delete(id);render();}}));
  }

  function renderSessionRow(row,list){
    const i=info(row,list);
    const badges=[
      row.state==='running'?badge('success',t.running):null,
      row.state==='unknown'?badge('neutral',t.unknown):null,
      i.bound?badge('info',t.bound):i.maybeBound?badge('neutral',t.maybeBound):null,
      i.incomplete?badge('warning',t.phase[i.incomplete]||i.incomplete):null,
    ];
    const project=row.project?.mapped?basename(row.project.localCwd):t.unmapped;
    const stamp=state.tab==='archived'&&row.archivedAt?row.archivedAt:row.lastActiveAt;
    const when=(state.tab==='archived'&&row.archivedAt?t.archivedAt:t.lastActive)+' '+ago(t,stamp);
    const resume=i.incomplete&&row.state==='idle'?button('secondary',t.resume,()=>void apply(PHASE_METHOD[i.incomplete],[row],{}),{disabled:state.busy,action:'resume'}):null;
    return el('article',{class:'cvb-row'+(state.selected.has(row.id)?' is-selected':'')},
      selectBox(row.id,!i.selectable,i.selectable?undefined:t.notSelectable),
      el('div',{class:'cvb-row__copy'},
        el('strong',{title:row.title||row.id,text:row.title||t.noTitle}),
        el('span',{class:'cvb-row__meta'},el('span',{text:project}),el('span',{title:absolute(locale,stamp),text:when}),el('span',{text:bytes(row.bytes)}),el('span',{class:'cvb-id',title:row.id,text:row.id.slice(0,8)})),
        row.project?.localCwd?el('code',{class:'cvb-row__path',title:row.project.localCwd,text:row.project.localCwd}):null),
      el('div',{class:'cvb-row__aside'},badges,resume));
  }

  function renderStorageRow(item){
    return el('article',{class:'cvb-row'+(state.selected.has(item.id)?' is-selected':'')},
      selectBox(item.id,false),
      el('div',{class:'cvb-row__copy'},
        el('strong',{text:t.kinds[item.kind]||item.kind}),
        el('span',{class:'cvb-row__meta'},el('span',{text:item.reason}),el('span',{title:absolute(locale,item.lastModifiedAt),text:t.modified+' '+ago(t,item.lastModifiedAt)}),
          el('span',{text:bytes(item.bytes)}),item.fileCount>1?el('span',{text:t.files(item.fileCount)}):null)),
      el('div',{class:'cvb-row__aside'},badge('neutral',item.location==='vps'?'VPS':'Windows')));
  }

  function renderRelays(){
    const data=state.storage.relays;
    if(!data)return null;
    const rows=data.relays.map(relay=>el('article',{class:'cvb-row cvb-row--plain'},
      el('span',{class:'cvb-row__icon'},icon('server',16)),
      el('div',{class:'cvb-row__copy'},
        el('strong',{title:relay.id},el('span',{class:'cvb-id',text:relay.id.slice(0,8)}),relay.bridgeVersion?' · v'+relay.bridgeVersion:null),
        el('span',{class:'cvb-row__meta'},
          relay.sessions!==null?el('span',{text:t.relaySessions(relay.sessions)}):null,
          relay.activeRequests!==null?el('span',{text:t.relayRequests(relay.activeRequests)}):null,
          el('span',{text:relay.idleSince?t.relayIdle+ago(t,relay.idleSince):t.relayBusy}),
          relay.expiresAt?el('span',{text:t.relayExpires+ago(t,relay.expiresAt)+t.relayExpiresTail}):null)),
      el('div',{class:'cvb-row__aside'},relay.current?badge('success',t.relayCurrent):null)));
    return el('section',{class:'cvb-section'},el('h3',{class:'cvb-subtitle',text:t.relays}),el('p',{class:'cvb-description',text:t.relaysHint}),
      rows.length?el('div',{class:'cvb-list'},rows):notice('neutral','server',t.noRelays));
  }

  function renderSelection(count){
    if(!(count||state.busy))return null;
    if(state.busy)return el('div',{class:'cvb-selection'},el('span',{class:'cvb-selection__summary',text:t.working}));
    const pool=state.tab==='storage'?state.storage.plan?.items||[]:current()?.sessions||[];
    const size=pool.filter(row=>state.selected.has(row.id)).reduce((sum,row)=>sum+(row.bytes||0),0);
    const actions=state.tab==='active'?button('',t.archive(count),()=>openDialog('archive'),{iconName:'archive'})
      :state.tab==='archived'?[button('secondary',t.restore(count),()=>openDialog('restore'),{iconName:'restore'}),button('danger',t.remove(count),()=>openDialog('delete'),{iconName:'trash'})]
      :button('danger',t.clean(count),()=>openDialog('clean'),{iconName:'trash'});
    return el('div',{class:'cvb-selection'},el('span',{class:'cvb-selection__summary',text:t.selectedSummary(count,bytes(size))}),
      el('button',{type:'button',class:'cvb-link',text:t.clear,onclick:()=>{state.selected.clear();render();}}),actions);
  }

  function selectAll(rows){
    const all=rows.length>0&&rows.every(row=>state.selected.has(row.id));
    return el('label',{class:'cvb-check cvb-select-all'},el('input',{type:'checkbox',checked:all,disabled:!rows.length||state.busy,
      onchange:e=>{for(const row of rows)e.target.checked?state.selected.add(row.id):state.selected.delete(row.id);render();}}),el('span',{text:t.selectAll}));
  }

  function renderBody(){
    if(state.tab==='storage'){
      const plan=state.storage.plan;
      if(!plan)return [notice('neutral','refresh',state.loading?t.loading:'-')];
      const notes=[...new Set((plan.warnings||[]).map(w=>w.message))];
      return [
        el('p',{class:'cvb-description',text:t.totals(bytes(plan.totals?.vpsBytes),bytes(plan.totals?.windowsBytes))}),
        notes.length?notice('warning','alert',notes[0],notes.slice(1).map(m=>el('p',{text:m}))):null,
        plan.items.length?[selectAll(plan.items),el('div',{class:'cvb-list'},plan.items.map(renderStorageRow))]:notice('neutral','check',t.storageEmpty),
        renderRelays()];
    }
    const list=current(),rows=visible();
    const projects=new Map();
    for(const row of list?.sessions||[])if(row.project?.projectId)projects.set(row.project.projectId,basename(row.project.localCwd||row.project.remoteCwd));
    const general=[...new Set((list?.warnings||[]).filter(w=>!w.id).map(w=>w.message))];
    const field=(node)=>el('div',{class:'cvb-field'},node);
    return [
      el('form',{class:'cvb-filters',role:'search',onsubmit:e=>e.preventDefault()},
        el('div',{class:'cvb-search'},icon('search',14),el('input',{type:'search',placeholder:t.search,'aria-label':t.search,value:state.query,
          oninput:e=>{state.query=e.target.value;const pos=e.target.selectionStart;render();const box=root.querySelector('.cvb-search input');box?.focus();box?.setSelectionRange(pos,pos);}})),
        field(el('select',{'aria-label':t.allProjects,onchange:e=>{state.project=e.target.value;render();}},el('option',{value:'',text:t.allProjects}),[...projects].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>el('option',{value:id,text:name,selected:state.project===id})))),
        field(el('select',{'aria-label':t.anyAge,onchange:e=>{state.age=Number(e.target.value);render();}},[0,7,30,90].map(n=>el('option',{value:String(n),text:n?t.olderThan(n):t.anyAge,selected:state.age===n}))))),
      general.length?notice('warning','alert',general[0],general.slice(1).map(m=>el('p',{text:m}))):null,
      !list?notice('neutral','refresh',state.loading?t.loading:'-')
        :rows.length?[selectAll(rows.filter(row=>info(row,list).selectable)),el('div',{class:'cvb-list'},rows.map(row=>renderSessionRow(row,list)))]
        :notice('neutral','archive',t.empty)];
  }

  function render(){
    if(disposed)return;
    const tab=(name,label,count)=>el('button',{type:'button',class:'cvb-tab','aria-pressed':String(state.tab===name),disabled:state.busy,onclick:()=>{
      if(state.tab===name)return;
      state.tab=name;state.selected.clear();state.report=null;render();
      if(name==='storage'?!state.storage.plan:!state.lists[name])void refresh();
    }},label,count===undefined?null:[' ',el('span',{class:'cvb-tab__count',text:String(count)})]);
    // replaceChildren neither flattens arrays nor skips empty sections.
    root.replaceChildren(...[
      el('header',{class:'cvb-header'},el('h2',{class:'cvb-title',text:t.title}),
        button('secondary',state.loading?t.refreshing:t.refresh,()=>{void refresh();void loadClaude();},{iconName:'refresh',disabled:state.loading||state.busy,action:'refresh'})),
      el('p',{class:'cvb-description',text:t.description}),
      renderOverview(),
      el('div',{class:'cvb-tabs',role:'group'},tab('active',t.active,state.lists.active?.sessions.length),tab('archived',t.archived,state.lists.archived?.sessions.length),
        has('storage.plan')?tab('storage',t.storage,state.storage.plan?.items.length):null),
      state.error?notice('danger','alert',state.error):null,
      state.report?renderReport():null,
      renderSelection(state.selected.size),
      renderBody()].flat(Infinity).filter(Boolean));
  }

  render();
  void (async()=>{
    try{state.methods=await readMethods(ctx.backend,alive);}catch(error){if(!disposed){state.error=error.message;render();}return;}
    void loadClaude();
    await refresh();
  })();
  return ()=>{disposed=true;closeDialog();container.replaceChildren();};
}

define({activate(api){
  const unregister=api.settings.registerPage({title:{en:'VPS Sessions','zh-CN':'VPS 会话'},mount:mountPage});
  const stopBadges=api.sidebar&&api.threads&&api.backend?startBadges(api):()=>{};
  return ()=>{stopBadges();unregister();};
}});
})();
