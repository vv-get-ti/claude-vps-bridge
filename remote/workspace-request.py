"""One parser shared by native approval and execution; no shell evaluation."""
import argparse, json
from pathlib import Path

def request_schema():
    local=Path(__file__).with_name('workspace-request-schema.json')
    if not local.exists():local=Path(__file__).parents[1]/'plugin/runtime/workspace-request-schema.json'
    return json.loads(local.read_text(encoding='utf-8'))

def validate(request, internal=False, permission=False):
    # preflight carries a permission operation: any public action, or an operation
    # that exists only for permission checks (mcp-call from the PreToolUse hook).
    def bad(message):
        error=ValueError('INVALID_ARGUMENT: '+message)
        error.code='INVALID_ARGUMENT'
        raise error
    if not isinstance(request,dict):bad('Expected an operation object')
    schema=request_schema()
    actions=schema['controls'] if internal else {**schema['actions'],**schema['permissionOperations']} if permission else schema['actions']
    definition=actions.get(request.get('action'))
    if definition is None:bad('Unknown action. Allowed actions: '+', '.join(actions))
    fields={**schema['common'],**definition['fields']};allowed=', '.join(fields)
    unknown=set(request)-set(fields)
    if unknown:bad('Unknown fields: '+', '.join(sorted(unknown))+'. Allowed fields: '+allowed+('. Did you mean argv (你是不是想写 argv)?' if request['action']=='agent' else ''))
    types={'string':lambda v:isinstance(v,str),'integer':lambda v:type(v) is int and abs(v)<=9007199254740991,'boolean':lambda v:type(v) is bool,'object':lambda v:isinstance(v,dict)}
    for key,value in request.items():
        rule=fields[key];rule={'type':rule} if isinstance(rule,str) else rule
        name=rule['type'];array=name.endswith('[]');check=types[name[:-2] if array else name]
        if (not isinstance(value,list) or not all(check(item) for item in value)) if array else not check(value):bad(key+' must be '+name+'. Allowed fields: '+allowed)
        if 'enum' in rule and value not in rule['enum']:bad(key+' must be one of '+', '.join(rule['enum']))
        for field,required in rule.get('requires',{}).items():
            if request.get(field)!=required:bad(key+' requires '+field+'='+str(required))
        if 'minItems' in rule and len(value)<rule['minItems'] or 'maxItems' in rule and len(value)>rule['maxItems']:bad(key+' has an invalid item count. Use explicit --help for agent help')
    for key in definition.get('required',[]):
        if key not in request:bad('Missing required field '+key+'. Allowed fields: '+allowed)
    if 'anyRequired' in definition and not any(all(key in request for key in group) for group in definition['anyRequired']):bad('Required fields: '+' or '.join(' + '.join(group) for group in definition['anyRequired'])+'. Allowed fields: '+allowed)
    if request['action']=='batch':
        for item in request['requests']:
            validate(item)
            if item['action'] not in ('info','read','list','search') or any(key!='action' and key in item for key in schema['common']):bad('Batch accepts only bound read/list/search/info requests')
    if internal and request['action']=='preflight':validate(request['request'],permission=True)
    return request

def parse(argv):
    if argv in (['--help'],['-h']):return {'action':'info'}
    if len(argv)==1 and argv[0].lstrip().startswith('{'):
        request=json.loads(argv[0])
        if not isinstance(request,dict):raise ValueError('Expected an operation object')
        return validate(request)
    parser=argparse.ArgumentParser(prog='windows-workspace',exit_on_error=False)
    parser.add_argument('action',choices=['info','status','list','read','search','context','capability','jobs','job','artifact','media'])
    parser.add_argument('path',nargs='?');parser.add_argument('--pattern');parser.add_argument('--id')
    parser.add_argument('--offset',type=int);parser.add_argument('--limit',type=int)
    parser.add_argument('--request-id',dest='requestId');parser.add_argument('--wait-ms',dest='waitMs',type=int)
    parser.add_argument('--operation',choices=['status','cancel','output'])
    parser.add_argument('--stream',choices=['stdout','stderr']);parser.add_argument('--segment',type=int,choices=[0,1])
    parser.add_argument('--segment-id',dest='segmentId')
    parser.add_argument('--search-id',dest='searchId');parser.add_argument('--encoding',choices=['utf-8','base64'])
    args=vars(parser.parse_args(argv));return validate({k:v for k,v in args.items() if v is not None})
