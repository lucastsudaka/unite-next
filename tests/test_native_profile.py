"""REQ-VERIFY-001: explicit native profiles and truthful aggregate receipts."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_profile', ROOT / 'tools/native-profile.py')
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)
IMAGE = 'sha256:' + 'a' * 64
DIGEST = 'b' * 64


def transcript(major='50', scenario='full', *, result=None, cleanup=None):
    marker = 'UNITE_DESKTOP_PASS ' if scenario == 'full' else 'UNITE_CONFLICT_PASS '
    result = result or {'source_archive_sha256': DIGEST, 'native': f'GNOME Shell {profile.VERSIONS[major]}',
                        'scenario': scenario, 'exit': 0, 'timeout': False, 'unexpected_diagnostics': [],
                        'screenshot_error': None}
    cleanup = cleanup or {'scope': 'linux_subreaper', 'remaining': []}
    return marker + '{"scenarios": ["native observed expectation"]}\n' + json.dumps(result) + '\n' + \
        'UNITE_PROCESS_CLEANUP ' + json.dumps(cleanup) + '\n'


class NativeReceiptTests(unittest.TestCase):
    def test_all_four_native_results_require_the_same_exact_candidate(self):
        for major in ('50', '51'):
            for scenario in ('full', 'conflict'):
                with self.subTest(major=major, scenario=scenario):
                    result = profile.validate_run({'exit': 0, 'timeout': False},
                                                  transcript(major, scenario), major, scenario, DIGEST)
                    self.assertEqual(result['result']['source_archive_sha256'], DIGEST)
                    self.assertEqual(result['cleanup']['remaining'], [])

    def test_bad_native_results_are_never_converted_to_acceptance(self):
        original = json.loads(transcript().splitlines()[1])
        for key, value in [('source_archive_sha256', 'c' * 64), ('native', 'GNOME Shell 49.9'),
                           ('scenario', 'conflict'), ('exit', 1), ('exit', False), ('timeout', True),
                           ('unexpected_diagnostics', ['actual failure']), ('screenshot_error', 'blank capture')]:
            with self.subTest(key=key, value=value):
                changed = {**original, key: value}
                with self.assertRaises(ValueError):
                    profile.validate_run({'exit': 0, 'timeout': False}, transcript(result=changed), '50', 'full', DIGEST)
        for record in [{'exit': 1, 'timeout': False}, {'exit': None, 'timeout': False},
                       {'exit': False, 'timeout': False}, {'exit': 0, 'timeout': True},
                       {'exit': 0, 'timeout': False, 'error': 'outer container cleanup failed'}]:
            with self.subTest(record=record), self.assertRaises(ValueError):
                profile.validate_run(record, transcript(), '50', 'full', DIGEST)

    def test_missing_duplicate_or_wrong_markers_and_remaining_children_fail(self):
        text = transcript()
        for changed in [text.replace('UNITE_DESKTOP_PASS ', 'UNITE_OTHER_PASS '),
                        text + text, text + 'UNITE_DESKTOP_PASS {}\n',
                        text.replace('"remaining": []', '"remaining": [123]'),
                        text.replace('UNITE_PROCESS_CLEANUP ', 'UNRELATED '),
                        text.replace('{"scenarios": ["native observed expectation"]}', '[]')]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                profile.validate_run({'exit': 0, 'timeout': False}, changed, '50', 'full', DIGEST)


class NativeProfileBoundaryTests(unittest.TestCase):
    def test_only_the_exact_local_unprivileged_image_identity_is_accepted(self):
        data = [{'Id': IMAGE.removeprefix('sha256:'), 'Config': {'User': '65534:65534'}}]
        self.assertEqual(profile.immutable_image(IMAGE, data)['id'], IMAGE)
        for reference, inspected in [('native51:latest', data), (IMAGE, []),
                                     (IMAGE, data * 2), (IMAGE, [{'Id': 'c' * 64, 'Config': data[0]['Config']}]),
                                     (IMAGE, [{'Id': IMAGE, 'Config': {'User': 'root'}}])]:
            with self.subTest(reference=reference, inspected=inspected), self.assertRaises(ValueError):
                profile.immutable_image(reference, inspected)

    def test_image_command_keeps_the_accepted_isolation_policy(self):
        root = Path('/var/tmp/private profile')
        command = ['/usr/bin/python3', '-B', '/workspace/tools/test-desktop.py']
        args = profile.sandbox_command('51', root, IMAGE, '/resolved/podman', command,
                                       overlay=root / 'catalog51', cidfile=root / 'run.cid')
        self.assertEqual(args[0:6], ['/resolved/podman', 'run', '--rm', '--pull', 'never', '--network'])
        for value in ['none', 'ALL', 'label=type:container_engine_t', '--read-only',
                      '--workdir', '/workspace',
                      '/tmp:rw,nosuid,nodev,mode=1777', '/run:rw,nosuid,nodev,mode=755',
                      f'{root}/source:/workspace:ro', f'{root}/candidate:/artifact:ro',
                      f'{root}/catalog51:/usr/share/locale/pt_BR/LC_MESSAGES:ro']:
            self.assertIn(value, args)
        self.assertEqual(args[-len(command)-1:], [IMAGE, *command])
        self.assertNotIn('--privileged', args)
        self.assertFalse(any('seccomp=unconfined' in item or 'label=disable' in item for item in args))

    def test_host_command_is_private_and_paths_are_not_shell_interpreted(self):
        root = Path('/var/tmp/space & comma, profile')
        args = profile.sandbox_command('50', root, IMAGE, '/podman', ['/usr/bin/true'], overlay=root / 'catalog50')
        self.assertEqual(args[:4], ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session'])
        self.assertIn('--tmpfs', args)
        self.assertIn(str(root / 'source'), args)
        self.assertIn(str(root / 'candidate'), args)
        self.assertIn('pt_BR.UTF-8', args)
        self.assertEqual(args[-1], '/usr/bin/true')
        with self.assertRaises(ValueError):
            profile.sandbox_command('51', Path('/bad:mount'), IMAGE, '/podman', [])


class NativeSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='native-profile-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        for name in profile.REQUIRED:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('native source\n')

    def test_snapshot_records_declared_inputs_and_excludes_private_owners(self):
        for name in ['specs/private.md', '.agents/policy.json', 'docs/evidence/private.log',
                     'tools/private-export.py', 'tests/test_private.py', 'build/generated.js']:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('must stay outside profile input closure')
        script = self.source / 'tests/desktop.js'
        script.chmod(0o755)
        output = self.base / 'output'
        output.mkdir()
        manifest = profile.snapshot_source(self.source, output)
        names = {item['path'] for item in manifest}
        self.assertEqual(names, set(profile.REQUIRED))
        self.assertTrue((output / 'source/tests/desktop.js').stat().st_mode & 0o111)
        self.assertEqual(profile.source_manifest(self.source), manifest)
        self.assertFalse((output / 'source/specs').exists())
        script.write_text('new native source\n')
        self.assertNotEqual(profile.source_manifest(self.source), manifest)

    def test_symlink_and_missing_native_input_fail_before_session_setup(self):
        path = self.source / 'tests/desktop.js'
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'Missing profile inputs'):
            profile.source_manifest(self.source)
        path.symlink_to(self.source / 'tests/desktop-conflict.js')
        with self.assertRaisesRegex(ValueError, 'Symbolic'):
            profile.source_manifest(self.source)

    def test_nested_snapshot_does_not_inherit_its_parent_git_identity(self):
        subprocess.run(['git', 'init', '-q', str(self.base)], check=True)
        self.assertEqual(profile.git_state(self.source), {'kind': 'snapshot_without_own_git'})

    def test_failed_early_prerequisite_keeps_a_failed_receipt(self):
        (self.source / 'tools/test-desktop.py').unlink()
        output = self.base / 'failed'
        result = profile.main(['--source', str(self.source), '--archive', str(self.base / 'absent.zip'),
                               '--image51', IMAGE, '--output', str(output), '--preflight-only'])
        self.assertEqual(result, 1)
        receipt = json.loads((output / 'receipt.json').read_text())
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['runs'], [])
        self.assertIn('Missing profile inputs', receipt['errors'][0])
        with self.assertRaises(FileExistsError):
            profile.main(['--archive', str(self.base / 'absent.zip'), '--image51', IMAGE,
                          '--output', str(output)])

    def test_command_failure_and_timeout_preserve_actual_outputs(self):
        log = self.base / 'failure.log'
        record, text = profile.execute([sys.executable, '-c', 'import sys; print("actual failure"); sys.exit(7)'], log)
        self.assertEqual(record['exit'], 7)
        self.assertIn('actual failure', text)
        self.assertEqual(record, json.loads(log.with_suffix('.json').read_text()))
        timed, _ = profile.execute([sys.executable, '-c', 'import time; time.sleep(60)'],
                                    self.base / 'timeout.log', timeout=0.05)
        self.assertTrue(timed['timeout'])
        self.assertIsNotNone(timed['exit'])

    def assert_terminal_cancellation(self, signum):
        """Exercise real signal delivery while replacing native prerequisites only."""
        archive = self.base / 'candidate.zip'
        with zipfile.ZipFile(archive, 'w') as value:
            value.writestr('metadata.json', json.dumps({'uuid': profile.UUID, 'shell-version': ['50', '51']}))
            value.writestr('locale/pt_BR/LC_MESSAGES/unite-next.mo', b'fixture catalog')
        output = self.base / 'cancelled'
        real_execute = profile.execute
        commands = []
        prefix = 'native output ' * 8192

        def execute_fixture(argv, log, **kwargs):
            commands.append(log.name)
            record = {'exit': 0, 'timeout': False}
            if log.name == 'source-archive.log':
                return record, 'UNITE_PROFILE_PAYLOAD_PASS {}\n'
            if log.name == 'image-inspect.log':
                return record, json.dumps([{'Id': IMAGE, 'Config': {'User': '65534:65534'}}])
            if log.name.startswith('preflight'):
                major = log.stem.removeprefix('preflight')
                native = output / f'profile{major}' if major == '50' else output / 'image-results/profile51'
                profile.write_json(native / 'native.json', {'shell': profile.VERSIONS[major]})
                return record, ''
            if log.name.startswith('gettext'):
                major = log.stem.removeprefix('gettext')
                native = output / f'profile{major}' if major == '50' else output / 'image-results/profile51'
                profile.write_json(native / 'gettext.json', {'gettext': {'glib': 'Fechar'}})
                return record, ''
            if log.name == 'gnome50-full.log':
                child = ('import os,signal,sys,time; '
                         "signal.signal(signal.SIGTERM, lambda s,f: (print('owned cleanup',flush=True),sys.exit(0))); "
                         'print(os.getpid(),flush=True); '
                         "print('native output ' * 8192,flush=True); "
                         "print('stderr before cancellation',file=sys.stderr,flush=True); "
                         f'os.kill(os.getppid(),{signum}); time.sleep(60)')
                return real_execute([sys.executable, '-c', child], log, timeout=0.5)
            return {'exit': 1, 'timeout': False}, 'unexpected later scenario scheduled\n'

        with patch.object(profile, 'execute', side_effect=execute_fixture), \
                patch.object(profile.shutil, 'which', return_value='/fixture/podman'), \
                patch.object(profile, 'prepare_catalog', return_value={}):
            result = profile.main(['--source', str(self.source), '--archive', str(archive),
                                   '--image51', IMAGE, '--output', str(output)])
        self.assertEqual(result, 1)
        receipt = json.loads((output / 'receipt.json').read_text())
        self.assertEqual(receipt['status'], 'failed')
        self.assertIn('cancellation', receipt)
        self.assertEqual(len(receipt['runs']), 1)
        self.assertEqual(receipt['runs'][0]['status'], 'cancelled')
        self.assertEqual(commands[-1], 'gnome50-full.log')
        record = json.loads((output / 'gnome50-full.json').read_text())
        self.assertFalse(record['timeout'])
        self.assertTrue(record['cancelled'])
        self.assertIsNotNone(record['exit'])
        observed = (output / 'gnome50-full.log').read_text().splitlines()
        child_pid = int(observed[0])
        self.assertEqual(observed, [str(child_pid), prefix, 'stderr before cancellation', 'owned cleanup'])
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)

    def test_real_sigterm_is_terminal_preserves_output_and_stops_the_matrix(self):
        self.assert_terminal_cancellation(signal.SIGTERM)

    def test_real_keyboard_interrupt_is_terminal_preserves_output_and_stops_the_matrix(self):
        self.assert_terminal_cancellation(signal.SIGINT)

    def test_explicit_catalog_override_is_version_and_digest_bound(self):
        original = self.base / 'catalogs'
        original.mkdir()
        (original / 'foreign.mo').write_bytes(b'foreign retained bytes')
        bad = self.base / 'wrong.mo'
        bad.write_bytes(b'not the matching native Shell catalog')
        with self.assertRaisesRegex(ValueError, 'accepted 50.5 catalog hash'):
            profile.prepare_catalog(original, self.base / 'overlay', '50.5', bad)
        self.assertEqual((original / 'foreign.mo').read_bytes(), b'foreign retained bytes')

    def test_installed_catalog_overlay_preserves_all_foreign_bytes(self):
        original = self.base / 'installed-catalogs'
        original.mkdir()
        (original / 'foreign.mo').write_bytes(b'foreign retained bytes')
        po = b'msgid ""\nmsgstr "Content-Type: text/plain; charset=UTF-8\\n"\n\nmsgid "Close"\nmsgstr "Fechar"\n'
        compiled = subprocess.check_output(['msgfmt', '--output-file=-', '-'], input=po, timeout=10)
        (original / 'gnome-shell.mo').write_bytes(compiled)
        result = profile.prepare_catalog(original, self.base / 'installed-overlay', '50.5')
        self.assertFalse(result['explicit_override'])
        self.assertEqual((self.base / 'installed-overlay/foreign.mo').read_bytes(), b'foreign retained bytes')
        self.assertEqual((self.base / 'installed-overlay/gnome-shell.mo').read_bytes(), compiled)
        self.assertEqual(set(result['preserved']), {'foreign.mo', 'gnome-shell.mo'})

    def test_native_catalog_aliases_preserve_lookup_names_bytes_and_provenance(self):
        original = self.base / 'native-catalogs'
        original.mkdir()
        (original / 'canonical.mo').write_bytes(b'installed native catalog')
        (original / 'alias.mo').symlink_to('canonical.mo')
        destination = self.base / 'native-export'
        result = profile.export_catalogs(original, destination)
        for name in ('canonical.mo', 'alias.mo'):
            self.assertFalse((destination / name).is_symlink())
            self.assertEqual((destination / name).read_bytes(), b'installed native catalog')
            self.assertEqual(result[name]['sha256'], profile.sha256(original / 'canonical.mo'))
        self.assertEqual(result['alias.mo']['native_symlink'], 'canonical.mo')
        self.assertEqual(result['alias.mo']['native_target'], str(original / 'canonical.mo'))
        for name, target in [('directory-alias', original), ('broken-alias', original / 'missing')]:
            with self.subTest(name=name):
                alias = original / name
                alias.symlink_to(target)
                with self.assertRaisesRegex(ValueError, 'Unsupported native catalog entry'):
                    profile.export_catalogs(original, self.base / name)
                alias.unlink()

    def test_original_and_snapshot_zip_must_remain_byte_identical(self):
        original, snapshot = self.base / 'original.zip', self.base / 'candidate.zip'
        for path in (original, snapshot):
            path.write_bytes(b'one accepted candidate')
        expected = profile.sha256(original)
        profile.unchanged_archive(original, snapshot, expected)
        for path in (original, snapshot):
            path.write_bytes(b'one accepted candidate')
        original.write_bytes(b'source changed during native checks')
        with self.assertRaisesRegex(ValueError, 'changed or disappeared'):
            profile.unchanged_archive(original, snapshot, expected)
        original.write_bytes(b'one accepted candidate')
        snapshot.unlink()
        snapshot.symlink_to(original)
        with self.assertRaisesRegex(ValueError, 'changed or disappeared'):
            profile.unchanged_archive(original, snapshot, expected)


if __name__ == '__main__':
    unittest.main()
