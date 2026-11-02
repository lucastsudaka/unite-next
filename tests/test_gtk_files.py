"""Private-state GJS verification for GTK file publication and failure cleanup."""
import os
import base64
import ctypes
import importlib.util
import json
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'unite-next@lucastsudaka.github.io/gtk-files.py'
spec = importlib.util.spec_from_file_location('unite_gtk_files', HELPER)
gtk_files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gtk_files)


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
        self.assertIn("GTK_FILE_TESTS_PASS scenarios=11", result.stdout)

    def test_displaced_inode_survives_late_writes_through_an_open_descriptor(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-open-fd-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original user CSS\r\n')
            target.chmod(0o640)
            with target.open('ab', buffering=0) as writer:
                result = gtk_files.replace(target, target.read_bytes(), b'Owned and original CSS\r\n')
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
            native_exchange = gtk_files.exchange
            exchanges = 0

            def intervene(first, second):
                nonlocal exchanges
                exchanges += 1
                if exchanges == 1:
                    target.write_bytes(b'First foreign version')
                elif exchanges == 2:
                    # An editor can also update the destination during rollback.
                    target.write_bytes(b'Second foreign version')
                native_exchange(first, second)

            with patch.object(gtk_files, 'exchange', intervene):
                with self.assertRaisesRegex(RuntimeError, 'ownership conflict.*retained at'):
                    gtk_files.replace(target, b'Original', b'Owned original')
            versions = [path.read_bytes() for path in (target.parent / '.unite-next-gtk-recovery').iterdir()]
            self.assertEqual(target.read_bytes(), b'First foreign version')
            self.assertIn(b'Second foreign version', versions)

    def test_uncertain_exchange_failure_preserves_target_and_recovery(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-exchange-error-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            with patch.object(gtk_files, 'exchange', side_effect=OSError('Unsupported exchange')):
                with self.assertRaisesRegex(RuntimeError, 'Unsupported exchange.*recovery retained at'):
                    gtk_files.replace(target, b'Original', b'Owned original')
            self.assertEqual(target.read_bytes(), b'Original')
            self.assertEqual([path.read_bytes() for path in
                              (target.parent / '.unite-next-gtk-recovery').iterdir()], [b'Owned original'])

    def test_interrupt_after_native_exchange_does_not_unlink_the_displaced_inode(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-interrupt-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            native_exchange = gtk_files.exchange

            def interrupt(first, second):
                native_exchange(first, second)
                raise KeyboardInterrupt('Injected interruption after syscall')

            with patch.object(gtk_files, 'exchange', interrupt):
                with self.assertRaisesRegex(RuntimeError, 'interruption.*recovery retained at'):
                    gtk_files.replace(target, b'Original', b'Owned original')
            self.assertEqual(target.read_bytes(), b'Owned original')
            self.assertEqual([path.read_bytes() for path in
                              (target.parent / '.unite-next-gtk-recovery').iterdir()], [b'Original'])

    def test_existing_user_xattr_and_group_survive_publication(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-metadata-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            os.setxattr(target, 'user.unite-test', b'Foreign metadata')
            original = target.stat()
            result = gtk_files.replace(target, b'Original', b'Owned original')
            self.assertEqual(os.getxattr(target, 'user.unite-test'), b'Foreign metadata')
            self.assertEqual((target.stat().st_uid, target.stat().st_gid), (original.st_uid, original.st_gid))
            self.assertEqual(os.getxattr(result['recovery'], 'user.unite-test'), b'Foreign metadata')

    def test_failure_after_exchange_retains_both_versions_and_exposes_recovery(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-durability-error-') as directory:
            target = Path(directory) / 'gtk.css'
            target.write_bytes(b'Original')
            with patch.object(gtk_files, 'sync_directory', side_effect=OSError('Injected sync error')):
                with self.assertRaisesRegex(RuntimeError, 'sync error.*recovery retained at'):
                    gtk_files.replace(target, b'Original', b'Owned original')
            self.assertEqual(target.read_bytes(), b'Owned original')
            versions = list((target.parent / '.unite-next-gtk-recovery').iterdir())
            self.assertEqual([path.read_bytes() for path in versions], [b'Original'])

    def test_user_symlink_is_preserved_and_its_referent_is_updated(self):
        with tempfile.TemporaryDirectory(prefix='unite-gtk-symlink-') as directory:
            target = Path(directory) / 'user.css'
            target.write_bytes(b'Original')
            link = Path(directory) / 'gtk.css'
            link.symlink_to(target.name)
            result = gtk_files.replace(link, b'Original', b'Owned original')
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.read_bytes(), b'Owned original')
            self.assertEqual(Path(result['recovery']).read_bytes(), b'Original')

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
            request = json.dumps({'path': str(target),
                                  'expected': base64.b64encode(original).decode(),
                                  'updated': base64.b64encode(b'/* owned */\n' + original).decode()})
            child = subprocess.Popen(['/usr/bin/python3', '-B', str(HELPER)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True)
            output = []
            worker = threading.Thread(target=lambda: output.append(child.communicate(request)), daemon=True)
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
