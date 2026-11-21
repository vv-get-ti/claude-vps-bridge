"""Preview and revalidate only bridge-owned or transaction-owned leftovers."""
from collections import Counter
import hashlib
import re
import stat
import time

from bridge_paths import WORKSPACE_ROOT
from session_files import SessionError, children, entry, kind, remove_snapshot, tree
from session_inventory import (CLAUDE, PROJECTS, PROJECT_ID, activity, iso, optional_json,
                               process_activity, project_for, revision, sizes)
from session_lease import ARCHIVE, LEASES, SAFE_ID, UUID, available, lock

GRACE = 24 * 60 * 60
PENDING = CLAUDE / 'codexhost' / 'pending-sessions'
CLAIMS = WORKSPACE_ROOT / '.bridge-sessions'
MEDIA = WORKSPACE_ROOT / '.bridge-media'
TOKEN = r'[0-9a-f]{32}'
PLAN = re.compile(rf'\.plan-({TOKEN})\Z')
COMPLETED = re.compile(rf'\.completed-({TOKEN})\Z')
MOVE = re.compile(rf'\.bridge-move-({TOKEN})-([a-z]+)\Z')
MEDIA_FILE = re.compile(r'(?:[a-f0-9]{64}\.(?:png|jpg|jpeg|webp|gif|pdf)|\.source-[a-f0-9]{64}\.ref|\.inherited\.json)\Z')
DATA_ERRORS = (SessionError, OSError, ValueError, TypeError, KeyError, AttributeError)
REASONS = {
    'session-claim': '绑定记录对应的会话已不存在。',
    'prompt-cache': '提示词缓存对应的会话已不存在。',
    'context-notice': '通知记录对应的会话已不存在。',
    'presentation': '展示记录对应的会话已不存在。',
    'media': '桥接媒体没有存续会话或继承引用。',
    'archive-completed': '已结束的归档操作遗留的记录。',
    'archive-plan': '未发布且无对应事务的归档预备目录。',
    'archive-move': '没有对应归档事务的移动暂存。',
}
MESSAGES = {
    'DONE': '清理已完成。',
    'REVISION_CHANGED': '候选已变化或不再符合清理条件，请刷新预览。',
    'STATE_UNKNOWN': '无法确认会话打开状态或文件归属，已保留数据。',
    'RESULT_UNKNOWN': '无法确认清理完整完成，请刷新预览。',
}


def native_projects():
    projects = []
    for name in children(PROJECTS):
        path = PROJECTS / name
        info = entry(path)
        if info and stat.S_ISLNK(info.st_mode):
            raise SessionError('OWNERSHIP_UNCERTAIN')
        if info and stat.S_ISDIR(info.st_mode):
            projects.append(path)
    return projects


def native_present(session_id, projects):
    return entry(PENDING / session_id) is not None or any(
        entry(project / (session_id + '.jsonl')) is not None or entry(project / session_id) is not None
        for project in projects)


def bridge_projects():
    for name in children(WORKSPACE_ROOT):
        if name.startswith('.'):
            continue
        path = WORKSPACE_ROOT / name
        if project_for(str(path))['mapped']:
            yield path


def candidate(path, category, cutoff, *, shape, owners=()):
    rows = tree(path)
    if not rows or not shape(rows):
        return None
    newest = max(row['identity'][3] for row in rows.values()) / 1e9
    if newest >= cutoff or len({row['identity'][0] for row in rows.values()}) != 1:
        return None
    byte_count, files = sizes({'data': rows})
    identifier = 'v-' + hashlib.sha256(str(path).encode('utf8', errors='surrogateescape')).hexdigest()
    item = {'id': identifier, 'location': 'vps', 'kind': category, 'bytes': byte_count, 'fileCount': files,
            'reason': REASONS[category], 'revision': revision({'data': path}, {'data': rows}),
            'lastModifiedAt': iso(newest)}
    return item, path, rows, owners


def file_shape(rows):
    return rows['.']['kind'] == 'file'


def flat_files(rows, pattern):
    return rows['.']['kind'] == 'directory' and all(
        name == '.' or (row['kind'] == 'file' and pattern.fullmatch(name)) for name, row in rows.items())


def inherited_keys(file):
    record = optional_json(file)
    keys = set()
    if record is None:
        return keys
    if not isinstance(record.get('files'), list):
        raise SessionError('OWNERSHIP_UNCERTAIN')
    for item in record['files']:
        prefix = str(MEDIA) + '/'
        value = item['path']
        if not isinstance(value, str) or not value.startswith(prefix):
            raise SessionError('OWNERSHIP_UNCERTAIN')
        key, slash, name = value[len(prefix):].partition('/')
        if not slash or not SAFE_ID.fullmatch(key) or not re.fullmatch(r'[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif|pdf)', name):
            raise SessionError('OWNERSHIP_UNCERTAIN')
        keys.add(key)
    return keys


def archive_inventory(read_archive):
    archived, tokens, media_keys = set(), set(), set()
    for session_id in children(ARCHIVE):
        if not UUID.fullmatch(session_id):
            continue
        archived.add(session_id)
        journal, _ = read_archive(session_id)
        tokens.add(journal['token'])
        if journal['mediaKey']:
            media_keys.add(journal['mediaKey'])
        media_keys.update(inherited_keys(ARCHIVE / session_id / 'media' / '.inherited.json'))
    return archived, tokens, media_keys


def scan_storage(read_archive, *, now=None, opening_locked=False):
    cutoff = (time.time() if now is None else now) - GRACE
    warnings, candidates = {}, {}

    def warn(code, message):
        warnings[code] = {'code': code, 'message': message}

    def add(path, category, *, shape, owners=()):
        try:
            value = candidate(path, category, cutoff, shape=shape, owners=owners)
            if value:
                candidates[value[0]['id']] = value
        except DATA_ERRORS:
            warn('OWNERSHIP_UNCERTAIN', '部分路径或文件归属无法核实，已跳过。')

    try:
        projects = native_projects()
        mapped = list(bridge_projects())
        archived, tokens, media_refs = archive_inventory(read_archive)
    except DATA_ERRORS:
        warn('OWNERSHIP_UNCERTAIN', '无法完整核实原生目录或归档事务，已跳过 VPS 清理候选。')
        return candidates, list(warnings.values())

    if not opening_locked and not available(LEASES / 'opening'):
        warn('STATE_UNKNOWN', '有会话正在打开，无法预览 VPS 清理候选。')
        return candidates, list(warnings.values())
    observed = process_activity()
    if observed[2]:
        warn('STATE_UNKNOWN', '无法确认部分会话的打开状态，已保留孤立数据。')
    bindings = {}
    media_certain = True
    live = {path.stem for project in projects for name in children(project)
            if UUID.fullmatch((path := project / name).stem) and (name == path.stem or path.suffix == '.jsonl')}
    live.update(name for name in children(PENDING) if UUID.fullmatch(name))
    live.update(archived)
    for name in children(CLAIMS):
        if not (name.endswith('.json') and UUID.fullmatch(session_id := name[:-5])):
            continue
        try:
            claim = optional_json(CLAIMS / name)
            if not claim or not isinstance(claim.get('mediaKey'), str) or not SAFE_ID.fullmatch(claim['mediaKey']):
                raise SessionError('OWNERSHIP_UNCERTAIN')
            bindings[session_id] = claim
        except DATA_ERRORS:
            media_certain = False
            warn('OWNERSHIP_UNCERTAIN', '部分绑定无法解析，相应数据和媒体已保留。')

    def orphan(session_id, path):
        return session_id not in live and activity(session_id, [path], observed) == 'idle'

    cache_roots = {CLAIMS: ('session-claim', 'claim'), WORKSPACE_ROOT / '.bridge-cache': ('prompt-cache', 'prompt'),
                   WORKSPACE_ROOT / '.bridge-notices': ('context-notice', 'notice')}
    if not observed[2]:
        for parent, (category, unit) in cache_roots.items():
            for name in children(parent):
                if not (name.endswith('.json') and UUID.fullmatch(session_id := name[:-5])):
                    continue
                path = parent / name
                try:
                    if not orphan(session_id, path):
                        continue
                    row = optional_json(path)
                    if not row or not PROJECT_ID.fullmatch(row.get('projectId', '')):
                        raise SessionError('OWNERSHIP_UNCERTAIN')
                    if unit == 'claim':
                        project = project_for(row.get('remoteCwd'))
                        if session_id not in bindings or project.get('projectId') != row['projectId']:
                            raise SessionError('OWNERSHIP_UNCERTAIN')
                    add(path, category, shape=file_shape, owners=(session_id,))
                except DATA_ERRORS:
                    warn('OWNERSHIP_UNCERTAIN', '部分桥接记录归属无法核实，已跳过。')
        for project in mapped:
            for name in children(project / '.bridge-presentation'):
                path = project / '.bridge-presentation' / name
                if UUID.fullmatch(name) and orphan(name, path):
                    add(path, 'presentation', shape=lambda rows: flat_files(rows, re.compile(r'[a-zA-Z0-9_-]{1,100}\.json')), owners=(name,))

    media = [name for name in children(MEDIA) if SAFE_ID.fullmatch(name)]
    if media_certain and not observed[2]:
        try:
            inherited = {key: inherited_keys(MEDIA / key / '.inherited.json') for key in media}
            used = media_refs | set().union(*inherited.values())
            owners = {}
            unbound_writers = observed[0] - bindings.keys()
            for session_id, claim in bindings.items():
                owners.setdefault(claim['mediaKey'], []).append(session_id)
            for key in media:
                path = MEDIA / key
                bound = owners.get(key, [])
                if not bound and unbound_writers:
                    continue
                if key not in used and len(bound) <= 1 and all(orphan(owner, path) for owner in bound) and activity(key, [path], observed) == 'idle':
                    add(path, 'media', shape=lambda rows: flat_files(rows, MEDIA_FILE), owners=tuple(bound))
        except DATA_ERRORS:
            warn('OWNERSHIP_UNCERTAIN', '无法完整核实媒体继承引用，已保留媒体。')

    stage_names = children(ARCHIVE)
    planned_tokens = {match[1] for name in stage_names if (match := PLAN.fullmatch(name))}
    for name in stage_names:
        matched = PLAN.fullmatch(name) or COMPLETED.fullmatch(name)
        if not matched or matched[1] in tokens:
            continue
        path = ARCHIVE / name
        completed = name.startswith('.completed-')
        try:
            manifest = optional_json(path / 'manifest.json')
            if manifest is not None:
                session_id = manifest.get('id')
                if not isinstance(session_id, str) or not UUID.fullmatch(session_id):
                    raise SessionError('OWNERSHIP_UNCERTAIN')
                journal, _ = read_archive(session_id, path / 'manifest.json')
                if journal['token'] != matched[1] or journal['phase'] not in ({'deleting', 'restoring'} if completed else {'archiving'}):
                    raise SessionError('OWNERSHIP_UNCERTAIN')
            pattern = re.compile(r'manifest\.json' if completed else rf'(?:manifest\.json|\.manifest-{TOKEN})\Z')
            add(path, 'archive-completed' if completed else 'archive-plan', shape=lambda rows: flat_files(rows, pattern))
        except DATA_ERRORS:
            warn('OWNERSHIP_UNCERTAIN', '部分归档残留无法核实，已保留。')

    all_units = {'transcript', 'attachments', 'pending', 'claim', 'prompt', 'notice', 'media', 'presentation'}
    parents = {project: {'transcript', 'attachments'} for project in projects}
    parents.update({ARCHIVE / session_id: all_units for session_id in archived})
    parents.update({parent: {unit} for parent, (_, unit) in cache_roots.items()})
    parents.update({project / '.bridge-presentation': {'presentation'} for project in mapped})
    parents.update({PENDING: {'pending'}, MEDIA: {'media'}})
    for parent, units in parents.items():
        for name in children(parent):
            match = MOVE.fullmatch(name)
            if match and match[1] not in tokens | planned_tokens and match[2] in units:
                payload_kind = 'file' if match[2] in {'transcript', 'claim', 'prompt', 'notice'} else 'directory'
                add(parent / name, 'archive-move', shape=lambda rows: rows['.']['kind'] == 'directory'
                    and rows.get('payload', {'kind': payload_kind})['kind'] == payload_kind
                    and all(name in ('.', 'payload') or name.startswith('payload/') for name in rows))
    return candidates, list(warnings.values())


def result(item, code, status):
    return {'id': item['id'], 'code': code, 'status': status, 'message': MESSAGES[code]}


def storage_request(method, params, read_archive):
    if method == 'storage.plan' and params == {}:
        now = time.time()
        candidates, warnings = scan_storage(read_archive, now=now)
        items = sorted((value[0] for value in candidates.values()), key=lambda item: (item['lastModifiedAt'], item['id']))
        return {'generatedAt': iso(now), 'items': items, 'totals': {'vpsBytes': sum(item['bytes'] for item in items), 'windowsBytes': 0},
                'warnings': warnings}
    items = params.get('items')
    if method != 'storage.clean' or set(params) != {'items'} or not isinstance(items, list) or not 0 < len(items) <= 200 or any(
            not isinstance(item, dict) or set(item) != {'id', 'revision'} or not isinstance(item['id'], str)
            or not re.fullmatch(r'v-[0-9a-f]{64}', item['id']) or not isinstance(item['revision'], str)
            or not 0 < len(item['revision']) <= 256 for item in items):
        raise SessionError('INVALID_ARGUMENT')
    try:
        with lock(LEASES / 'opening') as acquired:
            if acquired:
                candidates, warnings = scan_storage(read_archive, opening_locked=True)
                uncertain = any(warning['code'] == 'STATE_UNKNOWN' for warning in warnings)
                results = []
                for item in items:
                    value = candidates.pop(item['id'], None)
                    results.append(clean_item(item, value, uncertain))
                return {'results': results}
    except DATA_ERRORS:
        pass
    return {'results': [result(item, 'STATE_UNKNOWN', 'rejected') for item in items]}


def clean_item(item, value, uncertain):
    if value is None and uncertain:
        return result(item, 'STATE_UNKNOWN', 'rejected')
    if value is None or value[0]['revision'] != item['revision']:
        return result(item, 'REVISION_CHANGED', 'conflict')
    _, path, rows, owners = value
    try:
        projects = native_projects() if owners else ()
        if tree(path) != rows or any(native_present(owner, projects) for owner in owners):
            return result(item, 'REVISION_CHANGED', 'conflict')
    except DATA_ERRORS:
        return result(item, 'STATE_UNKNOWN', 'rejected')
    try:
        remove_snapshot(path, rows)
    except DATA_ERRORS:
        return result(item, 'RESULT_UNKNOWN', 'unknown')
    return result(item, 'DONE', 'done')
