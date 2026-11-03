import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import System from 'system'
import { updateGtkFile } from '../unite-next@lucastsudaka.github.io/gtk-files.js'

const request = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(ARGV[0])[1]))
const nativeSpawn = Gio.SubprocessLauncher.prototype.spawnv
let exchanges = 0
Gio.SubprocessLauncher.prototype.spawnv = function (argv) {
  const substitute = () => {
    const path = Gio.File.new_for_path(request.path)
    path.delete(null)
    if (request.fault.endsWith('fifo')) nativeSpawn.call(this, ['/usr/bin/mkfifo', '--', request.path]).wait_check(null)
    else path.make_symbolic_link('foreign.css', null)
  }
  if (argv.includes('/usr/bin/dd') && argv.includes(`if=${request.path}`) && request.fault?.startsWith('read-race-')) substitute()
  if (argv.includes('/usr/bin/mv')) {
    exchanges++
    if (request.fault === 'concurrent') {
      GLib.file_set_contents(request.path, exchanges === 1 ? 'First foreign version' : 'Second foreign version')
    }
    if (request.fault === 'unsupported') throw new Error('Unsupported exchange')
    if (request.fault === 'fifo' || request.fault === 'symlink') substitute()
    if (request.fault === 'after-exchange') {
      const process = nativeSpawn.call(this, argv)
      process.wait_check(null)
      throw new Error('Injected interruption after exchange')
    }
  }
  if (request.fault === 'sync' && exchanges && argv.includes('/usr/bin/sync')) throw new Error('Injected sync error')
  return nativeSpawn.call(this, argv)
}
try {
  const result = updateGtkFile(request.path, existing => {
    if (GLib.base64_encode(new TextEncoder().encode(existing)) !== request.expected) throw new Error('Unexpected original bytes')
    return new TextDecoder('utf-8', { fatal: true }).decode(GLib.base64_decode(request.updated))
  }).finish()
  print(JSON.stringify(result))
} catch (error) {
  printerr(error.message)
  System.exit(1)
} finally {
  Gio.SubprocessLauncher.prototype.spawnv = nativeSpawn
}
