import { runCleanup } from './resources.js'
import { GtkStyles } from './gtk-styles.js'
import { ShellStyle, ScopedShellStyle } from './shell-styles.js'
import { ScopedStylesheetStore } from './scoped-styles.js'

export class Styles {
  constructor() {
    this.styles = new Map()
    this.scopedStore = null
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
      // Preserve the owner before loading so enclosing failure cleanup can unload it.
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

  addShellStyle(name, path) {
    this.deleteStyle(name)
    this.setStyle(name, ShellStyle, path)
  }

  addScopedShellStyle(name, path, scope) {
    this.deleteStyle(name)
    this.scopedStore ??= new ScopedStylesheetStore()
    this.setStyle(name, ScopedShellStyle, path, scope, this.scopedStore)
  }

  addGtkStyle(name, contents, versions) {
    this.deleteStyle(name)
    this.setStyle(name, GtkStyles, name, contents, versions)
  }

  removeAll() {
    runCleanup([
      ...[...this.styles.keys()].map(key => () => this.deleteStyle(key)),
      () => { this.scopedStore?.clear(); this.scopedStore = null }
    ])
  }
}
