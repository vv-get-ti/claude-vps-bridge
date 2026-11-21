"""Read live relay state without attaching or becoming a transport client."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import os
import re
import socket
import stat
import struct

from bridge_paths import ROOT
from session_files import SessionError, children, directory
from session_lease import UUID, available

RUN = ROOT / 'run'
LIMIT = 256


def read_frame(stream):
    raw = stream.readline(4097)
    if not raw.endswith(b'\n') or len(raw) > 4096:
        raise ValueError('Invalid relay frame')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('Invalid relay frame')
    return value


def timestamp(value):
    if isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value):
        try:
            datetime.fromisoformat(value.replace('Z', '+00:00'))
            return value
        except ValueError:
            pass
    return None


def observe(relay_id):
    name = relay_id + '.sock'
    lock = RUN / (name + '.owner.lock')
    try:
        with directory(RUN) as directory_fd, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or available(lock, shared=True):
                return None
            peer.settimeout(1.5)
            peer.connect(f'/proc/self/fd/{directory_fd}/{name}')
            pid, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            with peer.makefile('rb') as stream:
                hello = read_frame(stream).get('hello')
                if not isinstance(hello, dict) or uid != os.getuid() or hello.get('pid') != pid:
                    return None
                epoch, protocol = hello.get('epoch'), hello.get('protocol', 2)
                if not isinstance(epoch, str) or not UUID.fullmatch(epoch) or type(protocol) is not int or protocol < 1:
                    return None
                try:
                    peer.sendall(b'{"admin":"status"}\n')
                    details = read_frame(stream).get('status')
                    if not isinstance(details, dict):
                        details = {}
                except (OSError, ValueError):
                    details = {}
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or available(lock, shared=True):
                return None
    except (OSError, SessionError, ValueError):
        return None
    version = details.get('bridgeVersion')
    version = version if isinstance(version, str) and re.fullmatch(r'\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][a-zA-Z0-9.-]{1,64})?', version) else None
    def count(key):
        value = details.get(key)
        return value if type(value) is int and 0 <= value <= 1_000_000 else None
    row = {'id': relay_id, 'startedAt': timestamp(details.get('startedAt')), 'bridgeVersion': version,
           'protocol': protocol, 'sessions': count('sessions'), 'activeRequests': count('activeRequests'),
           'idleSince': timestamp(details.get('idleSince')), 'current': None,
           'expiresAt': timestamp(details.get('expiresAt'))}
    row['revision'] = hashlib.sha256(json.dumps([epoch, row], sort_keys=True).encode()).hexdigest()
    row['_epoch'] = epoch
    return row


def list_relays():
    names = [name[:-5] for name in children(RUN) if name.endswith('.sock') and UUID.fullmatch(name[:-5])]
    with ThreadPoolExecutor(max_workers=8) as workers:
        observed = list(workers.map(observe, names[:LIMIT]))
    rows = [row for row in observed if row is not None]
    warnings = []
    if len(observed) != len(rows) or any(row['sessions'] is None or row['activeRequests'] is None for row in rows):
        warnings.append({'code': 'STATE_UNKNOWN', 'message': '部分 relay 已退出、无法验证或尚未提供会话与请求计数。'})
    if len(names) > LIMIT:
        warnings.append({'code': 'RELAY_LIST_TRUNCATED', 'message': 'relay 数量超过本次可探测上限。'})
    return {'relays': rows, 'warnings': warnings}
