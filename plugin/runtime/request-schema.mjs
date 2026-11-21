import schema from './workspace-request-schema.json' with {type:'json'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const types={string:value=>typeof value==='string',integer:Number.isSafeInteger,boolean:value=>typeof value==='boolean',object};
// preflight carries a permission operation: any public action, or an operation that
// exists only for permission checks (mcp-call from the native PreToolUse hook).
export function validateRequest(request,{internal=false,permission=false}={}){
  const bad=detail=>{throw Object.assign(new Error('Invalid '+(request?.action??'workspace')+' request. '+detail),{code:'INVALID_ARGUMENT'});};
  if(!object(request))bad('Expected an operation object');
  const actions=internal?schema.controls:permission?{...schema.actions,...schema.permissionOperations}:schema.actions;
  if(!Object.hasOwn(actions,request.action))bad('Unknown action. Allowed actions: '+Object.keys(actions).join(', '));
  const definition=actions[request.action];
  const fields={...schema.common,...definition.fields};
  const allowed=Object.keys(fields).join(', ');
  const unknown=Object.keys(request).filter(key=>!Object.hasOwn(fields,key));
  if(unknown.length)bad('Unknown fields: '+unknown.join(', ')+'. Allowed fields: '+allowed+(request.action==='agent'?'. Did you mean argv (你是不是想写 argv)?':''));
  for(const [key,value] of Object.entries(request)){
    // Optional undefined properties can be introduced by an internal JS caller.
    if(value===undefined)continue;
    const rule=typeof fields[key]==='string'?{type:fields[key]}:fields[key];
    const array=rule.type.endsWith('[]'),type=array?rule.type.slice(0,-2):rule.type;
    if(array?(!Array.isArray(value)||!value.every(types[type])):!types[type](value))bad(key+' must be '+rule.type+'. Allowed fields: '+allowed);
    if(rule.enum&&!rule.enum.includes(value))bad(key+' must be one of '+rule.enum.join(', '));
    for(const [field,required] of Object.entries(rule.requires??{}))if(request[field]!==required)bad(key+' requires '+field+'='+required);
    if(rule.minItems!==undefined&&value.length<rule.minItems||rule.maxItems!==undefined&&value.length>rule.maxItems)bad(key+' has an invalid item count. Use explicit --help for agent help');
  }
  for(const key of definition.required??[])if(request[key]===undefined)bad('Missing required field '+key+'. Allowed fields: '+allowed);
  if(definition.anyRequired&&!definition.anyRequired.some(group=>group.every(key=>request[key]!==undefined)))bad('Required fields: '+definition.anyRequired.map(group=>group.join(' + ')).join(' or ')+'. Allowed fields: '+allowed);
  if(request.action==='batch')for(const item of request.requests){
    validateRequest(item);
    if(!['info','read','list','search'].includes(item.action)||Object.keys(schema.common).some(key=>key!=='action'&&key in item))bad('Batch accepts only bound read/list/search/info requests');
  }
  if(internal&&request.action==='preflight')validateRequest(request.request,{permission:true});
  return request;
}
