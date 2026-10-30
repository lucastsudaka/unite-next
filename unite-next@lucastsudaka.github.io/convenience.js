import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

class SettingsAdapter {
  constructor(settings, writable = true) {
    this._settings = settings
    this._writable = writable
  }

  exists(key) {
    return this._settings.settings_schema.has_key(key)
  }

  getSetting(key) {
    if (this.exists(key)) return this._settings.get_value(key).deepUnpack()
  }

  setSetting(key, value) {
    if (!this._writable || !this.exists(key)) return false

    const schemaKey = this._settings.settings_schema.get_key(key)
    const variant = new GLib.Variant(schemaKey.get_value_type().dup_string(), value)
    if (!schemaKey.range_check(variant)) {
      throw new RangeError(`Invalid value for setting ${key}`)
    }

    return this._settings.set_value(key, variant)
  }

  connect(name, callback) {
    return this._settings.connect(name, callback)
  }

  disconnect(id) {
    this._settings.disconnect(id)
  }
}

class PreferencesAdapter extends SettingsAdapter {
  exists(key) {
    return ['window-buttons-position', 'window-buttons-layout'].includes(key) || super.exists(key)
  }

  getSetting(key) {
    const layout = this._settings.get_string('button-layout')
    if (key === 'window-buttons-position') {
      return /(close|minimize|maximize).*:/.test(layout) ? 'left' : 'right'
    }
    if (key === 'window-buttons-layout') {
      return layout.match(/close|minimize|maximize/g) || []
    }

    return super.getSetting(key)
  }
}

// REQ-PREF-001: the activation owner supplies the native extension settings.
export function adaptSettings(settings) {
  return new SettingsAdapter(settings)
}

export function getPreferences() {
  const settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' })
  return new PreferencesAdapter(settings, false)
}

export function getInterface() {
  const settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' })
  return new SettingsAdapter(settings, false)
}

export function getDir() {
  return Gio.File.new_for_uri(import.meta.url).get_parent()
}

export function getPath() {
  return getDir().get_path()
}
