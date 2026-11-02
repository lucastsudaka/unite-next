import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'
import { UniteNextPreferencesWidget } from './preferences-widget.js'

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
