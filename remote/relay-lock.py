"""Hold a Linux kernel lock for exactly one relay process lifetime.

The inode is never unlinked: flock ownership, not a PID or file age, decides
whether another launcher can start. Python 3 is already a VPS prerequisite.
"""
import errno
import fcntl
import os
import stat
import sys


def main(argv):
    if len(argv) != 4:
        raise SystemExit('Expected lock path, Node executable, relay script and transport ID')
    lock_path, node, script, identity = argv
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError('Relay lock must be a regular file')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EAGAIN):
                return 0
            raise
        os.set_inheritable(fd, True)
        os.environ['CLAUDE_VPS_RELAY_LOCK_FD'] = str(fd)
        os.execv(node, [node, script, '--locked-serve', identity])
    finally:
        os.close(fd)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
