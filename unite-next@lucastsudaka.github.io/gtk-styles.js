import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import * as Convenience from './convenience.js'
import { runCleanup } from './resources.js'
import { updateGtkFile } from './gtk-files.js'

const GTK_VERSIONS = [3, 4]

function userStylesPath(version) {
  return GLib.build_filenamev([GLib.get_user_config_dir(), `gtk-${version}.0`, 'gtk.css'])
}

function reportRecovery(result, reported) {
  if (!result) return
  const directory = GLib.path_get_dirname(result.recovery)
  if (reported.has(directory)) return
  reported.add(directory)
  console.info(`Unite Next: GTK stylesheet recoveries retained in ${directory}`)
}

export function resetGtkStyles() {
  const reported = new Set()
  runCleanup(GTK_VERSIONS.map(version => () => reportRecovery(updateGtkFile(
    userStylesPath(version), style => style.replace(/\/\* UNITE_NEXT ([\s\S]*?) UNITE_NEXT \*\/\n/g, '')
  ).finish(), reported)))
}

class GtkStyle {
  constructor(version, name, data, report) {
    this.report = report
    this.version = version
    this.name = name
    this.filepath = userStylesPath(version)
    this.blocks = new Set()
    this.pending = null
    this.dirty = false
    this.setContents(data)
  }

  setContents(data) {
    const value = data.toString()
    let content = data
    if (value.startsWith('/') || value.startsWith('@/')) {
      const parts = ['styles', `gtk${this.version}`, data]
      const path = GLib.build_filenamev((value.startsWith('/') ? [] : [Convenience.getPath()])
        .concat(parts).map(part => part.replace(/^@/, '')))
      const uri = Gio.File.new_for_path(path).get_uri()
      const escaped = uri.replace(/[\\'\n\r\f]/g, character => `\\${character.codePointAt(0).toString(16)} `)
      content = `@import url('${escaped}');`
    }
    this.contents = `/* UNITE_NEXT ${this.name} */\n${content}\n/* ${this.name} UNITE_NEXT */\n`
    this.blocks.add(this.contents)
    this.dirty = true
  }

  _transaction(load) {
    const blocks = [...this.blocks]
    const contents = load ? this.contents : ''
    return updateGtkFile(this.filepath, existing => {
      let foreign = existing
      for (const block of blocks) foreign = foreign.split(block).join('')
      return contents + foreign
    })
  }

  load() {
    if (this.pending) return
    this.dirty = false
    const pending = this._transaction(true)
    this.pending = pending
    try {
      pending.watch((error, result) => {
        this.pending = null
        if (error) console.error(`Unite Next GTK stylesheet update failed: ${error.message}`)
        else this.report(result)
        if (this.dirty) this.load()
      })
    } catch (error) {
      this.pending = null
      throw error
    }
  }

  flush() {
    do {
      const pending = this.pending
      this.pending = null
      if (pending) this.report(pending.finish())
      if (!this.dirty) return
      this.dirty = false
      this.report(this._transaction(true).finish())
    } while (this.dirty)
  }

  unload() {
    this.dirty = false
    const pending = this.pending
    this.pending = null
    runCleanup([
      () => { if (pending) this.report(pending.finish()) },
      () => this.report(this._transaction(false).finish()),
      () => this.blocks.clear()
    ])
  }
}

export class GtkStyles {
  constructor(name, data, versions = GTK_VERSIONS) {
    this.name = name
    this.reported = new Set()
    const items = [].concat(versions).filter(ver => GTK_VERSIONS.includes(ver))
    this.styles = items.map(ver => new GtkStyle(ver, name, data, result => reportRecovery(result, this.reported)))
  }

  load() {
    this.styles.forEach(style => style.load())
  }

  update(data, versions = GTK_VERSIONS) {
    const items = [].concat(versions).filter(ver => GTK_VERSIONS.includes(ver))
    const removed = this.styles.filter(style => !items.includes(style.version))
    runCleanup(removed.map(style => () => style.unload()))
    this.styles = this.styles.filter(style => items.includes(style.version))
    for (const version of items) {
      let style = this.styles.find(entry => entry.version === version)
      if (style) style.setContents(data)
      else {
        style = new GtkStyle(version, this.name, data, result => reportRecovery(result, this.reported))
        this.styles.push(style)
      }
      style.load()
    }
  }

  flush() {
    runCleanup(this.styles.map(style => () => style.flush()))
  }

  unload() {
    runCleanup(this.styles.map(style => () => style.unload()))
  }
}
