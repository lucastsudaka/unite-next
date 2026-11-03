"""Ownership/conflict and real worker supervision tests; no desktop writes."""
import importlib.util
import errno
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[1] / "unite-next@lucastsudaka.github.io/x11.py"
spec = importlib.util.spec_from_file_location("unite_x11", HELPER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Store:
    def __init__(self, value):
        self.value = value
        self.events = []

    def grab(self):
        self.events.append("grab")

    def read(self):
        self.events.append("read")
        return self.value

    def write(self, value):
        self.events.append("write")
        self.value = value

    def ungrab(self):
        self.events.append("ungrab")


class OwnershipTests(unittest.TestCase):
    def test_exact_restore_and_absence(self):
        original = {"type": 128, "format": 32, "data": [1, 4, 1, 17, 42, 0xFFFFFFFF]}
        hidden = {"type": 128, "format": 32, "data": [3, 4, 2, 17, 42, 0xFFFFFFFF]}
        for value in [None, original]:
            store = Store(value)
            self.assertTrue(module.replace_owned(store, value, hidden))
            self.assertEqual(store.events, ["grab", "read", "write", "ungrab"])
            self.assertTrue(module.replace_owned(store, hidden, value))
            self.assertEqual(store.value, value)

    def test_foreign_update_is_not_overwritten(self):
        store = Store({"foreign": True})
        with self.assertRaisesRegex(ValueError, "Ownership conflict"):
            module.replace_owned(store, None, {"owned": True})
        self.assertEqual(store.value, {"foreign": True})
        self.assertEqual(store.events, ["grab", "read", "ungrab"])

    def test_foreign_update_matching_desired_is_still_a_conflict(self):
        store = Store({"desired": True})
        with self.assertRaisesRegex(ValueError, "Ownership conflict"):
            module.replace_owned(store, None, {"desired": True})
        self.assertNotIn("write", store.events)

    def test_unchanged_expected_value_is_noop(self):
        store = Store(None)
        self.assertFalse(module.replace_owned(store, None, None))
        self.assertNotIn("write", store.events)

    def test_invalid_snapshots_reject_before_x11(self):
        for value in [{}, {"type": 1, "format": 8, "data": [0] * 5},
                      {"type": 1, "format": 32, "data": [0] * 4},
                      {"type": 1, "format": 32, "data": [0, 0, -1, 0, 0]},
                      {"type": 1, "format": 32, "data": [0, 0, True, 0, 0]}]:
            with self.assertRaises(ValueError):
                module.snapshot(value)

    def test_only_target_badwindow_for_core_property_requests_means_gone(self):
        connection = module.Connection.__new__(module.Connection)
        connection.xid = 7
        connection.display = None
        connection.x = SimpleNamespace(XSync=lambda *_: None)
        for request in (18, 19, 20):
            with self.subTest(request=request):
                connection.errors = [(3, 7, request, 0)]
                with self.assertRaises(module.WindowGone):
                    connection.sync()
        for errors in ([(3, 8, 20, 0)], [(3, 7, 4, 0)], [(5, 7, 20, 0)],
                       [(3, 7, 20, 1)], [(3, 7, 20, 0), (5, 7, 20, 0)]):
            with self.subTest(errors=errors):
                connection.errors = errors
                with self.assertRaises(RuntimeError) as raised:
                    connection.sync()
                self.assertNotIsInstance(raised.exception, module.WindowGone)
                self.assertIn("X11 error", str(raised.exception))

    def test_destroyed_target_returns_explicit_result_and_releases_connection(self):
        class GoneStore(Store):
            atom = 71

            def __init__(self, phase):
                super().__init__(None)
                self.phase = phase

            def read(self):
                result = super().read()
                if self.phase == "read":
                    raise module.WindowGone("target destroyed during read")
                return result

            def write(self, value):
                self.events.append("write")
                raise module.WindowGone("target destroyed before write")

            def close(self):
                self.events.append("close")

        for operation, phase in (("read", "read"), ("replace", "read"), ("replace", "write")):
            connection = GoneStore(phase)
            with patch.object(module, "Connection", return_value=connection):
                result = module.worker({"operation": operation, "xid": "0x7", "expected": None,
                                        "value": {"type": 71, "format": 32, "data": [2, 0, 2, 0, 0]}})
            self.assertEqual(result, {"windowGone": True, "xid": "0x7"})
            self.assertEqual(connection.events[-1], "close")
            if phase == "write":
                self.assertEqual(connection.events, ["grab", "read", "write", "ungrab", "close"])
            elif operation == "replace":
                self.assertEqual(connection.events, ["grab", "read", "ungrab", "close"])

    def test_worker_preserves_live_ownership_conflicts_and_other_errors(self):
        for error in (ValueError("Ownership conflict: foreign value"), RuntimeError("X11 error 5")):
            def fail():
                raise error

            connection = SimpleNamespace(read=fail,
                                         close=lambda: closed.append(True), atom=71)
            closed = []
            with patch.object(module, "Connection", return_value=connection):
                with self.assertRaises(type(error)) as raised:
                    module.worker({"operation": "read", "xid": "0x7"})
            self.assertIs(raised.exception, error)
            self.assertEqual(closed, [True])

    def test_worker_failure_has_nonzero_exit_and_diagnostic(self):
        env = os.environ.copy()
        env["DISPLAY"] = "invalid-display"
        result = subprocess.run([sys.executable, HELPER], input=json.dumps(
            {"operation": "read", "xid": "0x1"}), env=env, capture_output=True,
            text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot connect", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_unresponsive_server_worker_is_killed_reaped_and_connection_closes(self):
        # Own a loopback-only fake X server; no shared X11 directory or display.
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(server.close)
        number = None
        for candidate in range(30000, 31000):
            try:
                server.bind(('127.0.0.1', 6000 + candidate))
                number = candidate
                break
            except OSError as error:
                if error.errno != errno.EADDRINUSE:
                    raise
        self.assertIsNotNone(number, "No private loopback X11 port available")
        try:
            server.listen(1)
            server.settimeout(5)
            disconnected = threading.Event()
            errors = []

            def stall():
                try:
                    connection, _ = server.accept()
                    with connection:
                        connection.settimeout(5)
                        while connection.recv(4096):
                            pass  # Deliberately never reply to the X11 handshake.
                        disconnected.set()
                except Exception as error:
                    errors.append(error)

            thread = threading.Thread(target=stall)
            thread.start()
            with tempfile.TemporaryDirectory(prefix="unite-x11-timeout-") as home:
                env = {**os.environ, "DISPLAY": f"inet/127.0.0.1:{number}", "HOME": home,
                       "XAUTHORITY": f"{home}/authority"}
                start = time.monotonic()
                result = subprocess.run([sys.executable, HELPER], input=json.dumps(
                    {"operation": "read", "xid": "0x1"}), capture_output=True,
                    text=True, env=env, timeout=5)
                elapsed = time.monotonic() - start
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertTrue(disconnected.is_set(), "Worker retained its X11 connection")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("timed out", result.stderr)
            self.assertLess(elapsed, 4, "Worker supervision exceeded its external bound")
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
