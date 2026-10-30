"""Private-state GJS verification for GTK file publication and failure cleanup."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


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
        self.assertIn("GTK_FILE_TESTS_PASS scenarios=9", result.stdout)


if __name__ == "__main__":
    unittest.main()
