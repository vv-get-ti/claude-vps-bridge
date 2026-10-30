// Acknowledged per-session configuration; never infer that a resumed/compacted
// native session still contains the previous complete rules.
export function contextUpdate(previous,current,{force=false}={}){
  const entries=current.contextEntries;
  if(!Array.isArray(entries))return {text:current.text,state:null,mode:'full'};
  const state={fingerprint:current.fingerprint,entries:Object.fromEntries(entries.map(e=>[e.id,e]))};
  if(force||!previous)return {text:'Current Windows configuration snapshot. It replaces earlier bridge configuration; the current user request remains authoritative.\n'+entries.map(e=>e.text).join('\n\n'),state,mode:'full'};
  const changed=entries.filter(e=>previous.entries[e.id]?.sha!==e.sha);
  const removed=Object.keys(previous.entries).filter(id=>!state.entries[id]);
  if(!changed.length&&!removed.length)return {text:'Windows configuration checked: unchanged. Continue applying the previously supplied rules. Current fingerprint: '+current.fingerprint,state,mode:'unchanged'};
  return {text:'Windows configuration update. Replace prior versions of the listed entries; removed entries no longer apply.\nRemoved entries: '+JSON.stringify(removed)+'\n\n'+changed.map(e=>e.text).join('\n\n'),state,mode:'delta'};
}
