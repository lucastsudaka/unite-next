import Gtk from 'gi://Gtk?version=3.0'
import GdkX11 from 'gi://GdkX11?version=3.0'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

if (GLib.getenv('UNITE_PRIVATE_TEST') !== '1') throw new Error('Private session required')
Gtk.init(null)
const [helper, ready, mode] = ARGV
const window = new Gtk.Window({ title: `Unite XWayland ${mode}`, default_width: 480, default_height: 320 })
window.set_wmclass('unite-acceptance', 'org.unite.Acceptance')
window.add(new Gtk.Label({ label: 'GTK 3 XWayland acceptance fixture' }))
window.connect('destroy', () => Gtk.main_quit())
window.realize()
const nativeWindow = window.get_window()
const xid = `0x${nativeWindow.get_xid().toString(16)}`
nativeWindow.get_display().sync()
function request(data) {
  const process = Gio.Subprocess.new(['/usr/bin/python3', helper],
    Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
  const [, output, errors] = process.communicate_utf8(JSON.stringify({ ...data, xid }), null)
  if (!process.get_successful()) throw new Error(errors)
  return JSON.parse(output)
}
const { value: initial, type } = request({ operation: 'read' })
// Gtk.Window may supply hints itself; the fixture explicitly selects each case.
const original = mode === 'absent' ? null : { type, format: 32, data: [3, 4, 1, 17, 42, 0xffffffff] }
request({ operation: 'replace', expected: initial, value: original })
GLib.file_set_contents(ready, JSON.stringify({ xid, original }))
window.show_all()
Gtk.main()
