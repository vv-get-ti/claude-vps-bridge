import path from 'node:path';
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
export function optionValue(argv, flag){
  const entries=argv.flatMap((arg,i)=>arg===flag?[argv[i+1]]:arg.startsWith(flag+'=')?[arg.slice(flag.length+1)]:[]);
  if(entries.length>1||entries.some(value=>!value||value.startsWith('--')))fail('INVALID_ARGUMENT','Invalid or repeated '+flag);
  return entries[0];
}
export function boundAgentArguments(argv,{parentThread,cwd}){
  const result=argv.flatMap(arg=>['--cwd','--parent-thread'].some(flag=>arg.startsWith(flag+'='))?[arg.slice(0,arg.indexOf('=')),arg.slice(arg.indexOf('=')+1)]:[arg]);
  const explicit=optionValue(result,'--parent-thread');
  if(parentThread&&explicit&&explicit!==parentThread)fail('PARENT_MISMATCH','父线程必须是当前会话绑定，不能覆盖为其他会话');
  const parent=parentThread||explicit;
  if(!parent)fail('PARENT_THREAD_REQUIRED','当前会话缺少父线程绑定；请重新打开会话，或显式提供 --parent-thread');
  if(result[0]==='delegate'&&result[1]==='start'&&!result.includes('--help')){
    const selected=optionValue(result,'--cwd');
    const key=value=>path.win32.resolve(value).replace(/[\\/]+$/,'').toLowerCase();
    if(selected&&(!path.win32.isAbsolute(selected)||key(selected)!==key(cwd)))fail('PROJECT_MISMATCH','Delegate into the selected project or its explicit managed worktree');
    if(!selected)result.push('--cwd',cwd);
    if(!explicit)result.push('--parent-thread',parent);
  }
  return {argv:result,parentThread:parent};
}
