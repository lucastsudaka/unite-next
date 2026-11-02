"""REQ-PREF/THEME/FEATURE: native tests run without a display or persistent settings."""
import gettext
import io
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
    def test_supplied_catalogs_localize_accessible_window_actions(self):
        labels = ("Close", "Minimize", "Restore", "Maximize")
        expected = {
            "cs": ("Zavřít", "Minimalizovat", "Obnovit", "Maximalizovat"),
            "fr": ("Fermer", "Réduire", "Restaurer", "Maximiser"),
            "ko": ("닫기", "최소화", "복원", "최대화"),
            "nl": ("Sluiten", "Minimaliseren", "Herstellen", "Maximaliseren"),
            "pt_BR": ("Fechar", "Minimizar", "Restaurar", "Maximizar"),
        }
        for locale, translations in expected.items():
            with self.subTest(locale=locale):
                result = subprocess.run(
                    ["msgfmt", "--check", "--output-file=-", str(ROOT / "translations" / f"{locale}.po")],
                    capture_output=True, timeout=10, check=True,
                )
                catalog = gettext.GNUTranslations(io.BytesIO(result.stdout))
                self.assertEqual(tuple(catalog.gettext(label) for label in labels), translations)

    def test_system_tray_schema_and_preferences_are_absent(self):
        schema = ET.parse(EXTENSION / "schemas/org.gnome.shell.extensions.unite-next.gschema.xml")
        template = ET.parse(EXTENSION / "settings.ui")
        keys = {key.attrib["name"] for key in schema.findall("schema/key")}
        controls = {node.attrib.get("id") for node in template.iter("object")}
        for key in ("show-legacy-tray", "greyscale-tray-icons"):
            with self.subTest(retired_setting=key):
                self.assertNotIn(key, keys)
                self.assertNotIn(key.replace("-", "_"), controls)
        self.assertNotIn("System Tray", {node.text for node in template.iter("property")})

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

    def test_native_import_probe_detects_eager_theme_and_preferences_allocations(self):
        for module in ("theme.js", "preferences-widget.js"):
            with self.subTest(module=module), tempfile.TemporaryDirectory(prefix="unite-import-probe-") as directory:
                fixture = Path(directory)
                shutil.copytree(EXTENSION, fixture / EXTENSION.name)
                (fixture / "tests").mkdir()
                shutil.copyfile(ROOT / "tests/preferences.mjs", fixture / "tests/preferences.mjs")
                source = fixture / EXTENSION.name / module
                source.write_bytes(source.read_bytes() + b"\nGio.File.new_for_uri('file:///synthetic-import-allocation')\n")
                result = subprocess.run(
                    ["gjs", "-m", str(fixture / "tests/preferences.mjs")],
                    env={**os.environ, "GSETTINGS_BACKEND": "memory"},
                    text=True, capture_output=True, timeout=30,
                )
                self.assertNotEqual(result.returncode, 0, "The fresh native import probe missed an eager allocation")
                self.assertIn("import creates no Gio.File before activation", result.stderr)

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
