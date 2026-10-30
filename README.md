# Unite Next

Unite Next is an independent fork of [Unite Shell](https://github.com/hardpixel/unite-shell) for GNOME Shell 50 and 51. It adds window controls and titles to the top panel, manages window decorations, and provides configurable panel spacing, notifications, desktop labels and X11 tray integration.

This repository is private during alpha development. Access to its sources, releases and issue tracker requires repository access. It is independently maintained and is not endorsed by the upstream project.

![Unite Next in an isolated GNOME 50 session](screenshot.png)

Native acceptance session with the GNOME performance-test client.

![Installed Unite Next preferences](settings.png)

## Compatibility and installation

GNOME Shell 50 is the minimum supported version. The exact supported majors are listed in [metadata.json](unite-next@lucastsudaka.github.io/metadata.json). GNOME 49 and earlier are unsupported; future majors are added only after integration testing.

Disable the original Unite Shell before enabling Unite Next. They can be installed together, with independent settings, but must not run together. If the original activates later, Unite Next releases its effects, requests its own native deactivation and reports the conflict. Disable the original before re-enabling Unite Next. A rejected startup is reported by GNOME as an extension error; use native extension reload or a new session after resolving that conflict. Actual cleanup failures remain visible and require inspection.

XWayland decoration handling requires system Python 3 and libX11. GTK 3 and GTK 4 application styling remain supported. GNU coreutils' `/usr/bin/ln` and `/usr/bin/timeout` provide exclusive, bounded GTK file publication. No third-party Python packages or runtime `xprop` are required.

| Distribution | Runtime packages |
| --- | --- |
| Debian / Ubuntu | `python3 libx11-6 coreutils` |
| Fedora | `python3 libX11 coreutils` |
| Arch Linux | `python libx11 coreutils` |

Download the alpha installation asset and checksum with an authenticated [GitHub CLI](https://cli.github.com/):

```bash
gh release download unite-next-v1 --repo lucastsudaka/unite-next --pattern 'unite-next-v1.zip*'
sha256sum --check unite-next-v1.zip.sha256
gnome-extensions install --force unite-next-v1.zip
```

Enable Unite Next in GNOME Extensions. GitHub's separate **Source code** downloads contain the sources; the named `unite-next-v1.zip` asset is the installable build. Generated builds are not committed to Git. See [releases](https://github.com/lucastsudaka/unite-next/releases) for the available versions.

## Build and verify

Build tools are system Python 3.9+, GJS, `gnome-extensions`, GNU gettext (`xgettext`, `msgcat`, `msgconv`, `msgmerge`, `msgfmt`) and `glib-compile-schemas`. Isolated resource tests also use `dbus-daemon` and `gdbus`. Node.js and Yarn are not required.

From a clean source checkout:

```bash
/usr/bin/python3 tools/build.py check
/usr/bin/python3 -m unittest discover -s tests -p 'test_*.py' -v
/usr/bin/python3 tools/test-runtime.py
/usr/bin/python3 tools/build.py package
```

The output is `build/unite-next-v<metadata version>.zip`. The metadata integer version is the release authority; `--version VERSION` asserts an exact match. Packaging stages privately, checks the native archive and atomically replaces only the selected output. A failed validation preserves existing artifacts.

The archive includes runtime modules/resources, preferences, schema XML, compiled locale catalogs, LICENSE and NOTICE. The GNOME installer compiles schemas. Sources retain the original PO catalogs and native build tools so the package can be rebuilt independently.

[Verification procedures](docs/public-verification.md) describe isolated native GNOME 50/51 acceptance, the conflict fixture, screenshot capture and the additional desktop-only dependencies. CI source/package checks supplement those native journeys.

## Source map and contribution

- `unite-next@lucastsudaka.github.io/extension.js`: activation, ownership and upstream conflict handling.
- `panel.js`, `window.js`, `layout.js` in that directory: desktop managers.
- `prefs.js`, `preferences-bindings.js`, `settings.ui`: native GTK/Adwaita preferences.
- `handlers.js`: owned signals, styles and cleanup; `x11.py`: bounded system-libX11 helper.
- `tools/`: native build, gettext and isolated verification entrypoints.
- `tests/`: normal, boundary and failure scenarios, including native compositor journeys.

Report issues and submit pull requests to [this repository](https://github.com/lucastsudaka/unite-next). Include GNOME version, relevant settings, reproduction steps and diagnostics. Run the checks for affected behavior; desktop-affecting changes require the native journeys described in the verification guide. Preserve unrelated user settings, GTK CSS and application-owned X11 properties.

Custom control themes live under `~/.local/share/unite-next/themes`. They must provide both variants and every close/minimize/maximize normal, hover and active asset. Optional `[Icons]` entries in `unite.theme` explicitly map intentionally shared artwork. An unavailable selection remains stored and visible in preferences; runtime reports use of the bundled default.

After changing marked UI/JavaScript strings, run the native generator and parity check:

```bash
/usr/bin/python3 tools/translations.py generate
/usr/bin/python3 tools/translations.py check
```

Generation preserves existing human translations and leaves new untranslated messages explicit. Keep the current native tooling and source conventions.

## License and credits

Unite Next retains [GPLv3](LICENSE). [NOTICE](NOTICE) records the supplying upstream source, dated modifications and attribution. [Asset provenance](docs/asset-provenance.md) records the inherited artwork and the limits of available per-theme attribution.

Original Unite Shell contributors retain credit for their work. Upstream credits [Pixel Saver](https://github.com/deadalnix/pixel-saver), [TopIcons Plus](https://github.com/phocean/TopIcons-plus) and [Extend Left Box](https://github.com/StephenPCG/extend-left-box) as inspiration. Translator credits remain in the PO catalogs. Historical upstream changelog links describe upstream releases.
