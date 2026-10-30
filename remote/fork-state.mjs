// Bridge state accompanying an upstream native fork. Never rewrites Claude history.
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const id=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw new Error('Invalid fork identity');return value;};
const posix=value=>value.replaceAll('\\','/');
export function forkPrefix(snapshot,sourceRef,checkpoint){
  if(sourceRef?.harnessId!=='claude-code'||checkpoint?.harnessId!==sourceRef.harnessId||checkpoint.nativeSessionId!==sourceRef.nativeSessionId)throw new Error('Fork checkpoint does not belong to the source Claude session');
  id(sourceRef.nativeSessionId);id(checkpoint.checkpointId);
  const index=snapshot.turns.findIndex(t=>t.checkpoint?.checkpointId===checkpoint.checkpointId&&t.nativeTurnRef?.nativeSessionId===sourceRef.nativeSessionId);
  if(index<0)throw new Error('Fork checkpoint is unavailable; no branch was created');
  return snapshot.turns.slice(0,index+1);
}
export async function inheritMedia(root,sourceBinding,turns,mediaKey){
  const mediaRoot=posix(path.join(root,'.bridge-media')),sourceKey=id(sourceBinding.mediaKey),ownKey=id(mediaKey);
  const ancestorFile=path.join(mediaRoot,sourceKey,'.inherited.json');
  const ancestors=await readFile(ancestorFile,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return {files:[]};throw e;});
  const permitted=new Map((ancestors.files??[]).map(f=>[f.path,f.sha256]));
  const escaped=mediaRoot.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(escaped+'/([a-zA-Z0-9_-]+)/([a-f0-9]{64})\\.(png|jpg|jpeg|webp|gif|pdf)(?=["\\s<\\\\]|$)','g');
  const files=new Map();
  for(const match of JSON.stringify(turns).matchAll(pattern)){
    const file=match[0],hash=match[2];
    if(match[1]!==sourceKey&&permitted.get(file)!==hash)continue;
    const bytes=await readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(bytes===null)continue; // A failed Read in history is not a missing required artifact.
    if(createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('Inherited attachment hash mismatch: '+file);
    files.set(file,{path:file,sha256:hash});
  }
  const directory=path.join(mediaRoot,ownKey);await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'.inherited.json'),temp=file+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify({files:[...files.values()]}),{mode:0o600});await rename(temp,file);
  return [...files.values()];
}
export function pairForkTurns(sourceTurns,derivedTurns){
  if(sourceTurns.length!==derivedTurns.length)throw new Error('Native fork prefix length differs; bridge history was not copied');
  for(const turns of [sourceTurns,derivedTurns]){
    const session=turns[0]?.nativeTurnRef?.nativeSessionId,keys=new Set();
    for(const turn of turns){const ref=turn.nativeTurnRef;if(!ref||ref.nativeSessionId!==session||typeof ref.nativeTurnKey!=='string'||!ref.nativeTurnKey||keys.has(ref.nativeTurnKey))throw new Error('Native fork contains inconsistent session identities or duplicate turn keys');keys.add(ref.nativeTurnKey);}
  }
  return sourceTurns.map((source,index)=>{
    const derived=derivedTurns[index];
    if(source.nativeTurnRef.nativeSessionId===derived.nativeTurnRef.nativeSessionId||source.nativeTurnRef.nativeTurnKey===derived.nativeTurnRef.nativeTurnKey)throw new Error('Native fork did not isolate history identities');
    if(JSON.stringify(source.input)!==JSON.stringify(derived.input))throw new Error('Native fork input history differs');
    return {source,derived};
  });
}
