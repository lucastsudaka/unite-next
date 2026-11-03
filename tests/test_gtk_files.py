"""Private-state GJS verification for GTK file publication and failure cleanup."""
import os
import base64
import ctypes
import json
from pathlib import Path
import select
import signal
import stat
import struct
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'tests/gtk-file-transaction.mjs'


def request_file(path, expected, updated, fault=None):
    request = Path(path).parent / 'transaction.json'
    request.write_text(json.dumps({'path': str(path),
                                   'expected': base64.b64encode(expected).decode(),
                                   'updated': base64.b64encode(updated).decode(),
                                   'fault': fault}))
    return request


def replace(path, expected, updated, fault=None):
    result = subprocess.run(['gjs', '-m', str(HELPER), str(request_file(path, expected, updated, fault))],
                            text=True, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


class GtkFileTests(unittest.TestCase):
    def test_native_private_file_scenarios(self):
        with tempfile.TemporaryDirectory(prefix="unite-gtk-files-") as directory:
            env = {**os.environ, "HOME": directory, "UNITE_PRIVATE_TEST": "1", "GSETTINGS_BACKEND": "memory"}
            for kind in ("CONFIG", "CACHE", "DATA", "RUNTIME"):
                path = Path(directory) / kind.lower()
                path.mkdir(mode=0o700)
                env[f"XDG_{kind}_HOME" if kind != "RUNTIME" else "XDG_RUNTIME_DIR"] = str(path)
            result = subprocess.run(
                ["gjs", "-m", str(ROOT / "tests/test-gtk-files.js")],
                cwd=ROOT, env=env, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("GTK_FILE_TESTS_PASS scenarios=14", result.stdout)

    def test_displaced_inode_survives_late_writes_through_an_open_descriptor(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-open-fd-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original user CSS\r\n')
            target.chmod(0o640)
            with target.open('ab', buffering=0) as writer:
                result = replace(target, target.read_bytes(), b'Owned and original CSS\r\n')
                writer.write(b'Late user edit\n')
            recovery = Path(result['recovery'])
            self.assertEqual(target.read_bytes(), b'Owned and original CSS\r\n')
            self.assertEqual(recovery.read_bytes(), b'Original user CSS\r\nLate user edit\n')
            self.assertEqual(recovery.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)

    def test_concurrent_edit_after_staging_is_restored_and_reported(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-exchange-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            with self.assertRaisesRegex(RuntimeError, 'ownership conflict.*retained at'):
                replace(target, b'Original', b'Owned original', 'concurrent')
            versions = [path.read_bytes() for path in (target.parent / '.unite-next-gtk-recovery').iterdir()]
            self.assertEqual(target.read_bytes(), b'First foreign version')
            self.assertIn(b'Second foreign version', versions)

    def test_uncertain_exchange_failure_preserves_target_and_recovery(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-exchange-error-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            with self.assertRaisesRegex(RuntimeError, 'Unsupported exchange.*recovery retained at'):
                replace(target, b'Original', b'Owned original', 'unsupported')
            self.assertEqual(target.read_bytes(), b'Original')
            self.assertEqual([path.read_bytes() for path in
                              (target.parent / '.unite-next-gtk-recovery').iterdir()], [b'Owned original'])

    def test_interrupt_after_native_exchange_does_not_unlink_the_displaced_inode(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-interrupt-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            with self.assertRaisesRegex(RuntimeError, 'interruption.*recovery retained at'):
                replace(target, b'Original', b'Owned original', 'after-exchange')
            self.assertEqual(target.read_bytes(), b'Owned original')
            self.assertEqual([path.read_bytes() for path in
                              (target.parent / '.unite-next-gtk-recovery').iterdir()], [b'Original'])

    def test_existing_user_xattr_and_group_survive_publication(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-metadata-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            os.setxattr(target, 'user.unite-test', b'Foreign metadata')
            original = target.stat()
            result = replace(target, b'Original', b'Owned original')
            self.assertEqual(os.getxattr(target, 'user.unite-test'), b'Foreign metadata')
            self.assertEqual((target.stat().st_uid, target.stat().st_gid), (original.st_uid, original.st_gid))
            self.assertEqual(os.getxattr(result['recovery'], 'user.unite-test'), b'Foreign metadata')

    def test_failure_after_exchange_retains_both_versions_and_exposes_recovery(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-durability-error-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            with self.assertRaisesRegex(RuntimeError, 'sync error.*recovery retained at'):
                replace(target, b'Original', b'Owned original', 'sync')
            self.assertEqual(target.read_bytes(), b'Owned original')
            versions = list((target.parent / '.unite-next-gtk-recovery').iterdir())
            self.assertEqual([path.read_bytes() for path in versions], [b'Original'])

    def test_user_symlink_is_preserved_and_its_referent_is_updated(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-symlink-') as directory:
            target = Path(directory) / 'user.css'
            target.write_bytes(b'Original')
            link = Path(directory) / 'gtk.css'
            link.symlink_to(target.name)
            result = replace(link, b'Original', b'Owned original')
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.read_bytes(), b'Owned original')
            self.assertEqual(Path(result['recovery']).read_bytes(), b'Original')

    def test_posix_acl_binary_xattrs_mode_and_timestamps_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-acl-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            entries = [(1, 6, 0xFFFFFFFF), (2, 4, 60000), (4, 0, 0xFFFFFFFF),
                       (16, 4, 0xFFFFFFFF), (32, 0, 0xFFFFFFFF)]
            acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
            os.setxattr(target, 'system.posix_acl_access', acl)
            os.setxattr(target, 'user.binary', b'\0\xff\x01metadata\0')
            os.utime(target, ns=(1600000000123456789, 1600000000987654321))
            original = target.stat()
            result = replace(target, b'Original', b'Owned original')
            for path in (target, Path(result['recovery'])):
                self.assertEqual(os.getxattr(path, 'system.posix_acl_access'), acl)
                self.assertEqual(os.getxattr(path, 'user.binary'), b'\0\xff\x01metadata\0')
                self.assertEqual((path.stat().st_uid, path.stat().st_gid, path.stat().st_mode),
                                 (original.st_uid, original.st_gid, original.st_mode))
                self.assertEqual(path.stat().st_mtime_ns, original.st_mtime_ns)

    def test_inherited_stage_acl_fails_before_exchange_without_extra_grants(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-inherited-acl-') as directory:
            root = Path(directory)
            target = root / 'gtk.css'
            target.write_bytes(b'Original')
            target.chmod(0o640)
            original = target.stat()
            attributes = os.listxattr(target)
            entries = [(1, 7, 0xFFFFFFFF), (2, 6, 60000), (4, 5, 0xFFFFFFFF),
                       (16, 7, 0xFFFFFFFF), (32, 0, 0xFFFFFFFF)]
            acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
            os.setxattr(root, 'system.posix_acl_default', acl)
            with self.assertRaisesRegex(RuntimeError, 'staging would introduce metadata.*posix_acl_access'):
                replace(target, b'Original', b'Owned original')
            self.assertEqual(target.read_bytes(), b'Original')
            self.assertEqual(os.listxattr(target), attributes)
            self.assertEqual(target.stat().st_ino, original.st_ino)
            self.assertEqual(target.stat().st_mode, original.st_mode)
            self.assertEqual(list((root / '.unite-next-gtk-recovery').iterdir()), [])

    def test_symlink_parent_components_are_resolved_without_replacing_the_link(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-link-chain-') as directory:
            root = Path(directory)
            (root / 'real/sub').mkdir(parents=True)
            (root / 'alias').symlink_to('real/sub', target_is_directory=True)
            target = root / 'real/user.css'
            target.write_bytes(b'Original')
            link = root / 'gtk.css'
            link.symlink_to('alias/../user.css')
            result = replace(link, b'Original', b'Owned original')
            self.assertEqual(os.readlink(link), 'alias/../user.css')
            self.assertEqual(target.read_bytes(), b'Owned original')
            self.assertEqual(Path(result['recovery']).parent, target.parent / '.unite-next-gtk-recovery')

    def test_foreign_recovery_symlink_is_not_followed_or_modified(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-recovery-link-') as directory:
            root = Path(directory)
            target = root / 'gtk.css'
            target.write_bytes(b'Original')
            foreign = root / 'foreign'
            foreign.mkdir(mode=0o700)
            (root / '.unite-next-gtk-recovery').symlink_to(foreign)
            with self.assertRaisesRegex(RuntimeError, 'owned and private'):
                replace(target, b'Original', b'Owned original')
            self.assertEqual(target.read_bytes(), b'Original')
            self.assertEqual(list(foreign.iterdir()), [])

    def test_nonregular_displaced_inodes_are_retained_without_blocking_or_following(self):
        for fault in ('fifo', 'symlink'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(prefix='unite-gtk-nonregular-') as directory:
                root = Path(directory)
                target = root / 'gtk.css'
                target.write_bytes(b'Original')
                foreign = root / 'foreign.css'
                foreign.write_bytes(b'Unrelated foreign data')
                os.utime(foreign, ns=(1600000000123456789, 1600000000987654321))
                access = foreign.stat().st_atime_ns
                with self.assertRaisesRegex(RuntimeError, 'Not a regular GTK stylesheet.*recovery retained'):
                    replace(target, b'Original', b'Owned original', fault)
                self.assertEqual(target.read_bytes(), b'Owned original')
                retained = list((root / '.unite-next-gtk-recovery').iterdir())
                self.assertEqual(len(retained), 1)
                if fault == 'fifo':
                    self.assertTrue(stat.S_ISFIFO(retained[0].lstat().st_mode))
                else:
                    self.assertEqual(os.readlink(retained[0]), 'foreign.css')
                self.assertEqual(foreign.stat().st_atime_ns, access, 'Foreign symlink referent was read')

    def test_nofollow_nonblock_read_closes_the_type_check_to_open_race(self):
        for fault in ('read-race-fifo', 'read-race-symlink'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(prefix='unite-gtk-read-race-') as directory:
                root = Path(directory)
                target = root / 'gtk.css'
                target.write_bytes(b'Original')
                (root / 'foreign.css').write_bytes(b'Unrelated foreign data')
                with self.assertRaises(RuntimeError):
                    replace(target, b'Original', b'Owned original', fault)
                self.assertFalse((root / '.unite-next-gtk-recovery').exists(), 'Failed read started publication')
                if fault.endswith('fifo'):
                    self.assertTrue(stat.S_ISFIFO(target.lstat().st_mode))
                else:
                    self.assertEqual(os.readlink(target), 'foreign.css')

    def test_invalid_utf8_fails_before_any_exchange_without_replacing_bytes(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-invalid-utf8-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Foreign\xff\x00CSS')
            with self.assertRaises(RuntimeError):
                replace(target, target.read_bytes(), b'Owned')
            self.assertEqual(target.read_bytes(), b'Foreign\xff\x00CSS')
            self.assertFalse((target.parent / '.unite-next-gtk-recovery').exists())

    def test_initial_fifo_is_rejected_without_opening_or_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-initial-fifo-') as directory:
            target = Path(directory) / 'gtk.css'
            os.mkfifo(target)
            with self.assertRaisesRegex(RuntimeError, 'Not a regular GTK stylesheet'):
                replace(target, b'', b'Owned')
            self.assertTrue(stat.S_ISFIFO(target.lstat().st_mode))
            self.assertFalse((target.parent / '.unite-next-gtk-recovery').exists())

    def test_multiple_leading_boms_and_embedded_bom_preserve_exact_bytes(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-bom-') as directory:
            target = Path(directory) / 'gtk.css'
            original = b'\xef\xbb\xbf' * 2 + b'/* user\xef\xbb\xbf */\r\n'
            target.write_bytes(original)
            result = replace(target, original, b'/* owned */\n' + original)
            self.assertEqual(target.read_bytes(), b'/* owned */\n' + original)
            self.assertEqual(Path(result['recovery']).read_bytes(), original)

    def test_native_staging_race_keeps_concurrent_bytes_without_etag_assumptions(self):
        """A real writer intervenes after native staging starts; no product mock."""
        with tempfile.TemporaryDirectory(prefix='unite-gtk-native-race-') as directory:
            target = Path(directory) / 'gtk.css'
            original = b'/* private fixture */\n' * 800000
            target.write_bytes(original)
            recovery = target.parent / '.unite-next-gtk-recovery'
            recovery.mkdir(mode=0o700)
            libc = ctypes.CDLL(None, use_errno=True)
            libc.inotify_init1.argtypes = [ctypes.c_int]
            libc.inotify_init1.restype = ctypes.c_int
            libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            libc.inotify_add_watch.restype = ctypes.c_int
            watch = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
            self.assertGreaterEqual(watch, 0)
            self.assertGreaterEqual(libc.inotify_add_watch(watch, os.fsencode(recovery), 0x100), 0)
            request = request_file(target, original, b'/* owned */\n' + original)
            child = subprocess.Popen(['gjs', '-m', str(HELPER), str(request)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            output = []
            worker = threading.Thread(target=lambda: output.append(child.communicate()), daemon=True)
            worker.start()
            try:
                self.assertTrue(select.select([watch], [], [], 10)[0], 'Native staging did not start')
                os.read(watch, 4096)
                os.kill(child.pid, signal.SIGSTOP)
                os.waitpid(child.pid, os.WUNTRACED)
                with target.open('ab', buffering=0) as writer:
                    writer.write(b'/* FOREIGN_CONCURRENT_EDIT */\n')
                    os.fsync(writer.fileno())
                os.kill(child.pid, signal.SIGCONT)
                worker.join(10)
                self.assertFalse(worker.is_alive(), 'Replacement did not finish')
                self.assertEqual(child.returncode, 1, output)
                self.assertIn('ownership conflict', output[0][1])
                self.assertEqual(target.read_bytes(), original + b'/* FOREIGN_CONCURRENT_EDIT */\n')
                self.assertTrue(list(recovery.iterdir()), 'Displaced version was discarded')
            finally:
                if child.poll() is None:
                    child.kill()
                worker.join(5)
                child.wait(timeout=5)
                os.close(watch)


if __name__ == "__main__":
    unittest.main()
