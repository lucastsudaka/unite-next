"""A real private XWayland parent and skip-taskbar transient for native input tests."""
import os

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk

if os.environ.get("UNITE_PRIVATE_TEST") != "1":
    raise SystemExit("Private session required")

Gtk.init(None)
parent = Gtk.Window(title="Unite native parent", default_width=480, default_height=320)
parent.set_wmclass("unite-acceptance", "org.unite.Acceptance")
parent.add(Gtk.Label(label="Native parent"))
transient = Gtk.Window(title="Unite native transient", default_width=320, default_height=160)
transient.set_wmclass("unite-acceptance", "org.unite.Acceptance")
transient.set_transient_for(parent)
transient.set_type_hint(Gdk.WindowTypeHint.DIALOG)
transient.set_skip_taskbar_hint(True)
transient.add(Gtk.Label(label="Native skip-taskbar transient"))
parent.show_all()
transient.show_all()
# A fixture lifetime limit; the native runner also owns and reaps this process.
GLib.timeout_add_seconds(30, Gtk.main_quit)
Gtk.main()
transient.destroy()
parent.destroy()
