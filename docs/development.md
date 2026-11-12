# Development ownership and verification

The extension runs inside GNOME Shell; preferences run in a separate GTK/Adwaita
process. Shared modules use libraries available in both processes. Native GJS
parsing in `tools/build.py check` follows static imports and re-exports from both
entrypoints and rejects incompatible process dependencies, including indirect
ones. It checks the selected source snapshot without executing extension code.
This complements the [GNOME process separation guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

## Working on a behavior

Find its implementation and focused scenarios below, inspect its consumers, then
run the relevant checks from the repository root. Tests derive expected results
from observable behavior; package integrity and desktop acceptance cover different
boundaries. `docs/public-verification.md` describes native prerequisites and
reproduction. Build outputs belong under the ignored `build` directory.

| Behavior | Implementation owner | Focused scenarios |
| --- | --- | --- |
| Activation, upstream exclusion and complete cleanup | `extension.js`, `extension-lifecycle.js`, `resources.js`, `features.js` | `tests/test-lifecycle.js`, `tests/test-resources.js`, `tests/test-features.js`, `tests/desktop-conflict.js`, `tests/desktop-failures.js` |
| Focused window eligibility, monitor policy and panel actions | `window.js`, `window-policy.js`, `panel-features.js`, `button-widgets.js` | `tests/test-window-policy.js`, `tests/test-window-controls.js`, `tests/test-panel.js`, `tests/desktop-input.js`, `tests/desktop-monitors.js` |
| GTK and Motif preservation | `gtk-styles.js`, `gtk-files.js`, `process-jobs.js`, `decorations.js`, `x11.py` | `tests/test-gtk-files.js`, `tests/test-process-jobs.js`, `tests/test_gtk_files.py`, `tests/test_x11.py`, `tests/desktop-capabilities.js`, `tests/desktop-x11.js` |
| Theme discovery, assets and CSS confinement | `theme.js`, `scoped-styles.js`, `styles.js`, `shell-styles.js` | `tests/test-scoped-styles.js`, `tests/test-window-controls.js`, `tests/desktop-corrections.js` |
| Desktop layout | `layout-features.js` | `tests/desktop.js`, `tests/desktop-corrections.js` |
| Preferences and localization | `prefs.js`, `preferences-widget.js`, `preferences-bindings.js`, schema/UI, gettext sources | `tests/test_preferences.py`, `tests/preferences.mjs`, `tests/desktop-preferences.js` |
| Accepted artifact origin, channel and unchanged transfer | `tools/candidate.py`, verification workflows | `tests/test_candidate.py`, `tests/test_release.py` |
| Source/package identity and import boundaries | `tools/build.py`, metadata, `tools/translations.py` | `tests/test_build.py` |
| Artwork admission and distribution notices | `tools/artwork.json`, `tools/build.py`, `NOTICE`, `docs/asset-provenance.md` | `tests/test_build.py` |

Runtime paths above are inside `unite-next@lucastsudaka.github.io/`.

## Composition and ownership

Native entrypoints import Shell resources and construct domain classes once with
explicit platform dependencies. Lifecycle, panel, layout and widget modules use
real ESM imports and accept only the native ports they consume. Tests import those
same modules; no loader rewrites imports or evaluates transformed source. The
package parser also rejects UI imports through these isolated domain owners.

`WindowManager` owns window state and decorations. `PanelManager` owns the single
synchronous presentation subscription and panel features. A notification failure
propagates to acquisition rollback; teardown disconnects the subscription before
destroying its consumers. Button actions resolve the current target at activation.
`window-policy.js` owns pure eligibility rules, and `decorations.js` owns decoration
state independently of the native Motif subprocess transport.
The helper reports an exact target-correlated `windowGone` result only for core
property requests rejected with BadWindow. The decoration owner accepts that
result only while draining after the native `unmanaged` signal. Normal completion,
disable restoration, foreign-property conflicts and other X11 errors remain
failures.

`resources.js` owns signals, timeouts and complete cleanup; `features.js` owns
feature transitions without injecting state into feature instances. `settings.js`
resolves the activation's schema and settings. GTK file transactions and Shell
styles have separate owners, coordinated by `styles.js`.

Existing GTK files use a GJS/GIO transaction with individually bounded GNU leaf
commands: a complete private stage is
atomically exchanged with the current file and the actual displaced inode is
retained under `.unite-next-gtk-recovery`. The post-exchange comparison detects
edits made during staging. On conflict, another exchange returns that displaced
version while retaining whatever occupied the destination; further concurrent
updates mean rollback cannot promise the newest version remains at `gtk.css`.
Every displaced inode remains recoverable, including writes through descriptors
held by other editors after the transaction. No automatic recovery garbage
collection is safe against such writers. Tests cover these boundaries and
timeouts; this protocol deliberately makes no linearizable CAS claim.

`file-reads.js` owns cancellable read-only GIO requests. It detaches delivery before
cancellation and consumes the eventual native finish result without retaining a
disposed desktop/transaction owner or starting more work.
`process-jobs.js` owns private command files, child completion polling, asynchronous
normal stdout/stderr collection and complete synchronous draining. X11 hide/show and GTK application/update coalesce while
commands execute. Removing a GTK owner, including a preference change that removes
global styling, restores synchronously before releasing ownership. Disable removes
polling, detaches pending read delivery and drains each owner before completing
restoration. An already-ready or cancelled read can finish later only to discard
its result; it cannot resume a transaction or reach the removed owner.
GTK uses `mv --exchange --no-copy`, `ln`, `realpath`, `sync`, `dd` and `timeout` from GNU
coreutils 9.5 or later. The native GJS owner performs metadata and content checks;
there is no second GTK scripting process. Temporary-file setup, metadata checks,
staging, cleanup and restoration fallbacks remain synchronous.

Every control-theme activation, reactivation and selection/brightness change uses
read-only asynchronous import preparation with the same CSS parser and lexical
asset bases. Compilation requires a prepared snapshot. `Styles` cancels an older
preparation before replacement/removal. Controls stay hidden and empty until the
first valid presentation. A first-theme failure logs its error and removes
candidate CSS/staging, retaining owned observers for retry by a valid selection or
feature reactivation. Actor/settings/signal acquisition failures still unwind
activation. The panel keeps any valid applied theme and variant until the latest
preparation succeeds, then applies the stylesheet, UUID class and action icons
together. Failure restores that presentation; reentrant settings changes supersede
the in-progress transition, including the first one. Native theme copies and an
in-progress candidate are explicitly owned during teardown.
Private generated CSS and native `St.Theme` application remain synchronous; this
does not claim that all filesystem I/O or native stylesheet parsing is nonblocking.

## Verification levels

```bash
/usr/bin/python3 tools/build.py check
/usr/bin/python3 -m unittest discover -s tests -p 'test_*.py' -v
/usr/bin/python3 tools/test-runtime.py
/usr/bin/python3 tools/build.py package
```

Python scenarios use disposable copies for package/schema/catalog changes. GJS
scenarios use private settings and XDG state. Native full and conflict journeys on
both supported Shell majors establish integrated acceptance of one exact archive;
source checks alone do not establish desktop behavior. Preserve failed attempts
and inspect diagnostics and descendant cleanup before accepting a run.

Use `tools/native-profile.py` with an explicit GNOME 51 image ID, catalog inputs and
a fresh output directory to stage and verify the same candidate on both majors.
The [public verification guide](public-verification.md) describes its preflight,
isolation, input correspondence and receipts. The profile uses already installed
tools and images.
Its default remains the native channel with a 50.5 host and 51.0 image; explicit
channel/version and host/image selections also cover the admitted 50.6 profile
without a private driver. The finite registry and real source exclusions are
covered by `tests/test_native_profile.py`. Image launcher cleanup reuses the
native runner's existing descendant owner; source/channel validation and native
result validation remain independent of publisher and repository admission.

Packaging discovers the runtime closure. Delivery admission separately uses an
explicit reviewed selection; these safeguards serve different boundaries. Release
verification binds the accepted archive to its source and build origin, and the
publisher independently validates it before any external write.
