"""REQ-VERIFY-001: escaped native helpers are owned, bounded and reaped."""
import json
import importlib.util
import os
from pathlib import Path
import select
import signal
import subprocess
import unittest

RUNNER = Path(__file__).resolve().parents[1] / 'tools/test-desktop.py'
spec = importlib.util.spec_from_file_location('desktop_supervision', RUNNER)
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class DesktopDescendantTests(unittest.TestCase):
    def test_preexisting_child_is_preserved_and_supervision_is_refused(self):
        child = subprocess.Popen(['/usr/bin/sleep', '30'])
        try:
            with self.assertRaisesRegex(RuntimeError, 'no preexisting children'):
                with desktop.owned_descendants():
                    self.fail('Desktop scope admitted a preexisting child')
            self.assertIsNone(child.poll(), 'Refused scope altered a preexisting child')
        finally:
            child.terminate()
            child.wait(timeout=5)

    def supervise_orphan(self, zombie=False, failure=False, ignore_term=False):
        worker = f'''import os, signal, time
read_fd, write_fd = os.pipe()
pid = os.fork()
if pid:
    os.close(write_fd)
    assert os.read(read_fd, 1) == b'1'
    os.close(read_fd)
    if {zombie!r}:
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
    print(pid, flush=True)
    os._exit(0)
os.close(read_fd)
os.setsid()
os.close(1)
os.close(2)
if {ignore_term!r}:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
os.write(write_fd, b'1')
os.close(write_fd)
if {zombie!r}:
    os._exit(0)
time.sleep(300)
'''
        script = f'''import importlib.util, json, subprocess, sys
spec = importlib.util.spec_from_file_location('desktop', {str(RUNNER)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with module.owned_descendants() as report:
    pid = subprocess.check_output(['/usr/bin/python3', '-c', {worker!r}], text=True)
    print(pid.strip(), flush=True)
    sys.stdin.readline()
    if {failure!r}:
        raise LookupError('Injected desktop owner failure')
print(json.dumps(report), flush=True)
'''
        owner = subprocess.Popen(['/usr/bin/python3', '-c', script], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                 start_new_session=True)
        child_fd = None
        try:
            self.assertTrue(select.select([owner.stdout], [], [], 5)[0], 'Owner startup deadline')
            line = owner.stdout.readline().strip()
            self.assertTrue(line.isdecimal(), line)
            pid = int(line)
            child_fd = os.pidfd_open(pid)
            output, errors = owner.communicate('\n', timeout=12)
            self.assertEqual(owner.returncode, int(failure), (output, errors))
            self.assertTrue(select.select([child_fd], [], [], 0)[0], 'Escaped child survived owner')
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)  # Termination alone is insufficient: its PID must be reaped.
            if failure:
                self.assertIn('Injected desktop owner failure', errors)
            else:
                report = json.loads(output)
                self.assertEqual(report['scope'], 'linux_subreaper')
                self.assertEqual(report['remaining'], [])
                self.assertIn(pid, [child['pid'] for child in report['reaped']])
                if ignore_term:
                    self.assertIn({'pid': pid, 'signal': signal.SIGKILL.value}, report['terminated'])
        finally:
            if child_fd is not None:
                if not select.select([child_fd], [], [], 0)[0]:
                    signal.pidfd_send_signal(child_fd, signal.SIGKILL)
                os.close(child_fd)
            if owner.poll() is None:
                os.killpg(owner.pid, signal.SIGKILL)
                owner.communicate(timeout=5)

    def test_native_helper_zombie_is_adopted_and_reaped(self):
        self.supervise_orphan(zombie=True)

    def test_helper_in_another_session_is_terminated_and_reaped_after_owner_failure(self):
        self.supervise_orphan(failure=True)

    def test_unresponsive_helper_is_killed_within_shutdown_deadline_and_reaped(self):
        self.supervise_orphan(ignore_term=True)


if __name__ == '__main__':
    unittest.main()
