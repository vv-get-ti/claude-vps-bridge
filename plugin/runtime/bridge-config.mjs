import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function validateConfig(value){
  if(value?.schemaVersion!==1)throw new Error('Unsupported bridge configuration version');
  if(typeof value.sshHost!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(value.sshHost))throw new Error('Invalid SSH host alias');
  for(const key of ['hostRoot','sshExecutable','pwshExecutable'])if(typeof value[key]!=='string'||!path.win32.isAbsolute(value[key])||/[\r\n\0]/.test(value[key]))throw new Error(key+' must be an absolute Windows path');
  for(const key of ['remoteRoot','remoteWorkspaceRoot','remoteClaudeExecutable'])if(typeof value[key]!=='string'||!value[key].startsWith('/')||value[key]==='/'||value[key].split('/').includes('..')||/[\r\n\0]/.test(value[key]))throw new Error(key+' must be an absolute remote path');
  return value;
}
let cached;
export function getBridgeConfig(){
  if(cached)return cached;
  const candidates=process.env.CLAUDE_VPS_CONFIG?[process.env.CLAUDE_VPS_CONFIG]:[path.join(root,'bridge-config.json'),path.join(root,'bridge-config.local.json')];
  const file=candidates.find(p=>fs.existsSync(p));
  if(!file)throw new Error('Bridge configuration missing; run the bridge installer configuration step');
  return cached=validateConfig(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
}
export function shellQuote(value){return "'"+String(value).replaceAll("'","'\\''")+"'";}
