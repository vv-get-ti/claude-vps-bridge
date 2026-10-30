"""Optional tools are configured explicitly, independently from bridge upgrades."""
from pathlib import Path
import argparse,json,subprocess,shlex,tomllib,inspect
from bridge_config import load_config,ssh_args,INSTALLED

def changes_for(args,config):
    changes={}
    if args.playwright!='keep':
        changes['playwright']=None if args.playwright=='disable' else {'type':'stdio','command':'python3','args':[config['remoteRoot']+'/mcp-local.py']}
    if args.disable_tavily:changes['tavily']=None
    if args.import_tavily_from_codex:
        source=tomllib.loads(args.import_tavily_from_codex.read_text(encoding='utf-8-sig'))
        entry=source.get('mcp_servers',{}).get('tavily',{})
        if entry.get('url')!='https://mcp.tavily.com/mcp/' or not entry.get('http_headers',{}).get('Authorization'):
            raise ValueError('The explicitly selected Codex config has no supported Tavily authorization')
        changes['tavily']={'type':'http','url':entry['url'],'headers':{'Authorization':entry['http_headers']['Authorization']}}
    return changes

def merge_tools(current,changes):
    result={**current,'mcpServers':dict(current.get('mcpServers',{}))}
    for name,value in changes.items():
        if value is None:result['mcpServers'].pop(name,None)
        else:result['mcpServers'][name]=value
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--playwright',choices=['keep','enable','disable'],default='keep')
    tavily=p.add_mutually_exclusive_group()
    tavily.add_argument('--import-tavily-from-codex',type=Path,metavar='CONFIG_TOML')
    tavily.add_argument('--disable-tavily',action='store_true')
    a=p.parse_args();config=load_config();changes=changes_for(a,config)
    if a.playwright=='enable' and not (INSTALLED/'runtime/node_modules/@playwright/mcp/cli.js').is_file():
        raise RuntimeError('Prepare the optional browser first: python prepare-local.py --with-playwright, then run install.ps1. No remote tools were changed.')
    code="""import sys,json,pathlib,os,datetime
p=pathlib.Path(REMOTE_ROOT)/'mcp-config.private.json'
changes=json.loads(sys.stdin.buffer.read())
current=json.loads(p.read_text()) if p.exists() else {'mcpServers':{}}
if not isinstance(current.get('mcpServers'),dict):raise ValueError('Invalid existing MCP configuration; unchanged')
MERGE_FUNCTION
result=merge_tools(current,changes)
changed=result!=current or not p.exists()
if changed:
 p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 if p.exists():
  backup=p.with_name(p.name+'.backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'));backup.write_bytes(p.read_bytes());backup.chmod(0o600)
 tmp=p.with_name(p.name+'.tmp');tmp.write_text(json.dumps(result));tmp.chmod(0o600);os.replace(tmp,p)
print(json.dumps({'changed':changed,'configured':sorted(result['mcpServers']),'mode':oct(p.stat().st_mode&0o777)}))
""".replace('REMOTE_ROOT',repr(config['remoteRoot'])).replace('MERGE_FUNCTION',inspect.getsource(merge_tools))
    r=subprocess.run(ssh_args(config,'python3 -c '+shlex.quote(code)),input=json.dumps(changes).encode(),capture_output=True,timeout=30)
    if r.returncode:raise RuntimeError('Optional MCP configuration failed; existing credentials were not printed. Check remote config JSON and directory permissions.')
    print(r.stdout.decode().strip())
if __name__=='__main__':main()
