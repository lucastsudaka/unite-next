#!/usr/bin/env python3
"""Run GJS contract tests with disposable home/settings/XDG state."""
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="unite-runtime-") as directory:
        env = os.environ.copy()
        env.update({"HOME": directory, "TMPDIR": directory,
                    "UNITE_PRIVATE_TEST": "1", "GSETTINGS_BACKEND": "memory"})
        for name in ("CONFIG", "CACHE", "DATA", "RUNTIME"):
            path = Path(directory) / name.lower()
            path.mkdir(mode=0o700)
            env[f"XDG_{name}_HOME" if name != "RUNTIME" else "XDG_RUNTIME_DIR"] = str(path)
        version = subprocess.check_output(["gnome-shell", "--version"], text=True, timeout=10)
        major = version.split()[-1].split('.')[0]
        abi = {'50': '18', '51': '51'}.get(major)
        if abi is None:
            raise RuntimeError(f'No accepted native test ABI for {version.strip()}')
        prefixes = [Path('/usr/lib64'), Path('/usr/lib')]
        multiarch = sysconfig.get_config_var('MULTIARCH')
        if multiarch:
            prefixes.append(Path('/usr/lib') / multiarch)
        directories = [prefix / f'mutter-{abi}' for prefix in prefixes
                       if (prefix / f'mutter-{abi}' / f'Clutter-{abi}.typelib').is_file()]
        if not directories:
            raise RuntimeError(f'Native Clutter-{abi} typelib was not found')
        shell_directories = [prefix / 'gnome-shell' for prefix in prefixes
                             if (prefix / 'gnome-shell' / f'St-{abi}.typelib').is_file()]
        if not shell_directories:
            raise RuntimeError(f'Native St-{abi} typelib was not found')
        directories.extend(shell_directories)
        for variable in ('GI_TYPELIB_PATH', 'LD_LIBRARY_PATH'):
            env[variable] = os.pathsep.join([*(str(path) for path in directories), env.get(variable, '')])
        env['UNITE_CLUTTER_VERSION'] = abi
        result = subprocess.run(["gjs", "-m", str(ROOT / "tests/test-lifecycle.js"), *sys.argv[1:]],
                                cwd=ROOT, env=env, timeout=30)
        if result.returncode or sys.argv[1:]:
            return result.returncode
        for script in ("test-resources.js", "test-process-jobs.js", "test-features.js", "test-window-policy.js",
                       "test-panel.js", "test-window-controls.js", "test-scoped-styles.js"):
            result = subprocess.run(["gjs", "-m", str(ROOT / "tests" / script)],
                                    cwd=ROOT, env=env, timeout=30)
            if result.returncode:
                return result.returncode
        return 0


if __name__ == "__main__":
    sys.exit(main())
