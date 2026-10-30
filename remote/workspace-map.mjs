import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export async function prepareWorkspace(info, root = path.join(os.homedir(),'windows-local-work')) {
  if (!info || typeof info.cwd!=='string' || !/^[a-z]:[\\/]/i.test(info.cwd) || /[\0\r\n]/.test(info.cwd) || !/^[a-f0-9]{64}$/.test(info.projectId) || typeof info.machineId!=='string' || !info.machineId || /[\0\r\n]/.test(info.machineId)) throw new Error('A verified Windows project identity is required');
  const localCwd = path.win32.normalize(info.cwd).replace(/[\\/]+$/, '');
  const key = localCwd.toLowerCase();
  if(createHash('sha256').update(info.machineId+'\n'+key).digest('hex')!==info.projectId)throw new Error('Windows project identity does not match its machine and canonical path');
  const name = path.win32.basename(localCwd).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!name || name === '.' || name === '..') throw new Error('Invalid project name');
  await fs.mkdir(root, {recursive:true, mode:0o700});
  // Retain legacy paths when identity matches; suffixes never imply a second copy.
  const legacySuffix = createHash('sha256').update(key).digest('hex').slice(0,10);
  for (const candidate of [...new Set([name, name+'-'+legacySuffix, name+'-'+info.projectId.slice(0,12)])]) {
    const directory = path.join(root,candidate);
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Coordination directory must not be a symlink');
    const file = path.join(directory,'.windows-project.json');
    const value = {version:2,localCwd,key,projectId:info.projectId,machineId:info.machineId,machine:info.machine,filesLiveOn:'windows',verifiedAt:new Date().toISOString()};
    // Publish a complete mapping atomically. Concurrent first opens must not read
    // the empty/partial file left between an exclusive open and its first write.
    if(!await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;})){
      const initial=file+'.'+randomUUID()+'.tmp';
      try{await fs.writeFile(initial,JSON.stringify(value,null,2),{mode:0o600});await fs.link(initial,file);}
      catch(e){if(e.code!=='EEXIST')throw e;}
      finally{await fs.unlink(initial).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    }
    if(!(await fs.lstat(file)).isFile())throw new Error('Coordination mapping must be a regular file');
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(saved.key!==key || (saved.projectId ? saved.projectId!==info.projectId : saved.machineId!==info.machineId) || (saved.machineId&&saved.machineId!==info.machineId))continue;
    // A mapping is an identity record, not a heartbeat. Avoid rewrites on every
    // resume and concurrent opens; verifiedAt records creation or migration.
    if(saved.version===2&&saved.projectId===info.projectId&&saved.machineId===info.machineId&&saved.localCwd===localCwd)return {directory,mapping:saved};
    const temporary=file+'.'+randomUUID()+'.tmp';
    await fs.writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temporary,file);
    return {directory,mapping:value};
  }
  throw new Error('Workspace identity collision; no project was substituted');
}
