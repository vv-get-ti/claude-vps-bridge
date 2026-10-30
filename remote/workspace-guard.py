#!/usr/bin/env python3
"""Native Claude PreToolUse hook: route project operations to Windows, not VPS."""
import json, re, shlex, sys, subprocess, os, hashlib, importlib.util
from pathlib import Path
from bridge_paths import ROOT, WORKSPACE_ROOT, WORKSPACE_COMMAND
WORKSPACE_NAMES=('windows-workspace','/usr/local/bin/windows-workspace',WORKSPACE_COMMAND)
AGENT_NAMES=('windows-agent','/usr/local/bin/windows-agent',str(ROOT/'windows-agent'))
WORKSPACE_PATTERN='(?:'+'|'.join(re.escape(x) for x in WORKSPACE_NAMES)+')'

def structured(command):
    match=re.fullmatch(r"\s*"+WORKSPACE_PATTERN+r"\s+'(\{.*\})'\s*",command or '',re.S)
    if match:
        value=json.loads(match.group(1))
        if not isinstance(value,dict):raise ValueError('Expected an operation object')
        return value
    normalized=re.sub(r'^\s*"\$CODEXHOST_CLI_PATH"','windows-agent',command or '')
    argv=shlex.split(normalized)
    if argv and argv[0] in WORKSPACE_NAMES:
        spec=importlib.util.spec_from_file_location('workspace_request',str(ROOT/'workspace-request.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.parse(argv[1:])
    if argv and argv[0] in AGENT_NAMES:
        if argv[1:] and argv[1] in ('start','read','wait','cancel','list','resolve','native-read'):
            raise ValueError('Use action agent with official harness/delegate/thread argv, or explicit nativeAction; legacy shortcut syntax is not permission-mappable')
        return {'action':'agent','argv':argv[1:]}
    raise ValueError('Unsupported command')

def preflight(operation,mode):
    result=subprocess.run([WORKSPACE_COMMAND,'--internal',json.dumps({'action':'preflight','request':operation,'permissionMode':mode})],capture_output=True,text=True,timeout=150)
    if result.returncode:raise ValueError(result.stderr[-2000:])
    return json.loads(result.stdout)

def permitted(command):
    if not isinstance(command, str):
        return False
    # Parse the whole JSON envelope as data, then canonicalize it in updatedInput
    # before Bash sees it. Apostrophes inside PowerShell never become Bash syntax.
    match = re.fullmatch(r"\s*"+WORKSPACE_PATTERN+r"\s+'(\{.*\})'\s*", command, re.S)
    if match:
        try:
            return isinstance(json.loads(match.group(1)), dict)
        except (ValueError, TypeError):
            return False
    # The existing official CLI bridge remains usable with literal argv only.
    normalized = re.sub(r'^\s*"\$CODEXHOST_CLI_PATH"', 'windows-agent', command)
    if re.search(r'[$`\n\r;&|<>()]', normalized):
        return False
    try:
        argv = shlex.split(normalized)
        return bool(argv and argv[0] in AGENT_NAMES+WORKSPACE_NAMES)
    except ValueError:
        return False

if __name__ == '__main__':
    try:
        request=json.load(sys.stdin)
        name=request.get('tool_name')
        if name=='Bash' and permitted(request.get('tool_input',{}).get('command')):
            operation=structured(request['tool_input']['command'])
            decision=preflight(operation,request.get('permission_mode'))
            output={'hookEventName':'PreToolUse'}
            if decision['decision'] in ('deny','ask','allow'):
                output.update(permissionDecision=decision['decision'],permissionDecisionReason=decision['reason'])
            if decision.get('additionalContext'):output['additionalContext']=decision['additionalContext']
            if re.match(r'^\s*'+WORKSPACE_PATTERN+r'\s',request['tool_input']['command']):
                canonical="windows-workspace '"+json.dumps(operation,ensure_ascii=False).replace("'",'\\u0027')+"'"
                output['updatedInput']={**request['tool_input'],'command':canonical}
            print(json.dumps({'hookSpecificOutput':output}))
        elif name=='Read':
            root=((WORKSPACE_ROOT/'.bridge-media')/(os.environ.get('WINDOWS_MEDIA_SESSION') or os.environ.get('WINDOWS_BRIDGE_SESSION','INVALID'))).resolve()
            target=Path(request.get('tool_input',{}).get('file_path','')).resolve()
            # Claude Code saves oversized tool output under this session's own
            # tool-results directory and expects Read to page it back.
            transcript=request.get('transcript_path')
            if isinstance(transcript,str) and transcript.endswith('.jsonl') and target.is_file() and target.is_relative_to((Path(transcript).with_suffix('')/'tool-results').resolve()):
                print('{}')
                sys.exit(0)
            inherited=False
            manifest=root/'.inherited.json'
            if not target.is_relative_to(root) and manifest.is_file():
                for item in json.loads(manifest.read_text()).get('files',[]):
                    if item.get('path')==str(target) and target.is_file():
                        inherited=hashlib.sha256(target.read_bytes()).hexdigest()==item.get('sha256')
                        break
            if (not target.is_relative_to(root) and not inherited) or not target.is_file() or target.suffix.lower() not in ('.png','.jpg','.jpeg','.webp','.gif','.pdf'):
                raise ValueError('Native Read is limited to this chat\'s staged media. Use windows-workspace read for project text.')
            print('{}')
        elif isinstance(name,str) and name.startswith(('mcp__tavily__','mcp__playwright__')):
            decision=preflight({'action':'mcp-call','tool':name,'arguments':request.get('tool_input',{})},request.get('permission_mode'))
            output={'hookEventName':'PreToolUse'}
            if decision['decision'] in ('deny','ask','allow'):
                output.update(permissionDecision=decision['decision'],permissionDecisionReason=decision['reason'])
            if decision.get('additionalContext'):output['additionalContext']=decision['additionalContext']
            print(json.dumps({'hookSpecificOutput':output}))
        elif name in ('AskUserQuestion', 'WebSearch', 'WebFetch'):
            print('{}')
        else:
            print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':'This session operates a Windows project. Use windows-workspace with one single-quoted JSON argument, or the literal windows-agent CLI. Native VPS filesystem/shell operations are not this workspace. Use action info for project details.'}}))
    except Exception as error:
        print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':str(error)}}))
