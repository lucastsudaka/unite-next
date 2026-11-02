import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import St from 'gi://St'
import * as Convenience from './convenience.js'
import { ScopedStylesheet } from './scoped-styles.js'

export class ShellStyle {
  constructor(path) {
    const absolute = path.toString().startsWith('/') ? path :
      GLib.build_filenamev([Convenience.getPath(), path.replace(/^@/, '')])
    if (GLib.file_test(absolute, GLib.FileTest.EXISTS)) this.file = Gio.File.new_for_path(absolute)
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

export class ScopedShellStyle extends ShellStyle {
  constructor(path, scope, store) {
    super(path)
    this.scoped = new ScopedStylesheet(this.file.get_path(), scope, store)
  }

  load() {
    this.scoped.load(this.theme)
  }

  unload() {
    this.scoped.unload(this.theme)
  }
}
