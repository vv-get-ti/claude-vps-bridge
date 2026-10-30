import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inside} from './project-environment.mjs';
import {boundedRead} from './bounded-file.mjs';
import {nativeAttachmentPath} from './host-input.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const images=new Set(['.png','.jpg','.jpeg','.webp','.gif']);
const transferLimit=5*1024*1024;
function desktopImagePaths(text){
  // Desktop includes attachment paths in text even when the Harness interface
  // accepts text only. Do not interpret examples inside the user's request.
  if(!/^\s*# Files mentioned by the user:[ \t]*\r?\n/.test(text))return [];
  const boundary=text.search(/^## My request:[ \t]*\r?$/m);if(boundary<0)return [];
  let fence;
  const context=text.slice(0,boundary).split('\n').map(line=>{
    const marker=line.match(/^\s*(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=undefined;return '';}
    return fence?'':line;
  }).join('\n');
  const paths=[];
  for(const section of context.matchAll(/^# Files mentioned by the user:[ \t]*\r?$/gm)){
    const files=context.slice(section.index+section[0].length).split(/^# /m,1)[0];
    for(const match of files.matchAll(/^## [^\r\n]+: ([^\r\n]+)\r?\nImage attachment: true(?=\r?\n|$)/gm)){
      const file=match[1];
      if(path.win32.isAbsolute(file)&&!/["\u0000-\u001f\u007f]/.test(file)&&images.has(path.win32.extname(file).toLowerCase()))paths.push(path.win32.normalize(file));
    }
  }
  return paths;
}
export function referencedMedia(input){
  const result=new Set();
  const textItems=(input??[]).filter(item=>item?.type==='text'&&typeof item.text==='string');
  for(const file of desktopImagePaths(textItems.map(item=>item.text).join('\n')))result.add(file);
  for(const item of textItems){const file=nativeAttachmentPath(item);if(file)result.add(file);}
  return [...result];
}
export async function exportMedia({cwd},ctx,request){
  const file=await fs.realpath(path.resolve(cwd,request.path));
  const granted=(ctx.attachments??[]).some(p=>p.toLowerCase()===file.toLowerCase());
  if(!inside(cwd,file)&&!granted)throw new Error('Media outside the project must be explicitly attached to this chat');
  const stat=await fs.stat(file),ext=path.extname(file).toLowerCase();if(!stat.isFile())throw new Error('Attachment is not a file');
  async function packet(name){const b=await boundedRead(name,transferLimit);return {sha256:sha(b),extension:path.extname(name).toLowerCase(),base64:b.toString('base64'),bytes:b.length};}
  if(images.has(ext)||ext==='.pdf'){
    const kind=ext==='.pdf'?'pdf':'image';
    const local=bytes=>({source:file,kind:'local-'+kind,bytes,files:[],note:'The '+kind+' remains on Windows because it exceeds the 5 MiB transfer limit. Choose local tools via action run if needed, then read their text results or transfer eligible output images/PDFs. No conversion or media processing was performed.'});
    if(stat.size>transferLimit)return local(stat.size);
    try{return {source:file,kind,files:[await packet(file)]};}
    catch(error){if(error.code!=='FILE_TOO_LARGE')throw error;return local((await fs.stat(file)).size);}
  }
  if(!['.mp4','.mov','.mkv','.webm'].includes(ext))throw new Error('Unsupported media input; use local tools to convert it first');
  if(request.timestamps!==undefined)throw Object.assign(new Error('Video processing is no longer part of media transport. Choose and run local tools with action run, then transfer their output images/PDFs with action media.'),{code:'MEDIA_PROCESSING_REMOVED'});
  return {source:file,kind:'local-video',bytes:stat.size,files:[],note:'The video remains on Windows. Choose local tools via action run to process it, then transfer output images/PDFs with action media or read text results. No media processing was performed.'};
}
