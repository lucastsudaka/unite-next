"""REQ-PACK-001/002 and REQ-I18N-001: real native tools, isolated source copies."""

import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import build
import translations


def translated_catalog_entries(data):
    """Read translated singular fixtures, keeping active and obsolete identities."""
    entries = {}
    for block in data.decode("utf-8").split("\n\n"):
        fields = {}
        section = None
        obsolete = False
        for line in block.splitlines():
            if line.startswith("#~ "):
                obsolete = True
                line = line[3:]
            if line.startswith("msgid "):
                section = "id"
                fields[section] = ast.literal_eval(line[6:])
            elif line.startswith("msgstr "):
                section = "value"
                fields[section] = ast.literal_eval(line[7:])
            elif line.startswith('"') and section:
                fields[section] += ast.literal_eval(line)
            else:
                section = None
        if fields.get("id") and fields.get("value"):
            entries[obsolete, fields["id"]] = fields["value"]
    return entries


class PackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="unite-package-tests-")
        cls.fixture = Path(cls.temporary.name) / "fixture"
        cls.fixture.mkdir()
        shutil.copytree(ROOT / build.EXTENSION, cls.fixture / build.EXTENSION)
        shutil.copytree(ROOT / "translations", cls.fixture / "translations")
        shutil.copyfile(ROOT / "LICENSE", cls.fixture / "LICENSE")
        shutil.copytree(ROOT / "LICENSES", cls.fixture / "LICENSES")
        (cls.fixture / "NOTICE").write_text("Package fixture attribution.\n", encoding="utf-8")
        metadata = cls.fixture / build.EXTENSION / "metadata.json"
        identity = json.loads(metadata.read_text(encoding="utf-8"))
        identity["version"] = 85  # Stable test input; unrelated release bumps do not change scenarios.
        metadata.write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")
        # These are private test derivatives, never published into the checkout.
        translations.generate(cls.fixture)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=self.temporary.name)
        self.root = Path(self.directory.name) / "source"
        shutil.copytree(self.fixture, self.root)
        self.output = Path(self.directory.name) / "output"
        self.output.mkdir()
        self.selected = self.output / "unite-next-v85.zip"
        self.unrelated = self.output / "unite-next-v84.zip"
        self.selected.write_bytes(b"previous selected artifact")
        self.unrelated.write_bytes(b"unrelated artifact")

    def tearDown(self):
        self.directory.cleanup()

    def assert_preserved(self):
        self.assertEqual(self.selected.read_bytes(), b"previous selected artifact")
        self.assertEqual(self.unrelated.read_bytes(), b"unrelated artifact")
        self.assertEqual(sorted(p.name for p in self.output.iterdir()),
                         ["unite-next-v84.zip", "unite-next-v85.zip"])

    def test_native_package_complete_and_replaces_only_selected_output(self):
        result = build.package(self.root, self.output, "85")
        self.assertEqual(result, self.selected)
        self.assertEqual(self.unrelated.read_bytes(), b"unrelated artifact")
        with zipfile.ZipFile(result) as archive:
            names = archive.namelist()
            self.assertIsNone(archive.testzip())
            for filename in build.REQUIRED_FILES:
                self.assertIn(filename, names)
            self.assertEqual(archive.read("metadata.json"),
                             (self.root / build.EXTENSION / "metadata.json").read_bytes())
            self.assertEqual(len([name for name in names if name.endswith(".mo")]), 5)
            self.assertNotIn("schemas/gschemas.compiled", names)
            self.assertFalse("animation.js" in names, "Obsolete GNOME 48 spinner workaround shipped")
            self.assertFalse(any(name.startswith(("tools/", ".agents/", "specs/"))
                                 for name in names))

    def test_native_package_includes_project_license_and_notice(self):
        license_bytes = (ROOT / "LICENSE").read_bytes()
        notice_bytes = b"Unite Next modifications; upstream attribution retained.\n"
        (self.root / "LICENSE").write_bytes(license_bytes)
        (self.root / "NOTICE").write_bytes(notice_bytes)
        result = build.package(self.root, self.output, "85")
        with zipfile.ZipFile(result) as archive:
            self.assertTrue("LICENSE" in archive.namelist(), "Installation ZIP lacks LICENSE")
            self.assertTrue("NOTICE" in archive.namelist(), "Installation ZIP lacks NOTICE")
            self.assertEqual(archive.read("LICENSE"), license_bytes)
            self.assertEqual(archive.read("NOTICE"), notice_bytes)
            self.assertEqual(archive.read("LICENSES/GPL-2.0.txt"),
                             (ROOT / "LICENSES/GPL-2.0.txt").read_bytes())

    def test_ego_package_changes_only_site_controlled_version_metadata(self):
        native = build.package(self.root, self.output, "85")
        original_native = native.read_bytes()
        ego = build.package(self.root, self.output, "85", channel="ego")
        self.assertEqual(ego, self.output / "ego" / f"{build.EXTENSION}.shell-extension.zip")
        with zipfile.ZipFile(native) as left, zipfile.ZipFile(ego) as right:
            left_files = {i.filename: left.read(i) for i in left.infolist() if not i.is_dir()}
            right_files = {i.filename: right.read(i) for i in right.infolist() if not i.is_dir()}
        self.assertEqual(left_files.keys(), right_files.keys())
        changed = [name for name in left_files if left_files[name] != right_files[name]]
        self.assertEqual(changed, ["metadata.json"])
        expected = json.loads(left_files["metadata.json"])
        del expected["version"]
        expected["version-name"] = "85"
        self.assertEqual(json.loads(right_files["metadata.json"]), expected)
        self.assertEqual(native.read_bytes(), original_native)
        self.assertEqual(json.loads((self.root / build.EXTENSION / "metadata.json").read_text())["version"], 85)
        self.assertEqual(build.verify_source_archive(self.root, ego, channel="ego")["channel"], "ego")
        for path, channel in ((ego, "native"), (native, "ego")):
            with self.subTest(channel=channel), self.assertRaisesRegex(ValueError, "metadata.json"):
                build.verify_source_archive(self.root, path, channel=channel)

    def test_ego_package_invalid_label_preserves_previous_artifacts(self):
        ego = self.output / "ego" / f"{build.EXTENSION}.shell-extension.zip"
        ego.parent.mkdir()
        ego.write_bytes(b"previous EGO candidate")
        metadata = self.root / build.EXTENSION / "metadata.json"
        identity = json.loads(metadata.read_text())
        identity["version"] = 10 ** 16
        metadata.write_text(json.dumps(identity))
        translations.generate(self.root)
        with self.assertRaisesRegex(ValueError, "version-name"):
            build.package(self.root, self.output, channel="ego")
        self.assertEqual(ego.read_bytes(), b"previous EGO candidate")
        self.assertEqual(self.selected.read_bytes(), b"previous selected artifact")

    def test_unknown_channel_fails_without_publishing(self):
        with self.assertRaisesRegex(ValueError, "Unknown package channel"):
            build.package(self.root, self.output, channel="unrecognized")
        self.assert_preserved()

    def test_ego_output_symlink_cannot_redirect_publication_into_runtime_sources(self):
        (self.output / "ego").symlink_to(self.root / build.EXTENSION, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "outside runtime source"):
            build.package(self.root, self.output, channel="ego")
        self.assertFalse((self.root / build.EXTENSION /
                          f"{build.EXTENSION}.shell-extension.zip").exists())
        self.assertTrue((self.output / "ego").is_symlink())
        self.assertEqual((self.output / "ego").resolve(), self.root / build.EXTENSION)
        self.assertEqual(self.selected.read_bytes(), b"previous selected artifact")
        self.assertEqual(self.unrelated.read_bytes(), b"unrelated artifact")

    def test_distribution_license_parent_cannot_select_external_bytes(self):
        licenses = self.root / "LICENSES"
        outside = self.root.parent / "external-license"
        licenses.rename(outside)
        licenses.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symbolic distribution license directory"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_ego_package_failure_preserves_existing_ego_and_native_outputs(self):
        ego = self.output / "ego" / f"{build.EXTENSION}.shell-extension.zip"
        ego.parent.mkdir()
        ego.write_bytes(b"previous EGO candidate")
        native_run = build.run
        def fail_pack(argv, *, cwd):
            if argv[:2] == ["gnome-extensions", "pack"]:
                raise subprocess.CalledProcessError(1, argv)
            return native_run(argv, cwd=cwd)
        with patch.object(build, "run", side_effect=fail_pack):
            with self.assertRaises(subprocess.CalledProcessError):
                build.package(self.root, self.output, channel="ego")
        self.assertEqual(ego.read_bytes(), b"previous EGO candidate")
        self.assertEqual(self.selected.read_bytes(), b"previous selected artifact")
        self.assertFalse(any(path.name.startswith(".unite-package-") for path in ego.parent.iterdir()))

    def test_existing_archive_correspondence_never_rebuilds_accepted_bytes(self):
        archive = build.package(self.root, self.output, "85")
        original = archive.read_bytes()
        result = build.verify_source_archive(self.root, archive)
        self.assertEqual(result["uuid"], "unite-next@lucastsudaka.github.io")
        self.assertEqual(result["version"], 85)
        self.assertEqual(archive.read_bytes(), original)

    def test_existing_archive_rejects_changed_source_without_modifying_it(self):
        archive = build.package(self.root, self.output, "85")
        original = archive.read_bytes()
        (self.root / "NOTICE").write_text("Changed corresponding source notice.\n")
        with self.assertRaisesRegex(ValueError, "Archive bytes differ.*NOTICE"):
            build.verify_source_archive(self.root, archive)
        self.assertEqual(archive.read_bytes(), original)

    def test_existing_archive_rejects_changed_compiled_catalog(self):
        archive = build.package(self.root, self.output, "85")
        changed = self.output / "changed.zip"
        with zipfile.ZipFile(archive) as source, zipfile.ZipFile(changed, "w") as destination:
            for item in source.infolist():
                data = source.read(item)
                if item.filename == "locale/pt_BR/LC_MESSAGES/unite-next.mo":
                    data += b"unexpected catalog bytes"
                destination.writestr(item, data)
        with self.assertRaisesRegex(ValueError, "Archive bytes differ.*unite-next.mo"):
            build.verify_source_archive(self.root, changed)

    def test_missing_distribution_notice_fails_before_publication(self):
        (self.root / "NOTICE").unlink()
        with self.assertRaisesRegex(ValueError, "distribution notice: NOTICE"):
            build.package(self.root, self.output, "85")
        self.assert_preserved()

    def test_mismatched_version_fails_before_any_native_tool(self):
        with patch.object(build, "run", side_effect=AssertionError("Tool unexpectedly ran")):
            with self.assertRaisesRegex(ValueError, "does not match"):
                build.package(self.root, self.output, "86")
        self.assert_preserved()

    def test_missing_source_is_rejected(self):
        (self.root / build.EXTENSION / "buttons.js").unlink()
        with self.assertRaisesRegex(ValueError, "Missing required"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_missing_referenced_theme_icon_is_rejected(self):
        (self.root / build.EXTENSION / "themes/default/light/close.svg").unlink()
        with self.assertRaises(subprocess.CalledProcessError):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_missing_tool_is_rejected(self):
        with patch.dict(os.environ, {"PATH": "/nonexistent-unite-tools"}):
            with self.assertRaises(FileNotFoundError):
                build.package(self.root, self.output)
        self.assert_preserved()

    def test_invalid_javascript_is_rejected_without_running_it(self):
        source = self.root / build.EXTENSION / "extension.js"
        source.write_text("export default class { broken( }", encoding="utf-8")
        with self.assertRaises(subprocess.CalledProcessError):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_missing_relative_import_is_rejected(self):
        source = self.root / build.EXTENSION / "extension.js"
        source.write_bytes(source.read_bytes() + b"\nimport './missing-runtime-module.js'\n")
        with self.assertRaisesRegex(ValueError, "Unresolved relative import"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_import_examples_in_comments_are_not_dependencies(self):
        source = self.root / build.EXTENSION / "extension.js"
        source.write_bytes(source.read_bytes() + b"\n// Example: from './not-an-import.js'\n")
        build.check(self.root)

    def test_shell_rejects_transitive_gtk_import_before_publication(self):
        source = self.root / build.EXTENSION
        (source / "extension.js").write_bytes(
            (source / "extension.js").read_bytes() + b"\nimport './wrong-process.js'\n")
        (source / "wrong-process.js").write_text("import Gtk from 'gi://Gtk?version=4.0'\n")
        with self.assertRaisesRegex(ValueError, "extension.js.*Gtk"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_preferences_rejects_transitive_shell_reexport(self):
        source = self.root / build.EXTENSION
        (source / "prefs.js").write_bytes(
            (source / "prefs.js").read_bytes() + b"\nexport * from './wrong-process.js'\n")
        (source / "wrong-process.js").write_text("import St from 'gi://St'\n")
        with self.assertRaisesRegex(ValueError, "prefs.js.*St"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_preferences_rejects_shell_resource_import(self):
        source = self.root / build.EXTENSION / "prefs.js"
        source.write_bytes(source.read_bytes() +
                          b"\nimport * as Main from 'resource:///org/gnome/shell/ui/main.js'\n")
        with self.assertRaisesRegex(ValueError, "prefs.js.*resource:"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_native_multiline_imports_and_shared_module_cycles_are_valid(self):
        source = self.root / build.EXTENSION
        (source / "prefs.js").write_bytes((source / "prefs.js").read_bytes() +
                                          b"\nimport {\n  value\n} from './shared-a.js'\n")
        (source / "shared-a.js").write_text(
            "import Gio from 'gi://Gio'\nimport './shared-b.js'\nexport const value = 1\n")
        (source / "shared-b.js").write_text("export * from './shared-a.js'\n")
        build.check(self.root)

    def test_isolated_factory_rejects_native_ui_import_allowed_in_shell(self):
        source = self.root / build.EXTENSION / "extension-lifecycle.js"
        source.write_bytes(source.read_bytes() + b"\nimport St from 'gi://St'\n")
        with self.assertRaisesRegex(ValueError, "extension-lifecycle.js.*St"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_isolated_policy_rejects_transitive_native_resource(self):
        source = self.root / build.EXTENSION
        policy = source / "window-policy.js"
        policy.write_bytes(policy.read_bytes() + b"\nexport * from './wrong-process.js'\n")
        (source / "wrong-process.js").write_text(
            "import * as Main from 'resource:///org/gnome/shell/ui/main.js'\n")
        with self.assertRaisesRegex(ValueError, "window-policy.js.*resource:"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_invalid_schema_fails_strict_native_validation(self):
        source = self.root / build.EXTENSION / "schemas/org.gnome.shell.extensions.unite-next.gschema.xml"
        source.write_text('<schemalist><schema id="org.gnome.shell.extensions.unite-next"><key name="invalid" '
                          'type="b"><default>not-a-boolean</default></key></schema></schemalist>',
                          encoding="utf-8")
        with self.assertRaises(subprocess.CalledProcessError):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_missing_effective_settings_schema_is_rejected(self):
        source = self.root / build.EXTENSION / "schemas/org.gnome.shell.extensions.unite-next.gschema.xml"
        source.write_text('<schemalist/>', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "settings-schema is absent"):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_concurrent_live_schema_fix_cannot_validate_bad_selected_bytes(self):
        source = self.root / build.EXTENSION / "schemas/org.gnome.shell.extensions.unite-next.gschema.xml"
        valid = source.read_bytes()
        source.write_text('<schemalist><schema id="org.gnome.shell.extensions.unite-next">'
                          '<key name="invalid" type="b"><default>invalid</default></key>'
                          '</schema></schemalist>', encoding="utf-8")
        original = build.run

        def repair_live_source(argv, **kwargs):
            if argv[:2] == ["gjs", "-c"]:
                source.write_bytes(valid)
            return original(argv, **kwargs)

        with patch.object(build, "run", side_effect=repair_live_source):
            with self.assertRaises(subprocess.CalledProcessError):
                build.package(self.root, self.output)
        self.assertEqual(source.read_bytes(), valid)
        self.assert_preserved()

    def test_invalid_catalog_is_rejected(self):
        (self.root / "translations/cs.po").write_text('msgid "unterminated', encoding="utf-8")
        with self.assertRaises(subprocess.CalledProcessError):
            build.package(self.root, self.output)
        self.assert_preserved()

    def test_packer_failure_preserves_both_artifacts(self):
        original = build.run

        def fail(argv, **kwargs):
            if argv[0] == "gnome-extensions":
                raise subprocess.CalledProcessError(17, argv)
            return original(argv, **kwargs)

        with patch.object(build, "run", side_effect=fail):
            with self.assertRaises(subprocess.CalledProcessError):
                build.package(self.root, self.output)
        self.assert_preserved()

    def test_invalid_staged_archive_preserves_both_artifacts(self):
        original = build.run

        def corrupt(argv, **kwargs):
            if argv[0] == "gnome-extensions":
                directory = Path(argv[argv.index("--out-dir") + 1])
                (directory / f"{build.EXTENSION}.shell-extension.zip").write_bytes(b"invalid zip")
                return b""
            return original(argv, **kwargs)

        with patch.object(build, "run", side_effect=corrupt):
            with self.assertRaises(zipfile.BadZipFile):
                build.package(self.root, self.output)
        self.assert_preserved()

    def test_interruption_before_publish_preserves_previous_artifact(self):
        with patch.object(build.os, "replace", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                build.package(self.root, self.output)
        self.assert_preserved()

    def test_parity_is_read_only_and_detects_stale_template(self):
        pot = self.root / "unite-next.pot"
        data = pot.read_bytes() + b"\n# stale generated template\n"
        pot.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "Stale gettext derivatives"):
            translations.check(self.root)
        self.assertEqual(pot.read_bytes(), data)

    def test_gettext_publication_failure_does_not_truncate_existing_file(self):
        pot = self.root / "unite-next.pot"
        pot.write_bytes(pot.read_bytes() + b"\n# stale derivative\n")
        original = pot.read_bytes()
        before = {str(path.relative_to(self.root)) for path in self.root.rglob("*")}
        with patch.object(translations.os, "replace", side_effect=OSError("injected publish failure")):
            with self.assertRaisesRegex(OSError, "injected publish failure"):
                translations.generate(self.root)
        self.assertEqual(pot.read_bytes(), original)
        self.assertEqual({str(path.relative_to(self.root)) for path in self.root.rglob("*")}, before)

    def assert_translations_preserved(self, before, after):
        expected = translated_catalog_entries(before)
        actual = translated_catalog_entries(after)
        self.assertTrue(expected)
        for identity, value in expected.items():
            self.assertIn(identity, actual, f"Lost translated entry: {identity}")
            self.assertEqual(actual[identity], value, f"Changed translation: {identity}")

    def test_catalog_merge_preserves_all_existing_translations(self):
        for language in ("cs", "fr", "ko", "nl", "pt_BR"):
            with self.subTest(locale=language):
                self.assert_translations_preserved(
                    (ROOT / f"translations/{language}.po").read_bytes(),
                    (self.root / f"translations/{language}.po").read_bytes())

    def test_preservation_check_detects_a_lost_active_or_obsolete_translation_in_every_locale(self):
        for language in ("cs", "fr", "ko", "nl", "pt_BR"):
            original = (self.root / f"translations/{language}.po").read_bytes()
            entries = translated_catalog_entries(original)
            for obsolete, message in ((False, "Close"), (True, "Extend top bar left box")):
                with self.subTest(locale=language, obsolete=obsolete):
                    prefix = "#~ " if obsolete else ""
                    previous = (f'{prefix}msgid {json.dumps(message)}\n'
                                f'{prefix}msgstr {json.dumps(entries[obsolete, message], ensure_ascii=False)}')
                    missing = f'{prefix}msgid {json.dumps(message)}\n{prefix}msgstr ""'
                    damaged = original.replace(previous.encode(), missing.encode(), 1)
                    self.assertNotEqual(damaged, original, "Loss fixture did not remove its translation")
                    with self.assertRaisesRegex(AssertionError, "Lost translated entry"):
                        self.assert_translations_preserved(original, damaged)

    def test_equivalent_renamed_messages_reuse_only_existing_human_translations(self):
        renamed = {
            "Extend top bar left box": "Extend top panel left box",
            "Show desktop name in top bar": "Show desktop name label in top panel",
            "Enable titlebar actions on top bar click": "Enable titlebar actions on top panel click",
            "Show window title in app menu": "Show window title in top panel appmenu",
            "Show window buttons in top bar": "Show window buttons in top panel",
            "Notification messages position": "System notification messages position",
            "Hide app menu application icon": "Hide application icon in appmenu button",
            "Reduce top bar items spacing": "Reduce top panel icons and buttons spacing",
            "Top bar desktop name text": "Desktop name label",
            "Max width for the app menu": "Maximum width for the appmenu button label",
            "Ellipsis mode for app menu": "Text ellipsis mode for appmenu button label",
            "Top bar window buttons position": "Window buttons position in top panel",
            "Top bar window buttons theme": "Top panel window buttons theme",
        }
        before = {}
        for catalog in sorted((self.root / "translations").glob("*.po")):
            # Retain real historical translations/provenance, with no active aliases.
            historical = translations.run(
                ["msgattrib", "--only-obsolete", "--no-wrap", str(catalog)], cwd=self.root)
            catalog.write_bytes(historical)
            before[catalog] = historical
        outputs = translations.generated(self.root)
        recovered = 0
        for catalog, historical in before.items():
            with self.subTest(locale=catalog.stem):
                self.assert_translations_preserved(historical, outputs[catalog])
                old = translated_catalog_entries(historical)
                current = translated_catalog_entries(outputs[catalog])
                for previous, message in renamed.items():
                    if (True, previous) in old:
                        self.assertEqual(current.get((False, message)), old[True, previous], message)
                        recovered += 1
                    else:
                        self.assertNotIn((False, message), current, "An untranslated label gained invented text")
                for message in ("Unavailable theme", "Hide workspace switcher button",
                                "Limit window actions and panel controls to the primary screen, including Always"):
                    self.assertNotIn((False, message), current, "Different/new behavior must retain explicit fallback")
        self.assertEqual(recovered, 59)

    def test_equivalent_message_recovery_keeps_an_existing_active_translation(self):
        message = "Extend top panel left box"
        for catalog in sorted((self.root / "translations").glob("*.po")):
            historical = translations.run(
                ["msgattrib", "--only-obsolete", "--no-wrap", str(catalog)], cwd=self.root)
            catalog.write_bytes(historical +
                f'\nmsgid "{message}"\nmsgstr "Current translation fixture"\n'.encode())
        outputs = translations.generated(self.root)
        for catalog in sorted((self.root / "translations").glob("*.po")):
            with self.subTest(locale=catalog.stem):
                self.assertEqual(translated_catalog_entries(outputs[catalog])[False, message],
                                 "Current translation fixture")
        for path, data in outputs.items():
            path.write_bytes(data)
        translations.check(self.root)


class ArchiveValidationTests(unittest.TestCase):
    def test_rejects_bad_crc(self):
        with tempfile.TemporaryDirectory(prefix="unite-crc-") as directory:
            path = Path(directory) / "corrupt.zip"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr("extension.js", b"unique expected bytes")
            path.write_bytes(path.read_bytes().replace(b"unique expected bytes", b"unique corrupted data"))
            with self.assertRaisesRegex(ValueError, "CRC mismatch"):
                build.validate_archive(path, {"extension.js": b"unique expected bytes"})

    def test_rejects_missing_extra_duplicate_unsafe_and_changed_contents(self):
        with tempfile.TemporaryDirectory(prefix="unite-zip-validation-") as directory:
            path = Path(directory) / "invalid.zip"
            for names in [[("metadata.json", b"expected")],
                          [("extension.js", b"expected"), ("tools/private.py", b"extra")],
                          [("extension.js", b"expected"), ("extension.js", b"expected")],
                          [("../extension.js", b"expected")],
                          [("extension.js", b"changed")]]:
                with self.subTest(names=[name for name, _ in names]):
                    with warnings.catch_warnings(record=True):
                        with zipfile.ZipFile(path, "w") as archive:
                            for name, data in names:
                                archive.writestr(name, data)
                    with self.assertRaises(ValueError):
                        build.validate_archive(path, {"extension.js": b"expected"})


if __name__ == "__main__":
    unittest.main()
