// REQ-PREF-001/002, REQ-I18N-001: invoke only inside the isolated GNOME acceptance session.
import Adw from 'gi://Adw'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Gtk from 'gi://Gtk?version=4.0'
import { LocaleCategory, setlocale } from 'gettext'

if (GLib.getenv('UNITE_PRIVATE_TEST') !== '1' || !['memory', 'keyfile'].includes(GLib.getenv('GSETTINGS_BACKEND'))) {
  throw new Error('Preferences window acceptance requires private session/settings state')
}
if (ARGV.length !== 1) throw new Error('Pass the isolated installed extension directory')
const nativeLocale = setlocale(LocaleCategory.MESSAGES, null)
print(`PREFERENCES_WINDOW_LOCALE ${JSON.stringify({
  requested: GLib.getenv('LANGUAGE'), native: nativeLocale
})}`)
if (GLib.getenv('LANGUAGE')?.split(':')[0] === 'pt_BR' && /^(C|POSIX)([.@]|$)/.test(nativeLocale)) {
  throw new Error('Portuguese preferences acceptance requires an installed non-C UTF-8 locale; set LC_ALL=pt_BR.UTF-8')
}

const directory = Gio.File.new_for_path(ARGV[0])
const [, metadataBytes] = directory.get_child('metadata.json').load_contents(null)
const metadata = { ...JSON.parse(new TextDecoder().decode(metadataBytes)), dir: directory, path: directory.get_path() }
Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'))
const { default: Preferences } = await import(directory.get_child('prefs.js').get_uri())
const { bindChoice } = await import(directory.get_child('preferences-bindings.js').get_uri())

let assertions = 0
let failure = null
let acquisition = 'imports-complete'
let inspectedWindow = null
function progress(name) {
  acquisition = name
  const window = inspectedWindow
  const surface = window?.get_surface()
  print(`PREFERENCES_WINDOW_STAGE ${JSON.stringify({
    stage: name, time: GLib.get_monotonic_time(),
    visible: window?.get_visible(), realized: window?.get_realized(), mapped: window?.get_mapped(),
    width: window?.get_width(), height: window?.get_height(),
    surfaceMapped: surface?.get_mapped(), frameTime: window?.get_frame_clock()?.get_frame_time()
  })}`)
}
async function bounded(promise, description, cleanup = () => {}) {
  let source = 0
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
          source = 0
          const previous = acquisition
          progress(`${description}-deadline`)
          reject(new Error(`Timed out acquiring ${description}; previous stage ${previous}`))
          return GLib.SOURCE_REMOVE
        })
      })
    ])
  } finally {
    if (source) GLib.source_remove(source)
    cleanup()
  }
}
function equal(actual, expected, message) {
  assertions++
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, observed ${actual}`)
}
function check(condition, message) { equal(Boolean(condition), true, message) }
function controlsIn(widget, result = new Map()) {
  const id = widget.get_buildable_id?.()
  if (id) result.set(id, widget)
  for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) controlsIn(child, result)
  return result
}
const choices = {
  'show-window-title': ['never', 'tiled', 'maximized', 'both', 'always'],
  'show-window-buttons': ['never', 'tiled', 'maximized', 'both', 'always'],
  'hide-window-titlebars': ['never', 'tiled', 'maximized', 'both', 'always'],
  'notifications-position': ['center', 'left', 'right'],
  'hide-activities-button': ['never', 'auto', 'always'],
  'window-buttons-placement': ['auto', 'left', 'right', 'first', 'last'],
  'app-menu-ellipsize-mode': ['start', 'middle', 'end']
}
const application = new Adw.Application({
  application_id: 'io.github.lucastsudaka.UniteNext.PreferencesAcceptance', flags: Gio.ApplicationFlags.NON_UNIQUE
})
application.connect('activate', () => {
  progress('application-activate')
  application.hold()
  ;(async () => {
    progress('preferences-construct')
    const preferences = new Preferences(metadata)
    const writer = preferences.getSettings()
    for (const key of writer.settings_schema.list_keys()) writer.reset(key)
    writer.set_string('window-buttons-theme', 'unavailable-acceptance-theme')
    progress('window-construct')
    const window = new Adw.PreferencesWindow({ application })
    inspectedWindow = window
    for (const signal of ['realize', 'map', 'unmap', 'unrealize']) {
      window.connect(signal, () => progress(`window-${signal}`))
    }
    progress('fill-start')
    await preferences.fillPreferencesWindow(window)
    progress('fill-complete')
    window.present()
    progress('present-returned')
    let tick = 0
    await bounded(new Promise(resolve => {
      tick = window.add_tick_callback(() => {
        tick = 0
        progress('first-frame')
        resolve()
        return GLib.SOURCE_REMOVE
      })
    }), 'first-frame', () => { if (tick) window.remove_tick_callback(tick) })
    check(window.get_mapped(), 'Native preferences window is mapped')
    check(window.get_width() > 0 && window.get_height() > 0, 'Native preferences window is allocated')
    const controls = controlsIn(window)
    progress('controls-discovered')
    const rowFor = key => {
      const row = controls.get(key.replace(/-/g, '_'))
      if (!row) throw new Error(`Missing native control ${key}`)
      return row
    }
    for (const [key, nicks] of Object.entries(choices)) {
      const row = rowFor(key)
      check(row instanceof Adw.ComboRow, `Native combo row ${key}`)
      const defaultValue = writer.get_default_value(key).deepUnpack()
      equal(row.selected, nicks.indexOf(defaultValue), `Initial selection ${key}`)
      const selected = row.selected === 0 ? nicks.length - 1 : 0
      row.selected = selected
      equal(writer.get_string(key), nicks[selected], `Native control writes ${key}`)
      const external = selected === 0 ? 1 : 0
      writer.set_string(key, nicks[external])
      equal(row.selected, external, `External update reaches native control ${key}`)
      writer.reset(key)
      equal(row.selected, nicks.indexOf(defaultValue), `External reset reaches native control ${key}`)
    }
    for (const key of writer.settings_schema.list_keys()) {
      if (key in choices || key === 'window-buttons-theme') continue
      const row = rowFor(key)
      const initial = writer.get_value(key)
      const type = initial.get_type_string()
      const property = { b: 'active', s: 'text', i: 'value' }[type]
      const klass = { b: Adw.SwitchRow, s: Adw.EntryRow, i: Adw.SpinRow }[type]
      check(row instanceof klass, `Native property row ${key}`)
      equal(row[property], initial.deepUnpack(), `Initial native property ${key}`)
      const change = type === 'b' ? !initial.deepUnpack() : type === 's' ? 'Private preference acceptance' : 137
      row[property] = change
      equal(writer.get_value(key).deepUnpack(), change, `Native property writes ${key}`)
      writer.set_value(key, initial)
      equal(row[property], initial.deepUnpack(), `External update reaches native property ${key}`)
      writer.reset(key)
      equal(row[property], writer.get_default_value(key).deepUnpack(), `External reset reaches native property ${key}`)
    }
    const theme = rowFor('window-buttons-theme')
    equal(writer.get_string('window-buttons-theme'), 'unavailable-acceptance-theme', 'Unknown initial theme ID survives window creation')
    check(theme.get_selected_item().get_string().includes('unavailable-acceptance-theme'), 'Unknown theme is visibly identified')
    check(theme.get_selected_item().get_string().startsWith(preferences.gettext('Unavailable theme')), 'Unknown theme presentation uses gettext')
    writer.set_string('window-buttons-theme', 'another-unavailable-acceptance-theme')
    check(theme.get_selected_item().get_string().includes('another-unavailable-acceptance-theme'), 'External unavailable theme is visibly selected')
    equal(writer.get_string('window-buttons-theme'), 'another-unavailable-acceptance-theme', 'Unknown external theme ID remains persisted')
    theme.selected = 1
    equal(writer.get_string('window-buttons-theme'), 'default', 'Choosing an available theme persists its stable ID')
    const never = rowFor('show-window-buttons')
    never.selected = 0
    equal(never.get_selected_item().get_string(), preferences.gettext('Never'), 'Choice labels use installed locale catalogs')
    if (GLib.get_language_names().some(language => language.startsWith('pt_BR'))) {
      equal(controls.get('general_page').title, 'Geral', 'Existing human pt_BR page translation is displayed')
      equal(never.get_selected_item().get_string(), 'Nunca', 'Existing human pt_BR choice translation is displayed')
    }
    const locked = Gio.Settings.new_full(writer.settings_schema, Gio.null_settings_backend_new(), null)
    const lockedRow = new Adw.ComboRow({ model: Gtk.StringList.new(['Never', 'Tiled', 'Maximized', 'Both', 'Always']) })
    const disposeLocked = bindChoice(locked, 'show-window-buttons', lockedRow, choices['show-window-buttons'])
    equal(lockedRow.sensitive, false, 'Actual Adw row reflects a locked backend')
    lockedRow.selected = 0
    equal(lockedRow.selected, 2, 'Actual Adw row rejects a locked edit')
    disposeLocked()
    progress('bindings-verified')

    let postCloseChanges = 0
    never.connect('notify::selected', () => postCloseChanges++)
    const closed = new Promise(resolve => window.connect('close-request', () => { resolve(); return false }))
    window.close()
    await bounded(closed, 'window-close')
    postCloseChanges = 0
    writer.set_string('show-window-buttons', 'always')
    equal(postCloseChanges, 0, 'Closed preferences retain no manual settings binding')
    for (const key of writer.settings_schema.list_keys()) writer.reset(key)
    print(`PREFERENCES_WINDOW_PASS assertions=${assertions} languages=${GLib.get_language_names().join(',')}`)
  })().catch(error => {
    failure = error
    printerr(error.stack)
  }).finally(() => {
    inspectedWindow = null
    application.release()
    application.quit()
  })
})
progress('application-run')
// Let GJS enter the native GTK loop after module evaluation has yielded;
// synchronous run() stalls this Adwaita activate handler's await continuation.
await application.runAsync([])
if (failure) throw failure
