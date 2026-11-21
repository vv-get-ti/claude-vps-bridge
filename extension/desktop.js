// Claude VPS Sessions: settings page for VPS Claude Code sessions.
// Classic script for CodexHost Desktop extension API v1. All data comes from
// the extension backend, which only calls the bridge admin.mjs contract.
(function(){
'use strict';
const TEXT={
  'zh-CN':{
    title:'VPS 会话',active:'会话',archived:'归档',refresh:'刷新',loading:'正在读取 VPS…',working:'正在处理…',
    allProjects:'全部项目',unmapped:'未对应 Windows 项目',search:'搜索标题、项目或 ID',anyAge:'任意时间',olderThan:n=>'超过 '+n+' 天未活动',
    selectAll:'全选当前筛选结果',empty:'没有符合条件的会话。',noTitle:'（无标题）',
    storage:(a,b,c)=>'活动 '+a+' · 归档 '+b+' · 桥接缓存 '+c,
    running:'运行中',unknown:'状态未知',bound:'已关联聊天',maybeBound:'可能关联聊天',
    phase:{archiving:'归档未完成',restoring:'恢复未完成',deleting:'删除未完成'},resume:'继续',
    notSelectable:'正在运行或无法确认已停止，不能操作',
    archive:n=>'归档（'+n+'）',restore:n=>'恢复（'+n+'）',remove:n=>'永久删除（'+n+'）',clear:'取消选择',
    lastActive:'最后活动',archivedAt:'归档于',
    confirmArchive:(n,s)=>'归档 '+n+' 个会话（'+s+'）？',archiveHint:'归档后 Claude 无法续接这些会话，数据保留，可在归档列表中恢复。',
    boundCheck:k=>'我知道其中 '+k+' 个会话关联了 CodexHost 聊天，恢复前这些聊天无法继续。',
    confirmRestore:(n,s)=>'恢复 '+n+' 个会话（'+s+'）？',restoreHint:'会话会回到原位置，原位置已有同名会话时不会覆盖。',
    confirmDelete:(n,s)=>'永久删除 '+n+' 个会话（'+s+'）？',deleteHint:'删除后无法恢复，相关的图片缓存和桥接记录会一并删除。',
    deleteCheck:'我确认永久删除这些会话',cancel:'取消',confirm:'确定',
    resultDone:n=>n+' 个已完成',resultFailed:n=>n+' 个未处理',resultUnknown:n=>n+' 个结果未知',
    unknownHint:'结果未知的会话没有自动重试。列表已刷新，请按其中显示的状态决定下一步。',dismiss:'关闭',
    days:n=>n+' 天前',hours:n=>n+' 小时前',minutes:n=>n+' 分钟前',now:'刚刚',
  },
  en:{
    title:'VPS Sessions',active:'Sessions',archived:'Archive',refresh:'Refresh',loading:'Reading the VPS…',working:'Working…',
    allProjects:'All projects',unmapped:'No Windows project',search:'Search title, project or ID',anyAge:'Any time',olderThan:n=>'Inactive for over '+n+' days',
    selectAll:'Select all filtered',empty:'No sessions match.',noTitle:'(untitled)',
    storage:(a,b,c)=>'Active '+a+' · Archive '+b+' · Bridge cache '+c,
    running:'Running',unknown:'State unknown',bound:'Linked chat',maybeBound:'May be linked',
    phase:{archiving:'Archive incomplete',restoring:'Restore incomplete',deleting:'Delete incomplete'},resume:'Continue',
    notSelectable:'Running or not confirmed stopped',
    archive:n=>'Archive ('+n+')',restore:n=>'Restore ('+n+')',remove:n=>'Delete permanently ('+n+')',clear:'Clear selection',
    lastActive:'Last active',archivedAt:'Archived',
    confirmArchive:(n,s)=>'Archive '+n+' session(s) ('+s+')?',archiveHint:'Claude cannot resume archived sessions. Data is kept and can be restored from the archive.',
    boundCheck:k=>'I understand '+k+' of them are linked to CodexHost chats, which cannot continue until restored.',
    confirmRestore:(n,s)=>'Restore '+n+' session(s) ('+s+')?',restoreHint:'Sessions return to their original location. Existing sessions are never overwritten.',
    confirmDelete:(n,s)=>'Permanently delete '+n+' session(s) ('+s+')?',deleteHint:'This cannot be undone. Related image caches and bridge records are deleted too.',
    deleteCheck:'I confirm permanent deletion',cancel:'Cancel',confirm:'Confirm',
    resultDone:n=>n+' done',resultFailed:n=>n+' not processed',resultUnknown:n=>n+' unknown',
    unknownHint:'Unknown outcomes were not retried. The list was refreshed; decide from the state it shows.',dismiss:'Dismiss',
    days:n=>n+' d ago',hours:n=>n+' h ago',minutes:n=>n+' min ago',now:'just now',
  },
};
const BATCH=200,POLL_MS=600;
const PHASE_METHOD={archiving:'sessions.archive',restoring:'sessions.restore',deleting:'sessions.delete'};

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
function bytes(n){
  if(!Number.isFinite(n))return '-';
  const units=['B','KB','MB','GB','TB'];let i=0,v=n;
  while(v>=1024&&i<units.length-1){v/=1024;i++;}
  return (i?v.toFixed(v<10?1:0):String(v))+' '+units[i];
}
function basename(p){return String(p||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop()||String(p||'');}

function mountPage(container,ctx){
  const t=TEXT[ctx.locale==='zh-CN'?'zh-CN':'en'];
  const state={tab:'active',lists:{active:null,archived:null},loading:false,busy:false,error:null,
    selected:new Set(),project:'',query:'',age:0,dialog:null,report:null};
  let disposed=false;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  async function call(method,params){
    const {jobId}=await ctx.backend.invoke('start',{method,params});
    // From here on the request may have reached the VPS: any failure, including
    // losing the backend while polling, leaves the outcome unknown.
    try{
      let text='',offset=0;
      for(;;){
        if(disposed)throw new Error('disposed');
        const reply=await ctx.backend.invoke('poll',{jobId,offset});
        if(reply.state==='running'){await sleep(POLL_MS);continue;}
        if(reply.state==='failed')throw Object.assign(new Error(reply.error?.message||'failed'),{code:reply.error?.code});
        text+=reply.chunk;offset=reply.nextOffset;
        if(offset>=reply.total)return JSON.parse(text);
      }
    }catch(error){throw Object.assign(error,{afterStart:true});}
  }
  const ago=iso=>{
    const ms=Date.now()-Date.parse(iso);
    if(!Number.isFinite(ms))return '-';
    if(ms<60000)return t.now;
    if(ms<3600000)return t.minutes(Math.floor(ms/60000));
    if(ms<86400000)return t.hours(Math.floor(ms/3600000));
    return t.days(Math.floor(ms/86400000));
  };
  const current=()=>state.lists[state.tab];
  function warningsFor(list,id){return (list?.warnings||[]).filter(w=>w.id===id);}
  function info(row,list){
    const warnings=warningsFor(list,row.id);
    const incomplete=warnings.find(w=>w.code==='ARCHIVE_INCOMPLETE')?.phase;
    const bound=(row.bound?.threads?.length||0)>0;
    const maybeBound=!bound&&warnings.some(w=>w.code==='BINDINGS_UNAVAILABLE');
    const selectable=row.state==='idle'&&!incomplete;
    return {incomplete,bound,maybeBound,selectable};
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

  async function refresh(){
    if(state.loading)return;
    state.loading=true;state.error=null;render();
    try{
      const [active,archived]=await Promise.all(['active','archived'].map(scope=>call('sessions.list',{scope})));
      for(const [scope,reply] of [['active',active],['archived',archived]]){
        if(!reply.ok)throw new Error(reply.error?.message||reply.error?.code);
        state.lists[scope]=reply.result;
      }
      const ids=new Set(current().sessions.map(row=>row.id));
      for(const id of [...state.selected])if(!ids.has(id))state.selected.delete(id);
    }catch(error){if(!disposed)state.error=error.message;}
    finally{state.loading=false;if(!disposed)render();}
  }

  async function apply(method,rows,extra){
    state.busy=true;state.dialog=null;state.report=null;render();
    const results=[];
    try{
      for(let i=0;i<rows.length;i+=BATCH){
        const items=rows.slice(i,i+BATCH).map(row=>({id:row.id,revision:row.revision}));
        try{
          const reply=await call(method,{items,...extra});
          if(!reply.ok)throw Object.assign(new Error(reply.error?.message||reply.error?.code),{afterStart:true,known:true});
          results.push(...reply.result.results);
        }catch(error){
          // Once a write has started, a lost reply means the outcome is unknown.
          const unknown=error.afterStart&&!error.known;
          for(const item of items)results.push({id:item.id,status:unknown?'unknown':'rejected',code:error.code||'ERROR',message:error.message});
          if(!error.afterStart)break;
        }
      }
    }finally{
      const titles=new Map(rows.map(row=>[row.id,row.title||row.id]));
      state.report={results:results.map(r=>({...r,title:titles.get(r.id)||r.id}))};
      state.selected.clear();state.busy=false;
      if(!disposed){render();await refresh();}
    }
  }

  function openDialog(kind){
    const rows=current().sessions.filter(row=>state.selected.has(row.id));
    if(!rows.length)return;
    const total=bytes(rows.reduce((sum,row)=>sum+(row.bytes||0),0));
    const list=current(),bound=rows.filter(row=>{const i=info(row,list);return i.bound||i.maybeBound;}).length;
    state.dialog={kind,rows,total,bound,checked:false};render();
  }

  function renderDialog(){
    const d=state.dialog;
    const danger=d.kind==='delete';
    const needCheck=danger||(d.kind==='archive'&&d.bound>0);
    const heading=d.kind==='archive'?t.confirmArchive(d.rows.length,d.total):d.kind==='restore'?t.confirmRestore(d.rows.length,d.total):t.confirmDelete(d.rows.length,d.total);
    const hint=d.kind==='archive'?t.archiveHint:d.kind==='restore'?t.restoreHint:t.deleteHint;
    const confirm=el('button',{class:'cvb-button '+(danger?'cvb-danger':'cvb-primary'),text:t.confirm,disabled:needCheck&&!d.checked,onclick:()=>{
      const method=d.kind==='archive'?'sessions.archive':d.kind==='restore'?'sessions.restore':'sessions.delete';
      void apply(method,d.rows,d.kind==='archive'&&d.bound>0?{confirmBound:true}:{});
    }});
    const check=needCheck?el('label',{class:'cvb-check'},el('input',{type:'checkbox',checked:d.checked,onchange:e=>{d.checked=e.target.checked;confirm.disabled=!d.checked;}}),
      el('span',{text:danger?t.deleteCheck:t.boundCheck(d.bound)})):null;
    return el('div',{class:'cvb-overlay'},el('div',{class:'cvb-dialog',role:'dialog'},
      el('h3',{text:heading}),el('p',{class:danger?'cvb-warn':'cvb-muted',text:hint}),
      el('ul',{class:'cvb-preview'},d.rows.slice(0,8).map(row=>el('li',{text:(row.title||t.noTitle)+' · '+bytes(row.bytes)})),d.rows.length>8?el('li',{text:'… +'+(d.rows.length-8)}):null),
      check,
      el('div',{class:'cvb-actions'},el('button',{class:'cvb-button',text:t.cancel,onclick:()=>{state.dialog=null;render();}}),confirm)));
  }

  function renderReport(){
    const results=state.report.results;
    const done=results.filter(r=>r.status==='done'),unknown=results.filter(r=>r.status==='unknown'),failed=results.filter(r=>r.status!=='done'&&r.status!=='unknown');
    return el('div',{class:'cvb-report'+(unknown.length||failed.length?' cvb-report-warn':'')},
      el('div',{class:'cvb-report-head'},el('strong',{text:[done.length?t.resultDone(done.length):null,failed.length?t.resultFailed(failed.length):null,unknown.length?t.resultUnknown(unknown.length):null].filter(Boolean).join(' · ')}),
        el('button',{class:'cvb-link',text:t.dismiss,onclick:()=>{state.report=null;render();}})),
      unknown.length?el('p',{class:'cvb-warn',text:t.unknownHint}):null,
      [...failed,...unknown].length?el('ul',{},[...failed,...unknown].slice(0,20).map(r=>el('li',{text:r.title+'：'+r.message}))):null);
  }

  function renderRow(row,list){
    const i=info(row,list);
    const badges=[
      row.state==='running'?el('span',{class:'cvb-badge cvb-badge-run',text:t.running}):null,
      row.state==='unknown'?el('span',{class:'cvb-badge',text:t.unknown}):null,
      i.bound?el('span',{class:'cvb-badge',text:t.bound}):i.maybeBound?el('span',{class:'cvb-badge',text:t.maybeBound}):null,
      i.incomplete?el('span',{class:'cvb-badge cvb-badge-warn',text:t.phase[i.incomplete]||i.incomplete}):null,
    ];
    const project=row.project?.mapped?basename(row.project.localCwd):t.unmapped;
    const when=state.tab==='archived'&&row.archivedAt?t.archivedAt+' '+ago(row.archivedAt):t.lastActive+' '+ago(row.lastActiveAt);
    const resume=i.incomplete&&row.state==='idle'?el('button',{class:'cvb-button cvb-small',text:t.resume,disabled:state.busy,onclick:()=>void apply(PHASE_METHOD[i.incomplete],[row],{})}):null;
    return el('li',{class:'cvb-row'+(state.selected.has(row.id)?' cvb-selected':'')},
      el('input',{type:'checkbox',checked:state.selected.has(row.id),disabled:!i.selectable||state.busy,title:i.selectable?undefined:t.notSelectable,
        onchange:e=>{e.target.checked?state.selected.add(row.id):state.selected.delete(row.id);render();}}),
      el('div',{class:'cvb-main'},
        el('div',{class:'cvb-title',title:row.title||row.id,text:row.title||t.noTitle}),
        el('div',{class:'cvb-meta'},el('span',{title:row.project?.localCwd||row.project?.remoteCwd,text:project}),el('span',{text:when}),el('span',{text:bytes(row.bytes)}),el('span',{class:'cvb-id',title:row.id,text:row.id.slice(0,8)}))),
      el('div',{class:'cvb-badges'},badges,resume));
  }

  function render(){
    if(disposed)return;
    const list=current(),rows=visible();
    const projects=new Map();
    for(const row of list?.sessions||[])if(row.project?.projectId)projects.set(row.project.projectId,basename(row.project.localCwd||row.project.remoteCwd));
    const selectable=rows.filter(row=>info(row,list).selectable);
    const allChecked=selectable.length>0&&selectable.every(row=>state.selected.has(row.id));
    const count=state.selected.size,storage=(state.lists.active||state.lists.archived)?.storage;
    const general=(list?.warnings||[]).filter(w=>!w.id);
    const tab=(name,label)=>el('button',{class:'cvb-tab'+(state.tab===name?' cvb-tab-on':''),disabled:state.busy,onclick:()=>{state.tab=name;state.selected.clear();render();}},
      label+(state.lists[name]?' '+state.lists[name].sessions.length:''));
    container.replaceChildren(el('div',{class:'cvb'},
      el('div',{class:'cvb-head'},
        el('div',{},el('h2',{text:t.title}),storage?el('div',{class:'cvb-muted',text:t.storage(bytes(storage.activeBytes),bytes(storage.archivedBytes),bytes(storage.cacheBytes))}):null),
        el('button',{class:'cvb-button',text:state.loading?t.loading:t.refresh,disabled:state.loading||state.busy,onclick:()=>void refresh()})),
      el('div',{class:'cvb-tabs'},tab('active',t.active),tab('archived',t.archived)),
      el('div',{class:'cvb-filters'},
        el('select',{onchange:e=>{state.project=e.target.value;render();}},el('option',{value:'',text:t.allProjects}),[...projects].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>el('option',{value:id,text:name,selected:state.project===id}))),
        el('select',{onchange:e=>{state.age=Number(e.target.value);render();}},[0,7,30,90].map(n=>el('option',{value:String(n),text:n?t.olderThan(n):t.anyAge,selected:state.age===n}))),
        el('input',{type:'search',placeholder:t.search,value:state.query,oninput:e=>{state.query=e.target.value;const pos=e.target.selectionStart;render();const box=container.querySelector('.cvb-filters input');box?.focus();box?.setSelectionRange(pos,pos);}})),
      state.error?el('p',{class:'cvb-error',text:state.error}):null,
      general.length?el('ul',{class:'cvb-notes'},[...new Set(general.map(w=>w.message))].map(m=>el('li',{text:m}))):null,
      state.report?renderReport():null,
      state.dialog?renderDialog():null,
      !state.dialog&&(count||state.busy)?el('div',{class:'cvb-bar'},
        state.busy?el('span',{text:t.working}):[
          el('button',{class:'cvb-link',text:t.clear,onclick:()=>{state.selected.clear();render();}}),
          state.tab==='active'?el('button',{class:'cvb-button cvb-primary',text:t.archive(count),onclick:()=>openDialog('archive')}):[
            el('button',{class:'cvb-button',text:t.restore(count),onclick:()=>openDialog('restore')}),
            el('button',{class:'cvb-button cvb-danger',text:t.remove(count),onclick:()=>openDialog('delete')})]]):null,
      el('label',{class:'cvb-check cvb-select-all'},el('input',{type:'checkbox',checked:allChecked,disabled:!selectable.length||state.busy||Boolean(state.dialog),onchange:e=>{for(const row of selectable)e.target.checked?state.selected.add(row.id):state.selected.delete(row.id);render();}}),el('span',{text:t.selectAll})),
      list?(rows.length?el('ul',{class:'cvb-list'},rows.map(row=>renderRow(row,list))):el('p',{class:'cvb-muted',text:t.empty})):el('p',{class:'cvb-muted',text:state.loading?t.loading:''})));
  }

  render();void refresh();
  return ()=>{disposed=true;container.replaceChildren();};
}

define({activate(api){
  return api.settings.registerPage({title:{en:'VPS Sessions','zh-CN':'VPS 会话'},mount:mountPage});
}});
})();
