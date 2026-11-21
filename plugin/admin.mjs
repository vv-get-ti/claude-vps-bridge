import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadBridgeConfig} from './runtime/bridge-config.mjs';
import {listBindings,remoteSessionRequest} from './runtime/session-admin.mjs';
import {bridgeStatus,currentRelay} from './runtime/bridge-status.mjs';
import {storageRequest} from './runtime/storage-admin.mjs';
import {remoteClaudeRequest} from './runtime/claude-installation.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const schema=JSON.parse(await fs.readFile(new URL('./runtime/session-admin-schema.json',import.meta.url),'utf8'));
const methods=Object.keys(schema.methods);
const ok=result=>({apiVersion:1,ok:true,result});
const fail=(code,message,details={})=>({apiVersion:1,ok:false,error:{code,message,details}});
const invalid=details=>fail('INVALID_ARGUMENT','请检查请求的字段和值。',details);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const types={integer:Number.isInteger,string:v=>typeof v==='string',object,
  uuid:v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v),
  storageId:v=>typeof v==='string'&&/^[vw]-[0-9a-f]{64}$/.test(v),
  revision:v=>typeof v==='string'&&v.length>0&&v.length<=256,
  project:v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v),
  scope:v=>['active','archived'].includes(v),boolean:v=>typeof v==='boolean'};
function check(value,fields,at){
  const allowedFields=Object.keys(fields).map(key=>key.replace(/\?$/,''));
  if(!object(value))return {at,allowedFields};
  const unknownFields=Object.keys(value).filter(key=>!allowedFields.includes(key));
  if(unknownFields.length)return {at,allowedFields,unknownFields};
  for(const [field,type] of Object.entries(fields)){
    const key=field.replace(/\?$/,'');
    if(!Object.hasOwn(value,key)&&field.endsWith('?'))continue;
    if(type==='items'||type==='storageItems'){
      if(!Array.isArray(value[key])||!value[key].length||value[key].length>schema.maxItems)return {at,key,allowedFields,maxItems:schema.maxItems};
      for(const [index,item] of value[key].entries()){
        const error=check(item,type==='items'?schema.item:schema.storageItem,`${at}.items[${index}]`);
        if(error)return error;
      }
    }else if(!types[type](value[key]))return {at,key,allowedFields};
  }
}

export async function admin(request,{directory=root,installedRoot=path.join(os.homedir(),'.codexhost','plugins','claude-vps'),getConfig=loadBridgeConfig,remote=remoteSessionRequest,claude=remoteClaudeRequest}={}){
  if(object(request)&&Object.hasOwn(request,'apiVersion')&&request.apiVersion!==schema.apiVersion)
    return fail('UNSUPPORTED_API_VERSION','不支持该管理接口版本。',{apiVersions:[schema.apiVersion]});
  const shape=check(request,schema.request,'request');if(shape)return invalid(shape);
  const {method,params}=request;
  if(!methods.includes(method))return invalid({at:'request.method',allowedFields:Object.keys(schema.request),methods});
  const bad=check(params,schema.methods[method],'params');if(bad)return invalid(bad);
  if(method==='info'){
    const {version:pluginVersion}=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
    return ok({pluginVersion,apiVersions:[schema.apiVersion],methods});
  }
  const state=path.join(directory,'runtime','state');
  if(method==='bridge.status')return ok(await bridgeStatus(directory,state));
  const configurationUnavailable=()=>fail('SSH_UNAVAILABLE','桥接 SSH 配置缺失或无法读取。');
  const configArgs={root:directory,installedRoot};
  if(method.startsWith('storage.')){
    return ok(await storageRequest(state,method,params,async remoteParams=>{
      let config;
      try{config=getConfig(configArgs);}catch{return configurationUnavailable();}
      return remote(config,method,remoteParams);
    }));
  }
  let config;
  try{config=getConfig(configArgs);}catch{return configurationUnavailable();}
  if(method==='claude.status'||method==='claude.update')return claude(config,method==='claude.status'?'check':'update');
  if(method==='relays.list'){
    const reply=await remote(config,method,params);
    if(reply.ok){
      const current=await currentRelay(state);
      const {relays,warnings}=reply.result;
      const matched=current&&relays.some(row=>row.id===current.id&&row._epoch===current.epoch&&row.expiresAt==null);
      if(!matched)warnings.push({code:'STATE_UNKNOWN',message:'无法核实当前 Host 正在使用的 relay。'});
      reply.result.relays=relays.map(({_epoch,...row})=>({...row,current:matched?row.id===current.id&&_epoch===current.epoch:null}));
    }
    return reply;
  }
  return listBindings(state).then(bindings=>remote(config,method,params,bindings));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1048576)break;chunks.push(chunk);}
  let request;
  if(size<=1048576){try{request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{}}
  const result=request===undefined?invalid({at:'request',allowedFields:Object.keys(schema.request)}):await admin(request);
  process.stdout.write(JSON.stringify(result)+'\n');
}
