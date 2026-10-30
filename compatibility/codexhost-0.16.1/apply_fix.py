"""Apply or restore the version-pinned CodexHost attachment fix (Python 3.11+)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

VERSION = '0.16.1'
ORIGINAL = 'd31bbef947c3f72e2cf5eb21b7db40fdd1467542adb30160d23931b2df464cf4'
PATCHED = '500fc46bbd4c89797eb5edb540d9340f139fe88e5c784dad17629e30b511c5cd'
TARGETS = {'windows-x64', 'linux-x64'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def replace_file(target, data, mode):
    temporary = target.with_name(target.name + '.attachment-fix.tmp')
    # Refuse an existing temporary file, including links left by another process.
    with temporary.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        temporary.chmod(mode)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def resolve_root(value):
    if value:
        return Path(value).expanduser().resolve()
    command = shutil.which('codexhost')
    if command:
        executable = Path(command).resolve()
        direct = executable.parent.parent
        platform = 'cli-win32-x64' if os.name == 'nt' else 'cli-linux-x64'
        for candidate in (direct, direct / 'node_modules/@codexhost' / platform):
            if (candidate / 'app/codexhost-distribution.json').is_file():
                return candidate.resolve()
    raise RuntimeError('Cannot find CodexHost. Supply --host-root with the directory containing app/.')


def run(root, payload, action):
    root = root.resolve()
    target = root / 'app/host-runtime.mjs'
    metadata_path = root / 'app/codexhost-distribution.json'
    for candidate in (target, metadata_path):
        if candidate.is_symlink() or not candidate.resolve().is_relative_to(root):
            raise RuntimeError('Refusing a redirected installation file.')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    if metadata.get('version') not in (VERSION, VERSION + '+pr654.679f3cb') or metadata.get('target') not in TARGETS:
        raise RuntimeError('Unsupported CodexHost version or platform; no changes made.')
    current = target.read_bytes()
    current_hash = digest(current)
    if current_hash not in (ORIGINAL, PATCHED):
        raise RuntimeError('Host file differs from the verified build; no changes made.')
    backup_dir = root / '.claude-vps-attachment-fix' / VERSION
    backup = backup_dir / 'host-runtime.original.mjs'
    if backup_dir.resolve() != backup_dir or backup.is_symlink():
        raise RuntimeError('Refusing a redirected backup directory.')
    if action == 'check':
        return {'state': 'patched' if current_hash == PATCHED else 'original', 'hostRoot': str(root),
                'restorable': backup.is_file() and digest(backup.read_bytes()) == ORIGINAL}
    if action == 'apply' and current_hash == PATCHED:
        return {'state': 'already-patched', 'changed': False}
    if action == 'restore' and current_hash == ORIGINAL:
        return {'state': 'already-original', 'changed': False}
    backup_dir.mkdir(parents=True, exist_ok=True)
    lock = backup_dir / 'operation.lock'
    try:
        handle = lock.open('x')
    except FileExistsError:
        raise RuntimeError('Another operation or interrupted operation owns operation.lock; inspect it before retrying.') from None
    try:
        with handle:
            handle.write(str(os.getpid()))
        if action == 'apply':
            replacement = payload.read_bytes()
            if digest(replacement) != PATCHED:
                raise RuntimeError('Repair payload hash mismatch; no host changes made.')
            if backup.exists():
                if digest(backup.read_bytes()) != ORIGINAL:
                    raise RuntimeError('Original backup hash mismatch; no host changes made.')
            else:
                with backup.open('xb') as stream:
                    stream.write(current)
                    stream.flush()
                    os.fsync(stream.fileno())
            expected = PATCHED
        else:
            replacement = backup.read_bytes()
            if digest(replacement) != ORIGINAL:
                raise RuntimeError('Original backup hash mismatch; no host changes made.')
            expected = ORIGINAL
        if digest(target.read_bytes()) != current_hash:
            raise RuntimeError('Installation changed during preparation; no host changes made.')
        replace_file(target, replacement, target.stat().st_mode & 0o777)
        if digest(target.read_bytes()) != expected:
            raise RuntimeError('Post-install verification failed; preserve backup for recovery.')
        return {'state': 'patched' if action == 'apply' else 'restored', 'changed': True,
                'restartRequired': True, 'backup': str(backup)}
    finally:
        lock.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-root', help='CodexHost directory containing app/; otherwise discover on PATH')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--check', action='store_true', help='Read-only compatibility check')
    actions.add_argument('--restore', action='store_true', help='Restore the original verified Host file')
    args = parser.parse_args()
    try:
        result = run(resolve_root(args.host_root), Path(__file__).with_name('host-runtime.mjs'),
                     'check' if args.check else 'restore' if args.restore else 'apply')
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
