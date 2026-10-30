import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import St from 'gi://St'
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Convenience from './convenience.js'

const GTK_VERSIONS = [3, 4]

// Cleanup is a best-effort traversal, but failure is never a successful result.
export function runCleanup(callbacks) {
  const errors = []
  for (const callback of callbacks) {
    try {
      callback()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors,
    `Unite cleanup failed: ${errors.map(error => error.message).join('; ')}`, { cause: errors[0] })
}

function isAbsPath(value) {
  return value.toString().startsWith('/')
}

function isRelPath(value) {
  return value.toString().startsWith('@/')
}

function isFilePath(value) {
  return isAbsPath(value) || isRelPath(value)
}

function filePath(parts) {
  const parse = part => part ? part.replace(/^@/, '') : ''
  const root  = isAbsPath(parts) ? [] : [Convenience.getPath()]
  const paths = root.concat(parts).map(parse)

  return GLib.build_filenamev(paths)
}

function userStylesPath(version) {
  return GLib.build_filenamev([GLib.get_user_config_dir(), `gtk-${version}.0`, 'gtk.css'])
}

function fileExists(path) {
  return GLib.file_test(path, GLib.FileTest.EXISTS)
}

function getGioFile(path) {
  const absPath = filePath(path)

  if (fileExists(absPath)) {
    return Gio.file_new_for_path(absPath)
  }
}

function updateFile(path, transform) {
  const file = Gio.File.new_for_path(path)
  let contents = ''
  let etag = null
  let originalBytes = null
  try {
    const [, bytes, tag] = file.load_contents(null)
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    etag = tag
    originalBytes = bytes
  } catch (error) {
    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error
  }
  const updated = transform(contents)
  if (updated === contents) return
  if (etag === null) {
    const directory = file.get_parent()
    try {
      directory.make_directory_with_parents(null)
    } catch (error) {
      if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw error
    }
    // Complete a private stage before exclusive publication. GLocalFile.move()
    // performs a destination check followed by rename(), so it is not a CAS.
    const stage = directory.get_child(`.unite-next-gtk-${GLib.uuid_string_random()}.css`)
    let ownsStage = false
    let failure = null
    try {
      const stream = stage.create(Gio.FileCreateFlags.PRIVATE, null)
      ownsStage = true
      try {
        stream.write_all(new TextEncoder().encode(updated), null)
      } catch (writeError) {
        try {
          stream.close(null)
        } catch (closeError) {
          throw new AggregateError([writeError, closeError], 'GTK staging write and close failed')
        }
        throw writeError
      }
      stream.close(null)

      const process = Gio.Subprocess.new(
        ['/usr/bin/timeout', '--foreground', '--signal=KILL', '1s',
          '/usr/bin/ln', '--no-target-directory', '--', stage.get_path(), file.get_path()],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      )
      const [, , stderr] = process.communicate_utf8(null, null)
      if (!process.get_successful()) {
        const status = process.get_if_exited() ? process.get_exit_status() : `signal ${process.get_term_sig()}`
        throw new Error(`GTK stylesheet publication failed (status ${status}): ${stderr.trim() || 'ln failed'}`)
      }
    } catch (error) {
      failure = error
    } finally {
      try {
        if (ownsStage) stage.delete(null)
      } catch (cleanupError) {
        if (!cleanupError.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
          if (failure) throw new AggregateError([failure, cleanupError], 'GTK publication and staging cleanup failed')
          throw cleanupError
        }
      }
    }
    if (failure) throw failure
  } else {
    // Local etags are timestamp-derived and can collide. Check the actual
    // content precondition as well; the subsequent native etag guard remains.
    const [, currentBytes] = file.load_contents(null)
    if (currentBytes.length !== originalBytes.length ||
        currentBytes.some((byte, index) => byte !== originalBytes[index])) {
      throw new Gio.IOErrorEnum({
        code: Gio.IOErrorEnum.WRONG_ETAG,
        message: `GTK stylesheet contents changed before replacement: ${path}`
      })
    }
    file.replace_contents(updated, etag, false, Gio.FileCreateFlags.NONE, null)
  }
}

export function resetGtkStyles() {
  runCleanup(GTK_VERSIONS.map(version => () => updateFile(
    userStylesPath(version), style => style.replace(/\/\* UNITE_NEXT ([\s\S]*?) UNITE_NEXT \*\/\n/g, '')
  )))
}

export class Signals {
  constructor() {
    this.signals = new Map()
  }

  registerHandler(object, name, callback) {
    const uid = GLib.uuid_string_random()
    const key = `[signal ${name} uuid@${uid}]`

    this.signals.set(key, {
      object:   object,
      signalId: object.connect(name, callback)
    })

    return key
  }

  hasSignal(key) {
    return this.signals.has(key)
  }

  connect(object, name, callback) {
    return this.registerHandler(object, name, callback)
  }

  disconnect(key) {
    if (this.hasSignal(key)) {
      const data = this.signals.get(key)

      this.signals.delete(key)
      if (data.object != null) data.object.disconnect(data.signalId)
    }
  }

  disconnectMany(keys) {
    runCleanup(keys.map(key => () => this.disconnect(key)))
  }

  disconnectAll() {
    this.disconnectMany([...this.signals.keys()])
  }
}

export class Settings extends Signals {
  constructor(context) {
    super()
    this.objects = Object.values(context.settings)
  }

  getSettingObject(key) {
    const object = this.objects.find(settings => settings.exists(key))
    if (!object) throw new Error(`Unknown Unite setting: ${key}`)
    return object
  }

  connect(name, callback) {
    const object = this.getSettingObject(name)
    return this.registerHandler(object, `changed::${name}`, callback)
  }

  get(key) {
    const object = this.getSettingObject(key)
    return object.getSetting(key)
  }

  set(key, value) {
    const object = this.getSettingObject(key)
    return object.setSetting(key, value)
  }
}

export class Injections {
  constructor() {
    this.store = new Map()
    this.items = new InjectionManager()
  }

  registerInjection(name, value) {
    const uid = GLib.uuid_string_random()
    const key = `[injection ${name} uuid@${uid}]`

    this.store.set(key, value)
    return key
  }

  method(object, method, callback) {
    const proto = object.prototype
    this.items.overrideMethod(proto, method, () => callback)

    return this.registerInjection(method, [proto, method])
  }

  vfunc(object, method, callback) {
    const proto = Object.getPrototypeOf(object)
    const vfunc = `vfunc_${method}`
    this.items.overrideMethod(proto, vfunc, () => callback)

    return this.registerInjection(vfunc, [proto, vfunc])
  }

  remove(key) {
    if (this.store.has(key)) {
      const [prototype, method] = this.store.get(key)
      this.items.restoreMethod(prototype, method)

      this.store.delete(key)
    }
  }

  removeAll() {
    this.store.clear()
    this.items.clear()
  }
}

export class Timeouts {
  constructor() {
    this.store = new Map()
  }

  register(addSource, callback, repeat = false) {
    const uid = GLib.uuid_string_random()
    const key = `[timeout uuid@${uid}]`

    const sourceId = addSource(() => {
      let keep = false
      try {
        keep = repeat ? callback() !== false : (callback(), false)
        return keep ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE
      } finally {
        if (!keep) this.store.delete(key)
      }
    })
    this.store.set(key, sourceId)

    return key
  }

  idle(callback) {
    return this.register(
      handler => GLib.idle_add(GLib.PRIORITY_DEFAULT, handler), callback
    )
  }

  timeout(time, callback) {
    return this.register(
      handler => GLib.timeout_add(GLib.PRIORITY_DEFAULT, time, handler), callback
    )
  }

  interval(time, callback) {
    return this.register(
      handler => GLib.timeout_add(GLib.PRIORITY_DEFAULT, time, handler), callback, true
    )
  }

  remove(key) {
    if (this.store.has(key)) {
      const sourceId = this.store.get(key)
      this.store.delete(key)
      GLib.source_remove(sourceId)
    }
  }

  removeAll() {
    runCleanup([...this.store.keys()].map(key => () => this.remove(key)))
  }
}

export class Feature {
  constructor(context, setting, callback) {
    this.context = context
    this._settingsKey = setting
    this._checkActive = callback
  }
}

export class Features {
  constructor(context) {
    this.context = context
    this.features = []
    this.settings = new Settings(context)
  }

  add(klass) {
    const feature = new klass(this.context)
    this.features.push(feature)

    const setting = feature._settingsKey
    const checkCb = feature._checkActive

    feature.activated = false

    const isActive = () => {
      return checkCb.call(null, this.settings.get(setting))
    }

    const onChange = () => {
      const active = isActive()

      if (active && !feature.activated) {
        feature.activated = true
        try {
          return feature.activate()
        } catch (error) {
          runCleanup([() => { throw error }, () => feature._doDestroy()])
        }
      }

      if (!active && feature.activated) {
        feature.activated = false
        return feature.destroy()
      }
    }

    feature._doActivate = () => {
      this.settings.connect(setting, onChange.bind(feature))
      onChange()
    }

    feature._doDestroy = () => {
      if (feature.activated) {
        feature.activated = false
        return feature.destroy()
      }
    }
  }

  activate() {
    this.features.forEach(feature => feature._doActivate())
  }

  destroy() {
    runCleanup([
      () => this.settings.disconnectAll(),
      ...this.features.map(feature => () => feature._doDestroy())
    ])
  }
}

class ShellStyle {
  constructor(path) {
    this.file = getGioFile(path)
  }

  get context() {
    return St.ThemeContext.get_for_stage(global.stage)
  }

  get theme() {
    return this.context.get_theme()
  }

  load() {
    this.theme.load_stylesheet(this.file)
  }

  unload() {
    this.theme.unload_stylesheet(this.file)
  }
}

class WidgetStyle {
  constructor(widget, style) {
    this.widget = widget
    this.style  = style
  }

  get existing() {
    return this.widget.get_style() || ''
  }

  load() {
    const style = this.existing + this.style
    this.widget.set_style(style)
  }

  unload() {
    const style = this.existing.replace(this.style, '')
    this.widget.set_style(style)
  }
}

class GtkStyle {
  constructor(version, name, data) {
    const content = this.parse(data, version)

    this.filepath = userStylesPath(version)
    this.contents = `/* UNITE_NEXT ${name} */\n${content}\n/* ${name} UNITE_NEXT */\n`
  }

  parse(data, ver) {
    if (isFilePath(data)) {
      const path = filePath(['styles', `gtk${ver}`, data])
      return `@import url('${path}');`
    } else {
      return data
    }
  }

  load() {
    updateFile(this.filepath, existing => existing.includes(this.contents) ? existing : this.contents + existing)
  }

  unload() {
    updateFile(this.filepath, existing => existing.replace(this.contents, ''))
  }
}

class GtkStyles {
  constructor(name, data, versions) {
    const items = [].concat(versions).filter(ver => GTK_VERSIONS.includes(ver))
    this.styles = items.map(ver => new GtkStyle(ver, name, data))
  }

  load() {
    this.styles.forEach(style => style.load())
  }

  unload() {
    runCleanup(this.styles.map(style => () => style.unload()))
  }
}

export class Styles {
  constructor() {
    this.styles = new Map()
  }

  hasStyle(name) {
    return name && this.styles.has(name)
  }

  getStyle(name) {
    return name && this.styles.get(name)
  }

  setStyle(name, object, ...args) {
    if (!this.hasStyle(name)) {
      const style = new object(...args)
      this.styles.set(name, style)
      style.load()
    }
  }

  deleteStyle(name) {
    if (this.hasStyle(name)) {
      const style = this.getStyle(name)
      this.styles.delete(name)
      style.unload()
    }
  }

  addShellStyle(name, data) {
    if (isFilePath(data)) {
      this.deleteStyle(name)
      this.setStyle(name, ShellStyle, data)
    } else {
      this.addWidgetStyle(name, Main.uiGroup, data)
    }
  }

  addWidgetStyle(name, widget, styles) {
    this.deleteStyle(name)
    this.setStyle(name, WidgetStyle, widget, styles)
  }

  addGtkStyle(name, contents, versions = GTK_VERSIONS) {
    this.deleteStyle(name)
    this.setStyle(name, GtkStyles, name, contents, versions)
  }

  removeAll() {
    runCleanup([...this.styles.keys()].map(key => () => this.deleteStyle(key)))
  }
}
