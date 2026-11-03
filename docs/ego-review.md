# EGO reviewer notes

Unite Next is an independent GPL fork of Unite Shell, with its own UUID,
GSettings schema, gettext domain and public issue tracker. The installable EGO
archive is built with `tools/build.py package --channel ego`; the site assigns
its internal `version`, while `version-name` follows the source native version.
Build tools, tests, PO sources, screenshots and this document remain in the source
repository rather than the installation archive. Applicable licenses and NOTICE
are included in both package channels.

## Lifecycle and process boundaries

Native entrypoints use `Extension` and `ExtensionPreferences`. Desktop services,
actors, settings, signals, timers and stylesheet ownership are acquired during
enable, never at import time. Preferences import GTK/Adwaita in their own process;
the Shell closure uses Shell libraries. `tools/build.py check` validates the
transitive import boundaries. Both native lifecycle methods remain synchronous.
Disable attempts every independent cleanup, releases references and reports
failures rather than treating failed restoration as success.

X11 hide/show and GTK application/update command completion is observed by an
owned removable GLib source;
GIO reaps the child, and private files carry command input/output without blocking
on a full pipe. Teardown removes the completion source, drains the bounded command
and completes restoration before returning. No GIO asynchronous completion callback
is left queued after disable. Local GIO file operations are still synchronous;
this design does not claim all filesystem I/O is nonblocking.
Removing a GTK owner, including a preference change that removes global styling,
also drains and restores synchronously before releasing ownership. Rollback and
window removal retain their deterministic draining boundary.

## XWayland property helper

`x11.py` is the sole Python runtime helper. It uses only the system standard
library and libX11, with no package installation. Exact `_MOTIF_WM_HINTS` type,
format, length and values, including property absence, must survive restoration.
The read/snapshot/compare-and-replace protocol protects foreign mutations with an
X server grab. GTK's bound APIs do not expose the required write operation:
[property_change](https://docs.gtk.org/gdk3/func.property_change.html) is unavailable
to bindings, and [property_get](https://docs.gtk.org/gdk3/func.property_get.html)
directs X11 clients to Xlib. GJS has no equivalent Xlib mutation binding in the
supported stack. Runtime `xprop` would not provide this complete transaction.
Python's ctypes supplies the missing native call without a bundled binary.

The helper supervisor owns its sole worker and kills/reaps it if the server stalls;
each request is bounded to one second. Normal requests are observed without
waiting in the Shell main loop. Disable may wait for a bounded in-flight request
and restoration, preserving the synchronous lifecycle guarantee. Errors are
reported. This is the functionality-based justification for the remaining
non-GJS script under the [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html#scripts-and-binaries);
acceptance of that justification belongs to EGO's reviewers.
If a property request reaches a window that has already been destroyed, the helper
returns a structured result correlated to that exact target. Only draining after
the native `unmanaged` signal accepts this result; a still-managed owner, ordinary
disable restoration, ownership conflict or other X11 error remains a visible
failure. This follows the [Xlib error definition](https://www.x.org/releases/X11R7.6/doc/libX11/specs/libX11/libX11.html):
BadWindow identifies a window argument that does not name a defined window.

## GTK file transactions

GTK editing now runs in the extension's GJS/GIO owner, replacing the Python GTK
helper. Existing bytes, metadata and concurrent edits must remain recoverable.
The transaction stages the complete update, preserves and verifies owner/group,
mode, timestamps and extended attributes, then uses GNU `mv --exchange --no-copy`
to retain the actual displaced inode beside the referent. A post-exchange content
check detects concurrent edits; rollback retains both versions on conflict.
Recovery files are never automatically deleted, because an editor can still hold
an open descriptor to the displaced inode. This is a recoverable exchange protocol,
not a filesystem compare-and-swap promise.
If the stage inherits extra metadata, such as a default ACL, that GIO cannot remove,
the transaction refuses publication before exchange and retains the original file.

GIO exposes file metadata but no atomic exchange or file/directory fsync operation
equivalent to this protocol. GNU coreutils 9.5 or later provides `mv`, `ln`,
`realpath`, `sync`, `dd` and `timeout` at their documented `/usr/bin` paths. `dd`
uses nonblocking, no-follow reads with file-type and inode checks so that a
concurrently substituted FIFO or symlink cannot block the Shell or silently select
a foreign referent. Binary command output preserves exact CSS bytes, including
line endings and byte-order marks; invalid UTF-8 fails without replacement. Each external
leaf command is independently bounded to one second, without a shell or child
scripting process. [GNU's exchange documentation](https://www.gnu.org/software/coreutils/manual/html_node/mv-invocation.html)
explains the same-filesystem atomic boundary; unsupported exchange fails visibly.
Native restoration drains the complete sequence synchronously, so its worst-case
wait includes multiple bounded commands. Cleanup failures remain observable.

## Upstream conflict

The two extensions can coexist on disk but change overlapping Shell state. Startup
rejects an active/activating upstream extension before acquiring desktop effects.
If upstream begins activating later, Unite Next first releases its own effects,
then requests its own native deactivation and reports the conflict. It does not
disable upstream, write upstream settings or patch native extension ordering.
Observers are owned and disconnected. Cleanup and deactivation failures remain
visible. This interaction with the extension manager requires case-by-case EGO
review; it is documented rather than presented as automatically acceptable.

## Assets and reproduction

[NOTICE](../NOTICE) preserves original attribution and applicable notices.
[Artwork provenance](asset-provenance.md) identifies 78 retained controls with
applicable source/grant evidence and 249 original GPL-3.0-or-later replacements.
All 26 theme IDs remain available; replacement designs retain the action/state
and variant interfaces. The source/package gate checks every admitted SVG hash,
original SPDX comments and the reviewed distribution notices. Earlier uncertain
artwork stays identifiable in history and is absent from the current package.
This documents applicable current coverage without making new claims about
permission for the retired historical images.

[Verification procedures](public-verification.md) describe source checks, private
settings/buses, full and upstream-conflict journeys, process supervision and exact
artifact correspondence on GNOME 50 and 51. A source check, successful build or
historical native result alone is insufficient to accept a changed archive. No
statement in this document claims EGO approval.
