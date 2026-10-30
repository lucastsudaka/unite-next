// Component acceptance entrypoint for a disposable GNOME session.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'
import * as Config from 'resource:///org/gnome/shell/misc/config.js'

export const METRICS = {}
const UUID = 'unite-next@lucastsudaka.github.io'
function assert(condition, message) { if (!condition) throw new Error(message) }
async function until(predicate, description) {
  const deadline = GLib.get_monotonic_time() + 10000000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Timed out acquiring ${description}`)
    await Scripting.sleep(16) // Observe compositor state within an explicit deadline.
  }
}

export async function runPreferences(owner) {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private preferences session required')
  const source = Gio.File.new_for_path(GLib.getenv('UNITE_TEST_SOURCE'))
  const library = GLib.getenv('UNITE_GNOME_LIBRARY_DIR')
  assert(library, 'Native preferences library directory was not resolved')
  const launcher = new Gio.SubprocessLauncher({
    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
  })
  launcher.setenv('LANGUAGE', 'pt_BR', true)
  launcher.setenv('LANG', 'pt_BR.UTF-8', true)
  launcher.setenv('LC_ALL', 'pt_BR.UTF-8', true)
  launcher.setenv('GI_TYPELIB_PATH', `${library}/girepository-1.0:${GLib.getenv('GI_TYPELIB_PATH') || ''}`, true)
  launcher.setenv('LD_LIBRARY_PATH', `${library}:${GLib.getenv('LD_LIBRARY_PATH') || ''}`, true)
  const child = launcher.spawnv(['gjs', '-m', source.get_child('tests/preferences-window.mjs').get_path(), owner.path])
  let timedOut = false
  let deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () => {
    deadline = 0
    timedOut = true
    child.force_exit()
    return GLib.SOURCE_REMOVE
  })
  let output
  let errors
  try {
    const [, stdout, stderr] = await new Promise((resolve, reject) => {
      child.communicate_utf8_async(null, null, (process, result) => {
        try { resolve(process.communicate_utf8_finish(result)) } catch (error) { reject(error) }
      })
    })
    output = stdout
    errors = stderr
  } catch (error) {
    child.force_exit()
    await new Promise((resolve, reject) => child.wait_async(null, (process, result) => {
      try { resolve(process.wait_finish(result)) } catch (waitError) { reject(waitError) }
    }))
    throw error
  } finally {
    if (deadline) GLib.source_remove(deadline)
  }
  if (output.trim()) print(output.trim())
  if (errors.trim()) printerr(errors.trim())
  assert(!timedOut, 'Native preferences client exceeded its 20-second process deadline')
  assert(child.get_successful() && output.includes('PREFERENCES_WINDOW_PASS'), 'Native preferences component failed; see acquisition diagnostics')
}

export async function run() {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private test state required')
  await until(() => Main.extensionManager.lookup(UUID)?.stateObj?.context ||
    Main.extensionManager.lookup(UUID)?.error, 'extension activation')
  const extension = Main.extensionManager.lookup(UUID)
  assert(extension?.stateObj?.context, `Extension activation failed: ${extension?.error}`)
  Main.overview.hide()
  await until(() => !Main.overview.visibleTarget, 'overview hidden')
  await runPreferences(extension.stateObj)
  print(`UNITE_PREFERENCES_COMPONENT_PASS ${JSON.stringify({ shell: Config.PACKAGE_VERSION })}`)
}
