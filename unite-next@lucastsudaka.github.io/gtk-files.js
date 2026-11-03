import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { ProcessSequence } from './process-jobs.js'
import { runCleanup } from './resources.js'

const ATTRIBUTES = 'unix::uid,unix::gid,unix::mode,time::access,time::access-usec,time::access-nsec,' +
  'time::modified,time::modified-usec,time::modified-nsec,xattr::*,xattr-sys::*'
const equalBytes = (first, second) => first.length === second.length && first.every((byte, index) => byte === second[index])
const command = (argv, decode = output => output) => ({
  argv: ['/usr/bin/timeout', '--foreground', '--signal=KILL', '1s', ...argv], decode
})
function readRegular(file) {
  const attributes = 'standard::type,unix::device,unix::inode'
  const before = file.query_info(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
  if (before.get_file_type() !== Gio.FileType.REGULAR) {
    throw new Error(`Not a regular GTK stylesheet: ${file.get_path()}`)
  }
  // Opening a replacement FIFO/symlink must not block the Shell or follow it.
  return { ...command(['/usr/bin/dd', `if=${file.get_path()}`, 'iflag=nofollow,nonblock', 'status=none']), binary: true,
    decode: bytes => {
      const after = file.query_info(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
      if (after.get_file_type() !== Gio.FileType.REGULAR) throw new Error(`Not a regular GTK stylesheet: ${file.get_path()}`)
      for (const name of ['unix::device', 'unix::inode']) {
        if (before.get_attribute_as_string(name) !== after.get_attribute_as_string(name)) throw conflict(file.get_path())
      }
      return bytes
    } }
}

function conflict(path) {
  return new Gio.IOErrorEnum({ code: Gio.IOErrorEnum.WRONG_ETAG,
    message: `GTK stylesheet ownership conflict: ${path}` })
}

function copyMetadata(source, destination) {
  const info = source.query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
  const current = destination.query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
  for (const name of current.list_attributes(null)) {
    if ((name.startsWith('xattr::') || name.startsWith('xattr-sys::')) && !info.has_attribute(name)) {
      // A default directory ACL can grant access when the original mode is copied.
      throw new Error(`GTK stylesheet staging would introduce metadata: ${name}`)
    }
  }
  const changes = info.dup()
  for (const name of info.list_attributes(null)) {
    // Do not require privileges to reapply an already identical security label.
    if (info.get_attribute_as_string(name) === current.get_attribute_as_string(name)) changes.remove_attribute(name)
  }
  destination.set_attributes_from_info(changes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
  const copied = destination.query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
  for (const name of info.list_attributes(null)) {
    if (info.get_attribute_as_string(name) !== copied.get_attribute_as_string(name)) {
      throw new Error(`GTK stylesheet metadata was not preserved: ${name}`)
    }
  }
}

function stageFile(file, bytes) {
  const stream = file.create(Gio.FileCreateFlags.PRIVATE, null)
  try {
    runCleanup([() => stream.write_all(bytes, null), () => stream.close(null)])
  } catch (error) {
    runCleanup([() => { throw error }, () => file.delete(null)])
  }
}

function* update(path, transform) {
  const file = Gio.File.new_for_path(path)
  let original = null
  let target = null
  let info = null
  try { info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null) } catch (error) {
    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error
  }
  if (info?.get_file_type() === Gio.FileType.REGULAR) {
    const resolved = yield command(['/usr/bin/realpath', '--canonicalize-existing', '--zero', '--', path])
    if (!resolved.endsWith('\0') || resolved.slice(0, -1).includes('\0')) throw new Error('Invalid GTK referent path')
    target = Gio.File.new_for_path(resolved.slice(0, -1))
    original = yield readRegular(target)
  } else if (info && info.get_file_type() !== Gio.FileType.SYMBOLIC_LINK) {
    throw new Error(`Not a regular GTK stylesheet: ${path}`)
  }
  // Preserve all leading BOM bytes independently of the runtime decoder's BOM option.
  let bom = 0
  if (original) while (original[bom] === 0xef && original[bom + 1] === 0xbb && original[bom + 2] === 0xbf) bom += 3
  const contents = original === null ? '' : '\ufeff'.repeat(bom / 3) +
    new TextDecoder('utf-8', { fatal: true }).decode(original.subarray(bom))
  const updated = transform(contents)
  if (updated === contents) return null
  const bytes = new TextEncoder().encode(updated)
  if (original === null) {
    const directory = file.get_parent()
    try { directory.make_directory_with_parents(null) } catch (error) {
      if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw error
    }
    const stage = directory.get_child(`.unite-next-gtk-${GLib.uuid_string_random()}.css`)
    stageFile(stage, bytes)
    try {
      yield command(['/usr/bin/sync', '--', stage.get_path()])
      yield command(['/usr/bin/ln', '--no-target-directory', '--', stage.get_path(), file.get_path()])
      yield command(['/usr/bin/sync', '--', directory.get_path()])
    } catch (error) {
      throw new Error(`GTK stylesheet publication failed: ${error.message}`, { cause: error })
    } finally {
      stage.delete(null)
    }
    return null
  }

  const current = yield readRegular(target)
  if (!equalBytes(current, original)) throw conflict(path)
  const recovery = target.get_parent().get_child('.unite-next-gtk-recovery')
  try {
    if (GLib.mkdir_with_parents(recovery.get_path(), 0o700) !== 0) throw new Error('Unable to create GTK recovery directory')
  } catch (error) { throw new Error(`Unable to create GTK recovery directory: ${error.message}`, { cause: error }) }
  const recoveryInfo = recovery.query_info('standard::type,unix::uid,unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
  if (recoveryInfo.get_file_type() !== Gio.FileType.DIRECTORY ||
      recoveryInfo.get_attribute_uint32('unix::uid') !== new Gio.Credentials().get_unix_user() ||
      (recoveryInfo.get_attribute_uint32('unix::mode') & 0o7777) !== 0o700) {
    throw new Error(`GTK recovery directory must be owned and private: ${recovery.get_path()}`)
  }
  const stage = recovery.get_child(`gtk.css-${GLib.uuid_string_random()}.css`)
  stageFile(stage, bytes)
  let retained = false
  try {
    copyMetadata(target, stage)
    yield command(['/usr/bin/sync', '--', stage.get_path()])
    // From this point, even a failed response can follow a completed exchange.
    retained = true
    const exchange = command(['/usr/bin/mv', '--no-target-directory', '--exchange', '--no-copy', '--', stage.get_path(), target.get_path()])
    const sync = command(['/usr/bin/sync', '--', recovery.get_path(), target.get_parent().get_path()])
    yield exchange
    yield sync
    const displaced = yield readRegular(stage)
    if (!equalBytes(displaced, original)) {
      yield exchange
      yield sync
      throw conflict(path)
    }
    return { recovery: stage.get_path() }
  } catch (error) {
    if (retained) throw new Error(`${error.message}; GTK recovery retained at ${stage.get_path()}`, { cause: error })
    throw error
  } finally {
    if (!retained) stage.delete(null)
  }
}

export function updateGtkFile(path, transform) {
  return new ProcessSequence(update(path, transform))
}
