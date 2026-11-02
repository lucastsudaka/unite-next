import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import * as Convenience from './convenience.js'
import { runCleanup } from './resources.js'

const GTK_VERSIONS = [3, 4]

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
    // Local etags are timestamp-derived and can collide. Reject an already
    // observed conflict before invoking the recoverable native transaction.
    const [, currentBytes] = file.load_contents(null)
    if (currentBytes.length !== originalBytes.length ||
        currentBytes.some((byte, index) => byte !== originalBytes[index])) {
      throw new Gio.IOErrorEnum({
        code: Gio.IOErrorEnum.WRONG_ETAG,
        message: `GTK stylesheet contents changed before replacement: ${path}`
      })
    }
    // Native GIO replacement checks its etag before writing/renaming, leaving
    // a lost-update interval. Exchange retains the actual displaced inode.
    const helper = Convenience.getDir().get_child('gtk-files.py').get_path()
    const process = Gio.Subprocess.new(
      ['/usr/bin/timeout', '--foreground', '--signal=KILL', '1s', '/usr/bin/python3', '-B', helper],
      Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    )
    const [, output, errors] = process.communicate_utf8(JSON.stringify({
      path: file.get_path(), expected: GLib.base64_encode(originalBytes),
      updated: GLib.base64_encode(new TextEncoder().encode(updated))
    }), null)
    if (!process.get_successful()) {
      const status = process.get_if_exited() ? process.get_exit_status() : `signal ${process.get_term_sig()}`
      throw new Error(`GTK stylesheet replacement failed (status ${status}): ${errors.trim() || 'inspect .unite-next-gtk-recovery before retrying'}`)
    }
    const { recovery } = JSON.parse(output)
    console.info(`Unite Next: GTK stylesheet recovery retained at ${recovery}`)
  }
}

export function resetGtkStyles() {
  runCleanup(GTK_VERSIONS.map(version => () => updateFile(
    userStylesPath(version), style => style.replace(/\/\* UNITE_NEXT ([\s\S]*?) UNITE_NEXT \*\/\n/g, '')
  )))
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
      const uri = Gio.File.new_for_path(path).get_uri()
      const escaped = uri.replace(/[\\'\n\r\f]/g, character => `\\${character.codePointAt(0).toString(16)} `)
      return `@import url('${escaped}');`
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

export class GtkStyles {
  constructor(name, data, versions = GTK_VERSIONS) {
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
