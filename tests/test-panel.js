// REQ-LIFE-001/002, REQ-PANEL-001, REQ-THEME-001, REQ-PREF-002.
// Execute the actual module bodies with UI boundary doubles, without a desktop.
const {GLib, Gio} = imports.gi

function assert(value, message = 'Assertion failed') {
  if (!value) throw new Error(message)
}

function equal(actual, expected, message = '') {
  assert(JSON.stringify(actual) == JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

class Emitter {
  constructor() { this.listeners = new Map(); this.nextId = 1 }
  connect(name, callback) {
    const id = this.nextId++
    this.listeners.set(id, {name, callback})
    return id
  }
  disconnect(id) { this.listeners.delete(id) }
  emit(name, ...args) {
    let result
    for (const {name: signal, callback} of [...this.listeners.values()]) {
      if (name == signal) result = callback(this, ...args)
    }
    return result
  }
}

class Actor extends Emitter {
  constructor(props = {}) {
    super()
    Object.defineProperty(this, 'context', {
      set() { throw new Error('Actor.context accepts only native Clutter.Context') }
    })
    this.children = []
    this.visible = true
    this.styles = new Set()
    Object.assign(this, props)
  }
  add_child(child) { child.parent = this; this.children.push(child) }
  remove_child(child) { this.children = this.children.filter(item => item != child); child.parent = null }
  get_parent() { return this.parent || null }
  get_first_child() { return this.children[0] || null }
  set_child(child) { this.destroy_all_children(); if (child) this.add_child(child) }
  destroy_all_children() { for (const child of [...this.children]) child.destroy() }
  destroy() {
    this.destroyed = true
    this.destroy_all_children()
    this.parent?.remove_child(this)
    this.listeners.clear()
  }
  add_style_class_name(name) { this.styles.add(name) }
  remove_style_class_name(name) { this.styles.delete(name) }
  set_gicon(icon) { this.gicon = icon }
  set_style(style) { this.style = style }
  get_clutter_text() { return {set_ellipsize() {}} }
  queue_relayout() {}
  set_child_at_index() {}
  set_child_below_sibling() {}
  show() { this.visible = true }
  hide() { this.visible = false }
}

class PanelButton extends Actor {
  constructor(...args) { super(); this._init(...args) }
  _init() { this.container = new Actor(); this.container.add_child(this) }
  setMenu(menu) { this.menu = menu }
  _onDestroy() { this.baseDestroyed = true }
  destroy() { this._onDestroy(); super.destroy() }
}

class ClickGesture extends Emitter {
  constructor(props = {}) { super(); Object.assign(this, props); this.button = 1; this.presses = 1 }
  get_button() { return this.button }
  get_n_presses() { return this.presses }
  get_coords_abs() { return {x: 400, y: 1100} }
  get_actor() { return this.actor || null }
  emit(name, ...args) {
    const result = super.emit(name, ...args)
    return name == 'may-recognize' && result === undefined ? true : result
  }
}

function runCleanup(callbacks) {
  const errors = []
  for (const callback of callbacks) {
    try { callback() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Cleanup failed')
}

class Signals {
  constructor() { this.connections = [] }
  connect(object, name, callback) {
    this.connections.push([object, object.connect(name, callback)])
  }
  disconnectAll() {
    for (const [object, id] of this.connections) object.disconnect(id)
    this.connections = []
  }
}

class Settings extends Emitter {
  constructor(context) { super(); this.context = context }
  get(key) { return this.context.values[key] }
  disconnectAll() { this.listeners.clear() }
}

const Handlers = {
  Feature: class {
    constructor(context, key, predicate) { this.context = context; this._settingsKey = key; this._checkActive = predicate }
  },
  Signals, Settings, runCleanup,
  Timeouts: class { removeAll() {} },
  Styles: class { addShellStyle() {} removeAll() {} },
  Features: class {},
  Injections: class { vfunc() {} removeAll() {} }
}
const GObject = {Object: class {}, registerClass: klass => klass}
const Clutter = {
  ActorAlign: {CENTER: 0, START: 1, END: 2},
  EventPhase: {TARGET: 1}, EventType: {BUTTON_PRESS: 1, TOUCH_BEGIN: 2},
  TextDirection: {RTL: 1}, ClickGesture,
  ActorBox: class {}
}
const themeContext = new Emitter()
themeContext.scale_factor = 2
const St = {
  Bin: Actor, BoxLayout: Actor, Button: Actor, Icon: Actor, Label: Actor,
  ThemeContext: {get_for_stage: () => themeContext}
}
const Shell = {
  AppState: {STARTING: 1, RUNNING: 2},
  AppSystem: {get_default() { throw new Error('Import-time AppSystem acquisition') }},
  WindowTracker: {get_default() { throw new Error('Import-time WindowTracker acquisition') }}
}
const Main = {
  overview: Object.assign(new Emitter(), {visibleTarget: false}),
  modalCount: 0, panel: Object.assign(new Emitter(), {
    statusArea: {}, _leftBox: new Actor(), _rightBox: new Actor(), actions: new Map(),
    add_action_full(name, phase, action) { action.actor = this; action.phase = phase; this.actions.set(name, action) },
    get_action(name) { return this.actions.get(name) },
    remove_action(action) {
      for (const [name, item] of this.actions) if (item == action) this.actions.delete(name)
      action.actor = null
    },
    get_transformed_position: () => [1920, 1080],
    get_transformed_size: () => [1280, 32],
    get_theme_node: () => ({get_background_color: () => ({red: 20, green: 20, blue: 20})}),
    add_style_class_name() {}, remove_style_class_name() {}, queue_relayout() {},
    addToStatusArea(name, actor, index, side) {
      this.statusArea[name] = actor
      ;(side == 'left' ? this._leftBox : this._rightBox).add_child(actor.container)
    }
  }),
  messageTray: {bannerAlignment: 0},
  wm: {_windowMenuManager: {showWindowMenuForWindow(win, type, rect) { Main.lastMenu = {win, type, rect} }}}
}
Main.panel.statusArea.quickSettings = new Actor()
Main.panel._rightBox.add_child(Main.panel.statusArea.quickSettings)
Main.panel.actions.set('window-drag', new ClickGesture())

const theme = {
  uuid: 'selected',
  getStyle: dark => dark ? '/selected/dark.css' : '/selected/light.css',
  getActionIcons: dark => Object.fromEntries(['close', 'minimize', 'maximize'].map(action => [action, {
    default: `${dark ? 'dark' : 'light'}-${action}`,
    hover: `${dark ? 'dark' : 'light'}-${action}-hover`,
    active: `${dark ? 'dark' : 'light'}-${action}-active`
  }]))
}
const Theme = {
  WindowControlsThemes: class { get default() { return theme } locate() { return theme } },
  isColorDark: color => color.red < 128
}

function loadModule(file, names, boundaries) {
  let source
  const baseline = GLib.getenv('UNITE_PANEL_BASELINE')
  if (baseline) {
    const process = Gio.Subprocess.new(['git', 'show', `${baseline}:unite-next@lucastsudaka.github.io/${file}`], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
    const [, stdout, stderr] = process.communicate_utf8(null, null)
    if (!process.get_successful()) throw new Error(stderr)
    source = stdout
  } else {
    source = new TextDecoder().decode(GLib.file_get_contents(`unite-next@lucastsudaka.github.io/${file}`)[1])
  }
  source = source.replace(/^import .*\n/gm, '').replace(/^export /gm, '')
  return Function(...Object.keys(boundaries), `${source}\nreturn {${names.join(',')}}`)(...Object.values(boundaries))
}

const globalFixture = {stage: {key_focus: null}}
const Buttons = loadModule('buttons.js', ['WindowControls', 'AppmenuLabel'], {
  GObject, St, Clutter, Main, PanelMenu: {Button: PanelButton}, _: value => `translated:${value}`,
  Animation: {}, AppMenu: class {}, runCleanup, global: globalFixture
})
const panel = loadModule('panel.js', ['AppmenuButton', 'WindowButtons', 'ExtendLeftBox', 'ActivitiesButton', 'ActivitiesText', 'DesktopName', 'TrayIcons', 'TitlebarActions'], {
  GObject, St, Clutter, Main, Buttons, Theme, Shell, Handlers,
  Meta: {WindowMenuType: {WM: 1}}, Pango: {EllipsizeMode: {END: 0}}, global: globalFixture
})
const layout = loadModule('layout.js', ['Messages', 'PanelSpacing'], {GObject, St, Clutter, Main, Handlers, global: globalFixture})

function context() {
  const activities = new Actor()
  activities.container = new Actor()
  return {
    values: {
      'window-buttons-layout': ['close', 'minimize', 'maximize'],
      'window-buttons-position': 'right', 'window-buttons-placement': 'auto',
      'window-buttons-theme': 'selected', 'gtk-theme': 'Adwaita', 'icon-scale-workaround': true,
      'action-double-click-titlebar': 'toggle-maximize',
      'action-middle-click-titlebar': 'minimize', 'action-right-click-titlebar': 'menu',
      'notifications-position': 'right'
    },
    activities, windowTracker: new Emitter(), appSystem: new Emitter(),
    focusApp: {state: 2},
    focusWindow: {hideTitlebars: true, showButtons: true, maximized: false, win: {id: 5}, syncAppmenu() {}}
  }
}

let passed = 0
function test(name, callback) {
  callback()
  passed++
  print(`PASS ${name}`)
}

test('empty layouts and reversed layouts preserve the input in every placement', () => {
  for (const placement of ['auto', 'left', 'right', 'first', 'last']) {
    for (const empty of [[], null]) {
      const owner = new panel.WindowButtons(context())
      owner.context.values['window-buttons-placement'] = placement
      owner.context.values['window-buttons-layout'] = empty
      owner.settings = new Settings(owner.context)
      let observed
      owner.controls = {addButtons: buttons => observed = buttons}
      owner._syncVisible = () => {}
      owner._onLayoutChange()
      equal(observed, [], placement)
    }
  }
  const owner = new panel.WindowButtons(context())
  const original = owner.context.values['window-buttons-layout']
  owner.context.values['window-buttons-placement'] = 'left'
  owner.settings = new Settings(owner.context)
  owner.controls = {addButtons: buttons => equal(buttons, ['maximize', 'minimize', 'close'])}
  owner._syncVisible = () => {}
  owner._onLayoutChange()
  equal(original, ['close', 'minimize', 'maximize'])
})

test('persisted icon mode initializes before buttons and brightness/mode changes replace assets', () => {
  const owner = new panel.WindowButtons(context())
  owner.activate()
  let close = owner.controls._buttons.get('close')
  equal(close.children[0].children[0].gicon, 'dark-close')
  const previous = close
  owner.isDark = false
  owner._onThemeChange()
  close = owner.controls._buttons.get('close')
  assert(previous.destroyed, 'Previous icon widget must be released')
  equal(close.children[0].children[0].gicon, 'light-close')
  owner.context.values['icon-scale-workaround'] = false
  owner._updateIconScaleWorkaround(true)
  close = owner.controls._buttons.get('close')
  equal(close.children[0].children.length, 0)
  assert(close.styles.has('window-button close'))
  owner.destroy()
})

test('controls expose translated names, keyboard focus, current focus target and pressed icon priority', () => {
  const ctx = context()
  const controls = new Buttons.WindowControls(ctx)
  controls.setControlThemeParams({actionIcons: theme.getActionIcons(true), iconScaleWorkaround: true})
  controls.addButtons(['close', 'minimize', 'maximize'])
  for (const [action, button] of controls._buttons) {
    assert(button.can_focus, action)
    assert(button.accessible_name.startsWith('translated:'), action)
  }
  ctx.focusWindow.maximized = true
  controls.setVisible(true)
  equal(controls._buttons.get('maximize').accessible_name, 'translated:Restore')
  const close = controls._buttons.get('close')
  close.pressed = true
  close.emit('notify::pressed')
  close.hover = false
  close.emit('notify::hover')
  equal(close.children[0].children[0].gicon, 'dark-close-active')
  let closed = 0
  ctx.focusWindow = {close: () => closed++}
  close.emit('clicked')
  equal(closed, 1)
})

test('busy app subscriptions are released and independent cleanup survives a failure', () => {
  const ctx = context()
  const app = new Emitter()
  app.get_state = () => 2
  app.get_busy = () => false
  ctx.focusApp = app
  const owner = new panel.AppmenuButton(ctx)
  owner.focused = null
  owner.appSignals = new Signals()
  owner.button = {setApp() {}, stopAnimation() {}, setReactive() {}, setVisible() {}, destroy() { owner.buttonDestroyed = true }}
  owner.tooltip = {destroy() { owner.tooltipDestroyed = true }}
  owner.signals = new Signals()
  owner.settings = new Settings(ctx)
  owner.timeouts = {removeAll() { throw new Error('Injected timeout cleanup failure') }}
  owner._syncState()
  equal(app.listeners.size, 1)
  let error
  try { owner.destroy() } catch (caught) { error = caught }
  assert(error instanceof AggregateError)
  assert(owner.buttonDestroyed && owner.tooltipDestroyed)
  equal(app.listeners.size, 0)
  Object.defineProperty(ctx, 'focusApp', {get() { throw new Error('Destroyed owner callback executed') }})
  app.emit('notify::busy')
})

test('app menu constructor and destructor release external ownership after failure', () => {
  const calls = []
  const menu = {
    setApp(app) { equal(app, null); calls.push('app') },
    destroy() { calls.push('menu') }
  }
  const owner = Object.create(Buttons.AppmenuLabel.prototype)
  owner.menu = menu
  owner._menuManager = {removeMenu() { calls.push('manager'); throw new Error('Injected manager failure') }}
  let error
  try { owner._onDestroy() } catch (caught) { error = caught }
  assert(error instanceof AggregateError)
  equal(calls, ['manager', 'app', 'menu'])
  assert(owner.baseDestroyed, 'Parent widget cleanup must still execute')
  equal(owner.menu, null)
  equal(owner._menuManager, null)

  let unwound = false
  const original = Buttons.AppmenuLabel.prototype._initialize
  const acquisitionError = new Error('Injected constructor failure')
  Buttons.AppmenuLabel.prototype._initialize = function () {
    this.menu = {destroy() { unwound = true }}
    throw acquisitionError
  }
  error = null
  try { new Buttons.AppmenuLabel() } catch (caught) { error = caught }
  finally { Buttons.AppmenuLabel.prototype._initialize = original }
  assert(unwound, 'A constructor failure must destroy its externally parented menu')
  assert(error instanceof AggregateError && error.errors.includes(acquisitionError))
})

test('native target gestures arbitrate actions and restore native dragging on teardown', () => {
  const ctx = context()
  let maximized = 0
  let minimized = 0
  ctx.focusWindow.maximize = () => maximized++
  ctx.focusWindow.minimize = () => minimized++
  const owner = new panel.TitlebarActions(ctx)
  owner.activate()
  equal(owner.actions.map(item => [item.required_button, item.n_clicks_required, item.recognize_on_press, item.phase]),
    [[2, 1, true, 1], [3, 1, true, 1]])
  const drag = Main.panel.get_action('window-drag')
  drag.button = 1; drag.presses = 1
  equal(drag.emit('may-recognize'), true, 'Native first primary drag')
  drag.presses = 2
  equal(drag.emit('may-recognize'), false)
  equal(maximized, 1)
  const [middle, right] = owner.actions
  equal(middle.emit('should-handle-sequence', {type: () => 1, get_button: () => 2}), true)
  equal(middle.emit('should-handle-sequence', {type: () => 1, get_button: () => 1}), false)
  middle.button = 2
  middle.emit('recognize')
  equal(minimized, 1)
  right.button = 3
  right.emit('recognize')
  equal(Main.lastMenu.rect, {x: 368, y: 1080, width: 64, height: 32})
  Main.modalCount = 1
  equal(middle.emit('may-recognize'), false)
  equal(drag.emit('may-recognize'), true)
  equal(maximized, 1)
  Main.modalCount = 0
  Main.overview.visibleTarget = true
  equal(middle.emit('may-recognize'), false)
  equal(drag.emit('may-recognize'), true)
  equal(maximized, 1)
  Main.overview.visibleTarget = false
  ctx.values['action-double-click-titlebar'] = 'none'
  equal(drag.emit('may-recognize'), true)
  equal(maximized, 1)
  const actions = {
    'toggle-maximize': 'maximize',
    'toggle-maximize-horizontally': 'maximizeX',
    'toggle-maximize-vertically': 'maximizeY',
    minimize: 'minimize', lower: 'lower'
  }
  for (const [setting, method] of Object.entries(actions)) {
    let calls = 0
    ctx.values['action-middle-click-titlebar'] = setting
    ctx.focusWindow[method] = () => calls++
    middle.emit('recognize')
    equal(calls, 1, setting)
  }
  ctx.focusWindow.hideTitlebars = false
  equal(middle.emit('may-recognize'), false)
  equal(drag.emit('may-recognize'), true)
  owner.destroy()
  equal(Main.panel.actions.size, 1)
  equal(drag.listeners.size, 0)
  equal(drag.emit('may-recognize'), true)
})

test('partially attached gestures unwind without retaining the native drag veto', () => {
  const owner = new panel.TitlebarActions(context())
  const attach = Main.panel.add_action_full
  let attached = 0
  Main.panel.add_action_full = function (...args) {
    if (++attached == 2) throw new Error('Injected action attachment failure')
    return attach.apply(this, args)
  }
  let error
  try { owner.activate() } catch (caught) { error = caught }
  finally { Main.panel.add_action_full = attach }
  assert(error, 'Acquisition failure must remain observable')
  owner.destroy()
  equal(Main.panel.actions.size, 1)
  equal(Main.panel.get_action('window-drag').listeners.size, 0)
})

test('tray teardown disconnects before unmanaging and releases widgets after failures', () => {
  const order = []
  const owner = new panel.TrayIcons(context())
  owner.signals = {disconnectAll() { order.push('disconnect') }}
  owner.settings = {disconnectAll() { order.push('settings') }}
  owner.tray = {unmanage_screen() { order.push('unmanage'); throw new Error('Injected unmanage failure') }}
  owner.indicators = {destroy() { order.push('destroy') }}
  try { owner.destroy() } catch (error) { assert(error instanceof AggregateError) }
  equal(order, ['disconnect', 'settings', 'unmanage', 'destroy'])
  equal(owner.tray, null)
  equal(owner.indicators, null)
})

test('notification scaling follows the theme context and cleanup restores prior geometry', () => {
  const banner = {width_set: true, width: 420, set_width(width) { this.width = width }}
  Main.messageTray._bannerBin = banner
  Main.messageTray.bannerAlignment = 0
  const owner = new layout.Messages(context())
  owner.activate()
  equal(banner.width, 780)
  equal(Main.messageTray.bannerAlignment, 2)
  themeContext.scale_factor = 3
  themeContext.emit('notify::scale-factor')
  equal(banner.width, 1170)
  owner.destroy()
  equal(banner.width, 420)
  equal(Main.messageTray.bannerAlignment, 0)
  equal(themeContext.listeners.size, 0)
})

test('partial feature activation can always unwind independent owned resources', () => {
  for (const type of [...Object.values(panel), ...Object.values(layout)]) {
    const owner = new type(context())
    owner.destroy()
  }
})

test('installed click gesture API matches the configured recognition contract', () => {
  imports.gi.versions.Clutter = GLib.getenv('UNITE_CLUTTER_VERSION') || '18'
  const NativeClutter = imports.gi.Clutter
  const gesture = new NativeClutter.ClickGesture({required_button: 2, n_clicks_required: 1, recognize_on_press: true})
  equal([gesture.required_button, gesture.n_clicks_required, gesture.recognize_on_press], [2, 1, true])
  equal(gesture.emit('may-recognize'), true)
  const id = gesture.connect('may-recognize', () => false)
  equal(gesture.emit('may-recognize'), false)
  gesture.disconnect(id)
  equal(gesture.emit('may-recognize'), true)
})

test('native manager objects initialize their GObject base and preserve their enable context', () => {
  const NativeGObject = imports.gi.GObject
  const features = class {
    constructor(context) { this.context = context }
    add() {}
  }
  const nativeHandlers = {...Handlers, Features: features}
  const {PanelManager} = loadModule('panel.js', ['PanelManager'], {
    GObject: NativeGObject, St, Clutter, Main, Buttons, Theme, Shell, Handlers: nativeHandlers,
    Meta: {WindowMenuType: {WM: 1}}, Pango: {}, global: globalFixture
  })
  const {LayoutManager} = loadModule('layout.js', ['LayoutManager'], {
    GObject: NativeGObject, St, Clutter, Main, Handlers: nativeHandlers, global: globalFixture
  })
  const ctx = context()
  for (const type of [PanelManager, LayoutManager]) {
    const manager = new type(ctx)
    assert(manager.ref_count > 0, 'Native GObject instance was not initialized')
    assert(manager.features.context === ctx, 'Enable context changed')
  }
})

print(`${passed} panel contract scenarios passed; live Shell input/accessibility remains pending.`)
