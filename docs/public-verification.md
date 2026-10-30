# Verification procedures

Source/package checks, isolated runtime scenarios and native compositor journeys cover different boundaries. A successful command alone does not establish desktop acceptance. Release notes identify the reviewed delivery commit, accepted CI artifact, installation ZIP digest and observed native results; this guide describes how those results can be reproduced.

## Source and runtime checks

Use the commands in [README](../README.md). The build validator checks JavaScript syntax/import closure, strict schema validity, complete theme assets, gettext parity and installation ZIP contents/CRC. Package scenarios exercise missing/invalid inputs, failed tools, version mismatch and preservation of existing output artifacts. Runtime scenarios use private HOME, XDG state and settings, including activation/cleanup failures and GTK file conflicts.

Expected gettext warnings about initial POT translator fields or the installed GTK ITS fallback are retained in command output. They do not replace the checks or permit invalid catalogs.

## Native desktop acceptance

Desktop-only dependencies include a matching GNOME Shell/GJS/Mutter stack, GTK 3/4, libadwaita, PyGObject, `xprop` as an independent X11 probe and a Portuguese locale. GNOME 51 uses the pinned [container recipe](../tests/containers/Containerfile.gnome51). Run each major in its matching native environment; a newer host does not prove the earlier major.

The disposable GNOME 51 container runs as `65534:65534`, with no network or capabilities, a read-only root/source, private writable results and disposable `/tmp`/`/run`. Keep the native glycin/bubblewrap image sandbox and default seccomp active. On the tested SELinux-enforcing host, the default outer container label denied bubblewrap's nested `devpts` mount. The verified invocation adds `--security-opt label=type:container_engine_t`: Podman supports an explicit process type, and this SELinux domain permits nested container mounts. It is broader than the default container domain and is used only for this disposable test environment. Labels remain enforced; the extension and image sandbox are unchanged. The focused native bubblewrap probe must succeed before the full journey; a loader failure remains an acceptance failure. See [Podman 6.1.4 security options](https://github.com/podman-container-tools/podman/blob/v6.1.4/docs/source/markdown/options/security-opt.md) and the [container SELinux policy](https://github.com/containers/container-selinux/blob/main/container.te).

After packaging, for each supported native environment:

```bash
/usr/bin/python3 tools/test-desktop.py --major 50 --log build/gnome50.log
/usr/bin/python3 tools/test-desktop.py --major 50 --scenario conflict --log build/gnome50-conflict.log
```

Use `51` and distinct output names in the GNOME 51 environment. The runner uses private session/system buses, HOME, settings, XDG state and a headless compositor. It supervises and reaps its descendants. It must not use the user's active desktop or settings.

Normal journeys exercise installation, enable/disable/re-enable, preferences persistence and writability, themes and icon states, window actions, GTK 3/4 clients, XWayland property preservation, tray integration, multi-monitor/scaling, localization and injected failures. The conflict fixture uses the original UUID only as a disposable upstream stand-in; it is not a compatibility shim or distributed runtime component. Conflict journeys verify startup rejection, late handoff through native deactivation, recovery, foreign settings/styles and visible cleanup failure.

Inspect scenario results and diagnostics, including unexpected errors and process cleanup. Known headless-environment service diagnostics remain separately classified; injected error scenarios must identify their expected diagnostics precisely. Missing proof or an unexpected error remains a failed/pending acceptance condition.

## Actual native screenshots

```bash
/usr/bin/python3 tools/test-desktop.py --major 50 --log build/gnome50-capture.log --screenshots-dir build/native-captures
```

The output directory must not exist. Capture uses the private compositor's native screenshot API and an explicit bounded ready/ack protocol. Only after complete acceptance succeeds does the runner export the primary-monitor desktop, actual fork preferences and a manifest with native version, archive hash, dimensions and PNG hashes. No artificial mockup or active-user-desktop capture is used.

## Release correspondence

The source tag uses `unite-next-v<metadata version>` to preserve the upstream project's historical tags. GitHub source ZIP/tar.gz files are source snapshots. The named extension ZIP and its `.sha256` asset are the installation downloads.

The read-only CI build supplies an identified ZIP, checksum and source-commit manifest. Accept that exact artifact in isolated native GNOME 50/51 and independently review its corresponding source before dispatching the release workflow. The workflow validates the selected successful build run, commit, artifact, digest, metadata and complete source payload, and publishes the original accepted ZIP without rebuilding a substitute. Publication is restricted to the confirmed private independent repository. Existing tags/releases/assets are preserved; partial external failures remain visible for inspection.
