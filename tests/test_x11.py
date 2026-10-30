"""Ownership/conflict and real worker supervision tests; no desktop writes."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

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
        # Own a fresh socket; never connect to the user's X server.
        directory = Path("/tmp/.X11-unix")
        if not directory.is_dir():
            self.skipTest("X11 socket directory unavailable")
        server = socket.socket(socket.AF_UNIX)
        owned_path = None
        for number in range(30000, 31000):
            path = directory / f"X{number}"
            try:
                server.bind(str(path))
                owned_path = path
                break
            except OSError:
                continue
        self.assertIsNotNone(owned_path, "No private X11 socket available")
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
                env = {**os.environ, "DISPLAY": f"unix/:{number}", "HOME": home,
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
            if owned_path:
                owned_path.unlink()


if __name__ == "__main__":
    unittest.main()
