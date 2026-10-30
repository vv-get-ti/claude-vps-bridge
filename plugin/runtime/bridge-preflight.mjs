const fault=(code,message)=>Object.assign(new Error(message),{code});
export function createBridgePreflight({connect,connectionKey,probe,recoverLegacy,timing=()=>{},now=Date.now,healthTtlMs=30000}){
  let healthCache,healthPending,generation=0;
  function validate(value){
    if(value?.protocol!==2||!Array.isArray(value.capabilities)||!value.capabilities.includes('project-context'))throw fault('BRIDGE_PROTOCOL_INCOMPATIBLE','Bridge versions differ. Update both installed sides before starting a model turn.');
    return value;
  }
  async function health(){
    await connect();
    const key=connectionKey();
    if(healthCache?.key===key&&healthCache.generation===generation&&now()<healthCache.until)return healthCache.value;
    if(healthPending)return healthPending;
    healthPending=(async()=>{
      const version=generation,started=performance.now();let value;
      try{value=await probe();}
      catch(error){if(!recoverLegacy)throw error;await recoverLegacy();value=await probe();}
      validate(value);
      if(!value.capabilities.includes('duplex-tools')||!value.capabilities.includes('duplex-control')){
        if(!recoverLegacy)throw fault('BRIDGE_DUPLEX_UNAVAILABLE','The remote bridge does not support the required duplex controls and tools.');
        await recoverLegacy();value=validate(await probe());
      }
      timing({phase:'bridge-capabilities',ms:performance.now()-started,ok:true});
      // A reconnect during the probe invalidates the cached result. The next
      // operation must inspect the connection it actually uses.
      if(generation!==version||connectionKey()!==key)throw fault('BRIDGE_CONNECTION_CHANGED','The bridge connection changed during capability validation. No turn was submitted; retry on the current connection.');
      healthCache={key,generation,value,until:now()+healthTtlMs};
      return value;
    })().finally(()=>{healthPending=null;});
    return healthPending;
  }
  return {health,invalidate(){generation++;healthCache=null;}};
}
