// Minimal private baseline: native WindowMenuManager with Unite disabled.
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'

const UUID = 'unite-next@lucastsudaka.github.io'
function assert(value, message) { if (!value) throw new Error(message) }
async function until(predicate, description) {
  const deadline = GLib.get_monotonic_time() + 5000000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Menu baseline timeout: ${description}`)
    await Scripting.sleep(16)
  }
}

export async function run() {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private session required')
  await until(() => Main.extensionManager.lookup(UUID)?.stateObj?.context,
    'initial extension activation')
  const owner = Main.extensionManager.lookup(UUID).stateObj
  const errors = []
  const manager = Main.wm._windowMenuManager
  try {
    Main.overview.hide()
    await until(() => !Main.overview.visibleTarget && !Main.overview.visible, 'overview hidden')
    await Scripting.createTestWindow({ maximized: true })
    await Scripting.waitTestWindows()
    const win = global.get_window_actors().find(actor =>
      actor.meta_window.get_client_type() === Meta.WindowClientType.WAYLAND)?.meta_window
    assert(win, 'Native Wayland test window missing')
    Main.activateWindow(win)
    await until(() => win.has_focus(), 'native window focused')
    Main.extensionManager.disableExtension(UUID)
    await until(() => !owner.context && !Main.panel.statusArea.uniteNextWindowControls,
      'Unite disabled before native baseline')
    assert(!Main.panel.has_style_class_name('unite-next-shell'), 'Unite panel style remains enabled')
    const [, y] = Main.panel.get_transformed_position()
    const [, height] = Main.panel.get_transformed_size()
    const rect = { x: 48 - height, y, width: 2 * height, height }
    assert(Object.values(rect).every(Number.isFinite), 'Non-finite native baseline rectangle')
    print(`UNITE_MENU_BASELINE_BEFORE ${JSON.stringify({ extensionEnabled: Boolean(owner.context), rect })}`)
    manager.showWindowMenuForWindow(win, Meta.WindowMenuType.WM, rect)
    await until(() => manager._manager.activeMenu?.isOpen, 'native baseline menu opened')
    const menu = manager._manager.activeMenu
    await until(() => menu.actor.mapped && menu.actor.has_allocation(), 'native baseline menu allocated')
    const source = manager._sourceActor
    print(`UNITE_MENU_BASELINE_AFTER ${JSON.stringify({ x: source.x, y: source.y,
      width: source.width, height: source.height, position: source.get_transformed_position(),
      size: source.get_transformed_size() })}`)
    menu.close()
    await until(() => !source.visible, 'native baseline menu source hidden')
    print('UNITE_MENU_BASELINE_PASS native menu opened and closed with Unite disabled')
  } catch (error) {
    errors.push(error)
  } finally {
    try { manager._manager.activeMenu?.close() } catch (error) { errors.push(error) }
    try {
      Main.extensionManager.enableExtension(UUID)
      await until(() => owner.context, 'extension state restored after native baseline')
    } catch (error) { errors.push(error) }
    try { await Scripting.destroyTestWindows() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors,
    `Native menu baseline failed: ${errors.map(error => error.message).join('; ')}`)
}
