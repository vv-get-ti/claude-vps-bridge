// Normalize structured items only when the public adapter receives them.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
// Receiving an inline attachment locally is separate from the 5 MiB remote
// transfer limit. 32 MiB decoded fits within the bridge's 48 MiB wire frame.
const inlineReceiveLimit=32*1024*1024;
const inlineTooLarge=()=>new Error('Inline image exceeds the 32 MiB local receive limit; attach a saved local file instead');
// Attachment authority belongs to the input object created here, never its text.
// This map stays local; the caller extracts paths before serializing the command.
const attachments=new WeakMap();
export const nativeAttachmentPath=item=>attachments.get(item);
export function normalizeNativeBridgeInput(input){
  if(!Array.isArray(input))throw new Error('Expected a desktop input array');
  return input.map(item=>{
    if(item?.type==='text')return item;
    let file;
    if(['localImage','file','attachment'].includes(item?.type))file=item.path??item.filePath;
    else if(item?.type==='image'){
      const url=item.imageUrl??item.url??item.image_url;
      if(typeof url==='string'&&url.length>48*1024*1024)throw inlineTooLarge();
      const match=typeof url==='string'&&url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/);
      if(!match)throw new Error('This bridge accepts local files or inline image data. Attach the local image or provide its Windows path.');
      const encoded=match[2].replace(/[\r\n]/g,''),padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
      if(Math.floor(encoded.length*3/4)-padding>inlineReceiveLimit)throw inlineTooLarge();
      const bytes=Buffer.from(encoded,'base64');if(bytes.length>inlineReceiveLimit)throw inlineTooLarge();
      const dir=path.join(here,'state','input-attachments');fs.mkdirSync(dir,{recursive:true});
      const ext=match[1].split('/')[1];file=path.join(dir,createHash('sha256').update(bytes).digest('hex')+'.'+ext);if(!fs.existsSync(file))fs.writeFileSync(file,bytes,{flag:'wx'});
    }else throw new Error('Unsupported desktop attachment type: '+String(item?.type)+'. It was not silently discarded.');
    if(typeof file!=='string'||!path.win32.isAbsolute(file)||/["\u0000-\u001f\u007f]/.test(file))throw new Error('Attachment must have an absolute Windows path');
    if(!/\.(png|jpe?g|webp|gif|pdf|mp4|mov|mkv|webm)$/i.test(file))throw new Error('Unsupported attachment type; provide project text through its file path');
    file=path.win32.normalize(file);
    const normalized={type:'text',text:'Explicitly attached local file:\n<image path="'+file+'">'};
    attachments.set(normalized,file);return normalized;
  });
}
