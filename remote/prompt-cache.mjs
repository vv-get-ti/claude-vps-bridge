// Preserve only upstream timestamps. Never derive a TTL from refresh/open time.
export function mergePromptCache(usage,previous,{capabilityUnknown=false,now=Math.floor(Date.now()/1000)}={}){
  const valid=value=>value?.id==='prompt-cache'&&value.kind==='countdown'&&Number.isSafeInteger(value.expiresAtUnix)&&value.expiresAtUnix>now&&value.label&&typeof value.label.en==='string'&&typeof value.label['zh-CN']==='string';
  let indicator=valid(previous)?previous:null;
  const supplied=Array.isArray(usage?.composerIndicators)?usage.composerIndicators:null;
  if(supplied){
    const incoming=supplied.find(i=>i?.id==='prompt-cache');
    if(incoming)indicator=valid(incoming)?incoming:null; // explicit expiry/invalid timestamp wins
    else if(!capabilityUnknown)indicator=null; // authoritative clear wins
  }
  const others=(supplied??[]).filter(i=>i?.id!=='prompt-cache');
  return {indicator,usage:usage||indicator?{...usage,composerIndicators:[...others,...(indicator?[indicator]:[])]}:null};
}
