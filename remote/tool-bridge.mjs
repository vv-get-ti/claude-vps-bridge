import net from 'node:net';
import {bridgeRoot} from './remote-config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';

// Private VPS Unix socket -> existing authenticated SSH channel -> bound Windows
// handler. The token selects one exact session, never a supplied filesystem cwd.
export async function createToolBridge(dispatch){
  const directory=path.join(bridgeRoot,'run');await fs.mkdir(directory,{recursive:true,mode:0o700});
  const socketPath=path.join(directory,'tools-'+randomUUID()+'.sock'),sessions=new Map();
  const server=net.createServer(socket=>{
    let buffer='',consumed=false;socket.on('error',()=>{});socket.setTimeout(120000,()=>socket.destroy());
    socket.on('data',chunk=>{if(consumed)return;buffer+=chunk;if(Buffer.byteLength(buffer)>48*1024*1024){socket.destroy();return;}if(!buffer.includes('\n'))return;consumed=true;
      void(async()=>{const message=JSON.parse(buffer.split('\n')[0]);const binding=sessions.get(message.sessionId),candidate=Buffer.from(String(message.token??''));
        if(!binding||candidate.length!==64||!timingSafeEqual(candidate,Buffer.from(binding.toolToken)))throw new Error('Unknown tool session or invalid authentication');
        if(!message.request||typeof message.request!=='object')throw new Error('Missing structured tool request');
        for(const [key,value] of Object.entries({cwd:binding.localCwd,projectId:binding.projectId,sessionId:binding.sessionId}))if(key in message.request&&message.request[key]!==value)throw new Error('Tool request cannot override the bound '+key);
        if(message.internal&&!['preflight','environment','mcp'].includes(message.request.action))throw new Error('Unsupported tool control action');
        return dispatch(binding,message.request,message.internal===true);
      })().then(value=>socket.end(JSON.stringify({ok:true,value})+'\n'),error=>socket.end(JSON.stringify({ok:false,error:{code:error.code??'TOOL_BRIDGE_FAILED',message:error.message}})+'\n'));
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await fs.chmod(socketPath,0o600);
  return {
    register(binding){binding.toolToken=randomBytes(32).toString('hex');sessions.set(binding.sessionId,binding);return {WINDOWS_TOOL_SOCKET:socketPath,WINDOWS_TOOL_TOKEN:binding.toolToken};},
    unregister(id){sessions.delete(id);},
    async close(){server.close();await fs.unlink(socketPath).catch(()=>{});}
  };
}
