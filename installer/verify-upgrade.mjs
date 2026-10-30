// Read-only installed-version verification. Does not open a model turn or restart Desktop.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import path from 'node:path';
import {shellQuote,getBridgeConfig} from '../plugin/runtime/bridge-config.mjs';
const exec=promisify(execFile),report={checkedAt:new Date().toISOString(),checks:[],desktopActivation:'This check does not certify the running GUI; see the separate desktop-activation record. A new installation requires normal restart.'};
const sha=b=>createHash('sha256').update(b).digest('hex');
try{
  const installed=JSON.parse(await fs.readFile(new URL('../installation-workspace.json',import.meta.url),'utf8'));
  for(const entry of installed.files){
    if(entry.sha256===null)await assert.rejects(fs.stat(entry.path),{code:'ENOENT'},'Retired file remains: '+entry.path);
    else assert.equal(sha(await fs.readFile(entry.path)),entry.sha256,'Installed file changed: '+entry.path);
  }
  report.checks.push({name:'Installed local files match the installation manifest',status:'PASS'});
  const config=installed.connection??getBridgeConfig();
  const ssh=config.sshExecutable;
  const names=Object.keys(installed.remote.hashes);
  const code='import json,hashlib,pathlib,shutil\nprint(json.dumps({"hashes":{f:hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest() for f in '+JSON.stringify(names)+'},"pdfRenderer":shutil.which("pdftoppm")}))\n';
  const hashes=await new Promise((resolve,reject)=>{const child=spawn(ssh,['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12',config.sshHost,'python3 -'],{windowsHide:true});let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('Remote installation check timed out'));},30000);child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',c=>{clearTimeout(timer);if(c)reject(new Error(err));else{try{resolve(JSON.parse(out));}catch(e){reject(e);}}});child.stdin.end(code);});
  assert.deepEqual(hashes.hashes,installed.remote.hashes);report.checks.push({name:'VPS files match the same installation manifest',status:'PASS'});
  report.pdfRenderer=hashes.pdfRenderer;report.checks.push({name:'Optional native PDF page renderer',status:hashes.pdfRenderer?'PASS':'UNAVAILABLE'});
  report.health=await new Promise((resolve,reject)=>{const child=spawn(ssh,['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12',config.sshHost,shellQuote(config.remoteRoot+'/check-health')],{windowsHide:true});let out='',err='',settled=false;const timer=setTimeout(()=>{child.kill();reject(new Error('Protocol health timed out'));},30000);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.stdout.on('data',b=>{out+=b;if(!out.includes('\n')||settled)return;settled=true;clearTimeout(timer);try{const frame=JSON.parse(out.split('\n')[0]);if(frame.error)throw new Error(frame.error);resolve(frame.value);}catch(e){reject(e);}child.stdin.end();});child.on('close',()=>{clearTimeout(timer);if(!settled)reject(new Error('Protocol health failed: '+err));});child.stdin.write(JSON.stringify({id:'upgrade-health',method:'health',params:{}})+'\n');});
  assert.equal(report.health.protocol,2);for(const c of ['project-context','local-policy','local-hooks','media-cache','agent-context','job-recovery','native-fork','duplex-control','live-reverse-probe','duplex-tools','context-delta'])assert.ok(report.health.capabilities.includes(c),c);
  report.checks.push({name:'Remote official adapter loads and bridge protocol capabilities match',status:'PASS'});report.success=true;
}catch(error){report.success=false;report.error=error.stack;process.exitCode=1;}
await fs.writeFile(new URL('verification-upgrade.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
