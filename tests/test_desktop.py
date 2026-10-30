"""REQ-VERIFY-001: real private bus ownership; never launch a GUI or use host buses."""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import tempfile
import unittest
import zipfile
import zlib
from unittest.mock import patch

RUNNER = Path(__file__).resolve().parents[1] / 'tools/test-desktop.py'
spec = importlib.util.spec_from_file_location('unite_desktop', RUNNER)
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class CandidateArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='unite-candidate-tests-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.archive = self.base / 'accepted.zip'
        self.destination = self.base / 'private-candidate.zip'
        self.metadata = {'uuid': 'unite-next@lucastsudaka.github.io', 'shell-version': ['50', '51']}

    def archive_bytes(self, metadata, compression=zipfile.ZIP_STORED, year=2020):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w', compression=compression) as archive:
            archive.comment = b'Original accepted ZIP container'
            for name, payload in [('extension.js', b'export default class Extension {}\n'),
                                  ('metadata.json', metadata)]:
                if payload is None:
                    continue
                entry = zipfile.ZipInfo(name, (year, 2, 3, 4, 5, 6))
                entry.compress_type = compression
                archive.writestr(entry, payload)
        return stream.getvalue()

    def test_both_zip_encodings_and_declared_majors_are_preserved_byte_for_byte(self):
        metadata_bytes = (json.dumps(self.metadata, indent=4) + '\n').encode()
        variants = [self.archive_bytes(metadata_bytes, zipfile.ZIP_STORED, 2020),
                    self.archive_bytes(metadata_bytes, zipfile.ZIP_DEFLATED, 2026)]
        self.assertNotEqual(*variants)
        for index, snapshot in enumerate(variants):
            with self.subTest(variant=index):
                self.archive.write_bytes(snapshot)
                for major in ['50', '51']:
                    destination = self.base / f'candidate-{index}-{major}.zip'
                    metadata, digest = desktop.stage_candidate_archive(self.archive, destination, major)
                    self.assertEqual(destination.read_bytes(), snapshot)
                    self.assertEqual(digest, hashlib.sha256(snapshot).hexdigest())
                    self.assertEqual(metadata, self.metadata)
                    with zipfile.ZipFile(destination) as candidate:
                        self.assertEqual(candidate.read('metadata.json'), metadata_bytes)

    def test_source_is_read_once_and_later_changes_cannot_change_staging_or_fingerprint(self):
        snapshot = self.archive_bytes(json.dumps(self.metadata).encode())
        self.archive.write_bytes(snapshot)
        original_read = Path.read_bytes
        reads = []

        def read_and_change(path):
            data = original_read(path)
            if path == self.archive:
                reads.append(path)
                path.write_bytes(b'Changed after the snapshot was read')
            return data

        with patch.object(Path, 'read_bytes', read_and_change):
            _, digest = desktop.stage_candidate_archive(self.archive, self.destination, '50')
        self.assertEqual(reads, [self.archive])
        self.assertEqual(self.destination.read_bytes(), snapshot)
        self.assertEqual(digest, hashlib.sha256(snapshot).hexdigest())
        self.assertNotEqual(self.archive.read_bytes(), snapshot)

    def test_missing_invalid_or_unsupported_metadata_fails_before_staging(self):
        cases = [None, b'{invalid', b'null', b'[]', b'{}',
                 json.dumps({**self.metadata, 'uuid': 'foreign@example.org'}).encode(),
                 json.dumps({**self.metadata, 'uuid': ''}).encode(),
                 json.dumps({**self.metadata, 'shell-version': '50'}).encode(),
                 json.dumps({**self.metadata, 'shell-version': []}).encode(),
                 json.dumps({**self.metadata, 'shell-version': ['50', '50']}).encode(),
                 json.dumps({**self.metadata, 'shell-version': [50]}).encode(),
                 json.dumps({**self.metadata, 'shell-version': ['50+']}).encode(),
                 json.dumps({**self.metadata, 'shell-version': ['51']}).encode()]
        for metadata in cases:
            with self.subTest(metadata=metadata):
                self.archive.write_bytes(self.archive_bytes(metadata))
                with self.assertRaises(ValueError):
                    desktop.stage_candidate_archive(self.archive, self.destination, '50')
                self.assertFalse(self.destination.exists())
        self.archive.write_bytes(b'Not a ZIP')
        with self.assertRaises(zipfile.BadZipFile):
            desktop.stage_candidate_archive(self.archive, self.destination, '50')
        self.assertFalse(self.destination.exists())

    def test_existing_staging_file_is_preserved(self):
        self.archive.write_bytes(self.archive_bytes(json.dumps(self.metadata).encode()))
        self.destination.write_bytes(b'Existing staging bytes')
        with self.assertRaises(FileExistsError):
            desktop.stage_candidate_archive(self.archive, self.destination, '50')
        self.assertEqual(self.destination.read_bytes(), b'Existing staging bytes')


def bus_call(address, method, *arguments):
    return subprocess.check_output([
        '/usr/bin/gdbus', 'call', '--address', address, '--dest', 'org.freedesktop.DBus',
        '--object-path', '/org/freedesktop/DBus', '--method', f'org.freedesktop.DBus.{method}',
        *arguments], text=True, timeout=5)


def bus_pid(address):
    reply = bus_call(address, 'GetConnectionUnixProcessID', 'org.freedesktop.DBus')
    match = re.fullmatch(r'\(uint32 (\d+),\)\s*', reply)
    if not match:
        raise AssertionError(f'Unexpected native daemon PID reply: {reply}')
    return int(match[1])


class PrivateBusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='unite-bus-tests-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        (self.base / 'runtime').mkdir(mode=0o700)
        self.daemons = []
        native_popen = subprocess.Popen

        def observe(command, *args, **kwargs):
            process = native_popen(command, *args, **kwargs)
            if command[0] == '/usr/bin/dbus-daemon':
                self.daemons.append(process)
            return process

        observer = patch.object(desktop.subprocess, 'Popen', observe)
        observer.start()
        self.addCleanup(observer.stop)
        self.addCleanup(self.assert_owned_children_reaped)

    def assert_owned_children_reaped(self):
        unreaped = [process for process in self.daemons if process.returncode is None]
        # Clean only known owned children even when an assertion exposes a regression.
        for process in unreaped:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=5)
        self.assertEqual(unreaped, [], 'Private bus context retained an owned child')

    def test_private_bus_has_no_activatable_services_and_reaps_on_normal_exit(self):
        with desktop.private_system_bus(self.base) as address:
            self.assertTrue(address.startswith(f'unix:path={self.base}/runtime/system-bus,'))
            self.assertEqual(bus_pid(address), self.daemons[0].pid)
            names = re.findall(r"'([^']+)'", bus_call(address, 'ListActivatableNames'))
            self.assertEqual(names, ['org.freedesktop.DBus'])
        self.assertIsNotNone(self.daemons[0].returncode)

    def test_exception_reaps_private_bus(self):
        with self.assertRaisesRegex(LookupError, 'Injected owner failure'):
            with desktop.private_system_bus(self.base) as address:
                self.assertEqual(bus_pid(address), self.daemons[0].pid)
                raise LookupError('Injected owner failure')
        self.assertIsNotNone(self.daemons[0].returncode)

    def test_failed_native_startup_reaps_its_only_child(self):
        (self.base / 'runtime').rmdir()  # Native daemon cannot bind its requested socket.
        with self.assertRaisesRegex(RuntimeError, 'Private system bus failed to start'):
            with desktop.private_system_bus(self.base):
                self.fail('Failed startup yielded an address')
        self.assertEqual(len(self.daemons), 1)
        self.assertIsNotNone(self.daemons[0].returncode)

    def test_sigterm_owner_reaps_its_private_bus(self):
        # The owner reports only its exact daemon; no host/global process discovery.
        script = f'''import importlib.util, signal, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('desktop', {str(RUNNER)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
signal.signal(signal.SIGTERM, lambda signum, frame: (_ for _ in ()).throw(SystemExit(128 + signum)))
with tempfile.TemporaryDirectory(prefix='unite-bus-owner-') as directory:
    base = Path(directory)
    (base / 'runtime').mkdir(mode=0o700)
    with module.private_system_bus(base) as address:
        print(address, flush=True)
        signal.pause()
'''
        owner = subprocess.Popen(['/usr/bin/python3', '-c', script], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        daemon_fd = None
        try:
            self.assertTrue(select.select([owner.stdout], [], [], 5)[0], 'Owner startup deadline')
            address = owner.stdout.readline().strip()
            self.assertTrue(address.startswith('unix:path='), address)
            daemon_pid = bus_pid(address)
            daemon_fd = os.pidfd_open(daemon_pid)
            owner.send_signal(signal.SIGTERM)
            output, errors = owner.communicate(timeout=10)
            self.assertEqual(owner.returncode, 143, (output, errors))
            self.assertTrue(select.select([daemon_fd], [], [], 0)[0], 'Private daemon survived owner')
            with self.assertRaises(ProcessLookupError):
                os.kill(daemon_pid, 0)
        finally:
            if owner.poll() is None:
                os.killpg(owner.pid, signal.SIGKILL)
                owner.communicate(timeout=5)
            if daemon_fd is not None:
                if not select.select([daemon_fd], [], [], 0)[0]:
                    signal.pidfd_send_signal(daemon_fd, signal.SIGKILL)
                    self.assertTrue(select.select([daemon_fd], [], [], 5)[0], 'Owned daemon cleanup deadline')
                os.close(daemon_fd)


def png(width=2, height=1):
    def chunk(kind, contents):
        return struct.pack('>I', len(contents)) + kind + contents + struct.pack('>I', zlib.crc32(kind + contents))
    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    pixels = (b'\0' + b'\x11\x22\x33\xff' * width) * height
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


class ScreenshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='unite-capture-tests-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'private-stage'
        self.source.mkdir()
        self.destination = self.base / 'public-captures'
        for name in ['screenshot.png', 'settings.png']:
            (self.source / name).write_bytes(png())

    def test_complete_native_captures_publish_exact_bytes_and_public_safe_manifest(self):
        manifest = desktop.publish_screenshots(self.source, self.destination, 'a' * 64, 'GNOME Shell 50.5')
        self.assertEqual(set(path.name for path in self.destination.iterdir()),
                         {'screenshot.png', 'settings.png', 'captures.json'})
        for name in ['screenshot.png', 'settings.png']:
            self.assertEqual((self.destination / name).read_bytes(), png())
            self.assertEqual((manifest['files'][name]['width'], manifest['files'][name]['height']), (2, 1))
        self.assertEqual(manifest['source_archive_sha256'], 'a' * 64)
        self.assertNotIn(str(self.base), (self.destination / 'captures.json').read_text())

    def test_existing_capture_directory_is_never_replaced(self):
        self.destination.mkdir()
        foreign = self.destination / 'existing.png'
        foreign.write_bytes(b'foreign bytes')
        with self.assertRaises(FileExistsError):
            desktop.publish_screenshots(self.source, self.destination, 'a' * 64, 'GNOME Shell 50.5')
        self.assertEqual(foreign.read_bytes(), b'foreign bytes')
        self.assertEqual(list(self.destination.iterdir()), [foreign])

    def test_invalid_or_unexpected_capture_outputs_fail_before_publication(self):
        original = png()
        corrupt = bytearray(original)
        corrupt[20] ^= 1
        cases = [('bad signature', b'not a PNG'), ('bad CRC', bytes(corrupt)),
                 ('truncated', original[:-1]), ('trailing data', original + b'junk'), ('empty dimensions', png(0, 1))]
        for name, contents in cases:
            with self.subTest(case=name):
                (self.source / 'settings.png').write_bytes(contents)
                with self.assertRaises(ValueError):
                    desktop.publish_screenshots(self.source, self.destination, 'a' * 64, 'GNOME Shell 50.5')
                self.assertFalse(self.destination.exists())
        (self.source / 'settings.png').write_bytes(original)
        unexpected = self.source / 'private-handshake.json'
        unexpected.write_text('{}')
        with self.assertRaises(ValueError):
            desktop.publish_screenshots(self.source, self.destination, 'a' * 64, 'GNOME Shell 50.5')
        unexpected.unlink()
        (self.source / 'settings.png').unlink()
        (self.source / 'settings.png').symlink_to(self.source / 'screenshot.png')
        with self.assertRaises(ValueError):
            desktop.publish_screenshots(self.source, self.destination, 'a' * 64, 'GNOME Shell 50.5')
        self.assertFalse(self.destination.exists())

    def test_publication_io_failure_removes_only_its_new_output(self):
        native_open = Path.open

        def fail_manifest(path, *args, **kwargs):
            if path.name == 'captures.json':
                raise OSError('Injected capture publication failure')
            return native_open(path, *args, **kwargs)

        with patch.object(Path, 'open', fail_manifest):
            with self.assertRaisesRegex(OSError, 'Injected capture publication failure'):
                desktop.publish_screenshots(self.source, self.destination, 'a' * 64, 'GNOME Shell 50.5')
        self.assertFalse(self.destination.exists())
        self.assertEqual((self.source / 'screenshot.png').read_bytes(), png())

    def test_native_capture_handshake_handles_ready_races_cancellation_invalid_data_and_deadline(self):
        module = (RUNNER.parents[1] / 'tests/screenshot-protocol.mjs').as_uri()
        script = self.base / 'protocol.mjs'
        script.write_text("""import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import {waitForJson, writeJson} from '""" + module + """'
const directory = Gio.File.new_for_path(ARGV[0])
const loop = new GLib.MainLoop(null, false)
let failure = null
function check(value, message) { if (!value) throw new Error(message) }
async function rejects(promise, phrase) {
  let observed
  try { await promise } catch(error) { observed=error.message }
  check(observed?.includes(phrase), `Expected ${phrase}, observed ${observed}`)
}
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
  ;(async () => {
    const early=directory.get_child('early.json')
    writeJson(early,{token:'expected'})
    check((await waitForJson(early,v=>v.token==='expected','early ready')).token==='expected','Preexisting ready lost')
    const later=directory.get_child('later.json')
    const pending=waitForJson(later,v=>v.token==='expected','later ready')
    GLib.idle_add(GLib.PRIORITY_DEFAULT,()=>{writeJson(later,{token:'expected'});return GLib.SOURCE_REMOVE})
    await pending
    await rejects(waitForJson(early,v=>v.token==='stale','wrong token'),'Invalid wrong token')
    const cancellable=new Gio.Cancellable()
    const cancelled=waitForJson(directory.get_child('never.json'),()=>true,'cancelled ready',cancellable)
    cancellable.cancel()
    await rejects(cancelled,'Cancelled cancelled ready')
    await rejects(waitForJson(directory.get_child('absent.json'),()=>true,'missing ack',null,20),'Timed out acquiring missing ack')
    const invalid=directory.get_child('invalid.json')
    invalid.replace_contents('{bad',null,false,Gio.FileCreateFlags.PRIVATE,null)
    await rejects(waitForJson(invalid,()=>true,'invalid ready'),'JSON')
    print('SCREENSHOT_PROTOCOL_PASS scenarios=6')
  })().catch(error=>{failure=error;printerr(error.stack)}).finally(()=>loop.quit())
  return GLib.SOURCE_REMOVE
})
await loop.runAsync()
if(failure) throw failure
""")
        result = subprocess.run(['gjs', '-m', str(script), str(self.source)], capture_output=True,
                                text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SCREENSHOT_PROTOCOL_PASS scenarios=6', result.stdout)

    def test_screenshots_are_rejected_for_partial_preferences_scenario(self):
        result = subprocess.run(['/usr/bin/python3', str(RUNNER), '--major', '50', '--scenario', 'preferences',
                                 '--screenshots-dir', str(self.destination)], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('--screenshots-dir requires --scenario full', result.stderr)
        self.assertFalse(self.destination.exists())


class ConflictFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='unite-conflict-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'fixture'
        self.source.mkdir()
        (self.source / 'metadata.json').write_text(json.dumps({'uuid': 'unite@hardpixel.eu'}))
        (self.source / 'extension.js').write_text('export default class Fixture {}\n')
        schemas = self.source / 'schemas'
        schemas.mkdir()
        (schemas / 'fixture.gschema.xml').write_text('''<schemalist>
<schema id="org.example.UniteNextConflictFixture" path="/org/example/UniteNextConflictFixture/">
<key name="sentinel" type="s"><default>'preserved'</default></key>
</schema></schemalist>''')
        self.data = self.base / 'private-data'
        self.data.mkdir()

    def test_upstream_fixture_compiles_only_inside_private_installation(self):
        destination = desktop.install_conflict_fixture(self.source, self.data, 'fork@example.org')
        self.assertEqual(destination, self.data / 'gnome-shell/extensions/unite@hardpixel.eu')
        self.assertTrue((destination / 'schemas/gschemas.compiled').is_file())
        self.assertFalse((self.source / 'schemas/gschemas.compiled').exists())
        self.assertEqual((destination / 'extension.js').read_bytes(), (self.source / 'extension.js').read_bytes())

    def test_invalid_identity_and_symbolic_fixture_fail_before_installation(self):
        with self.assertRaisesRegex(ValueError, 'independent fork UUID'):
            desktop.install_conflict_fixture(self.source, self.data, 'unite@hardpixel.eu')
        (self.source / 'metadata.json').write_text(json.dumps({'uuid': 'wrong@example.org'}))
        with self.assertRaisesRegex(ValueError, 'upstream UUID'):
            desktop.install_conflict_fixture(self.source, self.data, 'fork@example.org')
        (self.source / 'metadata.json').write_text(json.dumps({'uuid': 'unite@hardpixel.eu'}))
        (self.source / 'linked.js').symlink_to(self.source / 'extension.js')
        with self.assertRaisesRegex(ValueError, 'regular native sources'):
            desktop.install_conflict_fixture(self.source, self.data, 'fork@example.org')
        self.assertEqual(list(self.data.iterdir()), [])

    def test_invalid_schema_and_existing_installation_are_visible_failures(self):
        (self.source / 'schemas/fixture.gschema.xml').write_text('<invalid')
        with self.assertRaises(subprocess.CalledProcessError):
            desktop.install_conflict_fixture(self.source, self.data, 'fork@example.org')
        destination = self.data / 'gnome-shell/extensions/unite@hardpixel.eu'
        existing = destination / 'extension.js'
        before = existing.read_bytes()
        with self.assertRaises(FileExistsError):
            desktop.install_conflict_fixture(self.source, self.data, 'fork@example.org')
        self.assertEqual(existing.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
