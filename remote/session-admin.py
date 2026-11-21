"""One SSH request. Archive journals survive a lost caller or process."""
from contextlib import ExitStack
import errno
import json
import os
from pathlib import Path
import re
import sys
import time
from uuid import uuid4

from session_files import (SessionError, children, contents, directory, entry, inode, make_dir,
                           read_json, remove_tree, rename, save_json, tree, copy_tree)
from session_inventory import (CACHE_UNITS, activity, iso, media_is_exclusive, origins, owned,
                               process_activity, project_for, revision, sizes, transcripts)
from session_lease import ARCHIVE, LEASES, SAFE_ID, UUID, lock, session_path

READY = 'CLAUDE_VPS_SESSION_ADMIN_READY_V1'
MESSAGES = {
    'DONE': '操作已完成。', 'RUNNING': 'Claude 会话正在使用。', 'STATE_UNKNOWN': '无法确认会话已停止。',
    'REVISION_CHANGED': '会话文件已变化，请刷新列表。',
    'BOUND_REQUIRES_CONFIRMATION': '该会话关联了宿主聊天，请确认后归档。',
    'NOT_FOUND': '会话不存在。', 'NOT_ARCHIVED': '只允许删除或恢复已归档的会话。',
    'RESTORE_TARGET_EXISTS': '恢复目标已存在，文件未覆盖。',
    'OWNERSHIP_UNCERTAIN': '文件归属或路径无法核实，已停止处理。',
    'RESULT_UNKNOWN': '操作未确认完成，请刷新列表查看事务状态。',
    'ARCHIVE_CHECKSUM_MISMATCH': '文件与归档清单不符，已保留冲突文件。',
    'ARCHIVE_INCOMPLETE': '归档事务仍未完成，请按列表中的阶段继续。',
    'ARCHIVE_STAGING_CONFLICT': '跨文件系统暂存内容不完整，原件或已校验副本仍保留。',
    'ALREADY_ARCHIVED': '会话已归档。', 'INVALID_ARGUMENT': '管理请求无效。',
}
CONFLICTS = {'REVISION_CHANGED', 'RESTORE_TARGET_EXISTS', 'ARCHIVE_CHECKSUM_MISMATCH',
             'ARCHIVE_INCOMPLETE', 'ARCHIVE_STAGING_CONFLICT'}
PHASES = {'archiving', 'archived', 'restoring', 'deleting'}
HEX = re.compile(r'[0-9a-f]{64}\Z')
TOKEN = re.compile(r'[0-9a-f]{32}\Z')


def require(condition, code):
    if not condition:
        raise SessionError(code)


def manifest_path(session_id):
    return ARCHIVE / session_id / 'manifest.json'


def archive_manifest(session_id):
    file = manifest_path(session_id)
    try:
        value = read_json(file)
        require(entry(file.parent) is not None and value['version'] == 1 and value['id'] == session_id
                and value['phase'] in PHASES and TOKEN.fullmatch(value['token']), 'OWNERSHIP_UNCERTAIN')
        session = value['session']
        require(session['id'] == session_id and isinstance(session['lastActiveAt'], str), 'OWNERSHIP_UNCERTAIN')
        encoded, cwd, key = value['encodedProject'], session['project']['remoteCwd'], value['mediaKey']
        require(isinstance(encoded, str) and encoded not in ('', '.', '..') and '/' not in encoded
                and isinstance(cwd, str) and (key is None or SAFE_ID.fullmatch(key)), 'OWNERSHIP_UNCERTAIN')
        paths = origins(session_id, encoded, cwd, key)
        require('transcript' in value['units'], 'OWNERSHIP_UNCERTAIN')
        for name, row in value['units'].items():
            require(name in paths and row['origin'] == str(paths[name]) and '.' in row['files'], 'OWNERSHIP_UNCERTAIN')
            for relative, (kind, size, checksum) in row['files'].items():
                parts = relative.split('/')
                require(relative == '.' or all(part not in ('', '.', '..') for part in parts), 'OWNERSHIP_UNCERTAIN')
                require((kind == 'directory' and size == 0 and checksum is None) or
                        (kind == 'file' and isinstance(size, int) and size >= 0 and HEX.fullmatch(checksum)), 'OWNERSHIP_UNCERTAIN')
        return value, paths
    except (KeyError, TypeError, AttributeError, ValueError):
        raise SessionError('OWNERSHIP_UNCERTAIN') from None


def archive_paths(session_id, journal, paths):
    base = ARCHIVE / session_id
    # The journal is in the revision so a phase transition invalidates a preview.
    found = {'manifest': base / 'manifest.json'}
    for name in journal['units']:
        found[name] = base / name
        if journal['phase'] != 'archived':
            found['origin:'+name] = paths[name]
        if journal['phase'] in ('archiving', 'restoring'):
            destination = base / name if journal['phase'] == 'archiving' else paths[name]
            found['staging:'+name] = staging_path(destination, journal, name)
    return found


def collect(paths):
    return {name: rows for name, path in paths.items() if (rows := tree(path))}


def make_session(session_id, meta, project, claim, paths, snapshots, observed, uncertain):
    byte_count, file_count = sizes(snapshots)
    state = activity(session_id, paths.values(), observed)
    if uncertain and state == 'idle':
        state = 'unknown'
    return {'id': session_id, 'scope': 'active', 'project': project, 'title': meta['title'],
            'createdAt': meta['createdAt'], 'lastActiveAt': meta['lastActiveAt'], 'bytes': byte_count,
            'fileCount': file_count, 'state': state, 'revision': revision(paths, snapshots),
            'bindingKey': claim.get('mediaKey'), 'hasBoundThread': claim.get('hasBoundThread') if claim else False}


def warning(code, session_id=None, **fields):
    return {'code': code, 'message': MESSAGES.get(code, '部分会话文件无法核实。'),
            **({'id': session_id} if session_id else {}), **fields}


def list_sessions(params):
    warnings, sessions = [], []
    observed = process_activity()
    paths, uncertain = transcripts()
    active, archived, cache = 0, 0, 0
    ids = {}
    for file in paths:
        ids.setdefault(file.stem, []).append(file)
    if uncertain:
        warnings.append(warning('OWNERSHIP_UNCERTAIN'))
    if observed[2]:
        warnings.append(warning('STATE_UNKNOWN'))
    for session_id, locations in ids.items():
        if len(locations) != 1:
            warnings.append(warning('OWNERSHIP_UNCERTAIN', session_id))
            continue
        try:
            if entry(ARCHIVE / session_id) is not None:
                continue  # the journal is the visible owner from the first move onward
            meta, project, claim, rooted, snapshots = owned(locations[0], session_id)
            row = make_session(session_id, meta, project, claim, rooted, snapshots, observed, uncertain)
            active += row['bytes']
            if row['scope'] == params['scope'] and (not params.get('project') or project.get('projectId') == params['project']):
                sessions.append(row)
        except (SessionError, OSError) as error:
            warnings.append(warning(error.code if isinstance(error, SessionError) else 'OWNERSHIP_UNCERTAIN', session_id))
    for session_id in children(ARCHIVE):
        if not UUID.fullmatch(session_id):
            continue
        try:
            journal, origins_for_session = archive_manifest(session_id)
            rooted = archive_paths(session_id, journal, origins_for_session)
            snapshots = collect(rooted)
            contents_only = {name: rows for name, rows in snapshots.items() if name in journal['units']}
            byte_count, file_count = sizes(contents_only)
            archived += byte_count
            active += sizes({name: rows for name, rows in snapshots.items() if name.startswith('origin:')})[0]
            row = {**journal['session'], 'scope': 'archived', 'archivedAt': journal['archivedAt'],
                   'revision': revision(rooted, snapshots), 'bytes': byte_count, 'fileCount': file_count,
                   'state': activity(session_id, rooted.values(), observed)}
            if journal['phase'] != 'archived':
                warnings.append(warning('ARCHIVE_INCOMPLETE', session_id, phase=journal['phase']))
            if row['scope'] == params['scope'] and (not params.get('project') or row['project'].get('projectId') == params['project']):
                sessions.append(row)
        except (SessionError, OSError) as error:
            warnings.append(warning(error.code if isinstance(error, SessionError) else 'OWNERSHIP_UNCERTAIN', session_id))
    # Cache is a separate view of live bridge cache bytes (a subset of active
    # bytes for owned sessions, plus orphan cache). It is not added to totals.
    from bridge_paths import WORKSPACE_ROOT
    for name in CACHE_UNITS:
        root = WORKSPACE_ROOT / name
        try:
            for key in children(root):
                try:
                    cache += sizes({name: tree(root / key)})[0]
                except (SessionError, OSError):
                    warnings.append(warning('OWNERSHIP_UNCERTAIN'))
                    break
        except OSError:
            warnings.append(warning('OWNERSHIP_UNCERTAIN'))
    sessions.sort(key=lambda row: (row['lastActiveAt'], row['id']), reverse=True)
    return {'generatedAt': iso(time.time()), 'sessions': sessions,
            'storage': {'activeBytes': active, 'archivedBytes': archived, 'cacheBytes': cache}, 'warnings': warnings}


def staging_path(destination, journal, name):
    return destination.parent / ('.bridge-move-' + journal['token'] + '-' + name)


def verified(path, expected, *, partial=False):
    rows = tree(path, True)
    found = contents(rows)
    require((partial or found == expected) and all(expected.get(name) == row for name, row in found.items()),
            'ARCHIVE_CHECKSUM_MISMATCH')
    return rows


def move_unit(journal, name, source, target, phase):
    row = journal['units'][name]
    source_inode = row[phase + 'Inode']
    copy_inode = row.get(phase + 'Copy')
    original, destination = inode(source), inode(target)
    stage = staging_path(target, journal, name)
    if destination is not None:
        # Only a move we published may be resumed. A pre-existing target with
        # byte-identical content is still a conflict and is never overwritten.
        require(destination in (source_inode, copy_inode), 'RESTORE_TARGET_EXISTS' if phase == 'restore' else 'OWNERSHIP_UNCERTAIN')
        verified(target, row['files'])
        if original is not None:
            require(original == source_inode and destination == copy_inode, 'OWNERSHIP_UNCERTAIN')
            ensure_idle(journal['id'], (source, target))
            remove_tree(source, row['files'], partial=True)
    else:
        require(original == source_inode, 'OWNERSHIP_UNCERTAIN')
        rows = verified(source, row['files'])
        with directory(target.parent, create=True):
            pass
        if entry(stage) is None:
            ensure_idle(journal['id'], (source, target))
            try:
                rename(source, target)
            except OSError as error:
                if error.errno != errno.EXDEV:
                    raise
            else:
                verified(target, row['files'])
                return
            make_dir(stage)
            copy_tree(source, stage / 'payload', rows)
        require(children(stage) == ['payload'], 'ARCHIVE_STAGING_CONFLICT')
        try:
            verified(stage / 'payload', row['files'])
        except SessionError:
            raise SessionError('ARCHIVE_STAGING_CONFLICT') from None
        row[phase + 'Copy'] = inode(stage / 'payload')
        save_json(manifest_path(journal['id']), journal)
        verified(source, row['files'])
        rename(stage / 'payload', target)
        verified(target, row['files'])
        ensure_idle(journal['id'], (source, target))
        remove_tree(source, row['files'])
    if entry(stage) is not None:
        remove_tree(stage, {'.': ['directory', 0, None]})


def finish_archive(journal, paths):
    base = ARCHIVE / journal['id']
    for name in journal['units']:
        move_unit(journal, name, paths[name], base / name, 'archive')
    journal['phase'] = 'archived'
    save_json(manifest_path(journal['id']), journal)


def finish_removal(journal):
    base = ARCHIVE / journal['id']
    require(children(base) == ['manifest.json'], 'OWNERSHIP_UNCERTAIN')
    expected = contents(tree(base, True))
    done = ARCHIVE / ('.completed-' + journal['token'])
    rename(base, done)
    try:
        remove_tree(done, expected)
    except (OSError, SessionError):
        pass  # publication already removed the session from the archive


def ensure_idle(session_id, paths):
    state = activity(session_id, paths, process_activity(), check_lock=False)
    require(state != 'running', 'RUNNING')
    require(state == 'idle', 'STATE_UNKNOWN')


def apply_item(method, item, request):
    session_id = item['id']
    base = ARCHIVE / session_id
    if method == 'delete' and entry(base) is None:
        locations, uncertain = transcripts(session_id)
        require(not uncertain, 'OWNERSHIP_UNCERTAIN')
        raise SessionError('NOT_ARCHIVED' if locations else 'NOT_FOUND')
    with ExitStack() as locks:
        try:
            require(locks.enter_context(lock(session_path(session_id))), 'RUNNING')
            require(locks.enter_context(lock(LEASES / 'opening')), 'STATE_UNKNOWN')
        except OSError:
            raise SessionError('STATE_UNKNOWN') from None
        locations, uncertain = transcripts(session_id)
        require(not uncertain and len(locations) <= 1, 'OWNERSHIP_UNCERTAIN')
        if entry(base) is None:
            if method != 'archive':
                raise SessionError('NOT_ARCHIVED' if locations else 'NOT_FOUND')
            require(locations, 'NOT_FOUND')
            meta, project, claim, paths, snapshots = owned(locations[0], session_id)
            ensure_idle(session_id, paths.values())
            require(revision(paths, snapshots) == item['revision'], 'REVISION_CHANGED')
            if not request['params'].get('confirmBound'):
                bound = (claim.get('hasBoundThread') is True or session_id in request.get('boundIds', []) or
                         (claim.get('mediaKey') in request.get('boundKeys', {}) and
                          request['boundKeys'][claim['mediaKey']] == project.get('projectId')))
                require(not bound, 'BOUND_REQUIRES_CONFIRMATION')
            require('media' not in snapshots or media_is_exclusive(session_id, claim.get('mediaKey')), 'OWNERSHIP_UNCERTAIN')
            checked = {name: tree(paths[name], True) for name in snapshots}
            require(revision(paths, checked) == item['revision'], 'REVISION_CHANGED')
            ensure_idle(session_id, paths.values())
            require(revision(paths, collect(paths)) == item['revision'], 'REVISION_CHANGED')
            session = make_session(session_id, meta, project, claim, paths, snapshots, (set(), set(), False), False)
            journal = {'version': 1, 'id': session_id, 'token': uuid4().hex, 'phase': 'archiving',
                       'archivedAt': iso(time.time()), 'session': session, 'encodedProject': locations[0].parent.name,
                       'mediaKey': claim.get('mediaKey'), 'units': {name: {'origin': str(paths[name]),
                       'archiveInode': rows['.']['identity'][:2], 'files': contents(rows)} for name, rows in checked.items()}}
            with directory(ARCHIVE, create=True):
                pass
            # Publish a complete initial journal and its marker in one rename.
            staging = ARCHIVE / ('.plan-' + journal['token'])
            make_dir(staging)
            save_json(staging / 'manifest.json', journal)
            rename(staging, base)
            finish_archive(journal, paths)
            return
        journal, paths = archive_manifest(session_id)
        phase = journal['phase']
        rooted = archive_paths(session_id, journal, paths)
        ensure_idle(session_id, [*rooted.values(), *paths.values()])
        require(revision(rooted, collect(rooted)) == item['revision'], 'REVISION_CHANGED')
        if method == 'archive':
            require(phase != 'archived', 'ALREADY_ARCHIVED')
            require(phase == 'archiving', 'ARCHIVE_INCOMPLETE')
            require(all(location == paths['transcript'] for location in locations), 'OWNERSHIP_UNCERTAIN')
            # Confirmation in the originally accepted plan covers its continuation.
            finish_archive(journal, paths)
            return
        require(phase in ('archived', 'restoring' if method == 'restore' else 'deleting'), 'ARCHIVE_INCOMPLETE')
        if method == 'restore':
            project = journal['session']['project']
            if project['mapped']:
                require(project_for(project['remoteCwd']) == project, 'OWNERSHIP_UNCERTAIN')
            if phase == 'archived':
                require(not locations and all(entry(paths[name]) is None for name in journal['units']), 'RESTORE_TARGET_EXISTS')
                require(set(children(base)) <= {'manifest.json', *journal['units']}, 'OWNERSHIP_UNCERTAIN')
                for name, row in journal['units'].items():
                    verified(base / name, row['files'])
                    row['restoreInode'] = inode(base / name)
                ensure_idle(session_id, [*rooted.values(), *paths.values()])
                journal['phase'] = 'restoring'
                save_json(manifest_path(session_id), journal)
            for name in journal['units']:
                move_unit(journal, name, base / name, paths[name], 'restore')
        else:
            require(not locations, 'NOT_ARCHIVED')
            require(set(children(base)) <= {'manifest.json', *journal['units']}, 'OWNERSHIP_UNCERTAIN')
            for name, row in journal['units'].items():
                verified(base / name, row['files'], partial=phase == 'deleting')
            ensure_idle(session_id, [*rooted.values(), *paths.values()])
            if phase != 'deleting':
                journal['phase'] = 'deleting'
                save_json(manifest_path(session_id), journal)
            for name, row in journal['units'].items():
                remove_tree(base / name, row['files'], partial=True)
        finish_removal(journal)


def dispatch(request):
    method, params = request['method'], request['params']
    if method == 'sessions.list':
        require(params['scope'] in ('active', 'archived'), 'INVALID_ARGUMENT')
        return list_sessions(params)
    require(method in ('sessions.archive', 'sessions.restore', 'sessions.delete'), 'INVALID_ARGUMENT')
    require(isinstance(params['items'], list) and 0 < len(params['items']) <= 200, 'INVALID_ARGUMENT')
    results = []
    for item in params['items']:
        session_id = item.get('id') if isinstance(item, dict) else None
        status, code = 'done', 'DONE'
        try:
            require(isinstance(session_id, str) and UUID.fullmatch(session_id) and isinstance(item.get('revision'), str), 'INVALID_ARGUMENT')
            apply_item(method.split('.', 1)[1], item, request)
        except SessionError as error:
            code = error.code
            status = 'conflict' if code in CONFLICTS else 'rejected'
        except OSError as error:
            code = ('OWNERSHIP_UNCERTAIN' if error.errno in (errno.ELOOP, errno.ENOTDIR) else
                    'RESTORE_TARGET_EXISTS' if error.errno == errno.EEXIST and method == 'sessions.restore' else 'RESULT_UNKNOWN')
            status = 'unknown' if code == 'RESULT_UNKNOWN' else 'conflict' if code in CONFLICTS else 'rejected'
        except (TypeError, ValueError, KeyError, AttributeError):
            status, code = 'rejected', 'OWNERSHIP_UNCERTAIN'
        results.append({'id': session_id, 'status': status, 'code': code, 'message': MESSAGES[code]})
    return {'results': results}


def main():
    print(READY, file=sys.stderr, flush=True)
    try:
        data = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
        require(len(data) <= 16 * 1024 * 1024, 'INVALID_ARGUMENT')
        result = dispatch(json.loads(data))
        response = {'apiVersion': 1, 'ok': True, 'result': result}
    except (SessionError, ValueError, TypeError, KeyError, OSError) as error:
        code = error.code if isinstance(error, SessionError) else 'OWNERSHIP_UNCERTAIN' if isinstance(error, OSError) else 'INVALID_ARGUMENT'
        response = {'apiVersion': 1, 'ok': False, 'error': {'code': code, 'message': MESSAGES[code], 'details': {}}}
    print(json.dumps(response, ensure_ascii=True, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
