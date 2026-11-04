"""REQ-VERIFY-001: explicit native profiles and truthful aggregate receipts."""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from contextlib import redirect_stdout


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
    def test_explicit_admitted_version_does_not_change_the_default_validator(self):
        result = json.loads(transcript().splitlines()[1])
        result['native'] = 'GNOME Shell 50.6'
        profile.validate_run({'exit': 0, 'timeout': False}, transcript(result=result),
                             '50', 'full', DIGEST, version='50.6')
        self.assertEqual(profile.VERSIONS, {'50': '50.5', '51': '51.0'})
        with self.assertRaises(ValueError):
            profile.validate_run({'exit': 0, 'timeout': False}, transcript(result=result), '50', 'full', DIGEST)
        for version in ('50.7', '51.0'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                profile.validate_run({'exit': 0, 'timeout': False}, transcript(result=result),
                                     '50', 'full', DIGEST, version=version)

    def test_remaining_image_launcher_descendants_cannot_pass_acceptance(self):
        for cleanup in ({'scope': 'linux_subreaper', 'remaining': [123]},
                        {'scope': 'unknown', 'remaining': []}):
            with self.subTest(cleanup=cleanup), self.assertRaises(ValueError):
                profile.validate_run({'exit': 0, 'timeout': False, 'outer_cleanup': cleanup},
                                     transcript(), '50', 'full', DIGEST)

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
    def test_environment_kind_is_explicit_instead_of_inferred_from_the_major(self):
        root = Path('/var/tmp/explicit profile')
        image = profile.sandbox_command('50', root, IMAGE, '/podman', ['/usr/bin/true'],
                                         kind='image', results=root / 'image-results50')
        self.assertEqual(image[:3], ['/podman', 'run', '--rm'])
        self.assertIn(f'{root}/image-results50:/results:rw', image)
        host = profile.sandbox_command('51', root, None, None, ['/usr/bin/true'], kind='host')
        self.assertEqual(host[:4], ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session'])
        with self.assertRaises(ValueError):
            profile.sandbox_command('50', root, IMAGE, '/podman', [], kind='automatic')

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

    def test_declared_exclusions_actually_filter_selected_paths_without_overmatching(self):
        excluded = ['.git/config', 'build/output.js', 'specs/private.md', '.agents/policy.json',
                    'docs/evidence/private.log', 'tests/__pycache__/test.pyc', '__pycache__/module.pyc',
                    f'{profile.UUID}/nested/__pycache__/helper.pyc']
        retained = ['docs-copy/guide.md', f'{profile.UUID}/nested/docs/resource.txt']
        for name in excluded + retained:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('selected source bytes\n')
        output = self.base / 'excluded-snapshot'
        output.mkdir()
        with patch.object(profile, 'INPUTS', ('**/*',)):
            manifest = profile.snapshot_source(self.source, output)
        names = {entry['path'] for entry in manifest}
        self.assertFalse(names & set(excluded))
        self.assertTrue(set(retained) <= names)
        self.assertTrue(set(profile.REQUIRED) <= names)
        self.assertTrue(all(not (output / 'source' / name).exists() for name in excluded))

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

    def test_image_launcher_orphan_is_owned_and_reaped_in_the_command_record(self):
        script = '''import os,time
read_fd,write_fd=os.pipe()
pid=os.fork()
if pid:
 os.close(write_fd);assert os.read(read_fd,1)==b'1'
 print(pid,flush=True);os._exit(0)
os.close(read_fd);os.setsid();os.write(write_fd,b'1');os.close(write_fd)
time.sleep(30)
'''
        record, text = profile.execute([sys.executable, '-c', script], self.base / 'image-owner.log',
                                       podman='/unused/podman', cidfile=self.base / 'absent.cid')
        pid = int(text.strip())
        self.assertEqual(record['exit'], 0)
        self.assertEqual(record['outer_cleanup']['remaining'], [])
        self.assertEqual(record['outer_cleanup']['scope'], 'linux_subreaper')
        self.assertIn(pid, [child['pid'] for child in record['outer_cleanup']['reaped']])
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertEqual(record, json.loads((self.base / 'image-owner.json').read_text()))

    def test_image_command_failure_timeout_and_launch_failure_keep_outer_cleanup(self):
        cases = [('failure', [sys.executable, '-c', 'print("actual failure",flush=True); raise SystemExit(7)'], 2),
                 ('timeout', [sys.executable, '-c', 'import time; print("before timeout",flush=True); time.sleep(30)'], .1),
                 ('missing', ['/definitely-missing-native-profile-command'], 2)]
        for name, argv, timeout in cases:
            with self.subTest(name=name):
                record, output = profile.execute(argv, self.base / f'{name}.log', timeout=timeout,
                                                  podman='/unused/podman', cidfile=self.base / 'absent.cid')
                self.assertEqual(record['outer_cleanup']['remaining'], [])
                self.assertEqual(record['outer_cleanup']['scope'], 'linux_subreaper')
                self.assertEqual(record, json.loads((self.base / f'{name}.json').read_text()))
                if name == 'failure':
                    self.assertEqual(record['exit'], 7)
                    self.assertIn('actual failure', output)
                elif name == 'timeout':
                    self.assertTrue(record['timeout'])
                    self.assertIn('before timeout', output)
                else:
                    self.assertIsNone(record['exit'])
                    self.assertIn('definitely-missing-native-profile-command', output)

    def test_image_launcher_cancellation_keeps_output_and_terminal_cleanup_record(self):
        def cancelled(signum, frame):
            raise profile.ProfileCancelled('injected image SIGTERM')
        previous = signal.signal(signal.SIGTERM, cancelled)
        try:
            child = ('import os,signal,time; print(os.getpid(),flush=True); '
                     'os.kill(os.getppid(),signal.SIGTERM); time.sleep(30)')
            with self.assertRaises(profile.ProfileCancelled) as caught:
                profile.execute([sys.executable, '-c', child], self.base / 'image-cancel.log',
                                podman='/unused/podman', cidfile=self.base / 'absent.cid')
        finally:
            signal.signal(signal.SIGTERM, previous)
        record = caught.exception.command
        self.assertTrue(record['cancelled'])
        self.assertEqual(record['outer_cleanup']['remaining'], [])
        self.assertEqual(record, json.loads((self.base / 'image-cancel.json').read_text()))
        pid = int((self.base / 'image-cancel.log').read_text().strip())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def assert_cancellation_during_descendant_cleanup(self, signum):
        # An independent outer owner makes the regression safe even when the
        # implementation abandons its own owner and leaves the orphan alive.
        owner_spec = importlib.util.spec_from_file_location('profile_test_owner', ROOT / 'tools/test-desktop.py')
        owner = importlib.util.module_from_spec(owner_spec)
        owner_spec.loader.exec_module(owner)
        job = f'''import os,signal,time
supervisor=os.getppid()
read_fd,write_fd=os.pipe()
pid=os.fork()
if pid:
 os.close(write_fd);assert os.read(read_fd,1)==b'1'
 print(pid,flush=True);print('retained output '*8192,flush=True);os._exit(0)
os.close(read_fd);os.setsid()
def cleanup(sig,frame):
 print('owned cleanup',flush=True)
 os.kill(supervisor,{int(signum)});time.sleep(.1)
 os.kill(supervisor,{int(signal.SIGINT if signum == signal.SIGTERM else signal.SIGTERM)})
 print('second signal delivered',flush=True)
signal.signal(signal.SIGTERM,cleanup)
os.write(write_fd,b'1');os.close(write_fd)
time.sleep(30)
'''
        supervisor = '''import importlib.util,json,os,signal,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('profile_under_test',sys.argv[1]);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def terminated(sig,frame):raise p.ProfileCancelled('outer SIGTERM')
signal.signal(signal.SIGTERM,terminated)
previous={sig:signal.getsignal(sig) for sig in (signal.SIGINT,signal.SIGTERM)}
log=Path(sys.argv[2]);result={}
try:p.execute([sys.executable,'-c',sys.argv[3]],log,podman='/unused/podman',cidfile=log.with_suffix('.cid'))
except BaseException as error:result={'exception':type(error).__name__,'command':getattr(error,'command',None)}
result['handlers_restored']=all(signal.getsignal(sig)==handler for sig,handler in previous.items())
pid=int(log.read_text().splitlines()[0])
try:os.kill(pid,0);result['orphan_alive']=True
except ProcessLookupError:result['orphan_alive']=False
print(json.dumps(result))
'''
        log = self.base / f'outer-cancel-{int(signum)}.log'
        with owner.owned_descendants() as safety:
            result = subprocess.run([sys.executable, '-B', '-c', supervisor,
                                     str(ROOT / 'tools/native-profile.py'), str(log), job],
                                    capture_output=True, text=True, timeout=20)
        self.assertEqual(safety['remaining'], [])
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed['exception'], 'ProfileCancelled')
        self.assertTrue(observed['handlers_restored'])
        self.assertFalse(observed['orphan_alive'])
        record = observed['command']
        self.assertIsNotNone(record)
        self.assertEqual(record, json.loads(log.with_suffix('.json').read_text()))
        self.assertEqual(record['exit'], 0)
        self.assertFalse(record['timeout'])
        self.assertTrue(record['cancelled'])
        self.assertEqual(record['error'], f'Native profile interrupted by {signum.name}')
        self.assertEqual(record['sha256'], hashlib.sha256(log.read_bytes()).hexdigest())
        self.assertEqual(record['outer_cleanup']['remaining'], [])
        self.assertIn(signal.SIGKILL, [entry['signal'] for entry in record['outer_cleanup']['terminated']])
        lines = log.read_text().splitlines()
        self.assertEqual(lines[1:], ['retained output ' * 8192, 'owned cleanup', 'second signal delivered'])

    def test_sigterm_during_descendant_cleanup_is_terminal_after_reaping(self):
        self.assert_cancellation_during_descendant_cleanup(signal.SIGTERM)

    def test_sigint_during_descendant_cleanup_is_terminal_after_reaping(self):
        self.assert_cancellation_during_descendant_cleanup(signal.SIGINT)

    def test_repeated_signals_during_command_cleanup_keep_the_first_cancellation(self):
        child = '''import os,signal,sys,time
def cleanup(sig,frame):
 print('owned cleanup',flush=True);os.kill(os.getppid(),signal.SIGINT);sys.exit(0)
signal.signal(signal.SIGTERM,cleanup)
print(os.getpid(),flush=True);os.kill(os.getppid(),signal.SIGTERM);time.sleep(30)
'''
        log = self.base / 'repeated-cancel.log'
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        with self.assertRaises(profile.ProfileCancelled) as caught:
            profile.execute([sys.executable, '-c', child], log, timeout=10)
        self.assertTrue(all(signal.getsignal(sig) == handler for sig, handler in previous.items()))
        record = caught.exception.command
        self.assertEqual(record['error'], 'Native profile interrupted by SIGTERM')
        self.assertEqual(record['exit'], 0)
        self.assertTrue(record['cancelled'])
        self.assertFalse(record['timeout'])
        self.assertLess(record['seconds'], 3)
        self.assertEqual(record, json.loads(log.with_suffix('.json').read_text()))
        pid, message = log.read_text().splitlines()
        self.assertEqual(message, 'owned cleanup')
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid), 0)

    def test_wait_slices_preserve_the_single_command_deadline(self):
        record, output = profile.execute([sys.executable, '-c',
                                          'import time; print("before deadline",flush=True); time.sleep(.6)'],
                                         self.base / 'sliced-deadline.log', timeout=.15)
        self.assertTrue(record['timeout'])
        self.assertIn('before deadline', output)
        self.assertLess(record['seconds'], 3)

    def test_signal_during_handler_restoration_is_retained_and_handlers_are_restored(self):
        real_signal = signal.signal
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
            injected = False
            caught = None

            def restoring(sig, handler):
                nonlocal injected
                result = real_signal(sig, handler)
                if not injected and sig == signal.SIGINT and handler == previous[sig]:
                    injected = True
                    os.kill(os.getpid(), signum)
                return result

            log = self.base / f'restore-{int(signum)}.log'
            try:
                with patch.object(profile.signal, 'signal', side_effect=restoring):
                    try:
                        profile.execute([sys.executable, '-c', 'print("complete output")'], log)
                    except BaseException as error:
                        caught = error
                self.assertTrue(all(signal.getsignal(sig) == handler for sig, handler in previous.items()))
            finally:
                for sig, handler in previous.items():
                    real_signal(sig, handler)
            with self.subTest(signal=signum):
                self.assertTrue(injected)
                self.assertIsInstance(caught, profile.ProfileCancelled)
                record = caught.command
                self.assertEqual(record['exit'], 0)
                self.assertTrue(record['cancelled'])
                self.assertEqual(record['error'], f'Native profile interrupted by {signum.name}')
                self.assertEqual(record, json.loads(log.with_suffix('.json').read_text()))
                self.assertEqual(log.read_text(), 'complete output\n')

    def test_successful_launcher_still_cleans_its_surviving_private_container_id(self):
        identity = 'a' * 64
        cidfile = self.base / 'surviving.cid'
        cidfile.write_text(identity)
        podman = self.base / 'podman'
        calls = self.base / 'podman-calls.json'
        podman.write_text('#!/usr/bin/python3\nimport json,sys\nfrom pathlib import Path\n'
                          f'Path({str(calls)!r}).write_text(json.dumps(sys.argv[1:]))\n')
        podman.chmod(0o755)
        log = self.base / 'successful-launcher.log'
        record, output = profile.execute([sys.executable, '-c', 'print("launcher finished")'], log,
                                          podman=str(podman), cidfile=cidfile)
        self.assertEqual(record['exit'], 0)
        self.assertNotIn('error', record)
        self.assertEqual(output, 'launcher finished\n')
        self.assertEqual(json.loads(calls.read_text()), ['rm', '--force', '--ignore', identity])
        self.assertEqual(record['outer_cleanup']['remaining'], [])
        self.assertEqual(record, json.loads(log.with_suffix('.json').read_text()))

    def matrix_fixture(self, channel='native', extra=(), observed_versions=None):
        """Execute the generated source verifier; replace only unavailable native environments."""
        archive = self.base / 'input.zip'
        metadata = {'uuid': profile.UUID, 'shell-version': ['50', '51']}
        metadata.update({'version': 1} if channel == 'native' else {'version-name': '1'})
        with zipfile.ZipFile(archive, 'w') as value:
            value.writestr('metadata.json', json.dumps(metadata))
            value.writestr('locale/pt_BR/LC_MESSAGES/unite-next.mo', b'fixture catalog')
        original = archive.read_bytes()
        (self.source / 'tools/build.py').write_text('''import json,zipfile
def verify_source_archive(root,archive,*,channel):
 with zipfile.ZipFile(archive) as z: m=json.loads(z.read('metadata.json'))
 if (channel=='native') != ('version' in m): raise ValueError('Wrong channel')
 return {'channel':channel,'uuid':m['uuid']}
''')
        output = self.base / 'matrix'
        calls = []
        observed_versions = observed_versions or {'50': '50.5', '51': '51.0'}

        def host_path(argv, value):
            for mount in (argv[i + 1] for i, item in enumerate(argv[:-1]) if item == '--volume'):
                host, visible, _ = mount.rsplit(':', 2)
                if value.startswith(visible + '/'):
                    return Path(host) / value.removeprefix(visible + '/')
            return Path(value)

        def fixture(argv, log, **kwargs):
            calls.append((log.name, argv, kwargs))
            record = {'exit': 0, 'timeout': False}
            if 'inspect' in log.name:
                return record, json.dumps([{'Id': argv[-1], 'Config': {'User': '65534:65534'}}])
            if log.name == 'source-archive.log':
                code = argv[argv.index('-c') + 1]
                result = subprocess.run([sys.executable, '-B', '-c', code,
                                         str(host_path(argv, argv[-2])), argv[-1]],
                                        cwd=output / 'source', capture_output=True, text=True, timeout=10)
                return {'exit': result.returncode, 'timeout': False}, result.stdout + result.stderr
            if log.name.startswith(('preflight', 'gettext')):
                major = log.stem[-2:]
                destination = host_path(argv, argv[argv.index('_probe') + 1])
                data = {'shell': observed_versions[major]} if log.name.startswith('preflight') else {'gettext': {'glib': 'Fechar'}}
                profile.write_json(destination / ('native.json' if log.name.startswith('preflight') else 'gettext.json'), data)
                return record, ''
            major = argv[argv.index('--major') + 1]
            scenario = argv[argv.index('--scenario') + 1]
            result = {'source_archive_sha256': profile.sha256(archive),
                      'native': f'GNOME Shell {observed_versions[major]}', 'scenario': scenario,
                      'exit': 0, 'timeout': False, 'unexpected_diagnostics': [], 'screenshot_error': None}
            text = transcript(major, scenario, result=result)
            host_path(argv, argv[-1]).write_text(text)
            return record, text

        args = ['--source', str(self.source), '--archive', str(archive), '--output', str(output), *extra]
        with patch.object(profile, 'execute', side_effect=fixture), \
                patch.object(profile.shutil, 'which', return_value='/fixture/podman'), \
                patch.object(profile, 'prepare_catalog', return_value={}), redirect_stdout(io.StringIO()):
            status = profile.main(args)
        self.assertEqual(archive.read_bytes(), original)
        self.assertEqual((output / 'candidate/candidate.zip').read_bytes(), original)
        return status, json.loads((output / 'receipt.json').read_text()), calls

    def test_default_cli_keeps_the_original_native_host50_image51_profile(self):
        status, receipt, calls = self.matrix_fixture(extra=['--image51', IMAGE])
        self.assertEqual(status, 0)
        self.assertEqual(receipt['channel'], 'native')
        self.assertEqual(receipt['selection']['50'], {'kind': 'host', 'version': '50.5', 'image': None})
        self.assertEqual(receipt['selection']['51'], {'kind': 'image', 'version': '51.0', 'image': IMAGE})
        self.assertEqual(len(receipt['runs']), 4)
        self.assertEqual(next(argv for name, argv, _ in calls if name == 'gnome50-full.log')[0], '/usr/bin/bwrap')

    def test_ego_and_native_channels_use_the_exact_same_input_zip_in_both_images(self):
        # Each channel has its own source-valid fixture and immutable input bytes.
        for channel in ('native', 'ego'):
            with self.subTest(channel=channel):
                if (self.base / 'matrix').exists():
                    shutil.rmtree(self.base / 'matrix')
                status, receipt, calls = self.matrix_fixture(channel, extra=[
                    '--channel', channel, '--profile50', 'image', '--version50', '50.6',
                    '--image50', 'sha256:' + 'c' * 64, '--image51', IMAGE],
                    observed_versions={'50': '50.6', '51': '51.0'})
                self.assertEqual(status, 0)
                self.assertEqual(receipt['channel'], channel)
                self.assertEqual(receipt['payload_verification']['observed']['channel'], channel)
                self.assertEqual(len(receipt['runs']), 4)
                journeys = [(name, argv, options) for name, argv, options in calls if name.startswith('gnome')]
                self.assertEqual(len({str(options['cidfile']) for _, _, options in journeys}), 4)
                for name, argv, _ in journeys:
                    self.assertEqual(argv[0], '/fixture/podman')
                    self.assertIn('/artifact/candidate.zip', argv)
                    expected = 'image-results50' if '50' in name else 'image-results'
                    self.assertIn(f'{self.base}/matrix/{expected}:/results:rw', argv)

    def test_host51_and_image50_can_be_selected_explicitly(self):
        status, receipt, calls = self.matrix_fixture(extra=[
            '--profile50', 'image', '--image50', IMAGE, '--profile51', 'host'])
        self.assertEqual(status, 0)
        self.assertEqual(next(argv for name, argv, _ in calls if name == 'gnome51-full.log')[0], '/usr/bin/bwrap')
        self.assertEqual(receipt['profiles']['51']['native']['shell'], '51.0')

    def test_wrong_channel_stops_before_any_native_probe(self):
        status, receipt, calls = self.matrix_fixture(extra=['--image51', IMAGE, '--channel', 'ego'])
        self.assertEqual(status, 1)
        self.assertIn('correspondence failed', receipt['errors'][0])
        self.assertFalse(any(name.startswith(('preflight', 'gettext', 'gnome')) for name, _, _ in calls))

    def test_observed_minor_version_mismatch_stops_before_journeys(self):
        status, receipt, calls = self.matrix_fixture(extra=['--image51', IMAGE, '--version50', '50.6'])
        self.assertEqual(status, 1)
        self.assertIn('requires 50.6, observed 50.5', receipt['errors'][0])
        self.assertEqual(receipt['runs'], [])

    def test_invalid_profile_configuration_fails_before_external_commands(self):
        cases = [(['--version50', '50.7', '--image51', IMAGE], 'Unsupported native50 version'),
                 (['--version51', '50.6', '--image51', IMAGE], 'Unsupported native51 version'),
                 (['--profile51', 'host'], 'cannot supply both'),
                 ([], 'image51 must be'),
                 (['--image51', 'mutable:latest'], 'image51 must be'),
                 (['--image51', IMAGE, '--image50', IMAGE], 'unused by the selected host')]
        for i, (extra, expected) in enumerate(cases):
            output = self.base / f'invalid-{i}'
            with self.subTest(extra=extra), patch.object(profile, 'execute') as execute, redirect_stdout(io.StringIO()):
                status = profile.main(['--output', str(output), '--archive', 'unopened.zip', *extra])
            self.assertEqual(status, 1)
            self.assertIn(expected, json.loads((output / 'receipt.json').read_text())['errors'][0])
            execute.assert_not_called()

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
        with patch.dict(profile.CATALOGS, {'50.5': hashlib.sha256(compiled).hexdigest()}):
            result = profile.prepare_catalog(original, self.base / 'installed-overlay', '50.5')
        self.assertFalse(result['explicit_override'])
        self.assertEqual((self.base / 'installed-overlay/foreign.mo').read_bytes(), b'foreign retained bytes')
        self.assertEqual((self.base / 'installed-overlay/gnome-shell.mo').read_bytes(), compiled)
        self.assertEqual(set(result['preserved']), {'foreign.mo', 'gnome-shell.mo'})

    def test_installed_catalog_without_override_must_match_the_selected_version_hash(self):
        original = self.base / 'wrong-installed-catalog'
        original.mkdir()
        foreign = b'unrelated original catalog bytes'
        (original / 'foreign.mo').write_bytes(foreign)
        po = b'msgid ""\nmsgstr "Content-Type: text/plain; charset=UTF-8\\n"\n\nmsgid "Close"\nmsgstr "Fechar"\n'
        compiled = subprocess.check_output(['msgfmt', '--output-file=-', '-'], input=po, timeout=10)
        (original / 'gnome-shell.mo').write_bytes(compiled)
        overlay = self.base / 'wrong-installed-overlay'
        # Valid MO syntax and a plausible Portuguese translation are insufficient:
        # this is not the exact source/version catalog admitted by the registry.
        with self.assertRaisesRegex(ValueError, 'accepted 51.0 catalog hash'):
            profile.prepare_catalog(original, overlay, '51.0')
        for name, data in [('foreign.mo', foreign), ('gnome-shell.mo', compiled)]:
            self.assertEqual((original / name).read_bytes(), data)
            self.assertEqual((overlay / name).read_bytes(), data)

    def test_matching_catalog_digest_does_not_bypass_mo_parsing(self):
        original = self.base / 'invalid-mo'
        original.mkdir()
        malformed = b'this is not a GNU translation catalog'
        (original / 'gnome-shell.mo').write_bytes(malformed)
        with patch.dict(profile.CATALOGS, {'51.0': hashlib.sha256(malformed).hexdigest()}):
            with self.assertRaises(OSError):
                profile.prepare_catalog(original, self.base / 'invalid-mo-overlay', '51.0')

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
