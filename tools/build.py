#!/usr/bin/python3
"""Native source/package checks for REQ-PACK-001/002; no Node dependencies."""

import argparse
import ast
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

import translations


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = "unite-next@lucastsudaka.github.io"
LANGUAGES = ("cs", "fr", "ko", "nl", "pt_BR")
REQUIRED_FILES = ("extension.js", "prefs.js", "metadata.json", "settings.ui",
                  "buttons.js", "convenience.js", "resources.js", "settings.js",
                  "features.js", "gtk-styles.js", "shell-styles.js", "styles.js",
                  "layout.js", "panel.js", "theme.js", "window.js",
                  "button-widgets.js", "panel-features.js", "layout-features.js",
                  "extension-lifecycle.js", "window-policy.js", "decorations.js",
                  "preferences-widget.js",
                  "x11.py", "gtk-files.js", "process-jobs.js",
                  "schemas/org.gnome.shell.extensions.unite-next.gschema.xml")
PARSE_JS = """
const GLib = imports.gi.GLib;
const importsUsed = [];
for (const path of ARGV) {
  const [, data] = GLib.file_get_contents(path);
  const tree = Reflect.parse(new TextDecoder().decode(data), {target: 'module', source: path});
  for (const node of tree.body) {
    if (node.type === 'ImportDeclaration' ||
        (node.type === 'ExportDeclaration' && node.moduleRequest)) {
      const specifier = node.moduleRequest?.source?.value;
      if (typeof specifier !== 'string')
        throw new Error(`Unsupported native module request in ${path}`);
      importsUsed.push({path, specifier});
    }
  }
}
print(JSON.stringify(importsUsed));
"""


def run(argv, *, cwd):
    return translations.run(argv, cwd=cwd)


def identity(root=ROOT, version=None):
    metadata = json.loads((root / EXTENSION / "metadata.json").read_text(encoding="utf-8"))
    number = metadata.get("version")
    if type(number) is not int or number <= 0:
        raise ValueError("metadata.version must be a positive integer")
    if metadata.get("uuid") != EXTENSION or metadata.get("gettext-domain") != translations.DOMAIN:
        raise ValueError("Unexpected extension UUID or gettext domain")
    majors = metadata.get("shell-version")
    if not isinstance(majors, list) or not majors or any(
        not isinstance(item, str) or not re.fullmatch(r"[1-9][0-9]*", item) or int(item) < 50
        for item in majors
    ) or len(set(majors)) != len(majors):
        raise ValueError("shell-version must enumerate distinct GNOME majors >= 50")
    if version is not None and version != str(number):
        raise ValueError(f"Requested version {version!r} does not match metadata version {number}")
    return metadata


def source_files(root=ROOT):
    source = root / EXTENSION
    paths = {path for pattern in ("*.js", "*.ui", "metadata.json")
             for path in source.glob(pattern)}
    for name in ("x11.py",):
        helper = source / name
        if helper.exists():
            paths.add(helper)
    for directory in ("styles", "themes", "schemas"):
        base = source / directory
        if base.is_symlink() or not base.is_dir():
            raise ValueError(f"Missing or symbolic resource directory: {directory}")
        for path in base.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"Symbolic runtime source is not allowed: {path}")
            if path.is_file() and path.name != "gschemas.compiled":
                paths.add(path)
    files = {}
    for path in sorted(paths):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Invalid runtime source: {path}")
        relative = path.relative_to(source).as_posix()
        if path.suffix not in (".js", ".py", ".ui", ".json", ".css", ".svg", ".theme", ".xml"):
            raise ValueError(f"Unexpected runtime resource: {relative}")
        files[relative] = path.read_bytes()
    licenses = root / "LICENSES"
    if licenses.is_symlink() or not licenses.is_dir():
        raise ValueError("Missing or symbolic distribution license directory: LICENSES")
    for name in ("LICENSE", "NOTICE", "LICENSES/GPL-2.0.txt"):
        notice = root / name
        if notice.is_symlink() or not notice.is_file():
            raise ValueError(f"Missing or symbolic distribution notice: {name}")
        files[name] = notice.read_bytes()
    missing = set(REQUIRED_FILES) - files.keys()
    if missing:
        raise ValueError("Missing required runtime sources: " + ", ".join(sorted(missing)))
    if not any(name.startswith("themes/") for name in files) or not any(
        name.startswith("styles/") for name in files
    ):
        raise ValueError("Empty themes or styles directory")
    for name, data in files.items():
        if name.endswith((".ui", ".xml", ".svg")):
            ET.fromstring(data)
        if name.endswith(".py"):
            ast.parse(data.decode("utf-8"), filename=name)
    return files


def validate_module_imports(imported, source, files):
    """Check static import/re-export closure and native process boundaries.

    The GJS parser supplies module requests; comments and source formatting do
    not affect this graph. Shared Gio/GLib modules may serve both processes.
    """
    graph = {name: [] for name in files if name.endswith(".js")}
    for item in imported:
        name = Path(item["path"]).relative_to(source).as_posix()
        target = item["specifier"]
        if target.startswith("."):
            target = os.path.normpath((PurePosixPath(name).parent / target).as_posix())
            if target not in graph:
                raise ValueError(f"Unresolved relative import in {name}: {item['specifier']}")
        graph[name].append(target)

    boundaries = (
        ("extension.js", {"Gtk", "Gdk", "Adw"}, "resource:///org/gnome/Shell/Extensions/"),
        ("prefs.js", {"St", "Shell", "Meta", "Clutter"}, "resource:///org/gnome/shell/"),
    )
    # These owners are imported as real ESM by fast scenarios. Native UI types
    # and services enter their factories through the desktop composition only.
    isolated = ("resources.js", "settings.js", "features.js", "gtk-styles.js",
                "window-policy.js", "decorations.js", "extension-lifecycle.js",
                "button-widgets.js", "panel-features.js", "layout-features.js")
    boundaries += tuple((name, {"Gtk", "Gdk", "Adw", "St", "Shell", "Meta", "Clutter"}, "resource://")
                        for name in isolated if name in graph)
    for entry, forbidden_gi, forbidden_resource in boundaries:
        pending, visited = [entry], set()
        while pending:
            name = pending.pop()
            if name in visited:
                continue
            visited.add(name)
            for target in graph[name]:
                library = target.removeprefix("gi://").split("?", 1)[0]
                if (target.startswith("gi://") and library in forbidden_gi or
                        target.startswith(forbidden_resource)):
                    raise ValueError(f"{entry} imports unsupported process dependency {target} via {name}")
                if target in graph:
                    pending.append(target)


def check(root=ROOT, version=None):
    metadata = identity(root, version)
    files = source_files(root)
    if json.loads(files["metadata.json"]) != metadata:
        raise ValueError("Metadata changed during source snapshot; inspect and rerun")
    schemas = [ET.fromstring(data) for name, data in files.items()
               if name.startswith("schemas/") and name.endswith(".gschema.xml")]
    if not any(schema.get("id") == metadata.get("settings-schema")
               for tree in schemas for schema in tree.iter("schema")):
        raise ValueError("The metadata settings-schema is absent from the packaged schema XML")
    paths = sorted((root / "translations").glob("*.po"))
    if tuple(path.stem for path in paths) != LANGUAGES:
        raise ValueError("Expected the five supplied translation locales")
    catalogs = {}
    for path in paths:
        if path.is_symlink():
            raise ValueError(f"Symbolic translation catalog: {path}")
        catalogs[path.name] = path.read_bytes()
    # Every native validator reads the same selected bytes that will be packaged.
    with tempfile.TemporaryDirectory(prefix="unite-source-check-") as directory:
        snapshot = Path(directory)
        source = snapshot / EXTENSION
        for name, data in files.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (snapshot / "translations").mkdir()
        for name, data in catalogs.items():
            (snapshot / "translations" / name).write_bytes(data)
        (snapshot / "unite-next.pot").write_bytes((root / "unite-next.pot").read_bytes())
        imported = run(["gjs", "-c", PARSE_JS] +
                       [str(source / name) for name in files if name.endswith(".js")], cwd=snapshot)
        validate_module_imports(json.loads(imported), source, files)
        run(["gjs", "-m", str(ROOT / "tools/check-themes.mjs"), str(source)], cwd=snapshot)
        run(["glib-compile-schemas", "--strict", "--dry-run", str(source / "schemas")], cwd=snapshot)
        for name in catalogs:
            run(["msgfmt", "--check", "--output-file=/dev/null",
                 str(snapshot / "translations" / name)], cwd=snapshot)
        translations.check(snapshot)
    return metadata, files, catalogs


def validate_archive(path, expected):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("Archive contains duplicate paths")
        for entry in entries:
            name = entry.filename
            parts = PurePosixPath(name).parts
            mode = entry.external_attr >> 16
            if name.startswith("/") or "\\" in name or ".." in parts or not parts:
                raise ValueError(f"Unsafe archive path: {name}")
            if stat.S_ISLNK(mode) or entry.flag_bits & 1:
                raise ValueError(f"Unsupported archive entry: {name}")
            if entry.is_dir() and not any(item.startswith(name) for item in expected):
                raise ValueError(f"Unexpected archive directory: {name}")
        actual = {entry.filename for entry in entries if not entry.is_dir()}
        if actual != set(expected):
            raise ValueError(f"Archive content mismatch: missing {sorted(set(expected) - actual)}, "
                             f"extra {sorted(actual - set(expected))}")
        corrupt = archive.testzip()
        if corrupt:
            raise ValueError(f"Archive CRC mismatch: {corrupt}")
        for name, data in expected.items():
            if archive.read(name) != data:
                raise ValueError(f"Archive bytes differ from selected source: {name}")


def channel_files(metadata, files, channel):
    """Keep native source identity while projecting only EGO-controlled fields."""
    if channel not in ("native", "ego"):
        raise ValueError(f"Unknown package channel: {channel}")
    selected = dict(files)
    if channel == "ego":
        label = str(metadata["version"])
        if not re.fullmatch(r"[0-9]{1,16}", label):
            raise ValueError("EGO version-name must be the native version in at most 16 digits")
        projected = dict(metadata)
        projected.pop("version")
        projected["version-name"] = label
        selected["metadata.json"] = (json.dumps(projected, indent=2) + "\n").encode("utf-8")
    return selected


def verify_source_archive(root, archive, *, channel="native"):
    """Validate one existing ZIP against selected sources without rebuilding it."""
    metadata, files, catalogs = check(root)
    expected = channel_files(metadata, files, channel)
    for language in LANGUAGES:
        expected[f"locale/{language}/LC_MESSAGES/{metadata['gettext-domain']}.mo"] = translations.run(
            ["msgfmt", "--check", "--output-file=-", "-"], cwd=root,
            data=catalogs[f"{language}.po"])
    validate_archive(archive, expected)
    return {"uuid": metadata["uuid"], "version": metadata["version"],
            "channel": channel, "payload_files": len(expected)}


def package(root=ROOT, output_dir=None, version=None, *, channel="native"):
    metadata, files, selected_catalogs = check(root, version)
    files = channel_files(metadata, files, channel)
    destination = Path(output_dir) if output_dir is not None else root / "build"
    destination = destination.resolve()
    if destination == root.resolve() or destination.is_relative_to((root / EXTENSION).resolve()):
        raise ValueError("Package output must be outside runtime source directories")
    if channel == "ego":
        destination = (destination / "ego").resolve()
        if destination == root.resolve() or destination.is_relative_to((root / EXTENSION).resolve()):
            raise ValueError("Package output must be outside runtime source directories")
    destination.mkdir(parents=True, exist_ok=True)
    # Staging shares the destination filesystem so os.replace is atomic.
    with tempfile.TemporaryDirectory(prefix=".unite-package-", dir=destination) as temporary:
        stage = Path(temporary)
        source = stage / EXTENSION
        source.mkdir()
        for name, data in files.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        catalogs = stage / "translations"
        catalogs.mkdir()
        expected = dict(files)
        for language in LANGUAGES:
            path = catalogs / f"{language}.po"
            path.write_bytes(selected_catalogs[path.name])
            expected[f"locale/{language}/LC_MESSAGES/unite-next.mo"] = run(
                ["msgfmt", "--check", "--output-file=-", str(path)], cwd=stage)
        output = stage / "output"
        output.mkdir()
        extras = sorted({name.split("/")[0] for name in files} -
                        {"extension.js", "prefs.js", "metadata.json", "schemas"})
        argv = ["gnome-extensions", "pack", str(source), "--podir", str(catalogs),
                "--out-dir", str(output)]
        for name in extras:
            argv += ["--extra-source", name]
        run(argv, cwd=stage)
        candidate = output / f"{metadata['uuid']}.shell-extension.zip"
        validate_archive(candidate, expected)
        filename = (f"{metadata['uuid']}.shell-extension.zip" if channel == "ego" else
                    f"unite-next-v{metadata['version']}.zip")
        final = destination / filename
        os.replace(candidate, final)
    return final


def main():
    signal.signal(signal.SIGTERM, translations.interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "package", "version"))
    parser.add_argument("--version", help="Require this exact metadata extension version")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--channel", choices=("native", "ego"), default="native",
                        help="Package native version metadata or the independent EGO projection")
    args = parser.parse_args()
    if args.channel != "native" and args.command != "package":
        parser.error("--channel is only supported for package")
    try:
        if args.command == "version":
            print(identity(version=args.version)["version"])
        elif args.command == "check":
            check(version=args.version)
            print("source checks: passed")
        else:
            print(package(output_dir=args.output_dir, version=args.version, channel=args.channel))
    except (OSError, ValueError, ET.ParseError, SyntaxError, zipfile.BadZipFile,
            subprocess.SubprocessError) as error:
        print(f"{args.command} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
