import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import * as Convenience from './convenience.js'

const ACTIONS = ['close', 'minimize', 'maximize']
const STATES = ['default', 'hover', 'active']

function fileExists(path) {
  return GLib.file_test(path, GLib.FileTest.IS_REGULAR)
}

export function isColorDark({ red, green, blue }) {
  // HSP equation from http://alienryderflex.com/hsp.html
  const hsp = Math.sqrt(
    0.299 * (red * red) +
    0.587 * (green * green) +
    0.114 * (blue * blue)
  )

  return hsp < 127.6
}

export class WindowControlsTheme {
  constructor(uuid, path) {
    this.uuid = uuid
    this.keys = new GLib.KeyFile()
    this._gicons = new Map()
    this._iconPaths = new Map()
    this._files = [GLib.build_filenamev([path, 'unite.theme'])]
    this.error = null

    try {
      this.keys.load_from_file(
        GLib.build_filenamev([path, 'unite.theme']), GLib.KeyFileFlags.NONE
      )
      this.name = this.keys.get_string('Theme', 'Name')
      if (!this.name.trim()) throw new Error('Theme name is empty')
      this.dark = GLib.build_filenamev([path, this.keys.get_string('Dark', 'Style')])
      this.light = GLib.build_filenamev([path, this.keys.get_string('Light', 'Style')])
      this._files.push(this.dark, this.light)

      const overrides = new Map()
      const allowed = new Set(ACTIONS.flatMap(action => [action, `${action}-hover`, `${action}-active`]))
      if (this.keys.has_group('Icons')) {
        const [keys] = this.keys.get_keys('Icons')
        for (const key of keys) {
          if (!allowed.has(key)) throw new Error(`Unknown icon mapping ${key}`)
          const value = this.keys.get_string('Icons', key)
          if (!value || GLib.path_is_absolute(value)) {
            throw new Error(`Icon mapping ${key} must be a nonempty relative path`)
          }
          overrides.set(key, value)
        }
      }

      // REQ-THEME-001: validate every variant/action/state, not only its CSS.
      for (const dark of [true, false]) {
        const style = this.getStyle(dark)
        if (!fileExists(style)) throw new Error(`Missing stylesheet ${style}`)
        const directory = GLib.path_get_dirname(style)
        const icons = {}
        for (const action of ACTIONS) {
          icons[action] = {}
          for (const state of STATES) {
            const key = state === 'default' ? action : `${action}-${state}`
            const filename = overrides.get(key) || `${key}.svg`
            const icon = GLib.build_filenamev([directory, filename])
            this._files.push(icon)
            if (!fileExists(icon)) throw new Error(`Missing ${action}/${state} icon ${icon}`)
            icons[action][state] = icon
          }
        }
        this._iconPaths.set(dark, icons)
      }
      this.valid = true
    } catch (error) {
      this.valid = false
      this.error = `Invalid window controls theme ${uuid} at ${path}: ${error.message}`
    }
  }

  getActionIcons(dark = true) {
    if (!this.valid) throw new Error(this.error)
    if (!this._gicons.has(dark)) {
      const icons = this._iconPaths.get(dark)
      this._gicons.set(dark, Object.fromEntries(ACTIONS.map(action => [
        action, Object.fromEntries(STATES.map(state => [
          state, Gio.icon_new_for_string(icons[action][state])
        ]))
      ])))
    }
    return this._gicons.get(dark)
  }

  getStyle(dark = true) {
    return dark ? this.dark : this.light
  }

  match(gtkTheme) {
    return gtkTheme === this.name || gtkTheme.startsWith(`${this.name}-`)
  }
}

export class WindowControlsThemes {
  constructor({
    directories = [
      GLib.build_filenamev([Convenience.getPath(), 'themes']),
      GLib.build_filenamev([GLib.get_user_data_dir(), 'unite-next/themes'])
    ],
    warn = message => console.warn(message)
  } = {}) {
    this.themes = Object.create(null)
    this._directories = directories
    this._warn = warn
    this._bundledDefault = null
    this._missingTheme = null
    this.update()
  }

  get available() {
    return Object.values(this.themes)
  }

  get default() {
    if (!this._bundledDefault) throw new Error('Bundled default window controls theme is missing or invalid')
    return this._bundledDefault
  }

  get(name) {
    const theme = this.themes[name]
    if (theme) {
      this._missingTheme = null
      return theme
    }

    // REQ-PREF-002: one bounded, observable substitution; never rewrite settings.
    if (this._missingTheme !== name) {
      this._warn(`Window controls theme ${JSON.stringify(name)} is unavailable; using bundled default`)
      this._missingTheme = name
    }
    return this.default
  }

  match(gtkTheme) {
    return this.available.find(theme => theme.match(gtkTheme)) || this.default
  }

  locate(btnTheme, gtkTheme) {
    return btnTheme === 'auto' ? this.match(gtkTheme) : this.get(btnTheme)
  }

  watch(onChanged) {
    let disposed = false
    let pending = 0
    let monitors = []
    const cancel = entries => {
      for (const [monitor, id] of entries) {
        monitor.disconnect(id)
        monitor.cancel()
      }
    }
    const rebuild = () => {
      const replacements = []
      const watched = new Set()
      try {
        for (const path of this._watchDirectories) {
          let directory = Gio.File.new_for_path(path)
          // Missing user/theme/asset directories are watched through their
          // closest existing parent, without creating user configuration.
          while (directory && directory.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
            directory = directory.get_parent()
          }
          if (!directory || watched.has(directory.get_uri())) continue
          watched.add(directory.get_uri())
          const monitor = directory.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
          replacements.push([monitor, monitor.connect('changed', schedule)])
        }
      } catch (error) {
        cancel(replacements)
        throw error
      }
      cancel(monitors)
      monitors = replacements
    }
    const schedule = () => {
      if (disposed || pending) return
      pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        pending = 0
        try {
          onChanged()
        } catch (error) {
          this._warn(`Unable to refresh window controls themes: ${error.message}`)
        } finally {
          // Discovery may now name newly created asset directories or have
          // moved back to an ancestor after a theme directory was removed.
          if (!disposed) rebuild()
        }
        return GLib.SOURCE_REMOVE
      })
    }
    rebuild()
    return () => {
      if (disposed) return
      disposed = true
      if (pending) GLib.source_remove(pending)
      pending = 0
      cancel(monitors)
      monitors = []
    }
  }

  update() {
    this.themes = Object.create(null)
    this._bundledDefault = null
    this._missingTheme = null
    this._watchDirectories = new Set(this._directories)

    this._directories.forEach((pathName, index) => {
      const path = Gio.File.new_for_path(pathName)
      if (!path.query_exists(null)) return

      let data = null
      try {
        data = path.enumerate_children(
          `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_STANDARD_TYPE}`,
          Gio.FileQueryInfoFlags.NONE, null
        )
        while (true) {
          const info = data.next_file(null)
          if (!info) break
          if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue

          const uuid = info.get_name()
          const item = new WindowControlsTheme(uuid, GLib.build_filenamev([pathName, uuid]))
          for (const path of item._files) this._watchDirectories.add(GLib.path_get_dirname(path))
          if (!item.valid) {
            this._warn(item.error)
            continue
          }
          this.themes[uuid] = item
          if (index === 0 && uuid === 'default') this._bundledDefault = item
        }
      } catch (error) {
        if (index === 0) throw error
        this._warn(`Unable to read user window controls themes at ${pathName}: ${error.message}`)
      } finally {
        if (data) data.close(null)
      }
    })
    // Invalid user overrides cannot replace the bundled fallback.
    this.default
  }
}
