"""File operations anchored to directory descriptors. Linux VPS only."""
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
from uuid import uuid4

MAX_JSON_BYTES = 16 * 1024 * 1024


class SessionError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def kind(info):
    if stat.S_ISDIR(info.st_mode):
        return 'directory'
    if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
        return 'file'
    raise SessionError('OWNERSHIP_UNCERTAIN')


@contextmanager
def directory(path, create=False):
    if not path.is_absolute() or '..' in path.parts or path.anchor != '/':
        raise SessionError('OWNERSHIP_UNCERTAIN')
    flags = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY
    fd = os.open('/', flags)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def identity(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def entry(path):
    try:
        with directory(path.parent) as fd:
            return os.stat(path.name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def children(path):
    try:
        with directory(path) as fd:
            return sorted(os.listdir(fd))
    except FileNotFoundError:
        return []


@contextmanager
def file_reader(path):
    with directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as readable:
            before = os.fstat(fd)
            if kind(before) != 'file':
                raise SessionError('OWNERSHIP_UNCERTAIN')
            yield readable
            after = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            if identity(before) != identity(after):
                raise SessionError('REVISION_CHANGED')


def read_json(path):
    with file_reader(path) as source:
        data = source.read(MAX_JSON_BYTES + 1)
        if len(data) > MAX_JSON_BYTES:
            raise SessionError('OWNERSHIP_UNCERTAIN')
        return json.loads(data)


def save_json(path, value):
    content = json.dumps(value, ensure_ascii=True, separators=(',', ':'))
    if len(content) > MAX_JSON_BYTES:
        raise SessionError('OWNERSHIP_UNCERTAIN')
    with directory(path.parent) as parent:
        temporary = '.manifest-' + uuid4().hex
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf8') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def tree(path, digest=False):
    rows = {}

    def visit(current, relative):
        info = entry(current)
        if info is None:
            raise SessionError('REVISION_CHANGED')
        file_kind = kind(info)
        row = {'kind': file_kind, 'identity': identity(info)}
        rows[relative] = row
        if file_kind == 'directory':
            for name in children(current):
                visit(current / name, name if relative == '.' else relative + '/' + name)
        elif digest:
            with file_reader(current) as stream:
                if identity(os.fstat(stream.fileno())) != row['identity']:
                    raise SessionError('REVISION_CHANGED')
                checksum = hashlib.sha256()
                while block := stream.read(1024 * 1024):
                    checksum.update(block)
                row['sha256'] = checksum.hexdigest()
        if (after := entry(current)) is None or identity(after) != row['identity']:
            raise SessionError('REVISION_CHANGED')

    if entry(path) is not None:
        visit(path, '.')
    return rows


def contents(rows):
    return {name: [row['kind'], row['identity'][2] if row['kind'] == 'file' else 0, row.get('sha256')]
            for name, row in rows.items()}


def inode(path):
    info = entry(path)
    if info is not None:
        kind(info)
        return identity(info)[:2]


def rename(source, target):
    # RENAME_NOREPLACE is atomic for both files and directories. EEXIST cannot
    # overwrite even an empty directory created after the preflight.
    with directory(source.parent) as src, directory(target.parent) as dst:
        move = ctypes.CDLL(None, use_errno=True).renameat2
        if move(src, os.fsencode(source.name), dst, os.fsencode(target.name), 1):
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        os.fsync(src)
        os.fsync(dst)


def make_dir(path):
    with directory(path.parent) as parent:
        os.mkdir(path.name, 0o700, dir_fd=parent)
        os.fsync(parent)


def copy_tree(source, target, rows):
    for relative, row in rows.items():
        src, dst = source / relative, target / relative
        if row['kind'] == 'directory':
            make_dir(dst)
            continue
        with file_reader(src) as readable, directory(dst.parent) as parent:
            info = os.fstat(readable.fileno())
            if identity(info) != row['identity']:
                raise SessionError('REVISION_CHANGED')
            fd = os.open(dst.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, info.st_mode & 0o700, dir_fd=parent)
            try:
                while chunk := readable.read(1024 * 1024):
                    view = memoryview(chunk)
                    while view:
                        view = view[os.write(fd, view):]
                os.utime(fd, ns=(info.st_atime_ns, info.st_mtime_ns))
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(parent)


def remove_tree(path, expected, *, partial=False):
    rows = tree(path, True)
    found = contents(rows)
    if (not partial and found != expected) or any(expected.get(name) != row for name, row in found.items()):
        raise SessionError('ARCHIVE_CHECKSUM_MISMATCH')
    remove_snapshot(path, rows)


def remove_snapshot(path, rows):
    """Remove only the entries captured in a revalidated inventory."""
    for name, row in reversed(list(rows.items())):
        file = path / name
        with directory(file.parent) as parent:
            current = os.stat(file.name, dir_fd=parent, follow_symlinks=False)
            if kind(current) != row['kind']:
                raise SessionError('OWNERSHIP_UNCERTAIN')
            if row['kind'] == 'directory':
                if identity(current)[:2] != row['identity'][:2]:
                    raise SessionError('OWNERSHIP_UNCERTAIN')
                os.rmdir(file.name, dir_fd=parent)
            else:
                if identity(current) != row['identity']:
                    raise SessionError('REVISION_CHANGED')
                os.unlink(file.name, dir_fd=parent)
            os.fsync(parent)
