import { runCleanup } from './resources.js'
import { GtkStyles } from './gtk-styles.js'
import { ShellStyle, ScopedShellStyle, stylesheetPath } from './shell-styles.js'
import { ScopedStylesheetStore, StylesheetPreparation } from './scoped-styles.js'

export class Styles {
  constructor() {
    this.styles = new Map()
    this.scopedStore = null
    this.preparations = new Map()
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
    this.cancelScopedShellStyle(name)
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

  addScopedShellStyle(name, path, scope, presentation = { apply() {}, rollback() {} }, prepared = null) {
    this.cancelScopedShellStyle(name)
    const previous = this.getStyle(name)
    if (previous) {
      previous.replace(path, scope, prepared, presentation)
      return
    }
    this.scopedStore ??= new ScopedStylesheetStore()
    const style = new ScopedShellStyle(path, scope, this.scopedStore)
    this.styles.set(name, style)
    try {
      style.load(prepared)
      presentation.apply()
    } catch (error) {
      runCleanup([() => { throw error }, () => presentation.rollback(), () => this.deleteStyle(name)])
    }
  }

  prepareScopedShellStyle(name, path, scope, receive) {
    this.cancelScopedShellStyle(name)
    const pending = { preparation: null }
    this.preparations.set(name, pending)
    try {
      pending.preparation = new StylesheetPreparation(stylesheetPath(path), scope, (error, prepared) => {
        if (this.preparations.get(name) !== pending) return
        this.preparations.delete(name)
        receive(error, prepared)
      })
    } catch (error) {
      this.cancelScopedShellStyle(name)
      throw error
    }
  }

  cancelScopedShellStyle(name) {
    const pending = this.preparations.get(name)
    this.preparations.delete(name)
    pending?.preparation?.cancel()
  }

  addGtkStyle(name, contents, versions) {
    if (this.hasStyle(name)) {
      // Keep the transaction owner while normal preference changes coalesce.
      this.getStyle(name).update(contents, versions)
      return
    }
    this.setStyle(name, GtkStyles, name, contents, versions)
  }

  removeAll() {
    runCleanup([
      ...[...this.preparations.keys()].map(key => () => this.cancelScopedShellStyle(key)),
      ...[...this.styles.keys()].map(key => () => this.deleteStyle(key)),
      () => { this.scopedStore?.clear(); this.scopedStore = null }
    ])
  }
}
