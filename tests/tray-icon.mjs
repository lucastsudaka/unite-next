// Deliberately use the retained Gtk3 XEmbed client to test the legacy tray contract.
import Gtk from 'gi://Gtk?version=3.0'
import GLib from 'gi://GLib'

if (GLib.getenv('UNITE_PRIVATE_TEST') !== '1' || ARGV.length !== 1) throw new Error('Private session and state path required')
Gtk.init(null)
const icon = Gtk.StatusIcon.new_from_icon_name('application-x-executable')
icon.set_title('Unite native tray acceptance')
let activations = 0
function report() {
  GLib.file_set_contents(ARGV[0], JSON.stringify({ embedded: icon.is_embedded(), activations }))
}
icon.connect('notify::embedded', report)
icon.connect('activate', () => { activations++; report() })
icon.set_visible(true)
report()
Gtk.main()
