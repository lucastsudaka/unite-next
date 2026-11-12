// REQ-FEATURE-003, REQ-PREF-002, REQ-LIFE-002: actual policy and owned event paths.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { assert, throws } from './assert.js'
import GObject from 'gi://GObject'
import Shell from 'gi://Shell'
import Meta from 'gi://Meta'
import { WindowManager } from '../unite-next@lucastsudaka.github.io/window.js'
import * as themeModule from '../unite-next@lucastsudaka.github.io/theme.js'
import { createPanelFeatures, createPanelManager } from '../unite-next@lucastsudaka.github.io/panel-features.js'
import { runCleanup } from '../unite-next@lucastsudaka.github.io/resources.js'

assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Run with disposable HOME/XDG/settings state')
const root = ARGV[0] || Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path()
const extension = root + '/unite-next@lucastsudaka.github.io'
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected),
  message + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))

class Emitter {
  constructor() { this.listeners = new Map(); this.serial = 0 }
  connect(name, callback) { this.listeners.set(++this.serial, { name, callback }); return this.serial }
  disconnect(id) { assert(this.listeners.delete(id), 'Disconnect must release an owned handler') }
  emit(name, ...args) {
    for (const entry of [...this.listeners.values()])
      if (entry.name === name) entry.callback(this, ...args)
  }
}

class SettingsSource extends Emitter {
  constructor(values) { super(); this.values = values }
  exists(key) { return key in this.values }
  getSetting(key) { return this.values[key] }
  set(key, value) { this.values[key] = value; this.emit('changed::' + key) }
}

const Main = { overview: new Emitter(), panel: { statusArea: {} } }
const globalFixture = { stage: { key_focus: null }, workspace_manager: { get_active_workspace: () => ({}) } }

class Styles {
  constructor() { this.entries = new Map(); this.calls = []; this.preparations = [] }
  addGtkStyle(name, path) {
    if (this.gtkError) throw this.gtkError
    this.entries.set(name, path)
    this.calls.push({ type: 'gtk', name, path })
  }
  deleteStyle(name) { this.entries.delete(name); this.calls.push({ type: 'delete', name }) }
  addShellStyle(name, path) {
    this.entries.set(name, path)
    this.calls.push({ type: 'shell', name, path })
  }
  addScopedShellStyle(name, path, scope, prepared, presentation) {
    assert(prepared instanceof Map, 'Styles require a prepared snapshot')
    if (this.scopeError) throw this.scopeError
    const previous = this.entries.get(name)
    this.entries.set(name, path)
    try { presentation?.apply() } catch (error) {
      if (previous === undefined) this.entries.delete(name)
      else this.entries.set(name, previous)
      presentation?.rollback()
      throw error
    }
    this.calls.push({ type: 'scoped', name, path, scope })
  }
  cancelScopedShellStyle(name) {
    for (const pending of this.preparations) if (pending.name === name) pending.receive = null
  }
  prepareScopedShellStyle(name, path, scope, receive) {
    this.cancelScopedShellStyle(name)
    if (this.defer) this.preparations.push({ name, path, scope, receive })
    else receive(null, new Map())
  }
  removeAll() { this.entries.clear(); for (const pending of this.preparations) pending.receive = null }
}
const warnings = []
const Theme = {
  ...themeModule,
  WindowControlsThemes: class extends themeModule.WindowControlsThemes {
    constructor() { super({ warn: message => warnings.push(message) }) }
  }
}
class Controls {
  constructor() { this.container = { visible: true }; this.classes = new Set(); this.visibilityCalls = []; this.buttons = [] }
  setVisible(value) { this.container.visible = Boolean(value); this.visibilityCalls.push(this.container.visible) }
  add_style_class_name(name) { this.classes.add(name) }
  remove_style_class_name(name) { this.classes.delete(name) }
  setControlThemeParams(params) { this.params = params }
  addButtons(buttons) { this.buttons = buttons }
  destroy() {
    this.destroyed = true
    if (Main.panel.statusArea.uniteNextWindowControls === this)
      delete Main.panel.statusArea.uniteNextWindowControls
  }
}
const Buttons = { WindowControls: Controls, WINDOW_CONTROLS_SCOPE: 'fixture-owned-control-target' }
const panelModule = createPanelFeatures({
  St: {}, Pango: {}, Clutter: {}, Meta, Shell, Main, Buttons, Theme, Styles,
  InjectionManager: class {}, global: globalFixture
})
const PanelManager = createPanelManager({ GObject, featureTypes: panelModule })

function fixture({ appState = Shell.AppState.RUNNING } = {}) {
  Main.overview = Object.assign(new Emitter(), { visibleTarget: false })
  Main.panel = Object.assign(new Emitter(), {
    statusArea: {}, background: { red: 0, green: 0, blue: 0 },
    get_theme_node() { return { get_background_color: () => this.background } },
    addToStatusArea(name, controls) { this.statusArea[name] = controls; controls.setVisible(true) }
  })
  warnings.length = 0
  const values = {
    'show-appmenu-button': false, 'extend-left-box': false, 'hide-activities-button': 'never',
    'use-activities-text': false, 'show-desktop-name': false, 'enable-titlebar-actions': false,
    'restrict-to-primary-screen': true, 'show-window-buttons': 'always',
    'show-window-title': 'always', 'hide-window-titlebars': 'never',
    'window-buttons-theme': 'default', 'gtk-theme': 'Adwaita', 'icon-scale-workaround': false,
    'window-buttons-placement': 'auto', 'window-buttons-position': 'left',
    'window-buttons-layout': ['close', 'minimize', 'maximize'], 'button-layout': 'close,minimize,maximize:'
  }
  const settings = new SettingsSource(values)
  const app = Object.assign(new Emitter(), {
    state: appState, is_on_workspace: () => true, get_name: () => 'Fixture app'
  })
  const win = Object.assign(new Emitter(), {
    window_type: Meta.WindowType.NORMAL, focused: true, primary: true,
    skip_taskbar: false, minimized: false, maximized_horizontally: true, maximized_vertically: true,
    get_id: () => 1, get_description: () => 'Wayland fixture',
    get_client_type: () => Meta.WindowClientType.WAYLAND,
    has_focus() { return this.focused }, is_on_primary_monitor() { return this.primary },
    get_title: () => 'Fixture window'
  })
  const display = Object.assign(new Emitter(), { focus_window: win })
  const monitorManager = new Emitter()
  const tracker = Object.assign(new Emitter(), { focus_app: app, get_window_app: () => app })
  let manager
  const context = {
    workspaceManager: globalFixture.workspace_manager,
    getCurrentTime: () => 1, getWindowActors: () => [],
    settings: { extension: settings }, display, monitorManager, appSystem: new Emitter(), windowTracker: tracker,
    get focusWindow() { return manager.focusWindow }, get focusApp() { return manager.focusApp }
  }
  manager = new WindowManager(context)
  manager.styles = new Styles()
  manager._connect()
  manager.registerWindow(win)
  manager._onFocusWindow(display)
  const state = { context, manager, model: manager.getWindow(win), app, win, display, monitorManager,
    tracker, settings, values, panel: null }
  state.activatePanel = (configure = () => {}) => {
    state.presentationOwner = new PanelManager(context, manager)
    state.panel = state.presentationOwner.windowButtons
    // Actor placement is covered by native/panel acceptance; preserve all real
    // settings, theme resolution, style acquisition and eligibility callbacks.
    state.panel._positionControls = () => {}
    configure(state.panel)
    state.presentationOwner.activate()
    return state.panel
  }
  state.destroy = () => runCleanup([() => state.presentationOwner?.destroy(), () => manager.destroy()])
  return state
}

let passed = 0
let failed = 0
function test(name, callback, options) {
  const state = fixture(options)
  try {
    callback(state)
    passed++
    print('PASS ' + name)
  } catch (error) {
    failed++
    printerr('FAIL ' + name + ': ' + error.message + '\n' + error.stack)
  } finally {
    try { state.destroy() } catch (error) { failed++; printerr('FAIL cleanup ' + name + ': ' + error.message + '\n' + error.stack) }
  }
}

test('one policy covers focused window, app state, overview and selected eligibility', state => {
  const owner = state.activatePanel()
  const controls = owner.controls
  const cases = [
    { name: 'running focused eligible', expected: true },
    { name: 'not focused', focused: false, expected: false },
    { name: 'skip taskbar', skip: true, expected: false },
    { name: 'never selected', policy: 'never', expected: false },
    { name: 'overview', overview: true, expected: false },
    { name: 'starting app', appState: Shell.AppState.STARTING, expected: false },
    { name: 'stopped app', appState: Shell.AppState.STOPPED, expected: false },
    { name: 'no focused app', noApp: true, expected: false }
  ]
  for (const scenario of cases) {
    state.win.focused = scenario.focused ?? true
    state.win.skip_taskbar = scenario.skip ?? false
    state.values['show-window-buttons'] = scenario.policy || 'always'
    Main.overview.visibleTarget = scenario.overview ?? false
    state.app.state = scenario.appState ?? Shell.AppState.RUNNING
    state.tracker.focus_app = scenario.noApp ? null : state.app
    owner._syncVisible()
    equal(controls.container.visible, scenario.expected, scenario.name)
  }
})

test('overview callbacks preserve exclusion of a focused skip-taskbar transient', state => {
  const owner = state.activatePanel()
  state.win.skip_taskbar = true
  state.win.emit('notify::skip-taskbar')
  equal(owner.controls.container.visible, false, 'Window update excludes transient')
  Main.overview.visibleTarget = true
  Main.overview.emit('showing')
  equal(owner.controls.container.visible, false, 'Overview excludes controls')
  Main.overview.visibleTarget = false
  Main.overview.emit('hiding')
  equal(owner.controls.container.visible, false, 'Overview hide retains transient exclusion')
})

test('owned app-state updates refresh controls after updating the starting-app context', state => {
  state.context.appSystem.emit('app-state-changed', state.app)
  const owner = state.activatePanel()
  equal(owner.controls.container.visible, false, 'Starting app has no controls')
  state.app.state = Shell.AppState.RUNNING
  state.context.appSystem.emit('app-state-changed', state.app)
  equal(state.manager._startingApps.length, 0, 'Completed startup leaves no starting entry')
  equal(owner.controls.container.visible, true, 'Running focused app recovers without another focus event')
}, { appState: Shell.AppState.STARTING })

test('skip-taskbar notifications update eligibility and all manager observers disconnect', state => {
  const owner = state.activatePanel()
  state.win.skip_taskbar = true
  state.win.emit('notify::skip-taskbar')
  equal(owner.controls.container.visible, false, 'Changed skip-taskbar hides controls')
  state.win.skip_taskbar = false
  state.win.emit('notify::skip-taskbar')
  equal(owner.controls.container.visible, true, 'Changed eligibility restores controls')
  state.manager.destroy()
  const calls = owner.controls.visibilityCalls.length
  state.win.emit('notify::skip-taskbar')
  state.context.appSystem.emit('app-state-changed', state.app)
  equal(owner.controls.visibilityCalls.length, calls, 'Destroyed manager receives no callbacks')
  equal(state.win.listeners.size, 0, 'Window observers released')
  equal(state.context.appSystem.listeners.size, 0, 'App-state observer released')
})

test('loss of the focused window hides controls without a focus-app notification', state => {
  const owner = state.activatePanel()
  equal(owner.controls.container.visible, true, 'Initial eligible controls')
  state.display.focus_window = null
  state.display.emit('notify::focus-window')
  equal(owner.controls.container.visible, false, 'No focused window means no actionable controls')
})

test('primary restriction precedes every per-window policy for titles, controls and decorations', state => {
  const states = [
    { horizontal: false, vertical: false, matches: { never: false, tiled: false, maximized: false, both: false, always: true } },
    { horizontal: true, vertical: false, matches: { never: false, tiled: true, maximized: false, both: true, always: true } },
    { horizontal: false, vertical: true, matches: { never: false, tiled: true, maximized: false, both: true, always: true } },
    { horizontal: true, vertical: true, matches: { never: false, tiled: false, maximized: true, both: true, always: true } }
  ]
  for (const restricted of [true, false]) for (const primary of [true, false]) {
    state.values['restrict-to-primary-screen'] = restricted
    state.win.primary = primary
    for (const nativeState of states) {
      state.win.maximized_horizontally = nativeState.horizontal
      state.win.maximized_vertically = nativeState.vertical
      for (const [policy, matches] of Object.entries(nativeState.matches)) {
        const expected = matches && (primary || !restricted)
        for (const [key, property] of [['show-window-title', 'showTitle'],
          ['show-window-buttons', 'showButtons'], ['hide-window-titlebars', 'hideTitlebars']]) {
          state.values[key] = policy
          equal(state.model[property], expected, key + '/' + policy + '/' + restricted + '/' + primary)
          equal(state.values[key], policy, 'Policy inspection must not rewrite its selected value')
        }
      }
    }
  }
})

test('monitor and restriction events update existing window eligibility', state => {
  const owner = state.activatePanel()
  state.win.primary = false
  state.display.emit('window-entered-monitor', 1, state.win)
  equal(owner.controls.container.visible, false, 'Secondary window excluded even under always')
  state.settings.set('restrict-to-primary-screen', false)
  equal(owner.controls.container.visible, true, 'Restriction removal updates existing window')
  state.settings.set('restrict-to-primary-screen', true)
  equal(owner.controls.container.visible, false, 'Restriction restoration updates existing window')
  state.win.primary = true
  state.display.emit('window-entered-monitor', 0, state.win)
  equal(owner.controls.container.visible, true, 'Primary monitor return updates existing window')
})

test('maximization property notifications update policies without a size event', state => {
  const owner = state.activatePanel()
  let hidden = false
  state.model.decorations = { hide() { hidden = true }, show() { hidden = false }, stop() {} }
  const states = [
    { horizontal: false, vertical: false, signal: 'notify::maximized-horizontally', tiled: false, maximized: false, both: false },
    { horizontal: false, vertical: true, signal: 'notify::maximized-vertically', tiled: true, maximized: false, both: true },
    { horizontal: true, vertical: true, signal: 'notify::maximized-horizontally', tiled: false, maximized: true, both: true },
    { horizontal: true, vertical: false, signal: 'notify::maximized-vertically', tiled: true, maximized: false, both: true }
  ]
  for (const policy of ['tiled', 'maximized', 'both']) {
    state.settings.set('show-window-buttons', policy)
    state.settings.set('hide-window-titlebars', policy)
    for (const expected of states) {
      state.win.maximized_horizontally = expected.horizontal
      state.win.maximized_vertically = expected.vertical
      state.win.emit(expected.signal)
      equal(owner.controls.container.visible, expected[policy], policy + '/' + expected.signal + ' controls')
      equal(hidden, expected[policy], policy + '/' + expected.signal + ' decorations')
    }
  }
  state.manager.destroy()
  equal(state.win.listeners.size, 0, 'Destroyed window releases maximization observers')
  const calls = owner.controls.visibilityCalls.length
  state.win.emit('notify::maximized-horizontally')
  state.win.emit('notify::maximized-vertically')
  equal(owner.controls.visibilityCalls.length, calls, 'Destroyed window ignores maximization changes')
})

test('primary-only monitor changes update every existing window and disconnect on teardown', state => {
  const owner = state.activatePanel()
  const other = Object.assign(new Emitter(), {
    window_type: Meta.WindowType.NORMAL, primary: false,
    get_id: () => 2, get_description: () => 'Second Wayland fixture',
    get_client_type: () => Meta.WindowClientType.WAYLAND,
    has_focus: () => false, is_on_primary_monitor() { return this.primary }
  })
  state.manager.registerWindow(other)
  let focusedHidden = false
  let otherHidden = false
  state.model.decorations = { hide() { focusedHidden = true }, show() { focusedHidden = false }, stop() {} }
  state.manager.getWindow(other).decorations = {
    hide() { otherHidden = true }, show() { otherHidden = false }, stop() {}
  }
  state.settings.set('hide-window-titlebars', 'always')
  equal([focusedHidden, otherHidden], [true, false], 'Initial primary-only decorations')
  state.win.primary = false
  other.primary = true
  state.monitorManager.emit('monitors-changed')
  equal(owner.controls.container.visible, false, 'Stationary focused window loses primary eligibility')
  equal([focusedHidden, otherHidden], [false, true], 'Both stationary windows follow the new primary')
  state.win.primary = true
  other.primary = false
  state.monitorManager.emit('monitors-changed')
  equal(owner.controls.container.visible, true, 'Primary restoration refreshes controls')
  equal([focusedHidden, otherHidden], [true, false], 'Both stationary windows follow primary restoration')
  state.manager.destroy()
  equal(state.monitorManager.listeners.size, 0, 'Destroyed manager releases monitor configuration observer')
  const calls = owner.controls.visibilityCalls.length
  state.monitorManager.emit('monitors-changed')
  equal(owner.controls.visibilityCalls.length, calls, 'Destroyed manager ignores monitor changes')
})

test('global GTK styles follow the restriction boundary for every policy and side', state => {
  for (const side of ['left', 'right']) for (const restricted of [true, false]) {
    state.values['window-buttons-position'] = side
    state.settings.set('restrict-to-primary-screen', restricted)
    for (const policy of ['never', 'tiled', 'maximized', 'both', 'always']) {
      state.settings.set('hide-window-titlebars', policy)
      const expected = !restricted && policy !== 'never' ? '@/buttons-' + side + '/' + policy + '.css' : undefined
      equal(state.manager.styles.entries.get('windowDecorations'), expected, 'GTK ' + side + '/' + restricted + '/' + policy)
    }
  }
  state.settings.set('restrict-to-primary-screen', true)
  equal(state.manager.styles.entries.size, 0, 'Restriction removes previously acquired GTK style')
})

test('GTK style acquisition failures stay visible', state => {
  state.values['restrict-to-primary-screen'] = false
  state.values['hide-window-titlebars'] = 'always'
  const failure = new Error('Injected GTK style publication failure')
  state.manager.styles.gtkError = failure
  assert(throws(() => state.manager._onStylesChange(), 'GTK style failure disappeared') === failure,
    'Original publication failure must remain observable')
})

test('presentation failure during actual native window registration rolls back every acquired owner', state => {
  state.manager.deleteWindow(state.win)
  const owner = state.activatePanel()
  const settingHandlers = state.settings.listeners.size
  const original = new Error('Injected native presentation failure')
  let calls = 0
  owner.controls.setVisible = () => { calls++; throw original }
  assert(throws(() => state.manager.registerWindow(state.win), 'Native presentation failure disappeared') === original,
    'Original presentation error must reach the acquisition boundary')
  equal(calls, 1, 'Rollback must not re-notify the failing presentation owner')
  equal([state.manager.hasWindow(state.win), state.win.listeners.size],
    [false, 0], 'Failed window registration releases its map entry and native window handlers')
  equal(state.settings.listeners.size, settingHandlers, 'Failed registration releases its setting handlers')
})

test('presentation and window rollback failures preserve original ordered errors without repeated notification', state => {
  state.manager.deleteWindow(state.win)
  const owner = state.activatePanel()
  const settingHandlers = state.settings.listeners.size
  const original = new Error('Injected presentation acquisition failure')
  const cleanup = new Error('Injected decoration rollback failure')
  let calls = 0
  owner.controls.setVisible = () => {
    calls++
    state.manager.getWindow(state.win).decorations.reset = () => { throw cleanup }
    throw original
  }
  const error = throws(() => state.manager.registerWindow(state.win), 'Acquisition and rollback failures disappeared')
  assert(error.errors?.[0] === original && error.errors[1] === cleanup && error.cause === original,
    'Rollback must preserve both original errors in order')
  equal(calls, 1, 'Failed rollback must not re-notify its failing observer')
  equal([state.manager.hasWindow(state.win), state.win.listeners.size],
    [false, 0], 'Independent native window ownership releases despite a rollback failure')
  equal(state.settings.listeners.size, settingHandlers, 'Rollback failure does not retain setting handlers')
})

test('presentation permits one explicit owner and stale disconnects cannot remove a later owner', state => {
  let calls = 0
  const observer = () => calls++
  throws(() => state.manager.observePresentation(null), 'Invalid observer was accepted')
  const first = state.manager.observePresentation(observer)
  throws(() => state.manager.observePresentation(() => { throw new Error('Overwrote the first observer') }),
    'A second owner silently replaced the existing observer')
  state.display.emit('notify::focus-window')
  equal(calls, 1, 'Original owner remains connected')
  first()
  first()
  state.display.emit('notify::focus-window')
  equal(calls, 1, 'Idempotent disconnect stops callbacks')
  const second = state.manager.observePresentation(observer)
  first()
  state.display.emit('notify::focus-window')
  equal(calls, 2, 'Stale disconnect cannot remove a new registration of the same callback')
  state.manager.destroy()
  state.display.emit('notify::focus-window')
  state.win.emit('notify::skip-taskbar')
  equal(calls, 2, 'Destroyed manager retains no observer or disabled native callback')
  second()
  second()
})

function copyTree(source, target) {
  target.make_directory_with_parents(null)
  const children = source.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null)
  try {
    let info
    while ((info = children.next_file(null))) {
      const original = source.get_child(info.get_name())
      const destination = target.get_child(info.get_name())
      if (info.get_file_type() === Gio.FileType.DIRECTORY) copyTree(original, destination)
      else original.copy(destination, Gio.FileCopyFlags.NONE, null, null)
    }
  } finally { children.close(null) }
}

test('explicit selection discovers a newly installed theme without brightness rescans or lost diagnostics', state => {
  const owner = state.activatePanel()
  const identifier = 'late-selection-' + GLib.uuid_string_random()
  const target = Gio.File.new_for_path(GLib.get_user_data_dir()).resolve_relative_path('unite-next/themes/' + identifier)
  copyTree(Gio.File.new_for_path(extension + '/themes/default'), target)
  let discoveries = 0
  const update = owner.themes.update.bind(owner.themes)
  owner.themes.update = () => { discoveries++; update() }
  state.settings.set('window-buttons-theme', identifier)
  equal(owner.theme.uuid, identifier, 'Newly installed selected theme reaches runtime')
  equal(state.values['window-buttons-theme'], identifier, 'Selected ID remains stored')
  assert(new Theme.WindowControlsThemes().available.some(theme => theme.uuid === identifier),
    'Preferences discovery and runtime agree on the valid theme')
  equal(discoveries, 1, 'Selection refreshes discovery once')
  const call = owner.styles.calls.at(-1)
  equal(call, { type: 'scoped', name: 'windowButtons', path: target.get_child('dark/stylesheet.css').get_path(),
    scope: Buttons.WINDOW_CONTROLS_SCOPE }, 'Selected theme uses the owned stylesheet boundary')
  Main.panel.background = { red: 255, green: 255, blue: 255 }
  Main.panel.emit('style-changed')
  equal(discoveries, 1, 'Brightness changes reuse discovery')
  equal(owner.theme.uuid, identifier, 'Brightness preserves current selection')
  state.settings.set('window-buttons-theme', 'missing-after-selection')
  equal(warnings.length, 1, 'Unavailable selection reports one bounded substitution')
  Main.panel.background = { red: 0, green: 0, blue: 0 }
  Main.panel.emit('style-changed')
  equal(discoveries, 2, 'Unavailable brightness change does not rescan')
  equal(warnings.length, 1, 'Brightness does not reset unavailable-theme diagnostic ownership')
  equal(state.values['window-buttons-theme'], 'missing-after-selection', 'Fallback preserves missing selected ID')
})

test('selection discovery and scoped style failures remain observable and release their owner', state => {
  const owner = state.activatePanel()
  const previousTheme = owner.theme
  const errors = []
  owner._reportThemeFailure = (error, request) => {
    assert(request === owner.themeRequest, 'Wrong request owns the failure')
    errors.push(error)
  }
  const discoveryFailure = new Error('Injected theme discovery failure')
  owner.themes.update = () => { throw discoveryFailure }
  state.settings.set('window-buttons-theme', 'not-rewritten')
  assert(errors[0] === discoveryFailure, 'Original discovery failure must remain visible')
  assert(owner.theme === previousTheme, 'Failed discovery must not silently substitute another theme')
  equal(state.values['window-buttons-theme'], 'not-rewritten', 'Failed discovery does not rewrite selection')
  const styleFailure = new Error('Injected scoped style acquisition failure')
  owner.styles.scopeError = styleFailure
  owner._onThemeChange()
  assert(errors.length === 2 && errors[1] === styleFailure, 'Current asynchronous style failure must reach its reporter')
  assert(owner.theme === previousTheme, 'Failed update must preserve the previous presentation')
  const controls = owner.controls
  const signals = owner.signals
  owner.destroy()
  assert(controls.destroyed && !owner.controls && !owner.themes, 'Failed owner releases controls and theme references')
  equal(signals.signals.size, 0, 'External observers released')
})

test('pending theme changes keep class, variant and icons together and only the latest request can apply', state => {
  const owner = state.activatePanel()
  const original = owner.theme
  const css = owner.styles.entries.get('windowButtons')
  const icons = owner.controls.params.actionIcons
  const choices = owner.themes.available.filter(theme => theme.uuid !== original.uuid)
  owner.styles.defer = true
  state.settings.set('window-buttons-theme', choices[0].uuid)
  const obsolete = owner.styles.preparations.at(-1).receive
  state.settings.set('window-buttons-theme', choices[1].uuid)
  assert(owner.theme === original && owner.controls.classes.has(original.uuid) &&
    owner.styles.entries.get('windowButtons') === css && owner.controls.params.actionIcons === icons,
    'Pending preparation changed active presentation')
  obsolete(null, new Map())
  assert(owner.theme === original, 'An obsolete result replaced the active presentation')
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.theme.uuid === choices[1].uuid && !owner.controls.classes.has(original.uuid) &&
    owner.controls.classes.has(choices[1].uuid), 'Latest theme and class disagree')
  const darkIcons = owner.controls.params.actionIcons
  Main.panel.background = { red: 255, green: 255, blue: 255 }
  Main.panel.emit('style-changed')
  state.settings.set('icon-scale-workaround', true)
  assert(owner.appliedDark === true && owner.controls.params.actionIcons === darkIcons,
    'Rendering-mode change used the pending brightness variant')
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.appliedDark === false && owner.controls.params.actionIcons === owner.theme.getActionIcons(false),
    'Prepared brightness and icon variant disagree')
})

test('failed or disposed preparation preserves the valid theme and cannot reach a later activation', state => {
  const owner = state.activatePanel()
  const original = owner.theme
  const css = owner.styles.entries.get('windowButtons')
  const errors = []
  owner._reportThemeFailure = error => errors.push(error)
  owner.styles.defer = true
  const next = owner.themes.available.find(theme => theme.uuid !== original.uuid)
  state.settings.set('window-buttons-theme', next.uuid)
  const failure = new Error('Unreadable prepared theme')
  owner.styles.preparations.at(-1).receive(failure, null)
  assert(errors[0] === failure && owner.theme === original && owner.styles.entries.get('windowButtons') === css,
    'Failed preparation replaced the valid presentation or lost its error')
  owner._onThemeChange()
  const pending = owner.styles.preparations.at(-1)
  const late = pending.receive
  const controls = owner.controls
  state.settings.set('show-window-buttons', 'never')
  assert(pending.receive === null && controls.destroyed, 'Feature removal retained pending delivery or controls')
  state.settings.set('show-window-buttons', 'always')
  const current = owner.controls
  late(null, new Map())
  assert(current === owner.controls && !current.destroyed && errors.length === 1,
    'Old activation reached a later owner or reported a stale failure')
})

test('presentation failure restores class, icons and stylesheet and first-theme failure permits local recovery', state => {
  const owner = state.activatePanel()
  const original = owner.theme
  const css = owner.styles.entries.get('windowButtons')
  const icons = owner.controls.params.actionIcons
  const next = owner.themes.available.find(theme => theme.uuid !== original.uuid)
  const failure = new Error('Injected action-icon application failure')
  const errors = []
  owner._reportThemeFailure = error => errors.push(error)
  const set = owner.controls.setControlThemeParams.bind(owner.controls)
  let injected = false
  owner.controls.setControlThemeParams = params => {
    set(params)
    if (!injected) { injected = true; throw failure }
  }
  state.settings.set('window-buttons-theme', next.uuid)
  assert(errors[0] === failure && owner.theme === original && owner.controls.classes.has(original.uuid) &&
    !owner.controls.classes.has(next.uuid) && owner.controls.params.actionIcons === icons &&
    owner.styles.entries.get('windowButtons') === css, 'Failed transition did not restore the complete presentation')
  state.settings.set('show-window-buttons', 'never')
  Styles.prototype.scopeError = failure
  try {
    state.settings.set('show-window-buttons', 'always')
    assert(errors.length === 2 && errors[1] === failure && !owner.themeReady && !owner.controls.container.visible &&
      owner.controls.buttons.length === 0 && owner.signals.signals.size > 0, 'First-theme failure was exposed or lost retry ownership')
  } finally { delete Styles.prototype.scopeError }
  const controls = owner.controls
  state.settings.set('window-buttons-theme', original.uuid)
  assert(owner.controls === controls && owner.themeReady && controls.container.visible && controls.buttons.length === 3,
    'A valid selection did not recover the same activation')
})

function pendingFirstTheme(state) {
  Styles.prototype.defer = true
  try { return state.activatePanel() } finally { delete Styles.prototype.defer }
}

test('initial discovery failure is local and a later selection retries discovery in the same activation', state => {
  const discovery = Theme.WindowControlsThemes
  const failure = new Error('Bundled default window controls theme is missing or invalid')
  const errors = []
  let owner
  Theme.WindowControlsThemes = class { constructor() { throw failure } }
  try { owner = state.activatePanel(panel => { panel._reportThemeFailure = error => errors.push(error) }) }
  finally { Theme.WindowControlsThemes = discovery }
  const controls = owner.controls
  assert(errors[0] === failure && !owner.theme && !owner.themes && !owner.themeReady &&
    !controls.container.visible && !controls.buttons.length && owner.signals.signals.size > 0,
    'Discovery failure escaped the local theme boundary or lost retry observers')
  state.settings.set('window-buttons-theme', 'default')
  assert(owner.controls === controls && owner.themeReady && controls.container.visible && controls.buttons.length === 3,
    'Repaired discovery did not recover the same feature activation')
})

test('pending first theme stays hidden and empty across panel, focus, layout and mode events', state => {
  const owner = pendingFirstTheme(state)
  const controls = owner.controls
  const pending = owner.styles.preparations.at(-1)
  state.settings.set('window-buttons-layout', ['close'])
  state.settings.set('button-layout', 'close:')
  state.settings.set('window-buttons-placement', 'right')
  state.settings.set('icon-scale-workaround', true)
  Main.overview.visibleTarget = true
  Main.overview.emit('showing')
  state.tracker.emit('notify::focus-app')
  Main.overview.visibleTarget = false
  Main.overview.emit('hiding')
  assert(!owner.themeReady && !controls.container.visible && controls.buttons.length === 0 &&
    !controls.classes.size && !controls.params && !owner.styles.entries.size,
    'Pending initial theme exposed controls, icons, classes or CSS')
  pending.receive(null, new Map())
  assert(owner.themeReady && controls.container.visible && controls.params.iconScaleWorkaround &&
    controls.classes.has(owner.theme.uuid), 'Initial theme did not apply the current presentation mode')
  equal(controls.buttons, ['close'], 'Initial success uses the current layout')
})

test('first-theme errors, discovery failures and superseding brightness retain retry without applying obsolete results', state => {
  const owner = pendingFirstTheme(state)
  owner.styles.defer = true
  const errors = []
  owner._reportThemeFailure = error => errors.push(error)
  const first = owner.styles.preparations.at(-1)
  const late = first.receive
  const update = owner.themes.update.bind(owner.themes)
  const failure = new Error('Initial theme discovery failed')
  owner.themes.update = () => { throw failure }
  state.settings.set('window-buttons-theme', 'missing-during-first-read')
  assert(first.receive === null && errors[0] === failure, 'Discovery failure did not cancel/report the pending first read')
  late(null, new Map())
  assert(!owner.themeReady && !owner.controls.container.visible && !owner.styles.entries.size, 'Invalidated first read was applied')
  owner.themes.update = update
  const next = owner.themes.available.find(theme => theme.uuid !== owner.theme.uuid)
  state.settings.set('window-buttons-theme', next.uuid)
  const obsoleteDark = owner.styles.preparations.at(-1).receive
  Main.panel.background = { red: 255, green: 255, blue: 255 }
  Main.panel.emit('style-changed')
  obsoleteDark(null, new Map())
  assert(!owner.themeReady, 'Superseded first variant became ready')
  const readFailure = new Error('Missing imported first-theme file')
  owner.styles.preparations.at(-1).receive(readFailure, null)
  assert(errors.at(-1) === readFailure && !owner.themeReady && !owner.controls.buttons.length &&
    state.values['window-buttons-theme'] === next.uuid, 'First read failure exposed presentation or rewrote settings')
  state.settings.set('window-buttons-theme', next.uuid)
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.themeReady && owner.theme.uuid === next.uuid && owner.appliedDark === false &&
    owner.controls.params.actionIcons === owner.theme.getActionIcons(false), 'Latest valid first theme did not recover')
})

test('failed first presentation clears partial buttons and reentrant first selection still refreshes', state => {
  const owner = pendingFirstTheme(state)
  owner.styles.defer = true
  const controls = owner.controls
  const choices = owner.themes.available.filter(theme => theme.uuid !== owner.theme.uuid)
  const addButtons = controls.addButtons.bind(controls)
  const failure = new Error('Partial first button construction')
  const errors = []
  owner._reportThemeFailure = error => errors.push(error)
  let redirected = false
  controls.addButtons = buttons => {
    addButtons(buttons)
    if (!redirected && buttons.length) {
      redirected = true
      state.settings.set('window-buttons-theme', choices[0].uuid)
      throw failure
    }
  }
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(!owner.themeReady && !controls.container.visible && !controls.buttons.length && !controls.classes.size &&
    !owner.styles.entries.size && owner.styles.preparations.length === 2,
    'First rollback retained presentation or lost its reentrant retry')
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.themeReady && owner.theme.uuid === choices[0].uuid && controls.container.visible && controls.buttons.length === 3,
    'Reentrant first selection did not recover')
})

test('removing a pending first-theme owner detaches reads before a new feature activation', state => {
  const owner = pendingFirstTheme(state)
  const first = owner.styles.preparations.at(-1)
  const late = first.receive
  const controls = owner.controls
  state.settings.set('show-window-buttons', 'never')
  assert(controls.destroyed && first.receive === null && !owner.activation, 'First read outlived its feature owner')
  Styles.prototype.defer = true
  try { state.settings.set('show-window-buttons', 'always') } finally { delete Styles.prototype.defer }
  const current = owner.controls
  late(null, new Map())
  assert(current !== controls && !owner.themeReady && !current.container.visible && !current.buttons.length &&
    !owner.styles.entries.size, 'Disposed first result reached a later activation')
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.themeReady && current.container.visible, 'Reactivated feature did not prepare its own first theme')
})

test('a selection made reentrantly during presentation supersedes the in-progress transition', state => {
  const owner = state.activatePanel()
  const original = owner.theme
  const choices = owner.themes.available.filter(theme => theme.uuid !== original.uuid)
  owner.styles.defer = true
  const set = owner.controls.setControlThemeParams.bind(owner.controls)
  let redirected = false
  owner.controls.setControlThemeParams = params => {
    set(params)
    if (!redirected) { redirected = true; state.settings.set('window-buttons-theme', choices[1].uuid) }
  }
  state.settings.set('window-buttons-theme', choices[0].uuid)
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.theme === original && owner.controls.classes.has(original.uuid), 'Superseded synchronous transition was exposed')
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.theme.uuid === choices[1].uuid && owner.controls.classes.has(choices[1].uuid), 'Latest reentrant selection was lost')
})

test('reentrant brightness invalidates the in-progress theme before committing its stale variant', state => {
  const owner = state.activatePanel()
  const original = owner.theme
  const next = owner.themes.available.find(theme => theme.uuid !== original.uuid)
  owner.styles.defer = true
  const set = owner.controls.setControlThemeParams.bind(owner.controls)
  let changed = false
  owner.controls.setControlThemeParams = params => {
    set(params)
    if (!changed) {
      changed = true
      Main.panel.background = { red: 255, green: 255, blue: 255 }
      Main.panel.emit('style-changed')
    }
  }
  state.settings.set('window-buttons-theme', next.uuid)
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.theme === original && owner.appliedDark === true && owner.isDark === false,
    'Superseded dark presentation committed while the light request was pending')
  owner.styles.preparations.at(-1).receive(null, new Map())
  assert(owner.theme.uuid === next.uuid && owner.appliedDark === false, 'Latest reentrant brightness was not applied')
})

test('old class, icon, rollback and finalization callbacks cannot mutate a reentrant new activation', state => {
  const owner = state.activatePanel()
  for (const boundary of ['remove_style_class_name', 'add_style_class_name', 'setControlThemeParams']) {
    const choices = owner.themes.available.filter(theme => theme.uuid !== owner.theme.uuid)
    const requested = choices[0]
    const replacement = choices[1]
    const oldStyles = owner.styles
    const oldControls = owner.controls
    oldStyles.defer = true
    const original = oldControls[boundary].bind(oldControls)
    let restarted = false
    oldControls[boundary] = (...args) => {
      const result = original(...args)
      if (!restarted) {
        restarted = true
        state.settings.set('show-window-buttons', 'never')
        state.settings.set('window-buttons-theme', replacement.uuid)
        state.settings.set('show-window-buttons', 'always')
      }
      return result
    }
    state.settings.set('window-buttons-theme', requested.uuid)
    oldStyles.preparations.at(-1).receive(null, new Map())
    assert(oldControls.destroyed && owner.controls !== oldControls && owner.styles !== oldStyles,
      'Reentrant activation did not acquire independent resources at ' + boundary)
    assert(owner.theme.uuid === replacement.uuid && owner.controls.classes.has(replacement.uuid) &&
      owner.styles.entries.get('windowButtons') === owner.theme.getStyle(owner.appliedDark) && !owner.applyingTheme,
      'Old transition changed the new activation presentation at ' + boundary)
  }
})

print(passed + ' window-control scenarios passed; ' + failed + ' failed; native compositor acceptance remains separate.')
if (failed) throw new Error('Window-control contract scenarios failed')
