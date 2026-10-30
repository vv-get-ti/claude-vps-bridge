import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const git=async(cwd,args)=>(await exec('git',args,{cwd,windowsHide:true,maxBuffer:4*1024*1024})).stdout.trim();
const bad=(code,message)=>{throw Object.assign(new Error(message),{code});};
function locations(state,info,id){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id??''))bad('INVALID_ID','Isolation requires a stable requestId');const root=path.join(state,'worktrees',info.projectId,id);return {root,file:path.join(root,'record.json'),cwd:path.join(root,'work')};}
async function clean(cwd){if(await git(cwd,['status','--porcelain=v1','--untracked-files=all']))bad('WORKTREE_DIRTY','Commit or review changes before this operation; no files were overwritten');}
async function identity(info){const root=await fs.realpath(await git(info.cwd,['rev-parse','--show-toplevel']));if(root.toLowerCase()!==(await fs.realpath(info.cwd)).toLowerCase())bad('NOT_REPOSITORY_ROOT','Select the Git repository root for isolated work');return git(info.cwd,['rev-parse','HEAD']);}
export async function workspaceIsolation(state,info,request){
 const p=locations(state,info,request.requestId);
 if(request.operation==='create'){
  const base=await identity(info);await clean(info.cwd);
  if(request.expectedHead!==base)bad('HEAD_CHANGED','Supply the current repository HEAD as expectedHead');
  await fs.mkdir(path.dirname(p.root),{recursive:true});
  try{await fs.mkdir(p.root);}catch(e){if(e.code==='EEXIST')bad('ISOLATION_EXISTS','This isolation ID already exists; inspect its status instead of recreating');throw e;}
  const record={schemaVersion:1,projectId:info.projectId,source:info.cwd,cwd:p.cwd,base,requestId:request.requestId,state:'preparing',createdAt:new Date().toISOString()};
  await fs.writeFile(p.file,JSON.stringify(record));
  // --no-checkout alone is not useful here; checkout the committed tree, never copy private/untracked files.
  await git(info.cwd,['-c','core.hooksPath='+path.join(p.root,'no-hooks'),'worktree','add','--detach',p.cwd,base]);record.state='ready';await fs.writeFile(p.file,JSON.stringify(record));
  return {...record,note:'Changes remain in this worktree. Review and commit there, then explicitly apply with current expectedHead.'};
 }
 const record=JSON.parse(await fs.readFile(p.file,'utf8'));
 if(record.projectId!==info.projectId||record.source.toLowerCase()!==info.cwd.toLowerCase()||record.cwd!==p.cwd)bad('PROJECT_MISMATCH','Isolation belongs to another project');
 const actual=await fs.realpath(p.cwd);if(actual.toLowerCase()!==p.cwd.toLowerCase())bad('WORKTREE_CHANGED','Managed worktree path was redirected');
 const head=await git(p.cwd,['rev-parse','HEAD']);
 if(request.operation==='status')return {...record,head,changes:await git(p.cwd,['status','--short']),diff:await git(p.cwd,['diff','--stat',record.base]),diffCommand:['git','-C',p.cwd,'diff',record.base],note:'Diff excludes untracked file content; changes lists untracked files. No merge was performed.'};
 if(request.operation!=='apply')bad('INVALID_OPERATION','Use isolation create, status or apply');
 if(record.state!=='ready')bad('ISOLATION_NOT_READY','Worktree preparation did not finish');
 const targetHead=await identity(info);
 if(targetHead!==request.expectedHead||head!==request.expectedCandidate)bad('HEAD_CHANGED','Review both HEADs and provide expectedHead and expectedCandidate');
 await clean(info.cwd);await clean(p.cwd);
 try{await git(info.cwd,['merge-base','--is-ancestor',targetHead,head]);}catch{bad('MERGE_REVIEW_REQUIRED','Histories diverged; resolve and review in the worktree before applying. Main files were not changed');}
 // No hooks or merge commits are run; a reviewed descendant is fast-forwarded.
 await git(info.cwd,['-c','core.hooksPath='+path.join(p.root,'no-hooks'),'merge','--ff-only',head]);
 return {...record,applied:true,head:await git(info.cwd,['rev-parse','HEAD'])};
}
