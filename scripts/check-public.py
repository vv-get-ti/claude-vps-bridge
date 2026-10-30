"""Check candidate files or actual staged blobs without printing secret contents."""
from pathlib import Path,PurePosixPath
import argparse,re,subprocess,sys

ROOT=Path(__file__).resolve().parents[1]
FORBIDDEN_DIRS={'node_modules','transactions','runtime-context','state','run','__pycache__','.claude','.codex','.ssh'}
FORBIDDEN_SUFFIXES={'.pem','.key','.pfx','.sqlite','.db','.log','.png','.jpg','.jpeg','.mp4','.zip','.exe'}
PRIVATE_NAMES={'bridge-config.json','bridge-config.local.json','remote-config.json','adapter-selection.json','claude-path','node-path','.env','session.json'}
PATTERNS=[
 ('private-key',re.compile(r'-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----')),
 ('anthropic-token',re.compile(r'sk-ant-(?:api\d+|oat\d+)-[A-Za-z0-9_-]{20,}')),
 ('github-token',re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})')),
 ('bearer-secret',re.compile(r'\bBearer\s+[A-Za-z0-9._~+/-]{24,}')),
 ('literal-secret',re.compile(r'''(?i)["']?(?:api_key|access_token|refresh_token|client_secret)["']?\s*[:=]\s*["'][A-Za-z0-9_./+=-]{24,}["']''')),
 ('personal-windows-path',re.compile(r'(?i)[A-Z]:[\\/]+Users[\\/]+(?!YOUR_USER\b|example\b|developer\b|Public\b)[^\\/\s"\']+')),
]

def inspect_file(name,data):
    p=PurePosixPath(name);parts={x.lower() for x in p.parts};base=p.name.lower();issues=[]
    if parts&FORBIDDEN_DIRS or base in PRIVATE_NAMES or base.startswith(('mcp-config.private','installation-','verification-','diagnosis-','backup-')) or p.suffix.lower() in FORBIDDEN_SUFFIXES:
        issues.append('private-or-generated-path')
    if len(data)>2*1024*1024:issues.append('unexpected-large-source-file')
    try:text=data.decode('utf-8-sig')
    except UnicodeDecodeError:return issues+['non-text-file-needs-review']
    for label,pattern in PATTERNS:
        for match in pattern.finditer(text):issues.append(label+':line-'+str(text.count('\n',0,match.start())+1))
    return issues

def git(*args):return subprocess.check_output(['git','-C',str(ROOT),*args])

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--staged',action='store_true');args=parser.parse_args()
    raw=git('ls-files','-z') if args.staged else git('ls-files','--cached','--others','--exclude-standard','-z')
    names=sorted({x.decode('utf8') for x in raw.split(b'\0') if x});failed=[]
    for name in names:
        if args.staged:data=git('show',':'+name)
        else:
            file=ROOT/name
            if not file.is_file():continue
            if file.is_symlink():failed.append((name,['symlink-needs-review']));continue
            data=file.read_bytes()
        issues=inspect_file(name,data)
        if issues:failed.append((name,issues))
    for name,issues in failed:print(name+': '+', '.join(issues))
    print(('FAIL' if failed else 'PASS')+' Public source checks: '+str(len(names))+' files'+(' (staged blobs)' if args.staged else ' (working tree candidates)'))
    return 1 if failed else 0
if __name__=='__main__':sys.exit(main())
