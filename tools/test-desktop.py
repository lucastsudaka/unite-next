#!/usr/bin/python3
"""Run a candidate archive in an isolated, bounded native GNOME session."""
import argparse
import ctypes
from contextlib import contextmanager, ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import re
import selectors
import signal
import shutil
import struct
import subprocess
import sysconfig
import tempfile
import time
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
FORK_UUID = 'unite-next@lucastsudaka.github.io'


def stage_candidate_archive(archive, destination, major):
    """Stage and fingerprint one immutable snapshot without rebuilding the ZIP."""
    snapshot = archive.read_bytes()
    with zipfile.ZipFile(io.BytesIO(snapshot)) as candidate:
        if candidate.namelist().count('metadata.json') != 1:
            raise ValueError('Candidate archive must contain exactly one metadata.json')
        metadata = json.loads(candidate.read('metadata.json'))
        if not isinstance(metadata, dict) or metadata.get('uuid') != FORK_UUID:
            raise ValueError(f'Candidate archive must identify extension {FORK_UUID}')
        versions = metadata.get('shell-version')
        if (not isinstance(versions, list) or not versions or
                any(version not in ('50', '51') for version in versions) or
                len(set(versions)) != len(versions)):
            raise ValueError('Candidate metadata must declare explicit supported Shell majors')
        if major not in versions:
            raise ValueError(f'Candidate archive does not declare GNOME Shell {major}')
        invalid = candidate.testzip()
        if invalid:
            raise ValueError(f'Candidate archive contains an invalid ZIP member: {invalid}')
    archive_hash = hashlib.sha256(snapshot).hexdigest()
    with destination.open('xb') as output:
        output.write(snapshot)
    return metadata, archive_hash


def install_conflict_fixture(source, data_home, fork_uuid):
    """Install the upstream stub only into the runner's disposable data tree."""
    upstream_uuid = 'unite@hardpixel.eu'
    if fork_uuid == upstream_uuid:
        raise ValueError('Conflict acceptance requires an independent fork UUID')
    metadata = json.loads((source / 'metadata.json').read_text())
    if metadata.get('uuid') != upstream_uuid:
        raise ValueError('Conflict fixture must retain the upstream UUID')
    if any(path.is_symlink() for path in [source, *source.rglob('*')]):
        raise ValueError('Conflict fixture must contain only regular native sources')
    destination = data_home / 'gnome-shell/extensions' / upstream_uuid
    shutil.copytree(source, destination)
    subprocess.run(['glib-compile-schemas', '--strict', str(destination / 'schemas')],
                   check=True, timeout=10)
    return destination


def png_dimensions(path):
    """Check complete PNG framing and CRC before publishing a native capture."""
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'Invalid PNG signature: {path.name}')
    cursor, dimensions, image_data = 8, None, False
    while cursor + 12 <= len(data):
        length = struct.unpack('>I', data[cursor:cursor + 4])[0]
        kind = data[cursor + 4:cursor + 8]
        end = cursor + 12 + length
        if end > len(data):
            raise ValueError(f'Truncated PNG chunk: {path.name}')
        payload = data[cursor + 8:cursor + 8 + length]
        crc = struct.unpack('>I', data[end - 4:end])[0]
        if zlib.crc32(kind + payload) != crc:
            raise ValueError(f'Invalid PNG CRC: {path.name}')
        if cursor == 8:
            if kind != b'IHDR' or length != 13:
                raise ValueError(f'Missing PNG header: {path.name}')
            dimensions = struct.unpack('>II', payload[:8])
            if not all(dimensions):
                raise ValueError(f'Empty PNG dimensions: {path.name}')
        elif kind == b'IHDR':
            raise ValueError(f'Duplicate PNG header: {path.name}')
        if kind == b'IDAT':
            image_data = image_data or bool(length)
        if kind == b'IEND':
            if length or end != len(data) or not image_data:
                raise ValueError(f'Invalid PNG termination: {path.name}')
            return dimensions
        cursor = end
    raise ValueError(f'Incomplete PNG: {path.name}')


def publish_screenshots(source, destination, archive_hash, native):
    """Publish only complete private captures after the entire desktop run passes."""
    names = ('screenshot.png', 'settings.png')
    if {path.name for path in source.iterdir()} != set(names):
        raise ValueError('Native capture must produce exactly screenshot.png and settings.png')
    records = {}
    for name in names:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Native capture is not a regular file: {name}')
        width, height = png_dimensions(path)
        records[name] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                         'width': width, 'height': height}
    manifest = {'schema': 1, 'source_archive_sha256': archive_hash,
                'native': native, 'files': records}
    destination.mkdir(mode=0o755)  # Exclusive ownership; never overwrite prior captures.
    try:
        for name in names:
            with (destination / name).open('xb') as output:
                output.write((source / name).read_bytes())
        with (destination / 'captures.json').open('x', encoding='utf-8') as output:
            output.write(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    except BaseException:
        # Only this newly created directory is owned by the failed publication.
        shutil.rmtree(destination)
        raise
    return manifest


@contextmanager
def owned_descendants():
    """Adopt and reap only this otherwise childless Linux runner's descendants.

    Native helpers can create a new session and outlive dbus-run-session. Process
    groups alone cannot reap those orphans, including already exited helpers.
    """
    children_file = Path(f'/proc/{os.getpid()}/task/{os.getpid()}/children')
    def children():
        return [int(pid) for pid in children_file.read_text().split()]
    if children():
        raise RuntimeError('Desktop supervision requires no preexisting children')
    libc = ctypes.CDLL(None, use_errno=True)
    previous = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(previous), 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot query child-subreaper state')
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot own desktop descendants')
    report = {'scope': 'linux_subreaper', 'reaped': [], 'terminated': [], 'remaining': []}
    try:
        yield report
    finally:
        try:
            deadline = time.monotonic() + 5
            signaled = set()
            while children():
                for pid in children():
                    # An unreaped direct child retains its PID. Native pidfds also
                    # bind signaling to that process, never a recycled global PID.
                    try:
                        reaped, status = os.waitpid(pid, os.WNOHANG)
                        if reaped:
                            report['reaped'].append({'pid': pid, 'status': status})
                            continue
                        descriptor = os.pidfd_open(pid)
                        try:
                            sig = signal.SIGKILL if time.monotonic() >= deadline else signal.SIGTERM
                            if (pid, sig) not in signaled:
                                signal.pidfd_send_signal(descriptor, sig)
                                signaled.add((pid, sig))
                                report['terminated'].append({'pid': pid, 'signal': sig.value})
                        finally:
                            os.close(descriptor)
                    except ProcessLookupError:
                        continue
                if time.monotonic() > deadline + 5:
                    raise RuntimeError(f'Desktop descendants exceeded shutdown deadline: {children()}')
                if children():
                    time.sleep(0.01)  # Observe owned-child termination within the fixed deadline.
            report['remaining'] = children()
        finally:
            if libc.prctl(36, previous.value, 0, 0, 0) != 0:
                raise OSError(ctypes.get_errno(), 'Cannot restore child-subreaper state')


@contextmanager
def private_system_bus(base):
    """Own a non-activating bus; never expose the user's system bus to a test."""
    socket = base / 'runtime/system-bus'
    configuration = base / 'system.conf'
    configuration.write_text(f'''<busconfig><type>system</type><listen>unix:path={socket}</listen>
<auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/>
<allow receive_sender="*"/><allow own="*"/></policy></busconfig>''')
    process = None
    try:
        process = subprocess.Popen(
            ['/usr/bin/dbus-daemon', '--nofork', '--print-address=1', f'--config-file={configuration}'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=5):
                raise RuntimeError('Private system bus exceeded its 5-second startup deadline')
            address = process.stdout.readline().strip()
        if not address.startswith(f'unix:path={socket},guid=') or process.poll() is not None:
            raise RuntimeError(f'Private system bus failed to start: {address}')
        yield address
    finally:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate(timeout=5)


def classify_diagnostics(output, major, scenario='full', fork_uuid=None):
    """Retain proven native baseline diagnostics; fail every other critical/error.

    Baseline categories and reproduction procedures are described in
    docs/public-verification.md. This is a result classification, never log suppression.
    """
    baseline, unexpected = [], []
    conflict_messages = {
        'startup': 'Unite Next cannot run while unite@hardpixel.eu is active or activating',
        'cleanup': 'Injected native fork conflict cleanup failure',
    }
    conflict = scenario == 'conflict' and fork_uuid == FORK_UUID
    phases = iter(conflict_messages)
    next_phase = next(phases)
    pending = None
    observed = set()
    in_menu = False
    service = ('Gio.DBusError: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: '
               'The name {} was not provided by any .service files')
    calendar = service.format('org.gnome.Shell.CalendarServer')
    login = re.compile(r'Could not get a proxy for user [0-9]+: ' +
                       re.escape(service.format('org.freedesktop.login1')))
    allocation = ("clutter_actor_set_allocation_internal: assertion '!isnan (box->x1) && "
                  "!isnan (box->x2) && !isnan (box->y1) && !isnan (box->y2)' failed")
    for line in output.splitlines():
        if line.startswith(('UNITE_CONFLICT_EXPECT_ERROR ', 'UNITE_CONFLICT_OBSERVED_ERROR ')):
            kind, _, payload = line.partition(' ')
            try:
                record = json.loads(payload)
                phase = record['phase']
                message = conflict_messages[phase]
                valid = conflict and record['uuid'] == fork_uuid
                if kind == 'UNITE_CONFLICT_EXPECT_ERROR':
                    valid = valid and record == {'phase': phase, 'uuid': fork_uuid, 'message': message}
                    valid = valid and pending is None and phase == next_phase
                    if valid:
                        pending = {'phase': phase, 'marker': line, 'lines': []}
                else:
                    valid = valid and set(record) == {'phase', 'uuid', 'error'}
                    valid = valid and record['error'] in (message, f'Error: {message}')
                    valid = valid and pending is not None and pending['phase'] == phase
                    if valid:
                        if len(pending['lines']) == 1:
                            baseline.append({'category': 'intentional-conflict-error', 'phase': phase,
                                             'uuid': fork_uuid, 'line': pending['lines'][0]})
                            observed.add(phase)
                        else:
                            unexpected.extend([pending['marker'], *pending['lines'], line])
                        pending = None
                        next_phase = next(phases, None)
                if not valid:
                    unexpected.append(line)
            except (ValueError, TypeError, KeyError):
                unexpected.append(line)
            continue
        if line.startswith('UNITE_INPUT_MENU_BEFORE '):
            in_menu = True
        if line.startswith('UNITE_INPUT_MENU_AFTER '):
            in_menu = False
        if re.search(r'-WARNING .*Failed to load file://[^\s]*/unite-next@lucastsudaka\.github\.io/', line):
            unexpected.append(line)
            continue
        if not re.search(r'-CRITICAL|JS ERROR|JS WARNING|Script failed', line):
            continue
        if pending and re.fullmatch(
                r'\(gnome-shell:[0-9]+\): (?:GNOME Shell|Gjs)-CRITICAL \*\*: [0-9:.]+: '
                r'Extension ' + re.escape(fork_uuid) + r': Error: ' +
                re.escape(conflict_messages[pending['phase']]), line):
            pending['lines'].append(line)
            continue
        match = re.fullmatch(r'\(gnome-shell:[0-9]+\): (GNOME Shell|Clutter)-CRITICAL '
                             r'\*\*: [0-9:.]+: (.*)', line)
        if match and match[1] == 'GNOME Shell' and (match[2] == calendar or login.fullmatch(match[2])):
            baseline.append({'category': 'private-service-unavailable', 'line': line})
        elif major == '50' and match and match[1] == 'Clutter' and in_menu and match[2] == allocation:
            baseline.append({'category': 'native-window-menu-allocation', 'line': line})
        else:
            unexpected.append(line)
    if pending:
        unexpected.extend([pending['marker'], *pending['lines']])
    if scenario == 'conflict' and observed != set(conflict_messages):
        unexpected.append('Incomplete intentional conflict error protocol: ' +
                          ', '.join(sorted(set(conflict_messages) - observed)))
    return baseline, unexpected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, nargs="?")
    parser.add_argument("--major", required=True, choices=("50", "51"))
    parser.add_argument("--scenario", choices=("full", "preferences", "conflict"), default="full")
    parser.add_argument("--log", type=Path)
    parser.add_argument("--screenshots-dir", type=Path,
                        help="Export two native PNGs and their manifest into a new directory after full acceptance")
    args = parser.parse_args()
    if args.screenshots_dir:
        if args.scenario != 'full':
            parser.error('--screenshots-dir requires --scenario full')
        args.screenshots_dir = args.screenshots_dir.absolute()
        if args.screenshots_dir.exists() or args.screenshots_dir.is_symlink():
            parser.error('--screenshots-dir must name a new directory; existing captures are preserved')
    if args.archive is None:
        import build
        args.archive = ROOT / "build" / f"unite-next-v{build.identity()['version']}.zip"
    signal.signal(signal.SIGTERM, lambda signum, frame: (_ for _ in ()).throw(SystemExit(128 + signum)))
    version = subprocess.check_output(["gnome-shell", "--version"], text=True, timeout=10).strip()
    if not re.search(rf"\b{args.major}\.", version):
        parser.error(f"Requested GNOME {args.major}, installed {version}")
    with tempfile.TemporaryDirectory(prefix=f"unite-gnome{args.major}-") as directory, ExitStack() as resources:
        base = Path(directory)
        candidate = base / "candidate.shell-extension.zip"
        metadata, archive_hash = stage_candidate_archive(args.archive, candidate, args.major)
        env = os.environ.copy()
        for key in ("DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS", "SESSION_MANAGER",
                    "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "AT_SPI_BUS_ADDRESS",
                    "GDK_BACKEND", "GSETTINGS_SCHEMA_DIR", "GTK_THEME", "GTK_PATH",
                    "WAYLAND_SOCKET", "XAUTHORITY", "IBUS_ADDRESS", "PULSE_SERVER", "PULSE_COOKIE",
                    "PIPEWIRE_REMOTE", "GDK_SCALE", "GDK_DPI_SCALE", "GTK_CSD", "GTK_MODULES"):
            env.pop(key, None)
        env.update({"HOME": directory, "UNITE_PRIVATE_TEST": "1", "GSETTINGS_BACKEND": "keyfile",
                    "LIBGL_ALWAYS_SOFTWARE": "1", "GDK_BACKEND": "wayland", "XDG_SESSION_TYPE": "wayland",
                    "XDG_CURRENT_DESKTOP": "GNOME", "MUTTER_WM_CLASS_FILTER":
                    "Gnome-shell-perf-helper,Gjs,org.unite.Acceptance,io.github.lucastsudaka.UniteNext.PreferencesAcceptance,io.github.lucastsudaka.UniteNext.PreferencesCapture",
                    "UNITE_TEST_SOURCE": str(ROOT), "NO_AT_BRIDGE": "1", "GTK_A11Y": "none",
                    "GIO_USE_VFS": "local"})
        prefixes = [Path('/usr/lib64'), Path('/usr/lib')]
        multiarch = sysconfig.get_config_var('MULTIARCH')
        if multiarch:
            prefixes.append(Path('/usr/lib') / multiarch)
        libraries = sorted({(prefix / 'gnome-shell').resolve() for prefix in prefixes
                            if (prefix / 'gnome-shell/girepository-1.0/Shew-0.typelib').is_file()})
        if len(libraries) != 1:
            raise RuntimeError(f'Expected one native GNOME preferences library directory, found {libraries}')
        env['UNITE_GNOME_LIBRARY_DIR'] = str(libraries[0])
        for name in ("CONFIG", "CACHE", "DATA", "RUNTIME"):
            path = base / name.lower()
            path.mkdir(mode=0o700)
            env[f"XDG_{name}_HOME" if name != "RUNTIME" else "XDG_RUNTIME_DIR"] = str(path)
        screenshots = base / 'screenshots'
        if args.screenshots_dir:
            screenshots.mkdir(mode=0o700)
            env['UNITE_SCREENSHOTS_DIR'] = str(screenshots)
        else:
            env.pop('UNITE_SCREENSHOTS_DIR', None)
        env['DBUS_SYSTEM_BUS_ADDRESS'] = resources.enter_context(private_system_bus(base))
        if args.scenario == 'conflict':
            install_conflict_fixture(ROOT / 'tests/fixtures/upstream-conflict', Path(env['XDG_DATA_HOME']),
                                     metadata['uuid'])
            env['UNITE_CONFLICT_FORK_UUID'] = metadata['uuid']
        else:
            env.pop('UNITE_CONFLICT_FORK_UUID', None)
        subprocess.run(["gnome-extensions", "install", "--print-uuid", str(candidate)],
                       env=env, check=True, timeout=10)
        for schema, key, value in [
            ("org.gnome.shell", "enabled-extensions", json.dumps([metadata['uuid']])),
            ("org.gnome.desktop.interface", "enable-animations", "false")]:
            subprocess.run(["gsettings", "set", schema, key, value], env=env, check=True, timeout=10)
        bus_config = base / 'session.conf'
        bus_config.write_text('''<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen>
<auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/>
<allow receive_sender="*"/><allow own="*"/></policy></busconfig>''')
        # No activation service directories: every fixture is explicitly spawned.
        # This also prevents a test bus from asking the host user manager to start units.
        automation, marker = {
            'full': ('desktop.js', 'UNITE_DESKTOP_PASS '),
            'preferences': ('desktop-preferences.js', 'UNITE_PREFERENCES_COMPONENT_PASS '),
            'conflict': ('desktop-conflict.js', 'UNITE_CONFLICT_PASS '),
        }[args.scenario]
        command = ["/usr/bin/dbus-run-session", f"--config-file={bus_config}", "--", "gnome-shell", "--headless",
                   "--virtual-monitor", "2560x1440", "--virtual-monitor", "1920x1080",
                   "--wayland-display", "unite-acceptance", "--automation-script", str(ROOT / 'tests' / automation)]
        process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, start_new_session=True)
        timeout = False
        output = ''
        def kill_group(sig):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
        try:
            output, _ = process.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            timeout = True
            kill_group(signal.SIGTERM)
            try:
                output, _ = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                kill_group(signal.SIGKILL)
                output, _ = process.communicate(timeout=5)
        finally:
            kill_group(signal.SIGKILL)
            # Reap the directly owned session on every exit path, including SIGTERM.
            if process.poll() is None:
                output, _ = process.communicate(timeout=5)
        if args.log:
            args.log.write_text(output)
        baseline, unexpected = classify_diagnostics(output, args.major, args.scenario, metadata['uuid'])
        passed = not timeout and process.returncode == 0 and marker in output and not unexpected
        captures = None
        capture_error = None
        print(output)
        if args.screenshots_dir and passed:
            try:
                if 'UNITE_SCREENSHOTS_PASS ' not in output:
                    raise RuntimeError('Full acceptance did not report native screenshot completion')
                captures = publish_screenshots(screenshots, args.screenshots_dir, archive_hash, version)
            except Exception as error:
                capture_error = str(error)
                passed = False
        print(json.dumps({"source_archive_sha256": archive_hash,
                          "native": version, "scenario": args.scenario, "exit": process.returncode, "timeout": timeout,
                          "baseline_diagnostics": baseline, "unexpected_diagnostics": unexpected,
                          "screenshots": captures, "screenshot_error": capture_error}))
        return int(not passed)


if __name__ == "__main__":
    with owned_descendants() as supervision:
        result = main()
    print('UNITE_PROCESS_CLEANUP ' + json.dumps(supervision))
    raise SystemExit(result)
