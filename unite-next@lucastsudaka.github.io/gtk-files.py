#!/usr/bin/python3
"""Recoverable GTK stylesheet replacement; deliberately not a filesystem CAS.

An atomic exchange retains the actual displaced inode, including writes through
already-open descriptors. Recovery files are never automatically deleted. No
advisory lock or pre-replacement read can protect against an unrelated editor.
The caller supervises this synchronous helper independently of the Shell loop.
"""
import base64
import ctypes
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile


def exchange(first, second):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(first), -100, os.fsencode(second), 2):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(second))


def read_regular(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f'Not a regular GTK stylesheet: {path}')
        return stream.read(), info


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def replace(path, expected, updated):
    # Preserve a user-managed gtk.css symlink; operate on its current referent.
    target = Path(os.path.realpath(path))
    original, info = read_regular(target)
    if original != expected:
        raise ValueError(f'GTK stylesheet ownership conflict before replacement: {path}')
    recovery = target.parent / '.unite-next-gtk-recovery'
    try:
        recovery.mkdir(mode=0o700)
    except FileExistsError:
        pass
    directory_info = recovery.lstat()
    if (not stat.S_ISDIR(directory_info.st_mode) or directory_info.st_uid != os.getuid() or
            stat.S_IMODE(directory_info.st_mode) != 0o700):
        raise ValueError(f'GTK recovery directory must be owned and private: {recovery}')
    descriptor, name = tempfile.mkstemp(prefix='gtk.css-', suffix='.css', dir=recovery)
    retained = False
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(updated)
            stream.flush()
            # Match the original owner/group and filesystem metadata, including
            # ACL/user xattrs, before publication; failure leaves gtk.css intact.
            staged = os.fstat(stream.fileno())
            if (staged.st_uid, staged.st_gid) != (info.st_uid, info.st_gid):
                os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            shutil.copystat(target, name, follow_symlinks=False)
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            os.fsync(stream.fileno())
        # Once publication may have begun, no exception (including a Python
        # interrupt between syscall return and assignment) may unlink this path.
        retained = True
        exchange(name, target)
        # The inode at name is the version actually replaced, not a stale copy.
        # Keep it even on success: an editor may still hold a writable descriptor.
        sync_directory(recovery)
        sync_directory(target.parent)
        displaced, _ = read_regular(name)
        if displaced != expected:
            # Each exchange preserves both versions. A further external update
            # may now be at target; retain it too and never claim perfect rollback.
            exchange(name, target)
            sync_directory(recovery)
            sync_directory(target.parent)
            raise ValueError(f'GTK stylesheet ownership conflict; displaced version returned to {target}; '
                             f'concurrent/published version retained at {name}')
        return {'recovery': name}
    except BaseException as error:
        if retained:
            raise RuntimeError(f'{error}; GTK recovery retained at {name}') from error
        raise
    finally:
        if not retained:
            os.unlink(name)


def main():
    request = json.load(sys.stdin)
    if (not isinstance(request, dict) or set(request) != {'path', 'expected', 'updated'} or
            not isinstance(request['path'], str) or not os.path.isabs(request['path'])):
        raise ValueError('Invalid GTK replacement request')
    expected, updated = (base64.b64decode(request[key], validate=True) for key in ('expected', 'updated'))
    print(json.dumps(replace(request['path'], expected, updated)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
