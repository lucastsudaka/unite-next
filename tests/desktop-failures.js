import GLib from 'gi://GLib'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js'

const UUID = 'unite-next@lucastsudaka.github.io'
function assert(value, message) { if (!value) throw new Error(message) }

function released(owner, manager) {
  assert(owner.context === null && owner.windowManager === null &&
    owner.panelManager === null && owner.layoutManager === null, 'Failed lifecycle retains manager/context')
  assert(manager.windows.size === 0 && manager.signals.signals.size === 0 &&
    manager.timeouts.store.size === 0, 'Failed lifecycle retains window resources')
  assert(!Main.panel.statusArea.uniteNextAppMenu && !Main.panel.statusArea.uniteNextWindowControls,
    'Failed lifecycle retains native panel actors')
}

async function until(predicate, description) {
  const deadline = GLib.get_monotonic_time() + 5000000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Lifecycle fixture timeout: ${description}`)
    await Scripting.sleep(16)
  }
}

export async function runFailureCleanup(owner) {
  const extension = Main.extensionManager.lookup(UUID)
  Main.extensionManager.disableExtension(UUID)
  await until(() => extension.state === ExtensionState.INACTIVE && !owner.context, 'native inactive state')
  // Exercise synchronous lifecycle failures while the native manager remains
  // inactive. Its enabled-list queue must never coalesce our direct fault calls.
  owner.enable()
  const expected = new Error('Injected native lifecycle boundary failure')
  const windows = owner.windowManager
  const panel = owner.panelManager
  const destroy = panel.destroy
  panel.destroy = function () {
    destroy.call(this)
    throw expected
  }
  let observed
  try { owner.disable() } catch (error) { observed = error }
  assert(observed === expected, 'Cleanup changed or masked the original error')
  released(owner, windows)

  const { prototype } = windows.constructor
  const activate = prototype.activate
  let acquired
  prototype.activate = function () {
    acquired = this
    activate.call(this)
    throw expected
  }
  try {
    observed = null
    try { owner.enable() } catch (error) { observed = error }
    assert(observed === expected, 'Activation changed or masked the original error')
    released(owner, acquired)
  } finally {
    prototype.activate = activate
  }
  Main.extensionManager.enableExtension(UUID)
  await until(() => extension.state === ExtensionState.ACTIVE && owner.context,
    'native activation recovery after observed failures')
  print('UNITE_FAILURE_CLEANUP_PASS activation/cleanup/original-error/recovery')
}
