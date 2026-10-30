import Adw from 'gi://Adw'
import Gio from 'gi://Gio'
import Gtk from 'gi://Gtk'
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'
import * as Theme from './theme.js'
import { bindChoice, enumChoices } from './preferences-bindings.js'

class UniteNextPreferencesWidget {
  constructor(settings, template, gettext) {
    this._settings = settings
    this._gettext = gettext
    this._bindings = []
    this._buildable = Gtk.Builder.new_from_file(template)
    this._themes = new Theme.WindowControlsThemes()

    try {
      const choices = enumChoices(this._gettext)
      for (const [key, entries] of Object.entries(choices)) this._bindChoices(key, entries)
      this._bindThemes()

      // The schema owns types; only view properties are selected here.
      const properties = { b: 'active', i: 'value', s: 'text' }
      for (const key of this._settings.settings_schema.list_keys()) {
        if (key in choices || key === 'window-buttons-theme') continue

        const type = this._settings.settings_schema.get_key(key).get_value_type().dup_string()
        const property = properties[type]
        if (!property) throw new Error(`Unsupported preference type ${type} for ${key}`)
        this._settings.bind(key, this.getWidget(key), property, Gio.SettingsBindFlags.DEFAULT)
      }
    } catch (error) {
      this.destroy()
      throw error
    }
  }

  getWidget(name) {
    const widget = this._buildable.get_object(name.replace(/-/g, '_'))
    if (!widget) throw new Error(`Missing preference control ${name}`)
    return widget
  }

  _bindChoices(key, entries, unknownLabel = null) {
    const row = this.getWidget(key)
    const values = entries.map(([value]) => value)
    const model = Gtk.StringList.new(entries.map(([, label]) => label))
    row.set_model(model)

    const onUnknown = unknownLabel && (value => {
      values.push(value)
      model.append(`${unknownLabel}: ${value}`)
      return values.length - 1
    })
    this._bindings.push(bindChoice(this._settings, key, row, values, onUnknown))
  }

  _bindThemes() {
    const _ = this._gettext
    const themes = this._themes.available
      .filter(theme => theme.uuid !== 'auto' && theme.uuid !== 'default')
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
    const entries = [['auto', _('Auto')], ['default', _('Default')]]
    entries.push(...themes.map(theme => [theme.uuid, theme.name]))
    this._bindChoices('window-buttons-theme', entries, _('Unavailable theme'))
  }

  destroy() {
    this._bindings.splice(0).forEach(dispose => dispose())
    this._settings = null
    this._buildable = null
    this._themes = null
    this._gettext = null
  }
}

export default class UniteNextPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    // REQ-PREF-001: use the native metadata/schema lookup and per-window owner.
    const widget = new UniteNextPreferencesWidget(
      this.getSettings(), this.dir.get_child('settings.ui').get_path(), this.gettext.bind(this)
    )
    window.connect('close-request', () => {
      widget.destroy()
      return false
    })
    window.connect('destroy', () => widget.destroy())
    window.add(widget.getWidget('general_page'))
    window.add(widget.getWidget('windows_page'))
    window.set_default_size(620, 660)
  }
}
