#!/usr/bin/python3
"""Native gettext generation/parity for REQ-I18N-001; see docs/public-verification.md."""

import argparse
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
DOMAIN = "unite-next"
PROVENANCE_DATE = "1970-01-01 00:00+0000"
# Reviewed equivalent labels for retained settings, never new behavior text.
# The historical entries remain in each catalog with their original provenance.
RENAMED_MESSAGES = {
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


def run(argv, *, cwd, data=None):
    """Run a native tool without a shell, preserving visible failure diagnostics."""
    env = dict(os.environ, LC_ALL="C.UTF-8", TZ="UTC")
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, start_new_session=True)
    try:
        output, _ = process.communicate(input=data, timeout=60)
    except BaseException:
        # Kill the complete native-tool group, including packer/gettext children.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, argv)
    return output


def interrupted(signum, _frame):
    print(f"Operation interrupted by signal {signum}", file=sys.stderr)
    raise SystemExit(128 + signum)


def template(root=ROOT):
    """Extract both native source languages; normalize only creation provenance."""
    import json

    source = root / "unite-next@lucastsudaka.github.io"
    metadata = json.loads((source / "metadata.json").read_text(encoding="utf-8"))
    common = ["xgettext", "--from-code=UTF-8", "--package-name=unite-next",
              f"--package-version={metadata['version']}",
              "--copyright-holder=Unite Shell and Unite Next contributors",
              "--msgid-bugs-address=https://github.com/lucastsudaka/unite-next/issues",
              "--force-po", "--output=-"]
    with tempfile.TemporaryDirectory(prefix="unite-gettext-") as temporary:
        parts = []
        for language, paths in [
            ("Glade", sorted(source.glob("*.ui"))),
            ("JavaScript", sorted(source.glob("*.js"))),
        ]:
            output = run(common + [f"--language={language}"] +
                         [str(path.relative_to(root)) for path in paths], cwd=root)
            part = Path(temporary) / f"{language}.pot"
            part.write_bytes(output)
            parts.append(str(part))
        merged = run(["msgcat", "--use-first", "--no-wrap", "--output-file=-"] + parts,
                     cwd=root)
        converted = run(["msgconv", "--to-code=UTF-8", "--output-file=-", "-"],
                        cwd=root, data=merged)
    text = converted.decode("utf-8")
    text, count = re.subn(r'^"POT-Creation-Date: [^"\n]*\\n"$',
                          lambda _: f'"POT-Creation-Date: {PROVENANCE_DATE}\\n"',
                          text, flags=re.MULTILINE)
    if count != 1:
        raise ValueError("Expected exactly one gettext POT-Creation-Date header")
    output = text.encode("utf-8")
    run(["msgfmt", "--check", "--output-file=/dev/null", "-"], cwd=root, data=output)
    return output


def equivalent_translations(root, catalog):
    """Build a native compendium from explicitly matched historical translations."""
    historical = run(
        ["msgattrib", "--only-obsolete", "--clear-obsolete", "--translated", "--no-fuzzy",
         "--no-wrap", str(catalog.relative_to(root))], cwd=root)
    pattern = "^(" + "|".join(re.escape(message) for message in RENAMED_MESSAGES) + ")$"
    selected = run(
        ["msggrep", "--msgid", "--extended-regexp", f"--regexp={pattern}",
         "--no-wrap", "--output-file=-", "-"], cwd=root, data=historical)
    for previous, current in RENAMED_MESSAGES.items():
        # --no-wrap emits these finite singular IDs on one line. Only the ID is
        # renamed; msgstr bytes and translator comments are native gettext data.
        selected = re.sub(rb'^msgid "' + re.escape(previous.encode()) + rb'"$',
                          f'msgid "{current}"'.encode(), selected, flags=re.MULTILINE)
    return selected


def generated(root=ROOT):
    """Return outputs without writing; old msgstr values remain native merge inputs."""
    pot = template(root)
    outputs = {root / "unite-next.pot": pot}
    with tempfile.TemporaryDirectory(prefix="unite-compendium-") as temporary:
        compendium = Path(temporary) / "equivalent.po"
        for catalog in sorted((root / "translations").glob("*.po")):
            compendium.write_bytes(equivalent_translations(root, catalog))
            merged = run(["msgmerge", "--no-fuzzy-matching", "--previous", "--no-wrap",
                          f"--compendium={compendium}", "--output-file=-",
                          str(catalog.relative_to(root)), "-"], cwd=root, data=pot)
            run(["msgfmt", "--check", "--output-file=/dev/null", "-"], cwd=root, data=merged)
            outputs[catalog] = merged
    if len(outputs) != 6:
        raise ValueError("Expected five supplied translation catalogs")
    return outputs


def check(root=ROOT):
    stale = [str(path.relative_to(root)) for path, data in generated(root).items()
             if not path.is_file() or path.read_bytes() != data]
    if stale:
        raise ValueError("Stale gettext derivatives; run the authorized generator: " +
                         ", ".join(stale))


def generate(root=ROOT):
    paths = [root / "unite-next.pot", *sorted((root / "translations").glob("*.po"))]
    previous = {path: path.read_bytes() if path.exists() else None for path in paths}
    outputs = generated(root)
    if set(previous) != set(outputs) or any(
        (path.read_bytes() if path.exists() else None) != data
        for path, data in previous.items()
    ):
        raise ValueError("Gettext inputs changed during generation; inspect and rerun")
    for path, data in outputs.items():
        if previous[path] == data:
            continue
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
                os.fchmod(stream.fileno(), mode)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)


def main():
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("generate", "check"))
    args = parser.parse_args()
    try:
        if args.command == "generate":
            generate()
        else:
            check()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"gettext {args.command} failed: {error}", file=sys.stderr)
        return 1
    print(f"gettext {args.command}: passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
