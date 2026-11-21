import {createHash} from 'node:crypto';
import path from 'node:path';
import {applyMaintenance,planMaintenance} from '../maintenance.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const warning={code:'STATE_UNKNOWN',message:'无法核实本机任务日志，已保留日志。'};
const changed={code:'REVISION_CHANGED',message:'日志已变化或不再符合清理条件，请刷新预览。'};
const done={code:'DONE',message:'清理已完成。'};

function logItem(plan,row){
  const relative=path.relative(plan.state,row.file).split(path.sep).join('/');
  return {id:'w-'+hash(relative),location:'windows',kind:'task-log',bytes:row.bytes,fileCount:1,
    reason:'任务已结束，日志已超过本机保留期限。',
    revision:hash(JSON.stringify([row.identity,row.statusHash,row.hash])),lastModifiedAt:new Date(row.mtimeMs).toISOString()};
}

async function cleanWindows(plan,items){
  if(!plan)return items.map(({id})=>({id,status:'rejected',...warning}));
  const candidates=new Map(plan.candidates.map(row=>{const item=logItem(plan,row);return [item.id,{item,row}];}));
  const results=[];
  for(const {id,revision} of items){
    const value=candidates.get(id);
    if(value?.item.revision!==revision){
      results.push({id,status:'conflict',...changed});
      continue;
    }
    candidates.delete(id);
    const result=await applyMaintenance({...plan,candidates:[value.row]});
    results.push({id,...(result.deletedFiles===1?{status:'done',...done}:{status:'conflict',...changed})});
  }
  return results;
}

export async function storageRequest(state,method,params,remote){
  const preview=method==='storage.plan';
  const windows=params.items?.filter(row=>row.id.startsWith('w-'))??[];
  const vps=params.items?.filter(row=>row.id.startsWith('v-'))??[];
  const [plan,reply]=await Promise.all([
    preview||windows.length?planMaintenance(state).catch(()=>null):null,
    preview||vps.length?remote(preview?{}:{items:vps}):null,
  ]);
  if(preview){
    const localItems=plan?.candidates.map(row=>logItem(plan,row))??[];
    const remotePlan=reply?.ok?reply.result:null;
    const warnings=[...(remotePlan?.warnings??(reply?[reply.error]:[])),...(!plan?[warning]:[])];
    return {generatedAt:new Date().toISOString(),items:[...localItems,...(remotePlan?.items??[])],
      totals:{vpsBytes:remotePlan?.totals.vpsBytes??0,windowsBytes:plan?.summary.selectedBytes??0},warnings};
  }
  const local=await cleanWindows(plan,windows);
  const remoteResults=reply?.ok?reply.result.results:vps.map(({id})=>({id,status:'rejected',code:reply.error.code,message:reply.error.message}));
  // Each source preserves its input order, including repeated IDs.
  let localIndex=0,remoteIndex=0;
  return {results:params.items.map(({id})=>id.startsWith('w-')?local[localIndex++]:remoteResults[remoteIndex++])};
}
