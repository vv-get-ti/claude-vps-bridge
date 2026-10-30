"""Materialize only explicitly selected images/PDFs/video frames for native Claude Read."""
import base64, hashlib, json, os
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from bridge_paths import WORKSPACE_ROOT

def materialize(payload):
    session=os.environ.get('WINDOWS_MEDIA_SESSION') or os.environ.get('WINDOWS_BRIDGE_SESSION','')
    if not session or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in session):
        raise ValueError('Missing bridge session for attachment')
    root=(WORKSPACE_ROOT/'.bridge-media')/session
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    files=[]
    for item in payload['files']:
        raw=base64.b64decode(item['base64'],validate=True)
        if len(raw)>5*1024*1024 or hashlib.sha256(raw).hexdigest()!=item['sha256']:
            raise ValueError('Attachment size/hash mismatch')
        ext=item['extension']
        if ext not in ('.png','.jpg','.jpeg','.webp','.gif','.pdf'):
            raise ValueError('Unsupported attachment type')
        target=root/(item['sha256']+ext)
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']:
                raise ValueError('Existing attachment hash mismatch')
        else:
            target.write_bytes(raw);target.chmod(0o600)
        files.append({'path':str(target),'sha256':item['sha256'],'bytes':len(raw),**({'timestamp':item['timestamp']} if 'timestamp' in item else {})})
    return {'source':payload['source'],'kind':payload['kind'],'files':files,**({'bytes':payload['bytes']} if 'bytes' in payload else {}),'note':payload.get('note','Read these cached attachments using native Read. Original files remain on Windows.')}
