// REQ-FEATURE-001, REQ-STATE-001, REQ-LIFE-002: private native GTK/tray journeys.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'

function assert(value, message) { if (!value) throw new Error(message) }
async function until(predicate, description) {
  const deadline = GLib.get_monotonic_time() + 5000000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Capability timeout: ${description}`)
    await Scripting.sleep(16)
  }
}
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

async function command(argv, environment = {}) {
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE })
  for (const [key, value] of Object.entries(environment)) launcher.setenv(key, value, true)
  const process = launcher.spawnv(argv)
  let timedOut = false
  let source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
    source = 0
    timedOut = true
    process.force_exit()
    return GLib.SOURCE_REMOVE
  })
  try {
    const [, output, errors] = await new Promise((resolve, reject) => process.communicate_utf8_async(null, null, (object, result) => {
      try { resolve(object.communicate_utf8_finish(result)) } catch (error) { reject(error) }
    }))
    if (output) print(output.trimEnd())
    if (errors) printerr(errors.trimEnd())
    assert(!timedOut && process.get_successful(), `Native capability client failed: ${JSON.stringify(argv)}`)
    assert(!/reported min (?:width|height) -\d+/.test(errors), 'Native capability client reported a negative widget minimum')
    return output
  } finally {
    if (source) GLib.source_remove(source)
  }
}

export async function runCapabilities(owner, settings) {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private native session required')
  const config = Gio.File.new_for_path(GLib.get_user_config_dir())
  assert(config.has_prefix(Gio.File.new_for_path(GLib.get_home_dir())), 'Private HOME must contain the configuration fixture')
  const source = Gio.File.new_for_path(GLib.getenv('UNITE_TEST_SOURCE')).get_child('tests')
  const wm = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' })
  const saved = [
    ...['hide-window-titlebars', 'show-legacy-tray', 'greyscale-tray-icons'].map(key => [settings, key, settings.get_user_value(key)]),
    [wm, 'button-layout', wm.get_user_value('button-layout')]
  ]
  const scenarios = []
  const files = []
  const errors = []
  let trayProcess = null
  const trayStatePath = `${GLib.get_user_runtime_dir()}/unite-tray-state.json`
  const trayState = () => GLib.file_test(trayStatePath, GLib.FileTest.EXISTS)
    ? JSON.parse(decode(GLib.file_get_contents(trayStatePath)[1])) : null
  const selection = async () => Number((await command(['/usr/bin/python3', source.get_child('x11-selection.py').get_path()])).trim())
  const record = name => { scenarios.push(name); print(`UNITE_CAPABILITY_SCENARIO ${name}`) }
  const styleClient = async (version, side, hidden, maximized = false, decoration = 'custom') => {
    const argv = version === 3
      ? ['/usr/bin/python3', source.get_child('gtk3-style-window.py').get_path()]
      : ['gjs', '-m', source.get_child('gtk4-style-window.mjs').get_path()]
    const options = [side, `${hidden}`, `${maximized}`]
    if (version === 4) options.push(decoration)
    const output = await command([...argv, ...options], { GDK_BACKEND: 'wayland' })
    assert(output.includes('GTK_STYLE_CLIENT_PASS '), `Missing GTK ${version} native style proof`)
  }
  try {
    settings.set_string('hide-window-titlebars', 'never')
    await Scripting.waitLeisure()
    const foreign = '/* Native acceptance foreign CSS: café */\nlabel.unite-acceptance-probe { color: rgb(17, 34, 51); }\n'
    for (const version of [3, 4]) {
      const file = config.get_child(`gtk-${version}.0`).get_child('gtk.css')
      const existed = file.query_exists(null)
      const original = existed ? file.load_contents(null)[1] : new Uint8Array()
      const seeded = decode(original) + foreign
      files.push({ file, existed, original, seeded, version })
      GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700)
      file.replace_contents(seeded, null, false, Gio.FileCreateFlags.PRIVATE, null)
    }
    for (const side of ['left', 'right']) {
      wm.set_string('button-layout', side === 'left' ? 'minimize,maximize,close:' : ':minimize,maximize,close')
      settings.set_string('hide-window-titlebars', 'always')
      await Scripting.waitLeisure()
      for (const { file, seeded, version } of files) {
        const actual = decode(file.load_contents(null)[1])
        assert(actual.endsWith(seeded), `GTK ${version} apply changed foreign CSS`)
        const path = owner.dir.get_child(`styles/gtk${version}/buttons-${side}/always.css`).get_path()
        assert(actual.includes(`@import url('${path}');`), `GTK ${version} uses the wrong toolkit/side stylesheet`)
        await styleClient(version, side, true)
        if (version === 4) await styleClient(version, side, true, false, 'default')
      }
      record(`GTK3/4 real ${side} CSD controls hidden; foreign rule retained and rendered`)
    }
    wm.set_string('button-layout', 'minimize,maximize,close:')
    settings.set_string('hide-window-titlebars', 'maximized')
    await Scripting.waitLeisure()
    for (const version of [3, 4]) {
      await styleClient(version, 'left', false)
      await styleClient(version, 'left', true, true)
      if (version === 4) {
        await styleClient(version, 'left', false, false, 'default')
        await styleClient(version, 'left', true, true, 'default')
      }
    }
    record('GTK3/4 maximized-only CSS distinguishes normal and native maximized windows')

    settings.set_boolean('show-legacy-tray', false)
    await until(() => !Main.panel.statusArea.uniteNextTrayIndicator, 'legacy tray initially disabled')
    const trayLauncher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE })
    trayLauncher.setenv('GDK_BACKEND', 'x11', true)
    trayProcess = trayLauncher.spawnv(['gjs', '-m', source.get_child('tray-icon.mjs').get_path(), trayStatePath])
    await until(() => trayState() !== null, 'native tray client initialized')
    assert(!trayState().embedded && await selection() === 0, 'Disabled tray retains an XEmbed selection/client')
    settings.set_boolean('show-legacy-tray', true)
    await until(() => trayState()?.embedded && Main.panel.statusArea.uniteNextTrayIndicator?._icons.length === 1,
      'actual native tray client embedded')
    assert(await selection() !== 0, 'Managed tray has no X11 selection owner')
    const indicator = Main.panel.statusArea.uniteNextTrayIndicator
    assert(indicator.visible, 'Embedded legacy icon is not visible in the panel')
    settings.set_boolean('greyscale-tray-icons', true)
    assert(indicator._icons[0].get_effect('desaturate') && indicator._icons[0].get_effect('brightness-contrast'),
      'Native greyscale effects were not applied')
    settings.set_boolean('greyscale-tray-icons', false)
    assert(!indicator._icons[0].get_effect('desaturate') && !indicator._icons[0].get_effect('brightness-contrast'),
      'Native greyscale effects were not removed')
    settings.set_boolean('show-legacy-tray', false)
    await until(() => !trayState()?.embedded && !Main.panel.statusArea.uniteNextTrayIndicator, 'native tray client detached')
    assert(await selection() === 0, 'Feature teardown did not release the actual X11 tray selection')
    settings.set_boolean('show-legacy-tray', true)
    await until(() => trayState()?.embedded && Main.panel.statusArea.uniteNextTrayIndicator?._icons.length === 1,
      'same live tray client re-embedded exactly once')
    record('real XEmbed add, greyscale toggle, unmanage selection release and same-client re-embed')

    Main.extensionManager.disableExtension(owner.uuid)
    await until(() => !owner.context && !trayState()?.embedded, 'disable releases tray client and activation')
    assert(await selection() === 0, 'Disable did not release the actual X11 tray selection')
    for (const { file, seeded, version } of files) {
      assert(decode(file.load_contents(null)[1]) === seeded, `GTK ${version} disable changed foreign bytes or retained owned CSS`)
      await styleClient(version, 'left', false)
      if (version === 4) await styleClient(version, 'left', false, false, 'default')
    }
    record('disable restores fresh GTK3/4 CSD controls and exact foreign CSS; tray selection released')
    Main.extensionManager.enableExtension(owner.uuid)
    await until(() => owner.context && trayState()?.embedded && Main.panel.statusArea.uniteNextTrayIndicator?._icons.length === 1,
      're-enable retains the same live tray client exactly once')
    trayProcess.force_exit()
    await new Promise((resolve, reject) => trayProcess.wait_async(null, (object, result) => {
      try { object.wait_finish(result); resolve() } catch (error) { reject(error) }
    }))
    trayProcess = null
    await until(() => Main.panel.statusArea.uniteNextTrayIndicator?._icons.length === 0, 'real tray client removal')
    assert(!Main.panel.statusArea.uniteNextTrayIndicator.visible, 'Empty tray indicator remains visible')
    record('native tray client removal leaves no icon or visible empty indicator')
  } catch (error) {
    errors.push(error)
  } finally {
    const cleanup = async callback => { try { await callback() } catch (error) { errors.push(error) } }
    await cleanup(async () => {
      if (!trayProcess) return
      trayProcess.force_exit()
      await new Promise((resolve, reject) => trayProcess.wait_async(null, (object, result) => {
        try { object.wait_finish(result); resolve() } catch (error) { reject(error) }
      }))
    })
    await cleanup(async () => {
      if (owner.context) return
      Main.extensionManager.enableExtension(owner.uuid)
      await until(() => owner.context, 'cleanup re-enable')
    })
    await cleanup(async () => { settings.set_string('hide-window-titlebars', 'never'); await Scripting.waitLeisure() })
    for (const { file, existed, original } of files) await cleanup(() => {
      if (existed) file.replace_contents(decode(original), null, false, Gio.FileCreateFlags.PRIVATE, null)
      else if (file.query_exists(null)) file.delete(null)
    })
    for (const [object, key, value] of saved.slice().reverse()) await cleanup(() =>
      value === null ? object.reset(key) : object.set_value(key, value))
    await cleanup(() => { if (GLib.file_test(trayStatePath, GLib.FileTest.EXISTS)) Gio.File.new_for_path(trayStatePath).delete(null) })
  }
  if (errors.length) throw new AggregateError(errors, `Native GTK/tray acceptance failed: ${errors.map(error => error.message).join('; ')}`)
  const result = { scenarios }
  print(`UNITE_CAPABILITIES_PASS ${JSON.stringify(result)}`)
  return result
}
