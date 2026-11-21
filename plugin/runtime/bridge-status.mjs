import fs from 'node:fs/promises';
import path from 'node:path';
import {activationStatus,processAlive,readStamp} from './activation.mjs';
import {relayIdentity,routeObservation,validTime} from './ssh-routes.mjs';

const maxAgeMs=90000;
const versionPattern=/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
async function readRecord(directory,name){
  try{
    const file=path.join(directory,name),stat=await fs.lstat(file);
    if(stat.isFile()&&stat.nlink===1&&stat.size<=65536)return JSON.parse(await fs.readFile(file,'utf8'));
  }catch{}
  return null;
}

async function linkObservation(state,{now=Date.now(),isAlive=processAlive}={}){
  const [row,loaded]=await Promise.all([readRecord(state,'ssh-route.json'),readRecord(state,'loaded-install.json')]);
  const route=routeObservation({},row,isAlive);
  const last=Date.parse(route?.observedAt);
  const loadTime=Date.parse(loaded?.loadedAt);
  const fresh=route&&route.state!=='stopped'&&loaded?.pid===row.pid&&Number.isFinite(loadTime)&&
    last>=loadTime&&last<=now&&now-last<=maxAgeMs;
  return {row,route,fresh,loaded};
}

export async function bridgeStatus(directory,state,options){
  const [manifest,stamp,{row,route,fresh,loaded}]=await Promise.all([readRecord(directory,'manifest.json'),readStamp(directory),
    linkObservation(state,options)]);
  const activation=activationStatus(stamp,loaded,options?.isAlive);
  const states={connecting:'reconnecting',reconnecting:'reconnecting',connected:'connected',unavailable:'unavailable',closed:'unavailable'};
  const since=validTime(row?.since);
  return {
    pluginVersion:typeof manifest?.version==='string'&&manifest.version.length<=128&&versionPattern.test(manifest.version)?manifest.version:null,
    activation:{state:activation.status},
    connection:{state:fresh?states[route.state]:'unknown',since:fresh?(since&&since<=route.observedAt?since:route.observedAt):null,observedAt:route?.observedAt??null},
    route:{name:route?.route??null,kind:route?.routeType??null,ingress:route?.ingress.kind??'unknown',
      match:route?.consistency==='match'?true:route?.consistency==='mismatch'?false:null,
      lastSwitch:route?.lastSwitchAt?{from:route.lastSwitchFrom,to:route.lastSwitchTo,reason:route.lastSwitchDetail??route.lastSwitchReason,at:route.lastSwitchAt}:null},
  };
}

export async function currentRelay(state,options){
  const {row,route,fresh}=await linkObservation(state,options);
  const id=relayIdentity(row?.relayId),epoch=relayIdentity(row?.relayEpoch);
  return fresh&&route.state==='connected'&&id&&epoch?{id,epoch}:null;
}
