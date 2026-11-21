import net from 'node:net';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import {statSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {replaceFile} from './atomic-file.mjs';

const helper=fileURLToPath(new URL('socks-connect.mjs',import.meta.url));
const label=/^[\p{L}][\p{L}\p{N}_-]{0,47}$/u;
const reasons=new Set(['connection-failed','handshake-timeout','read-stalled','route-helper-unavailable']);
// SSH/cloudflared stderr is reduced to a fixed category; the text itself (which
// may contain addresses or hostnames) is never stored or reported.
const failureKinds=[
  ['dns-failed',/could not resolve hostname|no such host|name or service not known|temporary failure in name resolution|lookup .* (?:failed|no such)/i],
  ['host-key-mismatch',/remote host identification has changed|host key verification failed/i],
  ['auth-failed',/permission denied|too many authentication failures/i],
  ['connection-refused',/connection refused/i],
  ['network-unreachable',/network is unreachable|no route to host/i],
  ['connection-timeout',/timed out|timeout/i],
  ['socks-failed',/\bSOCKS_[A-Z_0-9]+\b/],
  ['cloudflared-error',/\bERR\b|failed to connect to origin|websocket: bad handshake|access denied/i],
  ['proxy-closed',/kex_exchange_identification|connection closed by unknown port 65535|ssh_exchange_identification/i],
  ['closed-by-remote',/connection (?:closed|reset) by/i],
];
export const failureDetails=new Set([...failureKinds.map(([kind])=>kind),'unclassified']);
export function classifySshFailure(stderr){
  if(typeof stderr!=='string'||!stderr.trim())return null;
  for(const [kind,pattern] of failureKinds)if(pattern.test(stderr))return kind;
  return 'unclassified';
}
export function routeFailureReason(error){
  if(error.code==='ROUTE_HELPER_UNAVAILABLE')return 'route-helper-unavailable';
  if(['HANDSHAKE_TIMEOUT','SSH_HANDSHAKE_TIMEOUT','REMOTE_HEALTH_TIMEOUT'].includes(error.code))return 'handshake-timeout';
  return 'connection-failed';
}
export function validHost(host){
  if(typeof host!=='string'||!host.length||host.length>253||/[^A-Za-z0-9.:-]/.test(host))return false;
  if(net.isIP(host))return true;
  return host.replace(/\.$/,'').split('.').every(part=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part));
}

export function validateRoutes(routes){
  if(routes===undefined)return [{name:'direct',direct:true}];
  if(!Array.isArray(routes)||!routes.length||routes.length>16)throw Error('sshRoutes must contain 1 to 16 routes');
  const names=new Set();
  for(const route of routes){
    if(!route||typeof route.name!=='string'||!label.test(route.name)||names.has(route.name))throw Error('Invalid or duplicate SSH route name');
    names.add(route.name);
    if(Object.keys(route).length!==2)throw Error('Invalid SSH route fields');
    if(route.direct===true)continue;
    const p=route.proxy;
    if(p?.type==='cloudflared'){
      if(Object.keys(p).some(k=>!['type','hostname','executable'].includes(k))||!validHost(p.hostname)||net.isIP(p.hostname))throw Error('Invalid cloudflared hostname');
      if(p.executable!==undefined){
        if(typeof p.executable!=='string'||!/^[A-Za-z]:[\\/]/.test(p.executable)||p.executable.slice(2).includes(':')||p.executable.split(/[\\/]/).includes('..')||!p.executable.toLowerCase().endsWith('.exe'))throw Error('Invalid cloudflared executable');
        commandPath(p.executable);
      }
    }else if(!p||Object.keys(p).length!==3||p.type!=='socks5'||!validHost(p.host)||!Number.isInteger(p.port)||p.port<1||p.port>65535)throw Error('Invalid SOCKS5 route');
  }
  return routes;
}

function commandPath(file){
  // OpenSSH interprets ProxyCommand as a command string. Only literal paths
  // and validated endpoint arguments may enter it, including on Windows.
  if((!path.win32.isAbsolute(file)&&!path.isAbsolute(file))||/["'%!$&`|<>^\x00-\x1f]/.test(file))throw Error('Unsafe ProxyCommand executable or helper path');
  return '"'+file+'"';
}

function findCloudflared(explicit){
  const env=process.env;
  const dirs=(env.PATH??'').split(path.delimiter).map(v=>v.replace(/^"(.*)"$/,'$1')).filter(v=>path.isAbsolute(v));
  for(const base of [env.ProgramFiles,env['ProgramFiles(x86)']])if(base)dirs.push(path.join(base,'cloudflared'));
  if(env.LOCALAPPDATA)dirs.push(path.join(env.LOCALAPPDATA,'Microsoft','WinGet','Links'));
  for(const file of explicit?[explicit]:dirs.map(dir=>path.join(dir,'cloudflared.exe'))){
    try{if(statSync(file).isFile()){const resolved=realpathSync(file);commandPath(resolved);return resolved;}}catch{}
  }
  throw Object.assign(Error('cloudflared executable unavailable'),{code:'ROUTE_HELPER_UNAVAILABLE'});
}
export class SshRoutes{
  constructor(config,{locateCloudflared=findCloudflared}={}){this.config=config;this.routes=validateRoutes(config.sshRoutes);this.locateCloudflared=locateCloudflared;this.index=0;this.lastSwitchReason=null;this.lastSwitchDetail=null;this.lastSwitchAt=null;}
  get current(){return this.routes[this.index];}
  get length(){return this.routes.length;}
  advance(reason,detail=null){
    if(this.length===1)return false;
    this.lastSwitchFrom=this.current.name;
    this.index=(this.index+1)%this.length;
    this.lastSwitchTo=this.current.name;
    this.lastSwitchReason=reasons.has(reason)?reason:'connection-failed';
    this.lastSwitchDetail=failureDetails.has(detail)?detail:null;this.lastSwitchAt=new Date().toISOString();
    return true;
  }
  args(command,{connectTimeout=12,keepAlive=false}={}){
    const args=['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout='+connectTimeout];
    if(keepAlive)args.push('-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2');
    if(this.current.proxy?.type==='cloudflared'){
      const {executable,hostname}=this.current.proxy;
      args.push('-o','ProxyCommand='+commandPath(this.locateCloudflared(executable))+' access ssh --hostname '+hostname);
    }else if(this.current.proxy){
      const {host,port}=this.current.proxy;
      const node=path.win32.join(this.config.hostRoot,'runtime','node.exe');
      args.push('-o','ProxyCommand='+[commandPath(node),commandPath(helper),host,port,'"%h"','%p'].join(' '));
    }else if(this.config.sshRoutes)args.push('-o','ProxyCommand=none');
    return [...args,this.config.sshHost,command];
  }
  async firstAvailable(attempt,mayRetry=()=>true){
    for(let i=0;;i++){
      try{return await attempt(this);}
      catch(error){
        if(i+1>=this.length||!mayRetry(error))throw error;
        this.advance(routeFailureReason(error),error.sshFailure);
      }
    }
  }
}

export const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)).toISOString():null;
const routeLabel=value=>typeof value==='string'&&label.test(value)?value:null;
export const relayIdentity=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)?value:null;
const states=new Set(['connecting','reconnecting','connected','unavailable','closed']);
const routeTypes=new Set(['direct','cloudflared','socks5']);
function safeIngress(value){
  const kind=['direct','local-proxy'].includes(value?.kind)?value.kind:'unknown';
  const process=kind==='local-proxy'&&typeof value?.process==='string'&&/^[A-Za-z][A-Za-z0-9_+-]{0,63}$/.test(value.process)?value.process:null;
  return {kind,process};
}
let pendingObservation=Promise.resolve();
const recentObservations=new Map();
export function recordRouteState(directory,state){
  if(typeof state.route!=='string'||!label.test(state.route)||!states.has(state.state))return Promise.resolve();
  const row={route:state.route,routeType:routeTypes.has(state.routeType)?state.routeType:null,state:state.state,ingress:safeIngress(state.ingress),lastSwitchReason:reasons.has(state.lastSwitchReason)?state.lastSwitchReason:null,lastSwitchDetail:failureDetails.has(state.lastSwitchDetail)?state.lastSwitchDetail:null,lastSwitchAt:validTime(state.lastSwitchAt),pid:process.pid,
    since:validTime(state.since),lastSwitchFrom:routeLabel(state.lastSwitchFrom),lastSwitchTo:routeLabel(state.lastSwitchTo),
    relayId:relayIdentity(state.relayId),relayEpoch:relayIdentity(state.relayEpoch)};
  const file=path.join(directory,'ssh-route.json');
  const signature=JSON.stringify(row),now=Date.now(),previous=recentObservations.get(file);
  if(previous?.signature===signature&&now-previous.now<5000)return pendingObservation;
  const observation={signature,now};
  recentObservations.set(file,observation);
  row.observedAt=new Date(now).toISOString();
  // Preserve callback order even when mkdir/rename of an earlier state is slow.
  pendingObservation=pendingObservation.catch(()=>{}).then(async()=>{
    await fs.mkdir(directory,{recursive:true});
    const temp=file+'.'+randomUUID()+'.tmp';
    await fs.writeFile(temp,JSON.stringify(row),{mode:0o600});
    try{await replaceFile(temp,file);}
    finally{await fs.rm(temp,{force:true});}
  }).catch(error=>{
    if(recentObservations.get(file)===observation)recentObservations.delete(file);
    throw error;
  });
  return pendingObservation;
}

export function routeObservation(config,row,isAlive){
  if(!row||!states.has(row.state))return null;
  if(typeof row.route!=='string'||!label.test(row.route))return null;
  const selected=validateRoutes(config.sshRoutes).find(r=>r.name===row.route);
  if(!selected&&!routeTypes.has(row.routeType))return null;
  const observed=Date.parse(row.observedAt);
  if(!Number.isFinite(observed)||!Number.isSafeInteger(row.pid)||row.pid<1)return null;
  const ingress=safeIngress(row.ingress),type=routeTypes.has(row.routeType)?row.routeType:selected.proxy?.type??'direct';
  // A SOCKS exit may reach sshd over the network or through a local tunnel.
  // Its final hop alone cannot establish which Windows-side proxy was used.
  let consistency='unknown';
  if(ingress.kind!=='unknown'){
    if(type==='direct')consistency=ingress.kind==='direct'?'match':'mismatch';
    if(type==='cloudflared'){
      if(ingress.kind==='direct')consistency='mismatch';
      else if(ingress.process)consistency=ingress.process==='cloudflared'?'match':'mismatch';
    }
  }
  return {route:row.route,routeType:type,state:isAlive(row.pid)===false?'stopped':row.state,ingress,consistency,lastSwitchReason:reasons.has(row.lastSwitchReason)?row.lastSwitchReason:null,lastSwitchDetail:failureDetails.has(row.lastSwitchDetail)?row.lastSwitchDetail:null,lastSwitchAt:validTime(row.lastSwitchAt),observedAt:new Date(observed).toISOString(),
    lastSwitchFrom:routeLabel(row.lastSwitchFrom),lastSwitchTo:routeLabel(row.lastSwitchTo)};
}
