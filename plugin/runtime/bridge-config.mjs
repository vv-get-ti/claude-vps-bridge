import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRoutes} from './ssh-routes.mjs';
import {flowLimits} from '../transport-streams.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function validateTransportOptions(value){
  validateRoutes(value.sshRoutes);
  flowLimits({chunkBytes:value.transportChunkBytes,windowBytes:value.transportWindowBytes});
}
export function validateConfig(value){
  if(value?.schemaVersion!==1)throw new Error('Unsupported bridge configuration version');
  if(typeof value.sshHost!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(value.sshHost))throw new Error('Invalid SSH host alias');
  for(const key of ['hostRoot','sshExecutable','pwshExecutable'])if(typeof value[key]!=='string'||!path.win32.isAbsolute(value[key])||/[\r\n\0]/.test(value[key]))throw new Error(key+' must be an absolute Windows path');
  for(const key of ['remoteRoot','remoteWorkspaceRoot','remoteClaudeExecutable'])if(typeof value[key]!=='string'||!value[key].startsWith('/')||value[key]==='/'||value[key].split('/').includes('..')||/[\r\n\0]/.test(value[key]))throw new Error(key+' must be an absolute remote path');
  validateTransportOptions(value);
  return value;
}
let cached;
export function loadBridgeConfig({root:directory=root,installedRoot,configFile=process.env.CLAUDE_VPS_CONFIG}={}){
  const candidates=configFile?[configFile]:[path.join(directory,'bridge-config.json'),path.join(directory,'bridge-config.local.json'),...(installedRoot?[path.join(installedRoot,'bridge-config.json')]:[])];
  const file=candidates.find(p=>fs.statSync(p,{throwIfNoEntry:false})?.isFile());
  if(!file)throw new Error('Bridge configuration missing; run the bridge installer configuration step');
  return validateConfig(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
}
export function getBridgeConfig(){return cached??=loadBridgeConfig();}
export function shellQuote(value){return "'"+String(value).replaceAll("'","'\\''")+"'";}
