import {shellQuote} from './bridge-config.mjs';
import {remoteAdminRequest} from './session-admin.mjs';

export async function remoteClaudeRequest(config,action,options={}){
  const mutating=action==='update';
  const command='python3 -B '+shellQuote(config.remoteRoot+'/claude_admin.py')+' '+shellQuote(config.remoteClaudeExecutable);
  try{
    return await remoteAdminRequest(config,command,{action},{timeoutMs:mutating?360000:45000,...options,mutating});
  }catch(error){
    const unknown=error.code==='RESULT_UNKNOWN';
    const code=unknown?'RESULT_UNKNOWN':'SSH_UNAVAILABLE';
    const message=unknown?'更新已提交，结果未确认。请重新检查 Claude Code 版本。':'无法连接 VPS 的 Claude Code 管理入口。';
    return {apiVersion:1,ok:false,error:{code,message,details:{}}};
  }
}

export function createClaudeInstallation(getConfig,remote=remoteClaudeRequest){
  return async function installation(action){
    if(!['check','update'].includes(action))throw Error('无效的 Claude Code 安装操作。');
    const reply=await remote(getConfig(),action);
    if(!reply.ok)throw Object.assign(Error(reply.error.message),{code:reply.error.code});
    const {installed,latest,updateAvailable,method,output}=reply.result;
    return {currentVersion:installed,latestVersion:latest??'Unknown',updateAvailable,
      canUpdate:method!=='unknown',...(latest===null?{latestVersionKind:'unknown'}:{}),
      ...(output?{message:output}:{})};
  };
}
