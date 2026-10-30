// Display bookkeeping only. Never reuse this state to skip model context or policy checks.
import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable=rows=>rows.map(row=>JSON.stringify(row)).sort();
const legacyLocalReason='Provider, credential or runtime variable remains local and is not applied by this bridge';
export function validNoticeState(value){
  return value?.schemaVersion===1&&['rulesHash','capabilitiesHash','warningsHash'].every(k=>/^[a-f0-9]{64}$/.test(value[k]??''))&&Number.isSafeInteger(value.warningCount)&&value.warningCount>=0;
}
export function contextNotice(previous,environment){
  if(!validNoticeState(previous))previous=null;
  const rules=environment.ruleFiles??[],capabilities=environment.capabilities??[];
  // Recognize the previous local-runtime description during a two-sided upgrade.
  const warnings=[...new Map((environment.warnings??[]).filter(w=>w.kind!=='local-only'&&w.reason!==legacyLocalReason).map(w=>{
    const row={path:w.path,key:w.key,reason:w.reason,blocking:w.blocking===true};return [JSON.stringify(row),row];
  })).values()];
  const state={schemaVersion:1,
    rulesHash:digest(stable(rules.map(r=>[r.path,r.scope,r.paths,r.sha256]))),
    capabilitiesHash:digest(stable(capabilities.map(c=>[c.id,c.kind,c.name,c.path,c.sha256,c.disableModelInvocation]))),
    warningsHash:digest(stable(warnings)),warningCount:warnings.length};
  const messages=[];
  if(previous&&previous.rulesHash!==state.rulesHash)messages.push(`项目规则已更新（${rules.length} 份）。`);
  if(previous&&previous.capabilitiesHash!==state.capabilitiesHash)messages.push(`Skills/命令/Agent 定义已更新（${capabilities.length} 项）。`);
  if(previous?.warningsHash!==state.warningsHash){
    const blocking=warnings.filter(w=>w.blocking).length;
    if(warnings.length)messages.push(`${warnings.length} 项本机配置不兼容${blocking?`，其中 ${blocking} 项会阻止相关操作`:''}。`);
    else if(previous?.warningCount)messages.push('本机配置不兼容的问题已解除。');
  }
  return {state,changed:!previous||Object.keys(state).some(k=>state[k]!==previous[k]),text:messages.join('\n')};
}
