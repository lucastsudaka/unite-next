#!/usr/bin/python3
"""Prepare explicit local native profiles and record one unchanged-ZIP matrix.

No installation, image pull/build, network access, publication or retry is done.
The existing test-desktop.py remains the native-session/process owner.
"""
import argparse
import ast
import ctypes
import gettext
import hashlib
import json
import locale
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import zipfile


ROOT = Path(__file__).resolve().parents[1]
UUID = 'unite-next@lucastsudaka.github.io'
VERSIONS = {'50': '50.5', '51': '51.0'}
# Version-matched official catalogs already documented in the public guide.
CATALOGS = {
    '50.5': '8d2ab765cdc31cb521ed82802357aac9de6b1c2787a08a9ecd1127a62dcca65f',
    '51.0': '4d1a773619f5c11c8dffa701e5e03ea2bb17d342d6d69744898a0112c97c1f3d',
}
# Declare the native tool/Python closure without depending on private owners.
# New Python consumers must be admitted here alongside their public sources.
INPUTS = ('tools/build.py', 'tools/candidate.py', 'tools/check-themes.mjs',
          'tools/native-profile.py', 'tools/test-desktop.py', 'tools/test-runtime.py',
          'tools/translations.py', 'tests/test_build.py', 'tests/test_candidate.py',
          'tests/test_desktop.py', 'tests/test_native_profile.py', 'tests/test_diagnostics.py',
          'tests/test_release.py', '.github/workflows/release.yml',
          'tests/test_gtk_files.py', 'tests/test_preferences.py', 'tests/test_supervision.py',
          'tests/test_x11.py', 'tests/gtk3-style-window.py', 'tests/gtk-transient-window.py',
          'tests/*.js', 'tests/*.mjs',
          'tests/fixtures/upstream-conflict/**/*', f'{UUID}/**/*',
          'translations/*.po', 'unite-next.pot', 'LICENSE', 'LICENSES/*.txt', 'NOTICE')
EXCLUSIONS = ('.git/', 'build/', 'specs/', '.agents/', 'docs/', '**/__pycache__/')
REQUIRED = ('tools/native-profile.py', 'tools/test-desktop.py', 'tools/build.py',
            'tools/translations.py', 'tests/desktop.js', 'tests/desktop-conflict.js',
            f'{UUID}/metadata.json', 'LICENSE', 'NOTICE')


class ProfileCancelled(BaseException):
    """Terminal cancellation, deliberately outside subprocess EINTR handling."""

    def __init__(self, reason):
        super().__init__(reason)
        self.command = None


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, data):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')
    temporary.replace(path)


def unchanged_archive(original, snapshot, expected):
    for path in (original, snapshot):
        if path.is_symlink() or not path.is_file() or sha256(path) != expected:
            raise ValueError(f'Native candidate changed or disappeared: {path}')


def source_manifest(source):
    paths = {path for pattern in INPUTS for path in source.glob(pattern)
             if path.is_file() or path.is_symlink()}
    paths = {path for path in paths if path.relative_to(source).as_posix() not in EXCLUSIONS
             and '__pycache__' not in path.parts and path.name != 'gschemas.compiled'}
    result = []
    for path in sorted(paths):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Symbolic or non-regular profile input: {path}')
        result.append({'path': path.relative_to(source).as_posix(),
                       'mode': '100755' if path.stat().st_mode & 0o111 else '100644',
                       'sha256': sha256(path)})
    missing = set(REQUIRED) - {entry['path'] for entry in result}
    if missing:
        raise ValueError(f'Missing profile inputs: {sorted(missing)}')
    return result


def git_state(source):
    result = subprocess.run(['git', '-C', str(source), 'rev-parse', '--show-toplevel'],
                            capture_output=True, text=True, timeout=10)
    if result.returncode or Path(result.stdout.strip()).resolve() != source.resolve():
        return {'kind': 'snapshot_without_own_git'}
    head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True, timeout=10).strip()
    status = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain=v1', '-z'], timeout=10)
    return {'kind': 'git', 'head': head, 'dirty': bool(status),
            'porcelain': os.fsdecode(status).split('\0')[:-1]}


def snapshot_source(source, output):
    before = source_manifest(source)
    target = output / 'source'
    target.mkdir(mode=0o755)
    for entry in before:
        original = source / entry['path']
        copied = target / entry['path']
        copied.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        shutil.copyfile(original, copied)
        copied.chmod(0o755 if entry['mode'] == '100755' else 0o644)
    if before != source_manifest(source) or before != source_manifest(target):
        raise ValueError('Profile source changed during snapshot acquisition')
    write_json(output / 'source-manifest.json', {'schema': 1, 'inputs': INPUTS,
               'exclusions': EXCLUSIONS, 'files': before})
    return before


def immutable_image(reference, inspection):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', reference):
        raise ValueError('image51 must be an explicit local sha256 image ID, never a tag')
    if len(inspection) != 1 or 'sha256:' + inspection[0].get('Id', '').removeprefix('sha256:') != reference:
        raise ValueError('Resolved image identity differs from the requested image ID')
    if inspection[0].get('Config', {}).get('User') != '65534:65534':
        raise ValueError('The native51 profile requires image user 65534:65534')
    return {'id': reference, 'user': '65534:65534',
            'repo_digests': inspection[0].get('RepoDigests', [])}


def sandbox_command(major, output, image, podman, command, *, overlay=None, cidfile=None):
    """Use the already accepted native isolation policy without fallback flags."""
    output = output.resolve()
    if ':' in str(output) or '\n' in str(output):
        raise ValueError('Native profile output path cannot contain colon or newline mount delimiters')
    if major == '50':
        argv = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session',
                '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
                '--tmpfs', '/tmp', '--tmpfs', '/run', '--setenv', 'TMPDIR', '/tmp',
                '--setenv', 'PATH', '/usr/bin:/bin', '--bind', str(output), str(output),
                '--ro-bind', str(output / 'source'), str(output / 'source'),
                '--ro-bind', str(output / 'candidate'), str(output / 'candidate'),
                '--chdir', str(output / 'source')]
        if overlay:
            argv += ['--ro-bind', str(overlay), '/usr/share/locale/pt_BR/LC_MESSAGES']
        for key, value in [('LC_ALL', 'pt_BR.UTF-8'), ('LANG', 'pt_BR.UTF-8'), ('LANGUAGE', 'pt_BR'),
                           ('PYTHONDONTWRITEBYTECODE', '1'), ('HOME', '/tmp/native-profile-home')]:
            argv += ['--setenv', key, value]
        return argv + command
    argv = [podman, 'run', '--rm', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL',
            '--security-opt', 'label=type:container_engine_t', '--read-only',
            '--workdir', '/workspace',
            '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--tmpfs', '/run:rw,nosuid,nodev,mode=755',
            '--volume', f'{output}/source:/workspace:ro',
            '--volume', f'{output}/candidate:/artifact:ro',
            '--volume', f'{output}/image-results:/results:rw']
    if overlay:
        argv += ['--volume', f'{overlay}:/usr/share/locale/pt_BR/LC_MESSAGES:ro']
    if cidfile:
        argv += ['--cidfile', str(cidfile)]
    for value in ['LC_ALL=pt_BR.UTF-8', 'LANG=pt_BR.UTF-8', 'LANGUAGE=pt_BR',
                  'PYTHONDONTWRITEBYTECODE=1', 'HOME=/tmp/native-profile-home']:
        argv += ['--env', value]
    return argv + [image, *command]


def execute(argv, log, *, timeout=30, podman=None, cidfile=None):
    """Bound the outer launcher too; terminate only its own container on failure."""
    started = time.monotonic()
    try:
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, start_new_session=True)
    except OSError as error:
        log.write_text(str(error) + '\n')
        record = {'argv': argv, 'exit': None, 'timeout': False, 'error': str(error),
                  'seconds': round(time.monotonic() - started, 3), 'output': log.name, 'sha256': sha256(log)}
        write_json(log.with_suffix('.json'), record)
        return record, log.read_text()
    timed_out = False
    failure = None
    cancellation = None
    output = ''
    def stop(sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
    try:
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            stop(signal.SIGTERM)
            try:
                output, _ = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                stop(signal.SIGKILL)
                output, _ = process.communicate(timeout=5)
        except (ProfileCancelled, KeyboardInterrupt) as error:
            cancellation = error if isinstance(error, ProfileCancelled) else ProfileCancelled(
                'Native profile interrupted by KeyboardInterrupt')
            failure = str(cancellation)
            stop(signal.SIGTERM)
            try:
                output, _ = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                stop(signal.SIGKILL)
                output, _ = process.communicate(timeout=5)
        except Exception as error:
            failure = str(error) or type(error).__name__
    finally:
        if process.poll() is None:
            stop(signal.SIGKILL)
            output, _ = process.communicate(timeout=5)
        if podman and cidfile and cidfile.exists() and (cancellation or timed_out or process.returncode):
            identity = cidfile.read_text().strip()
            if not re.fullmatch('[0-9a-f]{64}', identity):
                failure = 'Invalid owned container ID in profile cidfile'
            else:
                try:
                    cleanup = subprocess.run([podman, 'rm', '--force', '--ignore', identity],
                                             capture_output=True, text=True, timeout=10)
                    if cleanup.returncode:
                        raise RuntimeError(f'Owned profile container cleanup failed: {cleanup.stderr}')
                except Exception as error:
                    failure = '; '.join(filter(None, [failure, str(error)]))
    log.write_text(output)
    record = {'argv': argv, 'exit': process.returncode, 'timeout': timed_out,
              'seconds': round(time.monotonic() - started, 3), 'output': log.name, 'sha256': sha256(log)}
    if failure:
        record['error'] = failure
    if cancellation:
        record['cancelled'] = True
    write_json(log.with_suffix('.json'), record)
    if cancellation:
        cancellation.command = record
        raise cancellation
    return record, output


def validate_run(record, output, major, scenario, archive_hash):
    summaries = [json.loads(line) for line in output.splitlines()
                 if line.startswith('{"source_archive_sha256":')]
    cleanups = [json.loads(line.removeprefix('UNITE_PROCESS_CLEANUP ')) for line in output.splitlines()
                if line.startswith('UNITE_PROCESS_CLEANUP ')]
    marker = 'UNITE_DESKTOP_PASS ' if scenario == 'full' else 'UNITE_CONFLICT_PASS '
    markers = [json.loads(line[len(marker):]) for line in output.splitlines() if line.startswith(marker)]
    if len(summaries) != 1 or len(cleanups) != 1 or len(markers) != 1 or not isinstance(markers[0], dict):
        raise ValueError('Native run lacks one unambiguous result and process-cleanup record')
    result, cleanup = summaries[0], cleanups[0]
    if (record.get('error') or type(record['exit']) is not int or record['exit'] != 0 or record['timeout'] is not False or
            type(result.get('exit')) is not int or result['exit'] != 0 or result.get('timeout') is not False or
            result.get('source_archive_sha256') != archive_hash or result.get('scenario') != scenario or
            result.get('native') != f'GNOME Shell {VERSIONS[major]}' or
            result.get('unexpected_diagnostics') != [] or result.get('screenshot_error') is not None or
            cleanup.get('remaining') != [] or cleanup.get('scope') != 'linux_subreaper'):
        raise ValueError('Native result does not satisfy artifact/scenario/diagnostic/cleanup acceptance')
    return {'result': result, 'cleanup': cleanup}


def export_catalogs(original, destination):
    """Materialize native lookup names, including regular-file aliases, privately."""
    destination.mkdir(mode=0o755)
    entries = {}
    for path in sorted(original.iterdir()):
        if not path.is_file():
            raise ValueError(f'Unsupported native catalog entry: {path}')
        data = path.read_bytes()
        target = destination / path.name
        target.write_bytes(data)
        target.chmod(0o644)
        entries[path.name] = {'sha256': hashlib.sha256(data).hexdigest()}
        if path.is_symlink():
            entries[path.name]['native_symlink'] = os.readlink(path)
            entries[path.name]['native_target'] = str(path.resolve(strict=True))
    return entries


def prepare_catalog(original, destination, version, supplied=None):
    shutil.copytree(original, destination)
    preserved = {path.name: sha256(path) for path in original.iterdir()}
    if supplied:
        if supplied.is_symlink() or not supplied.is_file():
            raise ValueError('Explicit Shell catalog must be a regular file, never a symlink')
        data = supplied.read_bytes()
        if version not in CATALOGS or hashlib.sha256(data).hexdigest() != CATALOGS[version]:
            raise ValueError(f'Explicit Shell catalog does not match the accepted {version} catalog hash')
        (destination / 'gnome-shell.mo').write_bytes(data)
        (destination / 'gnome-shell.mo').chmod(0o644)
    catalog = destination / 'gnome-shell.mo'
    if not catalog.is_file():
        raise ValueError(f'Matching native {version} Shell catalog is absent; supply its documented MO file')
    with catalog.open('rb') as stream:
        gettext.GNUTranslations(stream)
    return {'version': version, 'sha256': sha256(catalog), 'explicit_override': bool(supplied),
            'preserved': preserved}


def native_probe(destination, *, functional=False, fork_catalog=None):
    """Fresh process only: never constructs a Shell global or starts a desktop."""
    home = Path(os.environ['HOME'])
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ('CONFIG', 'CACHE', 'DATA', 'RUNTIME'):
        path = home / name.lower()
        path.mkdir(mode=0o700, exist_ok=True)
        os.environ[f'XDG_{name}_HOME' if name != 'RUNTIME' else 'XDG_RUNTIME_DIR'] = str(path)
    import gi
    from gi.repository import GLib
    directory = Path(destination)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    version = subprocess.check_output(['/usr/bin/gnome-shell', '--version'], text=True, timeout=10).strip().split()[-1]
    reader = '''const Gio=imports.gi.Gio; const GLib=imports.gi.GLib;
void imports.gi.Shell.Global;
print(new TextDecoder().decode(Gio.resources_lookup_data('/org/gnome/shell/misc/config.js', Gio.ResourceLookupFlags.NONE).get_data()));'''
    # Match the installed namespace locations, without constructing a Shell instance.
    prefixes = [Path('/usr/lib64'), Path('/usr/lib')]
    import sysconfig
    if sysconfig.get_config_var('MULTIARCH'):
        prefixes.append(Path('/usr/lib') / sysconfig.get_config_var('MULTIARCH'))
    libraries = [prefix / 'gnome-shell' for prefix in prefixes
                 if list((prefix / 'gnome-shell').glob('Shell-*.typelib'))]
    if len(libraries) != 1 or len(list(libraries[0].glob('Shell-*.typelib'))) != 1:
        raise ValueError('Expected one installed Shell namespace for native profile probe')
    abi = next(libraries[0].glob('Shell-*.typelib')).stem.removeprefix('Shell-')
    paths = [libraries[0], *sorted(libraries[0].parent.glob('mutter-*'))]
    env = {**os.environ, **{key: os.pathsep.join(map(str, paths)) for key in ('GI_TYPELIB_PATH', 'LD_LIBRARY_PATH')}}
    config = subprocess.check_output(['/usr/bin/gjs', '-c', f'imports.gi.versions.Shell="{abi}";'+reader],
                                     env=env, text=True, timeout=10)
    values = {}
    for key in ('PACKAGE_VERSION', 'LOCALEDIR', 'GETTEXT_PACKAGE'):
        matches = re.findall(rf'^export const {key} = (.+);$', config, re.MULTILINE)
        if len(matches) != 1:
            raise ValueError(f'Expected one native Shell {key}')
        values[key] = ast.literal_eval(matches[0])
    if values != {'PACKAGE_VERSION': version, 'LOCALEDIR': '/usr/share/locale', 'GETTEXT_PACKAGE': 'gnome-shell'}:
        raise ValueError(f'Unsupported or mismatched native Shell resource configuration: {values}')
    result = {'shell': version, 'gjs': subprocess.check_output(['/usr/bin/gjs', '--version'], text=True, timeout=10).strip(),
              'glib': f'{GLib.MAJOR_VERSION}.{GLib.MINOR_VERSION}.{GLib.MICRO_VERSION}', 'config': values, 'abi': abi}
    if functional:
        locale.setlocale(locale.LC_ALL, 'pt_BR.UTF-8')
        libc = ctypes.CDLL(None)
        for name in ('textdomain', 'bindtextdomain', 'dgettext'):
            function = getattr(libc, name)
            function.restype = ctypes.c_char_p
            function.argtypes = [ctypes.c_char_p] * (1 if name == 'textdomain' else 2)
        libc.bindtextdomain(b'gnome-shell', b'/usr/share/locale')
        libc.bindtextdomain(b'unite-next', os.fsencode(fork_catalog))
        libc.textdomain(b'gnome-shell')
        result['gettext'] = {'default_header': libc.dgettext(b'gnome-shell', b'').decode(),
                             'direct': libc.dgettext(b'unite-next', b'Close').decode(),
                             'glib': GLib.dgettext('unite-next', 'Close')}
        if not result['gettext']['default_header'] or result['gettext']['direct'] != 'Fechar' or result['gettext']['glib'] != 'Fechar':
            raise ValueError(f'Native default-domain gettext prerequisite failed: {result["gettext"]}')
    else:
        original = Path('/usr/share/locale/pt_BR/LC_MESSAGES')
        result['native_catalogs'] = export_catalogs(original, directory / 'catalog-original')
    write_json(directory / ('gettext.json' if functional else 'native.json'), result)
    print(json.dumps(result))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--image51', required=True)
    parser.add_argument('--catalog50', type=Path)
    parser.add_argument('--catalog51', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--preflight-only', action='store_true')
    args = parser.parse_args(argv)
    output = args.output.resolve()
    output.mkdir(mode=0o700)  # Existing evidence is never overwritten.
    def terminated(signum, frame):
        raise ProfileCancelled('Native profile interrupted by SIGTERM')
    previous_signal = signal.signal(signal.SIGTERM, terminated)
    receipt = {'schema': 1, 'status': 'running', 'preflight_only': args.preflight_only,
               'profiles': {}, 'runs': [], 'errors': []}
    try:
        source = args.source.resolve()
        receipt['source'] = {'git': git_state(source)}
        manifest = snapshot_source(source, output)
        receipt['source']['manifest_sha256'] = sha256(output / 'source-manifest.json')
        candidate = output / 'candidate'
        candidate.mkdir(mode=0o755)
        archive = candidate / 'candidate.zip'
        if args.archive.is_symlink() or not args.archive.is_file():
            raise ValueError('Native candidate input must be a regular file, never a symlink')
        shutil.copyfile(args.archive, archive)
        receipt['archive_sha256'] = sha256(archive)
        unchanged_archive(args.archive, archive, receipt['archive_sha256'])
        with zipfile.ZipFile(archive) as value:
            if value.testzip() is not None or value.namelist().count('metadata.json') != 1:
                raise ValueError('Corrupt or ambiguous native candidate')
            metadata = json.loads(value.read('metadata.json'))
            if metadata.get('uuid') != UUID or set(metadata.get('shell-version', [])) != {'50', '51'}:
                raise ValueError('Matrix candidate must identify Unite Next and explicit native50/51 targets')
            locale_file = candidate / 'locale/pt_BR/LC_MESSAGES/unite-next.mo'
            locale_file.parent.mkdir(mode=0o755, parents=True)
            locale_file.write_bytes(value.read('locale/pt_BR/LC_MESSAGES/unite-next.mo'))
        verifier = '''import json,sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()/'tools'))
import build
print('UNITE_PROFILE_PAYLOAD_PASS '+json.dumps(build.verify_source_archive(Path.cwd(), Path(sys.argv[1]))))'''
        command = sandbox_command('50', output, args.image51, '',
            ['/usr/bin/python3', '-B', '-c', verifier, str(archive)])
        record, text = execute(command, output / 'source-archive.log', timeout=120)
        matches = [json.loads(line.removeprefix('UNITE_PROFILE_PAYLOAD_PASS ')) for line in text.splitlines()
                   if line.startswith('UNITE_PROFILE_PAYLOAD_PASS ')]
        if record['exit'] != 0 or record['timeout'] or record.get('error') or len(matches) != 1:
            raise ValueError('Source/native-catalog/archive correspondence failed; see preserved source-archive output')
        receipt['payload_verification'] = {'command': record, 'observed': matches[0]}
        podman = shutil.which('podman')
        if not podman:
            raise ValueError('Local Podman executable is required; nothing is installed automatically')
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', args.image51):
            raise ValueError('image51 must be an explicit local sha256 image ID, never a tag')
        record, text = execute([podman, 'image', 'inspect', args.image51], output / 'image-inspect.log')
        if record['exit'] != 0 or record['timeout'] or record.get('error'):
            raise ValueError('Local image inspection failed; see its preserved output')
        inspection = json.loads(text)
        receipt['image51'] = immutable_image(args.image51, inspection)
        image_results = output / 'image-results'
        image_results.mkdir(mode=0o777)
        image_results.chmod(0o777)  # Only this explicitly mounted disposable results directory is writable by image UID.
        for major in ('50', '51'):
            profile = output / f'profile{major}' if major == '50' else image_results / 'profile51'
            profile.mkdir(mode=0o777 if major == '51' else 0o700)
            if major == '51':
                profile.chmod(0o777)
            visible = str(profile) if major == '50' else '/results/profile51'
            tool = str(output / 'source/tools/native-profile.py') if major == '50' else '/workspace/tools/native-profile.py'
            cidfile = output / f'probe{major}.cid' if major == '51' else None
            command = sandbox_command(major, output, args.image51, podman,
                ['/usr/bin/python3', '-B', tool, '_probe', visible], cidfile=cidfile)
            record, _ = execute(command, output / f'preflight{major}.log', podman=podman, cidfile=cidfile)
            if record['exit'] != 0 or record['timeout'] or record.get('error'):
                raise ValueError(f'Native{major} inventory preflight failed; see its preserved output')
            native = json.loads((profile / 'native.json').read_text())
            if native['shell'] != VERSIONS[major]:
                raise ValueError(f'Profile native{major} requires {VERSIONS[major]}, observed {native["shell"]}')
            overlay = output / f'catalog{major}'
            catalog = prepare_catalog(profile / 'catalog-original', overlay, native['shell'], getattr(args, f'catalog{major}'))
            cidfile = output / f'gettext{major}.cid' if major == '51' else None
            command = sandbox_command(major, output, args.image51, podman,
                ['/usr/bin/python3', '-B', tool, '_probe', visible, '--functional',
                 str(candidate / 'locale') if major == '50' else '/artifact/locale'], overlay=overlay, cidfile=cidfile)
            record, _ = execute(command, output / f'gettext{major}.log', podman=podman, cidfile=cidfile)
            if record['exit'] != 0 or record['timeout'] or record.get('error'):
                raise ValueError(f'Native{major} gettext preflight failed; see its preserved output')
            receipt['profiles'][major] = {'native': native, 'catalog': catalog,
                                         'gettext': json.loads((profile / 'gettext.json').read_text())}
        if not args.preflight_only:
            for major in ('50', '51'):
                for scenario in ('full', 'conflict'):
                    cidfile = output / f'{major}-{scenario}.cid' if major == '51' else None
                    log = output / f'gnome{major}-{scenario}.log'
                    native_log = str(output / f'gnome{major}-{scenario}-native.log') if major == '50' else f'/results/{scenario}-native.log'
                    tool = str(output / 'source/tools/test-desktop.py') if major == '50' else '/workspace/tools/test-desktop.py'
                    artifact = str(archive) if major == '50' else '/artifact/candidate.zip'
                    command = sandbox_command(major, output, args.image51, podman,
                        ['/usr/bin/python3', '-B', tool, artifact, '--major', major, '--scenario', scenario, '--log', native_log],
                        overlay=output / f'catalog{major}', cidfile=cidfile)
                    run = {'major': major, 'scenario': scenario, 'status': 'running'}
                    receipt['runs'].append(run)
                    try:
                        record, text = execute(command, log, timeout=150, podman=podman, cidfile=cidfile)
                    except ProfileCancelled as error:
                        run.update(status='cancelled', command=error.command, error=str(error))
                        raise
                    run.update(command=record, status='failed')
                    try:
                        run.update(validate_run(record, text, major, scenario, receipt['archive_sha256']))
                        native_path = output / f'gnome{major}-{scenario}-native.log' if major == '50' else image_results / f'{scenario}-native.log'
                        run['native_log'] = {'path': native_path.relative_to(output).as_posix(), 'sha256': sha256(native_path)}
                        unchanged_archive(args.archive, archive, receipt['archive_sha256'])
                        run['status'] = 'passed'
                    except Exception as error:
                        run['error'] = str(error)
                    write_json(output / 'receipt.json', receipt)
        if manifest != source_manifest(source):
            raise ValueError('Live source inputs changed since the immutable profile snapshot')
        unchanged_archive(args.archive, archive, receipt['archive_sha256'])
        receipt['source']['git_after'] = git_state(source)
        receipt['status'] = 'preflight_passed' if args.preflight_only else (
            'passed' if len(receipt['runs']) == 4 and all(run['status'] == 'passed' for run in receipt['runs']) else 'failed')
    except (ProfileCancelled, KeyboardInterrupt) as error:
        reason = str(error) or 'Native profile interrupted by KeyboardInterrupt'
        receipt['status'] = 'failed'
        receipt['errors'].append(reason)
        receipt['cancellation'] = {'reason': reason}
        if isinstance(error, ProfileCancelled) and error.command is not None:
            receipt['cancellation']['command'] = error.command
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['errors'].append(str(error))
    write_json(output / 'receipt.json', receipt)
    signal.signal(signal.SIGTERM, previous_signal)
    print(json.dumps(receipt))
    return int(receipt['status'] == 'failed')


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == '_probe':
        functional = '--functional' in sys.argv[3:]
        native_probe(sys.argv[2], functional=functional,
                     fork_catalog=sys.argv[sys.argv.index('--functional') + 1] if functional else None)
    else:
        raise SystemExit(main())
