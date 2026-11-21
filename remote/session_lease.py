"""Shared relay leases and exclusive administration locks."""
from contextlib import ExitStack, contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import sys

from bridge_paths import ROOT
from session_files import SessionError, directory, entry, kind

ARCHIVE = ROOT / 'archive'
LEASES = ROOT / 'run' / 'session-leases'
CLIENTS = ROOT / 'run' / 'session-clients'
SAFE_ID = re.compile(r'[a-zA-Z0-9_-]{1,100}\Z')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z')


@contextmanager
def lock(path, *, shared=False, create=True):
    try:
        with directory(path.parent, create) as parent:
            flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_CREAT | os.O_RDWR if create else os.O_RDONLY)
            fd = os.open(path.name, flags, 0o600, dir_fd=parent)
    except FileNotFoundError:
        if create:
            raise
        yield True
        return
    try:
        try:
            if kind(os.fstat(fd)) != 'file':
                raise SessionError('STATE_UNKNOWN')
        except SessionError:
            raise SessionError('STATE_UNKNOWN') from None
        try:
            fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        else:
            yield True
    finally:
        os.close(fd)


def available(path, *, shared=False):
    with lock(path, shared=shared, create=False) as acquired:
        return acquired


def session_path(session_id):
    if not isinstance(session_id, str) or not SAFE_ID.fullmatch(session_id):
        raise SessionError('STATE_UNKNOWN')
    return LEASES / (session_id + '.lock')


def acquire_session(stack, session_id):
    if not stack.enter_context(lock(session_path(session_id), shared=True)):
        raise SessionError('SESSION_MANAGED')
    if entry(ARCHIVE / session_id) is not None:
        raise SessionError('SESSION_ARCHIVED')


def response(code=None):
    print(json.dumps({'code': code}), flush=True)


def main():
    with ExitStack() as lifetime, ExitStack() as initial_lease, ExitStack() as opening:
        first = json.loads(sys.stdin.readline())
        if first['kind'] == 'worker':
            pid = os.getppid()
            if first['pid'] != pid or not lifetime.enter_context(lock(CLIENTS / str(pid), shared=True)):
                raise SessionError('STATE_UNKNOWN')
            response()
            sys.stdin.read()
            return
        if not opening.enter_context(lock(LEASES / 'opening', shared=True)):
            raise SessionError('SESSION_MANAGED')
        initial = first.get('id')
        if initial is not None:
            acquire_session(initial_lease, initial)
        writer = None
        response()
        for line in sys.stdin:
            command = json.loads(line)
            if command['kind'] == 'verify':
                # Reuse the same native lookup as inventory before an unclaimed resume.
                from session_inventory import transcript_info, transcripts
                locations, uncertain = transcripts(initial)
                if uncertain or len(locations) > 1:
                    raise SessionError('PROJECT_MISMATCH')
                if locations:
                    meta = transcript_info(locations[0], initial)
                    if meta['cwd'] != command['cwd']:
                        raise SessionError('PROJECT_MISMATCH')
                response()
                continue
            if command['kind'] == 'writer':
                writer = command.get('id')
                if writer is not None and writer != initial:
                    acquire_session(lifetime, writer)
                response()
                continue
            if writer is not None and writer != initial:
                initial_lease.close()  # fork media and presentation have finished reading the source
            opening.close()
            response()
            sys.stdin.read()
            return


if __name__ == '__main__':
    try:
        main()
    except SessionError as error:
        response(error.code)
    except (OSError, ValueError, KeyError):
        response('STATE_UNKNOWN')
