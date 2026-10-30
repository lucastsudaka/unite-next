// Private-file handshake shared by the compositor and its real preferences client.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

export function writeJson(file, value) {
  file.replace_contents(JSON.stringify(value), null, false, Gio.FileCreateFlags.PRIVATE, null)
}

export async function waitForJson(file, verify, description, cancellable = null, timeoutMs = 10000) {
  const monitor = file.get_parent().monitor_directory(Gio.FileMonitorFlags.NONE, null)
  let changed = 0
  let cancelled = 0
  let timeout = 0
  try {
    return await new Promise((resolve, reject) => {
      const inspect = () => {
        try {
          const [, bytes] = file.load_contents(null)
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          if (!verify(value)) throw new Error(`Invalid ${description} response`)
          resolve(value)
        } catch (error) {
          if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) reject(error)
        }
      }
      changed = monitor.connect('changed', (_monitor, changedFile, otherFile) => {
        if (changedFile?.equal(file) || otherFile?.equal(file)) inspect()
      })
      timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timeout = 0
        reject(new Error(`Timed out acquiring ${description}`))
        return GLib.SOURCE_REMOVE
      })
      if (cancellable) {
        cancelled = cancellable.connect(() => reject(new Error(`Cancelled ${description}`)))
        if (cancellable.is_cancelled()) reject(new Error(`Cancelled ${description}`))
      }
      inspect() // Includes a response written before the observer was installed.
    })
  } finally {
    if (timeout) GLib.source_remove(timeout)
    if (changed) monitor.disconnect(changed)
    monitor.cancel()
    if (cancelled) cancellable.disconnect(cancelled)
  }
}
