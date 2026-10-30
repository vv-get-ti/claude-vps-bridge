from bridge_paths import WORKSPACE_COMMAND
"""Official SessionStart(compact) hook: reload current local rules after compaction."""
import json, subprocess, sys
try:
    request=json.load(sys.stdin)
    if request.get('source')!='compact':
        print('{}');sys.exit(0)
    result=subprocess.run([WORKSPACE_COMMAND,'--internal','{"action":"environment"}'],capture_output=True,text=True,timeout=110)
    if result.returncode:raise RuntimeError(result.stderr[-1500:])
    environment=json.loads(result.stdout)
    print(json.dumps({'hookSpecificOutput':{'hookEventName':'SessionStart','additionalContext':'Context was compacted. Reloaded current Windows project configuration; it replaces older configuration snapshots.\n'+environment['text']}}))
except Exception as error:
    print('Windows rules could not be restored after compaction: '+str(error),file=sys.stderr)
    sys.exit(2)
