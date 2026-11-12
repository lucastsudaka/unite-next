// Current ownership, eligibility, monitor, theme-discovery and locale contracts.
import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import St from 'gi://St'
import Shell from 'gi://Shell'
import { LocaleCategory, setlocale } from 'gettext'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'

function assert(value, message) { if (!value) throw new Error(message) }
async function until(predicate, description) {
  const deadline = GLib.get_monotonic_time() + 10000000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Correction timeout: ${description}`)
    await Scripting.sleep(16)
  }
}
const controls = () => Main.panel.statusArea.uniteNextWindowControls
const background = actor => actor.get_theme_node().get_background_image()?.get_uri() ?? null
function widthRequest(actor) {
  return { min: actor.min_width, minSet: actor.min_width_set,
    natural: actor.natural_width, naturalSet: actor.natural_width_set }
}
function restoreWidth(actor, state) {
  actor.min_width = state.min
  actor.natural_width = state.natural
  actor.min_width_set = state.minSet
  actor.natural_width_set = state.naturalSet
}
function sameWidth(actual, expected) {
  return actual.minSet === expected.minSet && actual.naturalSet === expected.naturalSet &&
    (!expected.minSet || actual.min === expected.min) &&
    (!expected.naturalSet || actual.natural === expected.natural)
}
function copyTree(source, target) {
  target.make_directory_with_parents(null)
  const entries = source.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
  try {
    for (let info; (info = entries.next_file(null));) {
      const from = source.get_child(info.get_name()), to = target.get_child(info.get_name())
      if (info.get_file_type() === Gio.FileType.DIRECTORY) copyTree(from, to)
      else from.copy(to, Gio.FileCopyFlags.NONE, null, null)
    }
  } finally { entries.close(null) }
}

export async function runCorrections(owner, settings, win) {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private native session required')
  const saved = new Map(['show-window-buttons', 'show-window-title', 'hide-window-titlebars',
    'restrict-to-primary-screen', 'window-buttons-theme', 'icon-scale-workaround',
    'notifications-position'].map(key => [key, settings.get_user_value(key)]))
  const scenarios = [], errors = []
  const record = name => { scenarios.push(name); print(`UNITE_CORRECTION_SCENARIO ${name}`) }
  const themeContext = St.ThemeContext.get_for_stage(global.stage)
  const originalScale = themeContext.scale_factor
  const originalMonitor = win.get_monitor()
  const banner = Main.messageTray._bannerBin
  let originalWidth, originalAlignment, foreignRoot, transientProcess, nativeSheet, nativeSheetTheme
  try {
    settings.set_string('notifications-position', 'center')
    await Scripting.waitLeisure()
    originalWidth = widthRequest(banner)
    originalAlignment = Main.messageTray.bannerAlignment
    for (const [name, minSet, naturalSet] of [
      ['fixed', true, true], ['minimum-only', true, false],
      ['natural-only', false, true], ['unconstrained', false, false]
    ]) {
      const expected = { min: 431, natural: 577, minSet, naturalSet }
      restoreWidth(banner, expected)
      settings.set_string('notifications-position', 'right')
      await Scripting.waitLeisure()
      assert(banner.min_width === 390 * originalScale && banner.natural_width === 390 * originalScale,
        `${name}: positioning did not apply native requests`)
      themeContext.scale_factor = originalScale + 1
      await Scripting.waitLeisure()
      assert(banner.min_width === 390 * (originalScale + 1), `${name}: scale update did not apply`)
      themeContext.scale_factor = originalScale
      settings.set_string('notifications-position', 'center')
      await Scripting.waitLeisure()
      assert(sameWidth(widthRequest(banner), expected), `${name}: original request semantics were lost`)
    }
    record('notification fixed/minimum/natural/unconstrained requests survive scale and cleanup')
    restoreWidth(banner, originalWidth)
    settings.set_string('notifications-position', 'right')
    await Scripting.waitLeisure()
    const foreignWidth = { min: 467, natural: 611, minSet: true, naturalSet: true }
    restoreWidth(banner, foreignWidth)
    Main.messageTray.bannerAlignment = Clutter.ActorAlign.CENTER
    settings.set_string('notifications-position', 'left')
    themeContext.scale_factor = originalScale + 1
    await Scripting.waitLeisure()
    settings.set_string('notifications-position', 'center')
    await Scripting.waitLeisure()
    assert(sameWidth(widthRequest(banner), foreignWidth) && Main.messageTray.bannerAlignment === Clutter.ActorAlign.CENTER,
      'Foreign notification geometry was overwritten during update/cleanup')
    themeContext.scale_factor = originalScale
    restoreWidth(banner, originalWidth)
    Main.messageTray.bannerAlignment = originalAlignment
    record('foreign notification requests/alignment survive updates and independent cleanup')

    settings.set_string('show-window-buttons', 'never')
    await Scripting.waitLeisure()
    const foreignIcon = new St.Bin({ style_class: 'icon', width: 24, height: 24 })
    foreignRoot = new St.Bin({ style_class: 'close', child: foreignIcon, width: 32, height: 32 })
    Main.uiGroup.add_child(foreignRoot)
    await Scripting.waitLeisure()
    const foreignImage = background(foreignIcon)
    settings.set_string('show-window-buttons', 'always')
    settings.set_boolean('icon-scale-workaround', false)
    await Scripting.waitLeisure()
    assert(background(foreignIcon) === foreignImage, 'Bundled control theme changed a foreign actor')
    record('bundled control CSS leaves a foreign matching actor unchanged')

    settings.set_boolean('restrict-to-primary-screen', false)
    settings.set_string('hide-window-titlebars', 'never')
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE })
    launcher.setenv('GDK_BACKEND', 'x11', true)
    transientProcess = launcher.spawnv(['/usr/bin/python3', `${GLib.getenv('UNITE_TEST_SOURCE')}/tests/gtk-transient-window.py`])
    let transient
    await until(() => {
      transient = global.get_window_actors().map(actor => actor.meta_window)
        .find(window => window.get_title() === 'Unite native transient')
      return transient
    }, 'native transient mapped')
    Main.activateWindow(transient)
    await until(() => owner.context.focusWindow?.win === transient, 'native transient focus')
    await Scripting.waitLeisure()
    assert(transient.skip_taskbar && owner.context.focusApp?.state === Shell.AppState.RUNNING,
      'Native transient does not exercise running-app skip-taskbar eligibility')
    assert(!controls().container.visible, 'Ineligible transient initially has controls')
    Main.overview.show()
    await until(() => Main.overview.visible && !Main.overview.animationInProgress, 'overview shown')
    Main.overview.hide()
    await until(() => !Main.overview.visible && !Main.overview.animationInProgress, 'overview hidden')
    await Scripting.waitLeisure()
    assert(owner.context.focusWindow?.win === transient && !controls().container.visible,
      'Overview re-exposed controls for the same ineligible transient')
    transientProcess.force_exit()
    transientProcess.wait(null)
    transientProcess = null
    await until(() => !global.get_window_actors().some(actor => actor.meta_window === transient), 'transient closed')
    Main.activateWindow(win)
    await until(() => owner.context.focusWindow?.win === win, 'normal window refocused')
    record('real skip-taskbar transient remains ineligible after native overview cycle')

    const secondary = Main.layoutManager.monitors.findIndex((_, index) => index !== Main.layoutManager.primaryIndex)
    assert(secondary >= 0, 'Two monitors required for primary precedence')
    win.move_to_monitor(secondary)
    Main.activateWindow(win)
    await until(() => !win.is_on_primary_monitor() && owner.context.focusWindow?.win === win, 'secondary window focused')
    settings.set_boolean('restrict-to-primary-screen', true)
    for (const key of ['show-window-buttons', 'show-window-title', 'hide-window-titlebars']) settings.set_string(key, 'always')
    await Scripting.waitLeisure()
    let managed = owner.context.focusWindow
    assert(!managed.showButtons && !managed.showTitle && !managed.hideTitlebars && !controls().container.visible,
      'Always bypassed primary restriction on a secondary window')
    settings.set_boolean('restrict-to-primary-screen', false)
    await Scripting.waitLeisure()
    managed = owner.context.focusWindow
    assert(managed.showButtons && managed.showTitle && managed.hideTitlebars && controls().container.visible,
      'Unrestricted Always did not apply on the secondary window')
    win.move_to_monitor(Main.layoutManager.primaryIndex)
    await until(() => win.is_on_primary_monitor(), 'normal window returned to primary')
    record('primary restriction takes precedence over Always and updates the existing secondary window')

    const id = 'unite-next-native-corrections'
    const directory = Gio.File.new_for_path(`${GLib.get_user_data_dir()}/unite-next/themes/${id}`)
    const feature = owner.panelManager.windowButtons
    copyTree(owner.dir.get_child('themes/default'), directory)
    const firstSheets = ['dark', 'light'].map(name => directory.get_child(`${name}/stylesheet.css`))
    const firstBytes = firstSheets.map(file => file.load_contents(null)[1])
    const { WindowControlsThemes } = await import(owner.dir.get_child('theme.js').get_uri())
    const discover = WindowControlsThemes.prototype.update
    const readAsync = Gio.File.prototype.load_contents_async
    const reportFailure = feature._reportThemeFailure
    const firstFailures = []
    let restoreButtons = null
    feature._reportThemeFailure = (error, request) => {
      assert(request === feature.themeRequest, 'Initial error reached the wrong native request')
      firstFailures.push(error)
    }
    try {
      for (const boundary of ['discovery', 'startup', 'import', 'presentation']) {
        settings.set_string('show-window-buttons', 'never')
        settings.set_string('window-buttons-theme', id)
        const before = firstFailures.length
        const failure = new Error(`Injected first-theme ${boundary} failure`)
        if (boundary === 'discovery') WindowControlsThemes.prototype.update = () => { throw failure }
        if (boundary === 'startup') Gio.File.prototype.load_contents_async = function (...args) {
          if (this.has_prefix(directory)) throw failure
          return readAsync.apply(this, args)
        }
        if (boundary === 'import') for (const file of firstSheets)
          file.replace_contents('@import "missing-initial-import.css";', null, false, Gio.FileCreateFlags.PRIVATE, null)
        settings.set_string('show-window-buttons', 'always')
        const initialControls = controls()
        const addButtons = initialControls.addButtons
        if (boundary === 'presentation') {
          restoreButtons = () => { initialControls.addButtons = addButtons }
          initialControls.addButtons = function (buttons) {
            addButtons.call(this, buttons)
            if (buttons.length) throw failure
          }
        }
        assert(!feature.themeReady && !initialControls.container.visible && initialControls._buttons.size === 0,
          'First acquisition exposed controls before its asynchronous theme')
        await until(() => firstFailures.length === before + 1 && feature.styles.preparations.size === 0,
          `first-theme ${boundary} failure`)
        assert((boundary === 'import' || firstFailures.at(-1) === failure) &&
          !feature.themeReady && !initialControls.container.visible && initialControls._buttons.size === 0 &&
          !initialControls.has_style_class_name(id) && !feature.styles.hasStyle('windowButtons') &&
          (!feature.styles.scopedStore || (feature.styles.scopedStore.directory === null && feature.styles.scopedStore.files.size === 0)),
        `First ${boundary} failure retained partial presentation or staging`)
        assert(settings.get_string('window-buttons-theme') === id && owner.context && owner.windowManager.windows.size > 0,
          'First-theme error rewrote selection or disabled unrelated features')
        Gio.File.prototype.load_contents_async = readAsync
        WindowControlsThemes.prototype.update = discover
        initialControls.addButtons = addButtons
        restoreButtons = null
        for (let index = 0; index < firstSheets.length; index++)
          firstSheets[index].replace_contents(firstBytes[index], null, false, Gio.FileCreateFlags.PRIVATE, null)
        settings.set_string('window-buttons-theme', 'default')
        await until(() => feature.themeReady && feature.theme.uuid === 'default' && feature.styles.preparations.size === 0,
          `first-theme ${boundary} recovery`)
        assert(controls() === initialControls && controls()._buttons.size === 3 && controls().container.visible,
          'Valid theme did not recover the same native control activation')
        record(`first-theme ${boundary} failure stays local, removes partial state and recovers by valid selection`)
      }
    } finally {
      restoreButtons?.()
      Gio.File.prototype.load_contents_async = readAsync
      WindowControlsThemes.prototype.update = discover
      feature._reportThemeFailure = reportFailure
      for (let index = 0; index < firstSheets.length; index++)
        firstSheets[index].replace_contents(firstBytes[index], null, false, Gio.FileCreateFlags.PRIVATE, null)
    }
    for (const variant of ['dark', 'light']) {
      const files = directory.get_child(variant)
      const source = files.get_child('close.svg')
      source.copy(files.get_child('relative ; icon.svg'), Gio.FileCopyFlags.NONE, null, null)
      const css = files.get_child('stylesheet.css')
      const original = new TextDecoder().decode(css.load_contents(null)[1])
      files.get_child('imported.css').replace_contents(
        `/* delimiters: , { } ; */\n.close .icon { background-image: url('relative ; icon.svg') !important; }\n`,
        null, false, Gio.FileCreateFlags.PRIVATE, null)
      css.replace_contents(`@import url('imported.css');\n${original}`, null, false, Gio.FileCreateFlags.PRIVATE, null)
    }
    const variant = feature.isDark ? 'dark' : 'light'
    nativeSheet = directory.get_child(`${variant}/stylesheet.css`)
    nativeSheetTheme = themeContext.get_theme()
    assert(nativeSheetTheme.load_stylesheet(nativeSheet), 'Original native cascade control did not load')
    await Scripting.waitLeisure()
    assert(background(foreignIcon) === directory.get_child(`${variant}/close.svg`).get_uri(),
      'Native custom-root rules did not outrank imported important rules')
    nativeSheetTheme.unload_stylesheet(nativeSheet)
    nativeSheet = null
    await Scripting.waitLeisure()
    assert(background(foreignIcon) === foreignImage, 'Original native control was not released')
    record('native custom-root origin outranks imported important rules before transformation')
    // Native imported sheets have lower origin than a custom-loaded root, even
    // with !important. Exercise relative imports without a competing root image.
    for (const name of ['dark', 'light']) directory.get_child(`${name}/stylesheet.css`).replace_contents(
      '@import url("imported.css");\n.window-button .icon { width: 16px; height: 16px; }\n',
      null, false, Gio.FileCreateFlags.PRIVATE, null)
    settings.set_string('window-buttons-theme', id)
    await until(() => feature.theme.uuid === id && feature.styles.preparations.size === 0,
      'asynchronous imported theme selection')
    await Scripting.waitLeisure()
    assert(settings.get_string('window-buttons-theme') === id && feature.theme.uuid === id,
      'Newly installed valid selection was rejected by stale discovery')
    const expectedImage = directory.get_child(`${variant}/relative ; icon.svg`).get_uri()
    assert(background(controls()._buttons.get('close').get_child()) === expectedImage,
      `Scoped import lost its resource base: expected ${expectedImage}, observed ${background(controls()._buttons.get('close').get_child())}`)
    assert(background(foreignIcon) === foreignImage, 'Imported user CSS changed a foreign actor')
    record('late valid theme selection preserves imported relative assets and foreign actor isolation')
    for (const name of ['dark', 'light']) {
      directory.get_child(`${name}/close.svg`).copy(directory.get_child(`${name}/changed-icon.svg`),
        Gio.FileCopyFlags.NONE, null, null)
      directory.get_child(`${name}/imported.css`).replace_contents(
        `#panel .${id} .close .icon { background-image: url('changed-icon.svg') !important; }\n`,
        null, false, Gio.FileCreateFlags.PRIVATE, null)
    }
    settings.set_string('window-buttons-theme', 'default')
    settings.set_string('window-buttons-theme', id)
    await until(() => feature.styles.preparations.size === 0 &&
      background(controls()._buttons.get('close').get_child()) === directory.get_child(`${variant}/changed-icon.svg`).get_uri(),
    'asynchronous changed import presentation')
    await Scripting.waitLeisure()
    assert(background(controls()._buttons.get('close').get_child()) === directory.get_child(`${variant}/changed-icon.svg`).get_uri(),
      'Changed imported content or external ancestor/root UUID selectors did not reach the actor')
    assert(background(foreignIcon) === foreignImage, 'Changed user CSS affected a foreign actor')
    record('changed imports retain fresh content, external ancestor and root UUID matching')

    // The full native driver selects pt_BR; compiler-level tests cover all five catalogs.
    assert(GLib.get_language_names().some(language => language.startsWith('pt_BR')), 'Portuguese native locale required')
    print(`UNITE_NATIVE_ACTION_LOCALE ${JSON.stringify({ locale: setlocale(LocaleCategory.MESSAGES, null),
      domain: owner.metadata['gettext-domain'], direct: owner.gettext('Close'),
      native: GLib.dgettext('unite-next', 'Close'), actual: controls()._buttons.get('close')?.accessible_name,
      catalog: owner.dir.get_child('locale/pt_BR/LC_MESSAGES/unite-next.mo').query_exists(null) })}`)
    const names = { close: 'Fechar', minimize: 'Minimizar', maximize: win.maximized_horizontally && win.maximized_vertically ? 'Restaurar' : 'Maximizar' }
    for (const [action, expected] of Object.entries(names)) {
      assert(controls()._buttons.get(action)?.accessible_name === expected,
        `Unlocalized native accessible ${action}: expected ${expected}, observed ${controls()._buttons.get(action)?.accessible_name}`)
    }
    record('native accessible window-action names use the installed Portuguese catalog')
  } catch (error) { errors.push(error) }
  finally {
    const cleanup = async callback => { try { await callback() } catch (error) { errors.push(error) } }
    await cleanup(() => { if (nativeSheet) nativeSheetTheme.unload_stylesheet(nativeSheet) })
    await cleanup(() => { if (transientProcess) { transientProcess.force_exit(); transientProcess.wait(null) } })
    await cleanup(() => foreignRoot?.destroy())
    await cleanup(() => { themeContext.scale_factor = originalScale })
    await cleanup(async () => { settings.set_string('notifications-position', 'center'); await Scripting.waitLeisure() })
    await cleanup(() => { if (originalWidth) restoreWidth(banner, originalWidth) })
    await cleanup(() => { if (originalAlignment !== undefined) Main.messageTray.bannerAlignment = originalAlignment })
    await cleanup(() => win.move_to_monitor(originalMonitor))
    for (const [key, value] of [...saved].reverse()) await cleanup(() => value === null ? settings.reset(key) : settings.set_value(key, value))
    await cleanup(async () => {
      Main.overview.hide()
      Main.activateWindow(win)
      await until(() => owner.context.focusWindow?.win === win && !Main.overview.visibleTarget, 'normal fixture restored')
      await Scripting.waitLeisure()
    })
  }
  if (errors.length) throw new AggregateError(errors, `Native correction acceptance failed: ${errors.map(error => error.message).join('; ')}`)
  const result = { scenarios }
  print(`UNITE_CORRECTIONS_PASS ${JSON.stringify(result)}`)
  return result
}
