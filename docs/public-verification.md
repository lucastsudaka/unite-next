# Verification procedures

Source/package checks, isolated runtime scenarios and native compositor journeys cover different boundaries. A successful command alone does not establish desktop acceptance. Release notes identify the reviewed delivery commit, accepted CI artifact, installation ZIP digest and observed native results; this guide describes how those results can be reproduced.

## Source and runtime checks

Use the commands in [README](../README.md). The build validator checks JavaScript syntax/import closure, strict schema validity, complete theme assets, gettext parity and installation ZIP contents/CRC. Package scenarios exercise missing/invalid inputs, failed tools, version mismatch and preservation of existing output artifacts. Runtime scenarios use private HOME, temporary files, XDG state and settings, including activation/cleanup failures, GTK file conflicts, focused-window eligibility and notification request ownership. Native CSS scenarios check all 52 shipped theme variants, selector confinement, original import/asset bases, malformed input and staged-resource cleanup. Catalog tests compile and check all four accessible window-action names in each of the five supplied languages.

Expected gettext warnings about initial POT translator fields or the installed GTK ITS fallback are retained in command output. They do not replace the checks or permit invalid catalogs.

The generator uses a temporary native gettext compendium to recover existing human translations for thirteen explicitly reviewed equivalent labels of retained settings. It selects only translated, non-fuzzy historical entries with `msgattrib` and `msggrep`, preserves their original entries and provenance, and merges without fuzzy matching. Existing active translations take precedence. Messages describing changed behavior are not inferred from historical labels.

The X11 worker timeout scenario owns a loopback-only TCP server and uses an explicit `inet/127.0.0.1` display. It never contacts the user's X server and runs without a shared `/tmp/.X11-unix` directory; absence of that directory does not skip the scenario.

GTK transaction scenarios use private files and native atomic exchange. They
verify a concurrent edit after staging begins, writes through an already-open
descriptor after publication, a second edit during rollback, metadata/symlink
preservation, interruption and helper timeout. Displaced versions remain in the
private recovery directory described in the README. A GTK parser regression loads
the actual module from a path containing quotes, spaces and a backslash.

## Native desktop acceptance

Desktop-only dependencies include a matching GNOME Shell/GJS/Mutter stack, GTK 3/4, libadwaita, PyGObject, `xprop` as an independent X11 probe, a Portuguese locale and the matching GNOME Shell Portuguese translation catalog. Some distributions package that catalog separately. [GLib intentionally suppresses other-domain translations](https://docs.gtk.org/glib/func.dgettext.html) when the application's default domain has no catalog for the locale; an installed locale alone does not establish a translated Shell environment. GNOME 51 uses the pinned [container recipe](../tests/containers/Containerfile.gnome51). Run each major in its matching native environment; a newer host does not prove the earlier major.

The disposable GNOME 51 container runs as `65534:65534`, with no network or capabilities, a read-only root/source, private writable results and disposable `/tmp`/`/run`. Keep the native glycin/bubblewrap image sandbox and default seccomp active. On the tested SELinux-enforcing host, the default outer container label denied bubblewrap's nested `devpts` mount. The verified invocation adds `--security-opt label=type:container_engine_t`: Podman supports an explicit process type, and this SELinux domain permits nested container mounts. It is broader than the default container domain and is used only for this disposable test environment. Labels remain enforced; the extension and image sandbox are unchanged. The focused native bubblewrap probe must succeed before the full journey; a loader failure remains an acceptance failure. See [Podman 6.1.4 security options](https://github.com/podman-container-tools/podman/blob/v6.1.4/docs/source/markdown/options/security-opt.md) and the [container SELinux policy](https://github.com/containers/container-selinux/blob/main/container.te).

The tested host and pinned container have Portuguese locale data but omit the Shell application catalog. Their disposable test profile therefore adds the matching official [50.5 Portuguese catalog source](https://github.com/GNOME/gnome-shell/blob/50.5/po/pt_BR.po) or [51.0 source](https://github.com/GNOME/gnome-shell/blob/51.0/po/pt_BR.po). Compile that exact version with `msgfmt --check`, preserve the environment's existing `pt_BR/LC_MESSAGES` files in a disposable directory, and add the compiled `gnome-shell.mo` there. Before starting Shell, mount that directory read-only at `/usr/share/locale/pt_BR/LC_MESSAGES` inside the test namespace/container. This neither installs a host package nor changes the fork ZIP. The verified compiled catalog hashes are `8d2ab765cdc31cb521ed82802357aac9de6b1c2787a08a9ecd1127a62dcca65f` for 50.5 and `4d1a773619f5c11c8dffa701e5e03ea2bb17d342d6d69744898a0112c97c1f3d` for 51.0. A different native version needs its own matching catalog and verification.

After packaging, for each supported native environment:

```bash
/usr/bin/python3 tools/test-desktop.py --major 50 --log build/gnome50.log
/usr/bin/python3 tools/test-desktop.py --major 50 --scenario conflict --log build/gnome50-conflict.log
```

Use `51` and distinct output names in the GNOME 51 environment. Set `LC_ALL=pt_BR.UTF-8 LANG=pt_BR.UTF-8 LANGUAGE=pt_BR` for the full journey's native accessible-label assertions. The runner uses private session/system buses, HOME, settings, XDG state, `TMPDIR` and a headless compositor. Both bus endpoints are explicitly located under its private runtime directory; bus startup/address/cleanup tests check the actual daemon endpoint. Native image-loader temporary files therefore belong to the disposable session and are removed after its descendants are reaped. It must not use the user's active desktop or settings.

Startup uses private `enable-animations=true` and native `--force-animations`, following the [GNOME test tool's default animated profile](https://github.com/GNOME/gnome-shell/blob/51.0/src/gnome-shell-test-tool.in). GNOME [loads automation modules before connecting its startup-complete handler](https://github.com/GNOME/gnome-shell/blob/51.0/js/ui/main.js); each automation entrypoint checks during `init()` that startup is still pending and fails visibly if that signal has already passed. This detects late initialization without changing native startup events. The runner retains its 90-second deadline and does not automatically retry. Preserve failed attempts and their diagnostics separately from subsequent passing results; the profile and guard do not repair GNOME's native listener ordering.

The native [PerfHelper](https://github.com/GNOME/gnome-shell/blob/51.0/src/shell-perf-helper.c) normally destroys its test windows after 30 idle seconds. The runner reads the matching installed Shell resource configuration through an isolated native GJS process and uses the native scripting build-directory launcher mechanism to pass `--idle-timeout=90` to that exact helper. Its lifetime therefore covers the existing 90-second supervised journey; it is still explicitly terminated and reaped with the private session. The runner rejects missing, ambiguous or mismatched native resources instead of guessing a helper path. Input fixtures observe processed pointer coordinates, delivered control events and finished window/overview effects before advancing.

Normal journeys exercise installation, enable/disable/re-enable, preferences persistence and writability, themes and icon states, window actions, GTK 3/4 clients, XWayland property preservation, multi-monitor/scaling, localization and injected failures. They also verify that removed settings remain absent and stored retired-key values are left untouched. The conflict fixture uses the original UUID only as a disposable upstream stand-in; it is not a compatibility shim or distributed runtime component. Its original schema remains foreign test data. Conflict journeys verify startup rejection, late handoff through native deactivation, recovery, foreign settings/styles and visible cleanup failure.

Correction scenarios use a real skip-taskbar XWayland transient across an overview cycle, a secondary-monitor window with `Always` and primary restriction, real GTK 3/4 decoration clients with the restriction toggled, independent minimum/natural notification requests across scale changes and foreign updates, and a theme installed after activation with imported relative assets and root UUID/ancestor selectors. XWayland monitor transitions must restore/reapply exact absent/custom Motif values and switch a distinct window title to/from the application name. Native pointer input must reject restricted secondary-window actions and execute an unrestricted action exactly once. A foreign actor sharing the generic theme classes must keep its original styling. Native accessible labels must use the installed Portuguese catalog. These exercise actual actors and toolkit behavior in addition to isolated contract tests.

Control-theme staging keeps unchanged graph paths stable within an activation, unloads roots from the original and any replacement native theme, and removes generated files on teardown. Native St.Theme retains opaque imported-sheet parse caches until that theme object is destroyed; there is no public cache eviction API. The extension does not change native import cascade or patch theme internals to force eviction.

Inspect scenario results and diagnostics, including unexpected errors and process cleanup. Known headless-environment service diagnostics remain separately classified; injected error scenarios must identify their expected diagnostics precisely. Missing proof or an unexpected error remains a failed/pending acceptance condition.

## Executable native profiles

`tools/native-profile.py` prepares the current explicit GNOME 50.5 host and GNOME 51.0 image profiles around the unchanged native runner. It uses only an already installed host stack and an already available, immutable local Podman image ID. It never installs packages, pulls/builds images, changes host catalogs or retries a failed scenario. The image must retain its `65534:65534` user, native sandbox, default seccomp and the documented SELinux process type.

Supply the matching compiled Shell catalogs described above if those environments do not already contain them. Explicit catalog overrides must match the documented native-version hashes; every existing native catalog is copied unchanged into the disposable overlay. For the currently accepted local image:

```bash
/usr/bin/python3 tools/native-profile.py \
  --source . --archive build/unite-next-v1.zip \
  --image51 sha256:d67907a05a14eae2d8db0fbe0fd6c5c21cc7c9e0a40d738fbfa0a080e8faf82a \
  --catalog50 /path/to/gnome-shell-50.5.mo \
  --catalog51 /path/to/gnome-shell-51.0.mo \
  --output build/native-matrix
```

The output directory must be new. Add `--preflight-only` to validate source/archive correspondence, native resource versions, catalog preservation and fresh-process functional GLib translation without starting a compositor. `preflight_passed` does not establish desktop acceptance. A complete run executes full and conflict journeys once on each major, using one unchanged ZIP. `receipt.json` links command outputs, native results, process cleanup, image identity, catalogs and the declared source-input manifest; it records Git HEAD/dirtiness or the absence of an owning Git checkout. Changed source/candidate bytes, failed prerequisites, missing markers, unexpected critical diagnostics or remaining descendants prevent a passing receipt. Failed output remains available, and historical evidence is never replaced.

The source snapshot includes declared runtime, tool, test and gettext inputs,
the reviewed artwork inventory and source logo, applicable license texts, and the public publisher workflow consumed by its guard
regressions. It explicitly excludes build/Git/wrapper/specification/private
evidence files. Python/tool inputs have finite public names; update that
declaration when adding a native Python consumer. It is a verification input
closure, not the private export admission policy. Use the reviewed selected
delivery source as `--source` when proving public-source independence; an
authoring-tree run alone does not prove that boundary.

`tools/artwork.json` admits the current SVG set and distribution notices by
hash and records each group's applicable grant or original creation. Review
source/license evidence before changing that inventory. An edited inventory is
not itself proof of permission. The source gate rejects unreviewed additions or
mutations, invalid entries and missing original SPDX comments before running the
native packer; failed packaging preserves previous outputs. Original controls
and retained artwork share the same native/EGO payload and theme interfaces.

## Actual native screenshots

```bash
/usr/bin/python3 tools/test-desktop.py --major 50 --log build/gnome50-capture.log --screenshots-dir build/native-captures
```

The output directory must not exist. Capture uses the private compositor's native screenshot API and an explicit bounded ready/ack protocol. It waits for native window mapping/destruction effects and the target actor's transitions to finish; mapped or focused alone does not establish painted window content. Only after complete acceptance succeeds does the runner export the primary-monitor desktop, actual fork preferences and a manifest with native version, archive hash, dimensions and PNG hashes. Inspect the actual pixels before using the captures. No artificial mockup or active-user-desktop capture is used.

## Release correspondence

The source tag uses `unite-next-v<metadata version>` to preserve the upstream project's historical tags. GitHub source ZIP/tar.gz files are source snapshots. The named extension ZIP and its `.sha256` asset are the installation downloads.

The read-only CI build supplies separate `unite-next-native-candidate` and
`unite-next-ego-candidate` artifacts on the public repository's master push. Each
contains its ZIP, checksum and source-commit manifest with an explicit `channel`.
EGO preparation checks its complete payload and modes against the native package,
allowing only the documented version metadata projection. Preserve both manifests
and independently accept the exact artifact intended for distribution.

Accept the native artifact in isolated GNOME 50/51 and independently review its
corresponding source before dispatching the GitHub release workflow. The workflow
validates the selected successful build run, commit, artifact, digest, native
channel, metadata and complete source payload, and publishes the original accepted
ZIP without rebuilding a substitute. Publication is restricted to the confirmed
public independent repository. Existing tags/releases/assets are preserved;
partial external failures remain visible for inspection. The GitHub publisher
does not upload to EGO.

For the EGO channel, pass its explicit ZIP path as the first argument to
`tools/test-desktop.py` for both `full` and `conflict` on each major. Record its own
digest and observed results. Source correspondence is available through
`build.verify_source_archive(source, archive, channel="ego")` when importing the
native build module. The aggregate
`native-profile.py` retains its documented native-channel/version pins; a different
channel or native version requires explicit matching-environment proof and must
not be passed off as that pinned profile.
