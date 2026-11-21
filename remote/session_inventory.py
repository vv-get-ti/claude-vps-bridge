"""Discover native transcripts and bridge data with verifiable session ownership."""
from datetime import datetime, timezone
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import stat
import unicodedata

from bridge_paths import CONFIG, WORKSPACE_ROOT
from session_files import SessionError, children, entry, file_reader, kind, read_json, tree
from session_lease import ARCHIVE, CLIENTS, SAFE_ID, UUID, available, session_path

CLAUDE = Path(os.path.abspath(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude'))
PROJECTS = CLAUDE / 'projects'
PROJECT_ID = re.compile(r'[0-9a-f]{64}\Z')
CACHE_UNITS = {'.bridge-cache', '.bridge-media', '.bridge-notices'}


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def transcripts(session_id=None):
    paths, uncertain = [], False
    for name in children(PROJECTS):
        project = PROJECTS / name
        try:
            info = entry(project)
            if info is None:
                continue
            if stat.S_ISLNK(info.st_mode):
                uncertain = True
                continue
            if not stat.S_ISDIR(info.st_mode):
                continue
            for file in children(project) if session_id is None else [session_id + '.jsonl']:
                if file.endswith('.jsonl') and UUID.fullmatch(file[:-6]) and entry(project / file) is not None:
                    paths.append(project / file)
        except OSError:
            uncertain = True
    return paths, uncertain


def user_text(message):
    if not isinstance(message, dict) or message.get('role') != 'user':
        return None
    content = message.get('content')
    if isinstance(content, list):
        if any(isinstance(block, dict) and block.get('type') == 'tool_result' for block in content):
            return None
        content = ' '.join(block['text'] for block in content if isinstance(block, dict)
                           and block.get('type') == 'text' and isinstance(block.get('text'), str))
    if not isinstance(content, str):
        return None
    text = ''.join(char for char in content if unicodedata.category(char) != 'Cc').strip()
    if not text or text.startswith(('<local-command-', '<command-')):
        return None
    return text[:200]


def transcript_info(file, session_id):
    cwd, title, created, conversation = None, None, None, False
    with file_reader(file) as stream:
        info = os.fstat(stream.fileno())
        for raw in stream:
            try:
                row = json.loads(raw)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(row, dict) or row.get('isSidechain') is True:
                continue
            if isinstance(row.get('sessionId'), str) and row['sessionId'] != session_id:
                raise SessionError('OWNERSHIP_UNCERTAIN')
            if row.get('type') not in {'user', 'assistant'} or not isinstance(row.get('message'), dict):
                continue
            conversation = True
            value = row.get('cwd')
            if cwd is None and isinstance(value, str) and os.path.isabs(value) and '\0' not in value:
                cwd = os.path.normpath(value)
            if created is None and isinstance(row.get('timestamp'), str):
                try:
                    timestamp = datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00'))
                    if timestamp.tzinfo is not None:
                        created = iso(timestamp.timestamp())
                except (ValueError, OverflowError, OSError):
                    pass
            if title is None and row.get('type') == 'user' and not row.get('isMeta') and not row.get('isCompactSummary'):
                title = user_text(row['message'])
    return {'cwd': cwd, 'title': title, 'createdAt': created or iso(info.st_mtime),
            'lastActiveAt': iso(info.st_mtime), 'conversation': conversation}


def project_for(cwd):
    result = {'remoteCwd': cwd or '', 'mapped': False}
    if cwd is None or Path(cwd).parent != WORKSPACE_ROOT:
        return result
    try:
        record = read_json(Path(cwd) / '.windows-project.json')
        local, machine = record['localCwd'], record['machineId']
        key = ntpath.normpath(local).rstrip('\\/').lower()
        project_id = hashlib.sha256((machine + '\n' + key).encode('utf8')).hexdigest()
        if (record['version'] == 2 and record['filesLiveOn'] == 'windows' and machine
                and re.match(r'^[a-zA-Z]:[\\/]', local) and not re.search(r'[\r\n\0]', local)
                and record['key'] == key and record['projectId'] == project_id):
            return {**result, 'mapped': True, 'localCwd': local, 'projectId': project_id}
    except (FileNotFoundError, KeyError, ValueError, TypeError, AttributeError, OSError, SessionError):
        pass
    return result


def optional_json(path):
    try:
        value = read_json(path)
        if not isinstance(value, dict):
            raise SessionError('OWNERSHIP_UNCERTAIN')
        return value
    except FileNotFoundError:
        return None
    except (ValueError, UnicodeError, TypeError):
        raise SessionError('OWNERSHIP_UNCERTAIN') from None


def claim_path(session_id):
    return WORKSPACE_ROOT / '.bridge-sessions' / (session_id + '.json')


def origins(session_id, encoded_project, cwd, media_key):
    main = PROJECTS / encoded_project / (session_id + '.jsonl')
    units = {
        'transcript': main, 'attachments': main.with_suffix(''),
        'pending': CLAUDE / 'codexhost' / 'pending-sessions' / session_id,
        'claim': claim_path(session_id),
        'prompt': WORKSPACE_ROOT / '.bridge-cache' / (session_id + '.json'),
        'notice': WORKSPACE_ROOT / '.bridge-notices' / (session_id + '.json'),
    }
    if cwd and Path(cwd).parent == WORKSPACE_ROOT and '..' not in Path(cwd).parts:
        units['presentation'] = Path(cwd) / '.bridge-presentation' / session_id
    if media_key:
        units['media'] = WORKSPACE_ROOT / '.bridge-media' / media_key
    return units


def owned(file, session_id):
    meta = transcript_info(file, session_id)
    claim = optional_json(claim_path(session_id))
    cwd = meta['cwd'] or (claim or {}).get('remoteCwd')
    project = project_for(cwd)
    key = (claim or {}).get('mediaKey')
    if claim and (not isinstance(key, str) or not SAFE_ID.fullmatch(key) or not project['mapped']
                  or claim.get('projectId') != project['projectId'] or claim.get('remoteCwd') != cwd):
        raise SessionError('OWNERSHIP_UNCERTAIN')
    units = origins(session_id, file.parent.name, cwd, key)
    pending = units['pending']
    if entry(pending) is not None:
        descriptor = optional_json(pending / 'session.json')
        if not descriptor or descriptor.get('sessionId') != session_id or descriptor.get('cwd') != cwd:
            raise SessionError('OWNERSHIP_UNCERTAIN')
    snapshots = {name: rows for name, path in units.items() if (rows := tree(path))}
    if 'transcript' not in snapshots:
        raise SessionError('REVISION_CHANGED')
    directory_units = {'attachments', 'pending', 'presentation', 'media'}
    if any(rows['.']['kind'] != ('directory' if name in directory_units else 'file') for name, rows in snapshots.items()):
        raise SessionError('OWNERSHIP_UNCERTAIN')
    return meta, project, claim or {}, units, snapshots


def revision(rooted, snapshots):
    values = [(str(rooted[name]), relative, row['identity']) for name, rows in snapshots.items() for relative, row in rows.items()]
    return hashlib.sha256(json.dumps(sorted(values), ensure_ascii=True).encode('utf8')).hexdigest()


def sizes(snapshots):
    sizes = [row['identity'][2] for rows in snapshots.values() for row in rows.values() if row['kind'] == 'file']
    return sum(sizes), len(sizes)


def media_is_exclusive(session_id, media_key):
    if not media_key:
        return True
    media = WORKSPACE_ROOT / '.bridge-media'
    prefix = str(media / media_key) + '/'
    claims = [WORKSPACE_ROOT / '.bridge-sessions' / file for file in children(WORKSPACE_ROOT / '.bridge-sessions')
              if file.endswith('.json') and file != session_id + '.json']
    inheritance = [media / key / '.inherited.json' for key in children(media) if key != media_key]
    for other in children(ARCHIVE):
        if other == session_id or not UUID.fullmatch(other):
            continue
        claims.append(ARCHIVE / other / 'claim')
        inheritance.append(ARCHIVE / other / 'media' / '.inherited.json')
    for file in claims:
        if (optional_json(file) or {}).get('mediaKey') == media_key:
            return False
    for file in inheritance:
        for item in (optional_json(file) or {}).get('files', []):
            if not isinstance(item, dict) or not isinstance(item.get('path'), str) or item['path'].startswith(prefix):
                return False
    return True


def process_activity():
    """Return exact native references, held file paths and unclassified writers."""
    running, held, unknown = set(), set(), False
    claude = {b'claude', b'claude-windows', os.fsencode(Path(CONFIG.get('claudeExecutable', 'claude')).name)}
    try:
        processes = list(Path('/proc').iterdir())
    except OSError:
        return running, held, True
    for proc in processes:
        if not proc.name.isdecimal() or int(proc.name) == os.getpid():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            args = (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            if not args[0]:
                continue  # kernel thread or exited process
            comm = (proc / 'comm').read_bytes().strip()
            executable_args = args[:3]
            if any(arg.endswith(b'/remote-server.mjs') or arg == b'remote-server.mjs' for arg in executable_args):
                if available(CLIENTS / proc.name):
                    unknown = True  # still running a pre-lease worker
            if comm in claude or any(os.path.basename(arg) in claude or arg.endswith(b'/claude-code/cli.js') for arg in executable_args):
                ids = set()
                for index, arg in enumerate(args):
                    option, separator, value = arg.partition(b'=')
                    if option in {b'--resume', b'--session-id', b'-r'}:
                        value = value if separator else (args[index + 1] if index + 1 < len(args) else b'')
                        text = value.decode('ascii', errors='replace')
                        if UUID.fullmatch(text):
                            ids.add(text)
                running.update(ids)
                streaming = b'--input-format=stream-json' in args or (b'--input-format' in args and b'stream-json' in args)
                if len(ids) != 1 or not streaming or b'--continue' in args or b'-c' in args:
                    unknown = True  # an interactive invocation can select another history
            for fd in (proc / 'fd').iterdir():
                try:
                    name = os.readlink(fd)
                    if name.endswith(' (deleted)'):
                        name = name[:-10]
                except FileNotFoundError:
                    continue
                if name.startswith('/'):
                    held.add(name)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except (OSError, SessionError):
            unknown = True
    return running, held, unknown


def activity(session_id, paths, observed, *, check_lock=True):
    running, held, unknown = observed
    try:
        if check_lock and not available(session_path(session_id)):
            return 'running'
    except (OSError, SessionError):
        unknown = True
    if session_id in running or any(str(path) in held or any(name.startswith(str(path) + '/') for name in held) for path in paths):
        return 'running'
    return 'unknown' if unknown else 'idle'
