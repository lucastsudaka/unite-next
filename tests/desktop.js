import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'
import * as Config from 'resource:///org/gnome/shell/misc/config.js'

export { init } from './desktop-startup.js'

export const METRICS = {}
const UUID = 'unite-next@lucastsudaka.github.io'
function assert(value, message) { if (!value) throw new Error(message) }

async function until(predicate, description, milliseconds = 10000) {
  const deadline = GLib.get_monotonic_time() + milliseconds * 1000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Timed out: ${description}`)
    await Scripting.sleep(16) // Bounded observation of asynchronous compositor state.
  }
}

export async function run() {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private test state required')
  assert(GLib.get_tmp_dir() === `${GLib.get_home_dir()}/tmp`,
    'Native temporary files require the private session directory')
  await until(() => Main.extensionManager.lookup(UUID)?.stateObj?.context ||
    Main.extensionManager.lookup(UUID)?.error, 'initial extension activation')
  const extension = Main.extensionManager.lookup(UUID)
  assert(extension?.stateObj?.context, `Initial activation failed: ${extension?.error}`)
  const owner = extension.stateObj
  const settings = owner.getSettings()
  const retiredKeys = ['show-legacy-tray', 'greyscale-tray-icons']
  const removalPhases = []
  const buttonsModule = await import(owner.dir.get_child('buttons.js').get_uri())
  const panelModule = await import(owner.dir.get_child('panel.js').get_uri())
  assert(!('TrayIndicator' in buttonsModule) && !('TrayIcons' in panelModule),
    'Retired system tray exports remain available')
  const assertSystemTrayAbsent = phase => {
    const keys = settings.settings_schema.list_keys()
    assert(retiredKeys.every(key => !keys.includes(key)), `${phase}: retired schema keys remain available`)
    assert(!Main.panel.statusArea.uniteNextTrayIndicator, `${phase}: retired panel indicator remains registered`)
    if (owner.context) {
      assert(owner.panelManager, `${phase}: active panel owner is absent`)
    } else {
      assert(!owner.panelManager, `${phase}: disabled panel manager remains owned`)
    }
    // Read only the disposable runner fixture. The product must never read or
    // rewrite these unknown values, including during retained-setting changes.
    const stored = new GLib.KeyFile()
    stored.load_from_file(`${GLib.get_user_config_dir()}/glib-2.0/settings/keyfile`, GLib.KeyFileFlags.NONE)
    for (const [key, value] of [['show-legacy-tray', 'true'], ['greyscale-tray-icons', 'false']]) {
      assert(stored.get_value('org/gnome/shell/extensions/unite-next', key) === value,
        `${phase}: retired stored value ${key} changed`)
    }
    removalPhases.push(phase)
  }
  assertSystemTrayAbsent('initial activation')
  const wm = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' })
  Main.overview.hide()
  await until(() => !Main.overview.visibleTarget, 'overview hidden')

  // Every persisted boolean is exercised in both directions with real consumers.
  for (const key of settings.settings_schema.list_keys()) {
    if (settings.get_value(key).get_type_string() !== 'b') continue
    for (const value of [false, true]) {
      settings.set_boolean(key, value)
      await Scripting.waitLeisure()
      assert(!(extension.errors?.length), `${key} produced extension errors`)
    }
    settings.reset(key)
  }
  assertSystemTrayAbsent('retained setting changes')
  for (const placement of ['auto', 'left', 'right', 'first', 'last']) {
    wm.set_string('button-layout', ':')
    settings.set_string('window-buttons-placement', placement)
    await Scripting.waitLeisure()
    assert(Main.panel.statusArea.uniteNextWindowControls._buttons.size === 0, `Empty layout failed at ${placement}`)
  }
  wm.set_string('button-layout', 'minimize,maximize,close:')
  settings.reset('window-buttons-placement')
  settings.set_string('show-window-buttons', 'always')

  await Scripting.createTestWindow({ maximized: true })
  await Scripting.waitTestWindows()
  await until(() => global.get_window_actors().length > 0, 'Wayland window mapped')
  const win = global.get_window_actors()[0].meta_window
  Main.activateWindow(win)
  await until(() => owner.context.focusWindow?.win === win, 'focused window managed')
  assert(win.get_client_type() === Meta.WindowClientType.WAYLAND, 'Expected a native Wayland fixture')

  const themeModule = await import(owner.dir.get_child('theme.js').get_uri())
  const originalPanelStyle = Main.panel.get_style()
  try {
    for (const theme of new themeModule.WindowControlsThemes().available) {
      // Expectations come from the shipped manifest, independently of the
      // runtime theme cache and getActionIcons/getStyle implementations.
      const directory = owner.dir.get_child('themes').get_child(theme.uuid)
      const manifest = new GLib.KeyFile()
      manifest.load_from_file(directory.get_child('unite.theme').get_path(), GLib.KeyFileFlags.NONE)
      const mappings = new Set(manifest.has_group('Icons') ? manifest.get_keys('Icons')[0] : [])
      for (const mode of [true, false]) {
        settings.set_boolean('icon-scale-workaround', mode)
        settings.set_string('window-buttons-theme', theme.uuid)
        for (const dark of [true, false, true]) {
          Main.panel.set_style(`background-color: ${dark ? 'rgb(0,0,0)' : 'rgb(255,255,255)'};`)
          await Scripting.waitLeisure()
          await until(() => owner.panelManager.windowButtons.theme.uuid === theme.uuid &&
            owner.panelManager.windowButtons.appliedDark === dark &&
            owner.panelManager.windowButtons.styles.preparations.size === 0,
          `prepared ${theme.uuid} ${dark ? 'dark' : 'light'} controls`)
          await Scripting.waitLeisure()
          const controls = Main.panel.statusArea.uniteNextWindowControls
          assert(controls._buttons.size === 3, `Missing controls for ${theme.uuid}`)
          assert(controls._iconScaleWorkaround === mode, 'Rendering mode was not applied')
          const stylesheet = directory.resolve_relative_path(manifest.get_string(dark ? 'Dark' : 'Light', 'Style'))
          const iconFile = (action, state) => {
            const key = state === 'default' ? action : `${action}-${state}`
            const filename = mappings.has(key) ? manifest.get_string('Icons', key) : `${key}.svg`
            return stylesheet.get_parent().resolve_relative_path(filename)
          }
          for (const [action, button] of controls._buttons) {
            assert(button.can_focus && button.accessible_name, 'Control lacks accessible action/focus')
            assert(controls._actionIcons[action].default.get_file().equal(iconFile(action, 'default')),
              `Stale native icon for ${theme.uuid}/${action}/${dark}`)
            const bin = button.get_child()
            const actual = mode ? bin.get_child().gicon.get_file() : bin.get_theme_node().get_background_image()
            const state = button.pressed ? 'active' : button.hover ? 'hover' : 'default'
            assert(actual?.equal(iconFile(action, state)), `Displayed icon differs from manifest for ${theme.uuid}/${action}/${dark}/${mode}`)
          }
        }
      }
    }
  } finally {
    Main.panel.set_style(originalPanelStyle)
  }
  settings.reset('window-buttons-theme')
  settings.reset('icon-scale-workaround')

  settings.set_string('show-window-title', 'always')
  await Scripting.waitLeisure()
  assert(Main.panel.statusArea.uniteNextAppMenu._label.text === win.get_title(), 'Focused title does not reach panel')
  const controls = Main.panel.statusArea.uniteNextWindowControls
  controls._buttons.get('maximize').emit('clicked', 1)
  await until(() => !win.maximized_horizontally, 'restore action')
  controls._buttons.get('maximize').emit('clicked', 1)
  await until(() => win.maximized_horizontally && win.maximized_vertically, 'maximize action')

  const source = Gio.File.new_for_path(GLib.getenv('UNITE_TEST_SOURCE'))
  const { runCorrections } = await import(source.get_child('tests/desktop-corrections.js').get_uri())
  const corrections = await runCorrections(owner, settings, win)

  const { runSpinner } = await import(source.get_child('tests/desktop-spinner.js').get_uri())
  const spinner = await runSpinner(owner)
  const { runX11 } = await import(source.get_child('tests/desktop-x11.js').get_uri())
  await runX11(owner, settings)
  Main.activateWindow(win)
  await until(() => owner.context.focusWindow?.win === win, 'Wayland focus restored')
  const { runInput } = await import(source.get_child('tests/desktop-input.js').get_uri())
  const input = await runInput(owner, settings, wm, win)
  assert(input.scenarios.length === 11, 'Incomplete native input and secondary-monitor policy acceptance')

  const { runPreferences } = await import(source.get_child('tests/desktop-preferences.js').get_uri())
  await runPreferences(owner)
  assertSystemTrayAbsent('native preferences')
  if (GLib.getenv('UNITE_SCREENSHOTS_DIR')) {
    const { runScreenshots } = await import(source.get_child('tests/desktop-screenshots.js').get_uri())
    await runScreenshots(owner, win)
  }
  const { runCapabilities } = await import(source.get_child('tests/desktop-capabilities.js').get_uri())
  const capabilities = await runCapabilities(owner, settings)
  assert(capabilities.scenarios.length === 5, 'Incomplete GTK capability acceptance')
  assertSystemTrayAbsent('GTK disable and re-enable')
  Main.activateWindow(win)
  await until(() => owner.context.focusWindow?.win === win, 'Wayland focus restored after toolkit clients')
  const { runMonitors } = await import(source.get_child('tests/desktop-monitors.js').get_uri())
  const monitors = await runMonitors(owner, settings, wm, win)
  assert(monitors.pending.length === 0 && monitors.stateTransitions.length === 2 && monitors.scenarios.length === 2 &&
    monitors.scenarios.every(scenario => scenario.input.length === 11),
    `Incomplete monitor acceptance: ${JSON.stringify(monitors)}`)

  for (let cycle = 0; cycle < 3; cycle++) {
    const previous = owner.windowManager
    Main.extensionManager.disableExtension(UUID)
    await until(() => !owner.context, 'extension disabled')
    assert(previous.windows.size === 0 && previous.signals.signals.size === 0 && previous.timeouts.store.size === 0,
      'Disabled manager retains resources')
    assert(!Main.panel.statusArea.uniteNextWindowControls && !Main.panel.statusArea.uniteNextAppMenu,
      'Disabled actors remain registered')
    assert(!Main.panel.get_action('unite-next-titlebar-1'), 'Disabled gesture remains attached')
    assertSystemTrayAbsent(`disabled cycle ${cycle}`)
    Main.extensionManager.enableExtension(UUID)
    await until(() => owner.context, 'extension re-enabled')
    await Scripting.waitLeisure()
    assert(!(extension.errors?.length), `Cycle ${cycle} produced errors`)
    assertSystemTrayAbsent(`enabled cycle ${cycle}`)
  }
  const { runFailureCleanup } = await import(source.get_child('tests/desktop-failures.js').get_uri())
  await runFailureCleanup(owner)
  assertSystemTrayAbsent('failure cleanup and recovery')
  await Scripting.destroyTestWindows()
  Main.extensionManager.disableExtension(UUID)
  await until(() => !owner.context, 'final extension teardown')
  assertSystemTrayAbsent('final teardown')
  print(`UNITE_DESKTOP_PASS ${JSON.stringify({ shell: Config.PACKAGE_VERSION,
    monitors: Main.layoutManager.monitors.map(({ x, y, width, height }) => ({ x, y, width, height })),
    input: input.scenarios, monitorScenarios: monitors.scenarios, windowStateScenarios: monitors.stateTransitions,
    capabilities, spinner, corrections,
    systemTrayRemoval: { phases: removalPhases, retiredKeysAbsent: true, staleStoredValuesPreserved: true },
    scenarios: ['settings toggles', 'empty layouts', 'theme rendering modes', 'accessible controls',
      'Wayland window title/maximize', 'three lifecycle cycles', 'failure cleanup and recovery'] })}`)
}
