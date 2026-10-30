// Open the actual installed preferences without altering its settings for a capture.
import Adw from 'gi://Adw'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { waitForJson, writeJson } from './screenshot-protocol.mjs'

if (GLib.getenv('UNITE_PRIVATE_TEST') !== '1' || !['memory', 'keyfile'].includes(GLib.getenv('GSETTINGS_BACKEND'))) {
  throw new Error('Private capture session/settings required')
}
const [path, token, readyPath, ackPath] = ARGV
if (ARGV.length !== 4 || !token) throw new Error('Pass installed directory, capture token and ready/ack paths')
const directory = Gio.File.new_for_path(path)
const [, bytes] = directory.get_child('metadata.json').load_contents(null)
const metadata = { ...JSON.parse(new TextDecoder().decode(bytes)), dir: directory, path }
Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'))
const { default: Preferences } = await import(directory.get_child('prefs.js').get_uri())
const application = new Adw.Application({
  application_id: 'io.github.lucastsudaka.UniteNext.PreferencesCapture', flags: Gio.ApplicationFlags.NON_UNIQUE
})
let failure = null
application.connect('activate', () => {
  application.hold()
  ;(async () => {
    const preferences = new Preferences(metadata)
    const window = new Adw.PreferencesWindow({ application, title: metadata.name })
    try {
      await preferences.fillPreferencesWindow(window)
      window.present()
      const clock = window.get_frame_clock()
      let signal = 0
      let timeout = 0
      try {
        await new Promise((resolve, reject) => {
          signal = clock.connect('after-paint', () => {
            if (window.get_mapped() && window.get_width() > 0 && window.get_height() > 0) resolve()
          })
          timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            timeout = 0
            reject(new Error('Preferences capture did not acquire a mapped native frame'))
            return GLib.SOURCE_REMOVE
          })
          window.queue_draw()
        })
      } finally {
        if (signal) clock.disconnect(signal)
        if (timeout) GLib.source_remove(timeout)
      }
      writeJson(Gio.File.new_for_path(readyPath), { token, appId: application.application_id,
        title: window.title, width: window.get_width(), height: window.get_height() })
      await waitForJson(Gio.File.new_for_path(ackPath), value => value.token === token && value.captured === true,
        'preferences screenshot acknowledgement')
      print('PREFERENCES_SCREENSHOT_PASS')
    } finally {
      window.close()
    }
  })().catch(error => { failure = error; printerr(error.stack) }).finally(() => {
    application.release()
    application.quit()
  })
})
await application.runAsync([])
if (failure) throw failure
