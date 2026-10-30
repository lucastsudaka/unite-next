// Capture only the actual private compositor and its actual installed preferences.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Shell from 'gi://Shell'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { waitForJson, writeJson } from './screenshot-protocol.mjs'

function assert(value, message) { if (!value) throw new Error(message) }
async function bounded(promise, description) {
  let timeout = 0
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
        timeout = 0
        reject(new Error(`Timed out acquiring ${description}`))
        return GLib.SOURCE_REMOVE
      })
    })])
  } finally {
    if (timeout) GLib.source_remove(timeout)
  }
}

async function frame(predicate, description) {
  let signal = 0
  try {
    await bounded(new Promise((resolve, reject) => {
      signal = global.stage.connect('after-paint', () => {
        try { if (predicate()) resolve() } catch (error) { reject(error) }
      })
      global.stage.queue_redraw()
    }), description)
  } finally {
    if (signal) global.stage.disconnect(signal)
  }
}

async function capture(file, operation, ...arguments_) {
  const stream = file.create(Gio.FileCreateFlags.PRIVATE, null)
  try {
    const screenshot = new Shell.Screenshot()
    await bounded(new Promise((resolve, reject) => {
      screenshot[operation](...arguments_, stream, (object, result) => {
        try {
          const [success] = object[`${operation}_finish`](result)
          assert(success, `Native ${operation} did not produce a screenshot`)
          resolve()
        } catch (error) { reject(error) }
      })
    }), operation)
  } finally {
    stream.close(null)
  }
}

export async function runScreenshots(owner, desktopWindow) {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private screenshot session required')
  assert(desktopWindow, 'An actual desktop fixture window is required')
  const output = GLib.getenv('UNITE_SCREENSHOTS_DIR')
  assert(output, 'Runner-owned screenshot staging directory is required')
  const directory = Gio.File.new_for_path(output)
  assert(directory.has_prefix(Gio.File.new_for_path(GLib.get_home_dir())), 'Captures must remain in the private HOME')
  Main.activateWindow(desktopWindow)
  await frame(() => desktopWindow.has_focus() && !Main.overview.visibleTarget, 'private desktop frame')
  const monitor = Main.layoutManager.primaryMonitor
  assert(monitor && monitor.width > 0 && monitor.height > 0, 'A real primary monitor is required')
  await capture(directory.get_child('screenshot.png'), 'screenshot_area', monitor.x, monitor.y, monitor.width, monitor.height)

  const token = GLib.uuid_string_random()
  const runtime = Gio.File.new_for_path(GLib.get_user_runtime_dir())
  const ready = runtime.get_child(`capture-ready-${token}.json`)
  const ack = runtime.get_child(`capture-ack-${token}.json`)
  const source = Gio.File.new_for_path(GLib.getenv('UNITE_TEST_SOURCE'))
  const library = GLib.getenv('UNITE_GNOME_LIBRARY_DIR')
  assert(library, 'Native preferences library directory is required')
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE })
  launcher.setenv('LANGUAGE', 'en', true)
  launcher.setenv('LANG', 'C.UTF-8', true)
  launcher.setenv('LC_ALL', 'C.UTF-8', true)
  launcher.setenv('GI_TYPELIB_PATH', `${library}/girepository-1.0:${GLib.getenv('GI_TYPELIB_PATH') || ''}`, true)
  launcher.setenv('LD_LIBRARY_PATH', `${library}:${GLib.getenv('LD_LIBRARY_PATH') || ''}`, true)
  const child = launcher.spawnv(['gjs', '-m', source.get_child('tests/preferences-screenshot.mjs').get_path(),
    owner.path, token, ready.get_path(), ack.get_path()])
  let deadline = 0
  let timedOut = false
  const completion = new Promise(resolve => child.communicate_utf8_async(null, null, (object, result) => {
    try { resolve({ response: object.communicate_utf8_finish(result) }) } catch (error) { resolve({ error }) }
  }))
  deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () => {
    deadline = 0
    timedOut = true
    child.force_exit()
    return GLib.SOURCE_REMOVE
  })
  const cancelled = new Gio.Cancellable()
  const errors = []
  try {
    const information = await Promise.race([
      waitForJson(ready, value => value.token === token && typeof value.appId === 'string' &&
        value.width > 0 && value.height > 0, 'native preferences frame', cancelled),
      completion.then(outcome => { throw outcome.error || new Error('Preferences capture client exited before its frame handshake') })
    ])
    let window
    await frame(() => {
      window = global.get_window_actors().map(actor => actor.meta_window).find(candidate =>
        candidate.get_gtk_application_id() === information.appId || candidate.get_wm_class() === information.appId)
      return window && window.get_compositor_private()?.mapped
    }, 'mapped native preferences window')
    Main.activateWindow(window)
    await frame(() => window.has_focus(), 'focused native preferences frame')
    await capture(directory.get_child('settings.png'), 'screenshot_window', true, false)
    writeJson(ack, { token, captured: true })
  } catch (error) {
    errors.push(error)
    child.force_exit()
  } finally {
    cancelled.cancel()
    const outcome = await completion
    if (deadline) GLib.source_remove(deadline)
    if (outcome.error) errors.push(outcome.error)
    else {
      const [, stdout, stderr] = outcome.response
      if (stdout.trim()) print(stdout.trim())
      if (stderr.trim()) printerr(stderr.trim())
      if (timedOut || !child.get_successful() || !stdout.includes('PREFERENCES_SCREENSHOT_PASS')) {
        errors.push(new Error('Native preferences capture failed or exceeded its 20-second process deadline'))
      }
    }
    for (const file of [ready, ack]) {
      try { if (file.query_exists(null)) file.delete(null) } catch (error) { errors.push(error) }
    }
  }
  if (errors.length) throw new AggregateError(errors, `Native screenshot capture failed: ${errors.map(error => error.message).join('; ')}`)
  Main.activateWindow(desktopWindow)
  await frame(() => desktopWindow.has_focus(), 'desktop focus restored after capture')
  print('UNITE_SCREENSHOTS_PASS screenshot.png settings.png')
}
