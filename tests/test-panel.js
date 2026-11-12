// REQ-LIFE-001/002, REQ-PANEL-001, REQ-THEME-001, REQ-PREF-002.
// Import the actual ESM factories with UI boundary doubles, without a desktop.
import GLib from 'gi://GLib'
import NativeClutter from 'gi://Clutter'
import NativeGObject from 'gi://GObject'
import { Signals } from '../unite-next@lucastsudaka.github.io/resources.js'
import { Settings } from '../unite-next@lucastsudaka.github.io/settings.js'
import { Features } from '../unite-next@lucastsudaka.github.io/features.js'
import { createButtonWidgets, WINDOW_CONTROLS_SCOPE } from '../unite-next@lucastsudaka.github.io/button-widgets.js'
import { createPanelFeatures, createPanelManager } from '../unite-next@lucastsudaka.github.io/panel-features.js'
import { createLayoutFeatures, createLayoutManager } from '../unite-next@lucastsudaka.github.io/layout-features.js'

function assert(value, message = 'Assertion failed') {
  if (!value) throw new Error(message)
}

function equal(actual, expected, message = '') {
  assert(JSON.stringify(actual) == JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Run with disposable HOME/XDG/settings state')

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

class PresentationSource extends Emitter {
  observePresentation(callback) {
    const id = this.connect('presentation', callback)
    return () => this.disconnect(id)
  }
  invalidate() { this.emit('presentation') }
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

const Styles = class {
  addShellStyle() {}
  addScopedShellStyle(name, path, scope, presentation) { presentation?.apply() }
  cancelScopedShellStyle() {}
  prepareScopedShellStyle(name, path, scope, receive) { receive(null, new Map()) }
  removeAll() {}
}
const InjectionManager = class {
  constructor() { this.overrides = [] }
  overrideMethod(prototype, name, create) {
    const original = prototype[name]
    this.overrides.push([prototype, name, original])
    prototype[name] = create(original)
    if (InjectionManager.failNext) {
      InjectionManager.failNext = false
      throw new Error('Injected native override acquisition failure')
    }
  }
  clear() {
    for (const [prototype, name, original] of this.overrides) prototype[name] = original
    this.overrides = []
  }
}
const GObject = {Object: class {}, registerClass: klass => klass}
const Clutter = {
  ActorAlign: {CENTER: 0, START: 1, END: 2},
  EventPhase: {TARGET: 1},
  EventType: {TOUCH_BEGIN: 2},
  TextDirection: {RTL: 1}, ClickGesture,
  ActorBox: class {}
}
const themeContext = new Emitter()
themeContext.scale_factor = 2
const St = {
  Bin: Actor, BoxLayout: Actor,
  Button: Actor, Icon: Actor, Label: Actor,
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
  WindowControlsThemes: class { get default() { return theme } locate() { return theme } update() {} },
  isColorDark: color => color.red < 128
}

const globalFixture = {stage: {key_focus: null}}
const Buttons = {
  ...createButtonWidgets({
    GObject, St, Clutter, Main, PanelMenu: {Button: PanelButton}, gettext: value => `translated:${value}`,
    Animation: {}, AppMenu: class {}
  }),
  WINDOW_CONTROLS_SCOPE
}
const panel = createPanelFeatures({
  St, Clutter, Main, Buttons, Theme, Shell, Styles, InjectionManager,
  Meta: {WindowMenuType: {WM: 1}}, Pango: {EllipsizeMode: {END: 0}}, global: globalFixture
})
const layoutWarnings = []
const layout = createLayoutFeatures({
  St, Clutter, Main, Styles, global: globalFixture,
  warn: message => layoutWarnings.push(message)
})

function context() {
  const activities = new Actor()
  activities.container = new Actor()
  const values = {
      'button-layout': ':close,minimize,maximize',
      'window-buttons-layout': ['close', 'minimize', 'maximize'],
      'window-buttons-position': 'right', 'window-buttons-placement': 'auto',
      'window-buttons-theme': 'selected', 'gtk-theme': 'Adwaita', 'icon-scale-workaround': true,
      'action-double-click-titlebar': 'toggle-maximize',
      'action-middle-click-titlebar': 'minimize', 'action-right-click-titlebar': 'menu',
      'notifications-position': 'right'
  }
  const source = Object.assign(new Emitter(), { exists: key => key in values, getSetting: key => values[key] })
  return {
    values, settings: { extension: source },
    activities, windowTracker: new Emitter(), appSystem: new Emitter(),
    focusApp: {state: 2},
    focusWindow: {hideTitlebars: true, showButtons: true, hasFocus: true, skipTaskbar: false, maximized: false, win: {id: 5}}
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

test('panel allocation preserves finite nonnegative widths at normal, exact and overflow boundaries', () => {
  const saved = Main.panel
  try {
    for (const rtl of [false, true]) {
      for (const [width, center, right, expectedLeft] of [[1280, 200, 400, 300], [1280, 200, 1080, 0], [1280, 200, 1200, 0]]) {
        const allocations = []
        const box = natural => ({
          get_preferred_width: () => [natural, natural],
          allocate: value => allocations.push({...value})
        })
        Main.panel = {
          set_allocation() {}, get_text_direction: () => rtl ? Clutter.TextDirection.RTL : 0,
          _leftBox: box(300), _centerBox: box(center), _rightBox: box(right)
        }
        panel.ExtendLeftBox.prototype._allocate({x1: 0, y1: 0, x2: width, y2: 32})
        equal(allocations.length, 3)
        for (const allocation of allocations) {
          assert(Object.values(allocation).every(Number.isFinite), 'Panel geometry must remain finite')
          assert(allocation.x2 >= allocation.x1 && allocation.y2 >= allocation.y1,
            `Negative allocation at ${rtl}/${width}/${center}/${right}`)
        }
        equal(allocations[0].x2 - allocations[0].x1, expectedLeft, 'Available left space')
        equal(allocations[1].x2 - allocations[1].x1, center, 'Retained center natural width')
        equal(allocations[2].x2 - allocations[2].x1, right, 'Retained right natural width')
      }
    }
  } finally {
    Main.panel = saved
  }
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
  const controls = new Buttons.WindowControls(() => ctx.focusWindow)
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

test('control theme ownership marks every target without changing the native actor hierarchy', () => {
  for (const mode of [false, true]) {
    const controls = new Buttons.WindowControls(() => context().focusWindow)
    controls.setControlThemeParams({actionIcons: theme.getActionIcons(true), iconScaleWorkaround: mode})
    controls.addButtons(['close', 'minimize', 'maximize'])
    const actors = [controls.container, controls, controls._controls]
    for (const button of controls._buttons.values()) {
      actors.push(button, button.children[0])
      if (mode) actors.push(button.children[0].children[0])
    }
    for (const actor of actors) {
      const classes = [actor.style_class || '', ...actor.styles].flatMap(value => value.split(/\s+/))
      assert(classes.includes('unite-next-window-controls'), 'An owned CSS target lacks the fork scope')
    }
    assert(controls.container.children.length === 1 && controls.container.children[0] === controls, 'Native container hierarchy changed')
    assert(controls.children.length === 1 && controls.children[0] === controls._controls, 'Native control hierarchy changed')
    controls.destroy()
  }
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
  owner.button = {
    setApp() {}, stopAnimation() {}, setReactive() {}, setVisible() {},
    setText(text) { owner.text = text }, destroy() { owner.buttonDestroyed = true }
  }
  owner.tooltip = {destroy() { owner.tooltipDestroyed = true }}
  owner.signals = new Signals()
  owner.settings = new Settings(ctx)
  const timeoutError = new Error('Injected timeout cleanup failure')
  owner.timeouts = {removeAll() { throw timeoutError }}
  ctx.focusWindow.title = 'First\r\nwindow\nline\rend'
  owner._syncState()
  equal(app.listeners.size, 1)
  equal(owner.text, 'First window line end', 'Panel sanitizes the focused title')
  ctx.focusWindow = {hasFocus: true, title: 'Second\nwindow'}
  owner._syncState()
  equal(owner.text, 'Second window', 'Same-app window changes refresh panel-owned title')
  let error
  try { owner.destroy() } catch (caught) { error = caught }
  assert(error === timeoutError, 'Single cleanup failure must retain its original identity')
  assert(owner.buttonDestroyed && owner.tooltipDestroyed)
  equal(app.listeners.size, 0)
  Object.defineProperty(ctx, 'focusApp', {get() { throw new Error('Destroyed owner callback executed') }})
  app.emit('notify::busy')
})

test('app menu opening and hover changes cancel pending tooltip work', () => {
  const owner = new panel.AppmenuButton(context())
  owner.context.values['app-menu-max-width'] = 40
  owner.settings = new Settings(owner.context)
  const callbacks = new Map()
  let nextId = 0
  owner.timeouts = {
    timeout(_milliseconds, callback) { const id = ++nextId; callbacks.set(id, callback); return id },
    remove(id) { callbacks.delete(id) }
  }
  owner.tooltip = {visible: false, hide() { this.visible = false }}
  const button = {menu: {isOpen: false}, get_hover: () => true}
  owner._onAppMenuHover(button)
  equal(callbacks.size, 1)
  button.menu.isOpen = true
  owner._hideTooltip()
  equal(callbacks.size, 0, 'Opening the menu must cancel pending hover work')
  equal(owner.tooltipTimeout, null)
  owner._onAppMenuHover(button)
  equal(callbacks.size, 0, 'An open menu must not schedule another tooltip')
  button.menu.isOpen = false
  owner._onAppMenuHover(button)
  equal(callbacks.size, 1)
  button.get_hover = () => false
  owner._onAppMenuHover(button)
  equal(callbacks.size, 0, 'Leaving the app menu must cancel pending hover work')
  equal(owner.tooltip.visible, false)
})

test('activities policy updates immediately between active enum values and releases its observers', () => {
  const ctx = context()
  Object.assign(ctx.values, {'hide-activities-button': 'auto', 'show-desktop-name': false})
  ctx.focusApp = null
  const source = ctx.settings.extension
  const overviewListeners = Main.overview.listeners.size
  const owner = new Features(ctx)
  owner.add(panel.ActivitiesButton)
  try {
    owner.activate()
    equal(ctx.activities.container.visible, true, 'Auto shows Activities without a focused app')
    ctx.values['hide-activities-button'] = 'always'
    source.emit('changed::hide-activities-button')
    equal(ctx.activities.container.visible, false, 'Always hides Activities without another desktop event')
    ctx.values['hide-activities-button'] = 'auto'
    source.emit('changed::hide-activities-button')
    equal(ctx.activities.container.visible, true, 'Auto restores Activities without another desktop event')
  } finally {
    owner.destroy()
  }
  equal([source.listeners.size, ctx.appSystem.listeners.size, ctx.windowTracker.listeners.size,
    Main.overview.listeners.size], [0, 0, 0, overviewListeners], 'Policy observers are activation-owned')
  ctx.activities.container.visible = false
  source.emit('changed::hide-activities-button')
  equal(ctx.activities.container.visible, false, 'Disabled policy has no setting callback')
})

test('native allocation override restores its exact prototype method after normal and partial acquisition', () => {
  const saved = Main.panel
  const original = () => {}
  try {
    for (const fail of [false, true]) {
      const prototype = {vfunc_allocate: original}
      Main.panel = Object.assign(Object.create(prototype), {queue_relayout() {}})
      const owner = new panel.ExtendLeftBox(context())
      let observed
      owner._allocate = box => { observed = box }
      InjectionManager.failNext = fail
      let error
      try { owner.activate() } catch (caught) { error = caught }
      equal(Boolean(error), fail, 'Native override acquisition failure remains observable')
      assert(prototype.vfunc_allocate !== original, 'Native override was not installed')
      const box = {x1: 0, x2: 640}
      prototype.vfunc_allocate(box)
      assert(observed === box, 'Native vfunc does not use the owning feature')
      owner.destroy()
      assert(prototype.vfunc_allocate === original, 'Native vfunc was not restored exactly')
    }
  } finally {
    InjectionManager.failNext = false
    Main.panel = saved
  }
})

test('app menu constructor and destructor release external ownership after failure', () => {
  const calls = []
  const menu = {
    setApp(app) { equal(app, null); calls.push('app') },
    destroy() { calls.push('menu') }
  }
  const owner = Object.create(Buttons.AppmenuLabel.prototype)
  owner.menu = menu
  const managerError = new Error('Injected manager failure')
  owner._menuManager = {removeMenu() { calls.push('manager'); throw managerError }}
  let error
  try { owner._onDestroy() } catch (caught) { error = caught }
  assert(error === managerError, 'Single destructor failure must retain its original identity')
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
  assert(error === acquisitionError, 'Successful unwind must preserve the original acquisition error')
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

function bannerFixture(minimum, minimumSet, natural, naturalSet) {
  return {
    min_width: minimum, min_width_set: minimumSet,
    natural_width: natural, natural_width_set: naturalSet,
    frozen: 0,
    set_width(width) {
      if (width < 0) { this.min_width_set = false; this.natural_width_set = false }
      else {
        this.min_width = this.natural_width = width
        this.min_width_set = this.natural_width_set = true
      }
    },
    freeze_notify() { this.frozen++ },
    thaw_notify() { this.frozen-- }
  }
}
const widthRequests = banner => [banner.min_width, banner.min_width_set, banner.natural_width, banner.natural_width_set]

test('notification cleanup restores independent native width requests and flags after scaling', () => {
  for (const previous of [[420, true, 460, true], [250, true, 0, false],
    [0, false, 460, true], [0, false, 0, false]]) {
    const banner = bannerFixture(...previous)
    Main.messageTray._bannerBin = banner
    Main.messageTray.bannerAlignment = 0
    themeContext.scale_factor = 2
    const owner = new layout.Messages(context())
    owner.activate()
    equal(widthRequests(banner), [780, true, 780, true])
    equal(Main.messageTray.bannerAlignment, 2)
    themeContext.scale_factor = 3
    themeContext.emit('notify::scale-factor')
    equal(widthRequests(banner), [1170, true, 1170, true])
    owner.destroy()
    equal(widthRequests(banner), previous)
    equal(Main.messageTray.bannerAlignment, 0)
    equal([banner.frozen, themeContext.listeners.size], [0, 0])
  }
})

test('foreign notification requests and alignment survive later updates and cleanup visibly', () => {
  const banner = bannerFixture(420, true, 460, true)
  Main.messageTray._bannerBin = banner
  Main.messageTray.bannerAlignment = 0
  const owner = new layout.Messages(context())
  const warnings = layoutWarnings
  warnings.length = 0
  owner.activate()
  banner.min_width = 333
  banner.natural_width_set = false
  Main.messageTray.bannerAlignment = 1
  const foreign = widthRequests(banner)
  themeContext.emit('notify::scale-factor')
  owner._onPositionChange()
  owner.destroy()
  equal(widthRequests(banner), foreign)
  equal(Main.messageTray.bannerAlignment, 1)
  equal(warnings.length, 2, 'Each ownership conflict must remain visible once')
  assert(warnings.some(message => message.includes('width')))
  assert(warnings.some(message => message.includes('alignment')))
  equal(themeContext.listeners.size, 0)
  equal(owner.banner, null)
})

test('cleanup detects previously unobserved foreign notification geometry independently', () => {
  const banner = bannerFixture(420, true, 460, true)
  Main.messageTray._bannerBin = banner
  Main.messageTray.bannerAlignment = 0
  const owner = new layout.Messages(context())
  layoutWarnings.length = 0
  owner.activate()
  banner.min_width_set = false
  Main.messageTray.bannerAlignment = 1
  const foreign = widthRequests(banner)
  owner.destroy()
  equal(widthRequests(banner), foreign)
  equal(Main.messageTray.bannerAlignment, 1)
  equal(layoutWarnings.length, 2)
  equal(themeContext.listeners.size, 0)
})

test('notification restore failure still releases signals and references', () => {
  const banner = bannerFixture(420, true, 460, true)
  Main.messageTray._bannerBin = banner
  Main.messageTray.bannerAlignment = 0
  const owner = new layout.Messages(context())
  owner.activate()
  banner.freeze_notify = () => { throw new Error('Injected geometry restore failure') }
  let error
  try { owner.destroy() } catch (caught) { error = caught }
  assert(error, 'Geometry cleanup failure disappeared')
  equal(themeContext.listeners.size, 0)
  equal(owner.banner, null)
  equal(Main.messageTray.bannerAlignment, 0)
})

test('partial feature activation can always unwind independent owned resources', () => {
  for (const type of [...Object.values(panel), ...Object.values(layout)]) {
    const owner = new type(context())
    owner.destroy()
  }
})

test('installed click gesture API matches the configured recognition contract', () => {
  const gesture = new NativeClutter.ClickGesture({required_button: 2, n_clicks_required: 1, recognize_on_press: true})
  equal([gesture.required_button, gesture.n_clicks_required, gesture.recognize_on_press], [2, 1, true])
  equal(gesture.emit('may-recognize'), true)
  const id = gesture.connect('may-recognize', () => false)
  equal(gesture.emit('may-recognize'), false)
  gesture.disconnect(id)
  equal(gesture.emit('may-recognize'), true)
})

test('native manager objects initialize their GObject base and preserve their enable context', () => {
  const PanelManager = createPanelManager({GObject: NativeGObject, featureTypes: panel})
  const LayoutManager = createLayoutManager({GObject: NativeGObject, featureTypes: layout})
  const ctx = context()
  for (const type of [PanelManager, LayoutManager]) {
    const manager = new type(ctx, new Emitter())
    assert(manager.ref_count > 0, 'Native GObject instance was not initialized')
    assert(manager.features.context === ctx, 'Enable context changed')
    manager.destroy()
  }

  const disabledContext = () => {
    const state = context()
    Object.assign(state.values, {
      'show-appmenu-button': false, 'show-window-buttons': 'never', 'extend-left-box': false,
      'hide-activities-button': 'never', 'use-activities-text': false, 'show-desktop-name': false,
      'enable-titlebar-actions': false
    })
    return state
  }
  const state = disabledContext()
  const presentation = new PresentationSource()
  const manager = new PanelManager(state, presentation)
  manager.activate()
  equal(presentation.listeners.size, 1, 'One manager-owned presentation subscription')
  let appUpdates = 0
  let controlUpdates = 0
  manager.appmenu.button = {}
  manager.appmenu._syncState = () => appUpdates++
  manager.windowButtons.controls = {}
  manager.windowButtons._syncVisible = () => controlUpdates++
  presentation.invalidate()
  equal([appUpdates, controlUpdates], [1, 1], 'Both existing views refresh through the manager')
  manager.appmenu.button = null
  presentation.invalidate()
  equal([appUpdates, controlUpdates], [1, 2], 'An inactive view has no presentation callback')
  manager.destroy()
  equal([presentation.listeners.size, state.settings.extension.listeners.size], [0, 0], 'Manager releases every observer')
  equal(manager.windowManager, null, 'Manager releases its window provider')
  presentation.invalidate()
  equal([appUpdates, controlUpdates], [1, 2], 'Disabled manager has no callback')

  const failedState = disabledContext()
  const failedPresentation = new PresentationSource()
  const failed = new PanelManager(failedState, failedPresentation)
  failed.activate()
  const originalDisconnect = failed.disconnectPresentation
  const cleanupError = new Error('Injected presentation disconnect failure')
  failed.disconnectPresentation = () => { originalDisconnect(); throw cleanupError }
  let observed
  try { failed.destroy() } catch (error) { observed = error }
  assert(observed === cleanupError, 'Manager preserves its original cleanup error')
  equal([failedPresentation.listeners.size, failedState.settings.extension.listeners.size], [0, 0],
    'Independent feature cleanup still releases settings observers')
  equal(failed.windowManager, null, 'Cleanup failure does not retain the window provider')
  equal(failed.disconnectPresentation, null, 'Cleanup failure does not retain a release callback')
})

print(`${passed} panel contract scenarios passed; live Shell input/accessibility remains pending.`)
