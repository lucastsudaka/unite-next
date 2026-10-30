"""REQ-PREF/THEME/FEATURE: native tests run without a display or persistent settings."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "unite-next@lucastsudaka.github.io"


class PreferencesTests(unittest.TestCase):
    def test_native_settings_choices_and_assets(self):
        self.assertIsNotNone(shutil.which("gjs"), "Install the documented native GJS test tool")
        result = subprocess.run(
            ["gjs", "-m", str(ROOT / "tests/preferences.mjs")],
            cwd=ROOT,
            env={**os.environ, "GSETTINGS_BACKEND": "memory"},
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("scenarios passed", result.stdout)

    def test_standalone_theme_validator_rejects_a_missing_asset(self):
        with tempfile.TemporaryDirectory(prefix="unite-theme-check-") as directory:
            fixture = Path(directory) / "extension"
            shutil.copytree(EXTENSION, fixture)
            missing = fixture / "themes/default/light/close.svg"
            missing.unlink()
            result = subprocess.run(
                ["gjs", "-m", str(ROOT / "tools/check-themes.mjs"), str(fixture)],
                env={**os.environ, "GSETTINGS_BACKEND": "memory"},
                text=True,
                capture_output=True,
                timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(str(missing), result.stderr)

    def test_each_schema_key_has_a_native_control(self):
        schema = ET.parse(EXTENSION / "schemas/org.gnome.shell.extensions.unite-next.gschema.xml")
        template = ET.parse(EXTENSION / "settings.ui")
        controls = {node.attrib["id"]: node for node in template.iter("object") if "id" in node.attrib}
        for key in schema.findall("schema/key"):
            name = key.attrib["name"]
            with self.subTest(setting=name):
                row = controls[name.replace("-", "_")]
                expected = "AdwComboRow" if "enum" in key.attrib or name == "window-buttons-theme" else {
                    "b": "AdwSwitchRow", "s": "AdwEntryRow", "i": "AdwSpinRow"
                }[key.attrib["type"]]
                self.assertEqual(row.attrib["class"], expected)
        self.assertNotIn("GtkComboBoxText", {node.attrib.get("class") for node in template.iter("object")})


if __name__ == "__main__":
    unittest.main()
