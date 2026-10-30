import {open} from 'node:fs/promises';
// Cap allocation before reading. stat rejects already-large files; reading at
// most maxBytes+1 also catches growth after stat without loading the whole file.
export async function boundedRead(file,maxBytes,{openFile=open}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new Error('Invalid file byte limit');
  const handle=await openFile(file,'r');
  const tooLarge=()=>Object.assign(new Error('File exceeds the '+maxBytes+' byte limit'),{code:'FILE_TOO_LARGE'});
  try{
    const stat=await handle.stat();if(!stat.isFile())throw Object.assign(new Error('Expected a regular file'),{code:'INVALID_FILE'});if(stat.size>maxBytes)throw tooLarge();
    const chunks=[];let total=0;
    for(;;){
      const buffer=Buffer.allocUnsafe(Math.min(65536,maxBytes-total+1));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;
      total+=bytesRead;if(total>maxBytes)throw tooLarge();chunks.push(buffer.subarray(0,bytesRead));
    }
    return Buffer.concat(chunks,total);
  }finally{await handle.close();}
}
