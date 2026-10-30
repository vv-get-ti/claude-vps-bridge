// Only consume public input items delivered to the adapter.
export const attachmentNotice='支持 Desktop 附件清单中带本机路径的图片。附件没有提供可读路径时，可让 Claude 使用 windows-workspace media 读取已保存的项目文件。';
export async function decodeHostInput(input,load=()=>import('./host-input.mjs')){
  if(!Array.isArray(input))throw new Error('Expected a turn input array');
  if(input.some(i=>i?.type==='text'&&i.text?.startsWith('CODEXHOST_CLAUDE_VPS_INPUT_V2\n')))throw new Error('检测到旧宿主附件补丁封装。请重装或升级 CodexHost 清除旧补丁，再使用 windows-workspace media 指定项目内文件。');
  // Keep existing item identity: structured attachments carry local provenance.
  if(input.every(item=>item?.type==='text'&&typeof item.text==='string'))return input;
  try{
    const normalized=await (await load()).normalizeNativeBridgeInput(input);
    if(!Array.isArray(normalized)||normalized.length!==input.length||normalized.some(item=>item?.type!=='text'||typeof item.text!=='string'))throw new Error('Attachment normalization did not preserve every input item');
    return normalized;
  }catch(e){throw new Error('附件处理失败，未提交本轮。请用 windows-workspace media 指定项目内文件。 '+e.message);}
}
