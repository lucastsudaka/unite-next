import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { loadModule, assert, throws } from './load-module.js'

const root = ARGV[0] || Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path()
const config = GLib.get_user_config_dir()
assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Run through tools/test-runtime.py for private state')
const St = {}
const Main = { uiGroup: {}, panel: { statusArea: {} }, overview: { visibleTarget: false } }
let importAllocations = 0
const legacySettings = () => { importAllocations++; return { exists: () => true } }
const Convenience = { getSettings: legacySettings, getPreferences: legacySettings, getInterface: legacySettings, getPath: () => `${root}/unite-next@lucastsudaka.github.io`, getDir: () => Gio.File.new_for_path(`${root}/unite-next@lucastsudaka.github.io`) }
const Handlers = loadModule(`${root}/unite-next@lucastsudaka.github.io/handlers.js`,
  { Gio, GLib, St, Main, Convenience, InjectionManager: class {} },
  ['runCleanup', 'resetGtkStyles', 'Signals', 'Settings', 'Timeouts', 'Feature', 'Features', 'Styles'])
let passed = 0
let failed = 0
function test(name, callback) {
  try { callback(); passed++; print(`PASS ${name}`) }
  catch (error) { failed++; printerr(`FAIL ${name}: ${error.stack}`) }
}
const read = path => new TextDecoder().decode(GLib.file_get_contents(path)[1])
const gtk3 = `${config}/gtk-3.0/gtk.css`
const gtk4 = `${config}/gtk-4.0/gtk.css`

test('Module import acquires no settings services', () => assert(importAllocations === 0, 'Import allocated active settings'))
test('GTK reset does not create files', () => {
  Handlers.resetGtkStyles()
  assert(!GLib.file_test(gtk3, GLib.FileTest.EXISTS), 'GTK 3 file was created')
  assert(!GLib.file_test(gtk4, GLib.FileTest.EXISTS), 'GTK 4 file was created')
})
test('GTK foreign bytes survive apply/remove; unchanged reset preserves inode', () => {
  GLib.mkdir_with_parents(GLib.path_get_dirname(gtk3), 0o700)
  const original = '/* user CSS */\nbutton { color: red; }\n'
  GLib.file_set_contents(gtk3, original)
  const file = Gio.File.new_for_path(gtk3)
  const inode = () => file.query_info('unix::inode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint64('unix::inode')
  const before = inode()
  Handlers.resetGtkStyles()
  assert(read(gtk3) === original && inode() === before, 'Unchanged CSS was rewritten')
  const styles = new Handlers.Styles()
  styles.addGtkStyle('test', 'window { padding: 0; }')
  assert(read(gtk3).endsWith(original), 'Foreign rules were changed')
  styles.removeAll()
  assert(read(gtk3) === original, 'Foreign CSS did not survive removal')
})
test('GTK cleanup attempts both versions on invalid UTF-8', () => {
  GLib.file_set_contents(gtk3, new Uint8Array([0xff]))
  GLib.file_set_contents(gtk4, '/* UNITE_NEXT test */\nwindow {}\n/* test UNITE_NEXT */\n/* user */')
  throws(() => Handlers.resetGtkStyles(), 'Invalid UTF-8 was silently replaced')
  assert(GLib.file_get_contents(gtk3)[1][0] === 0xff, 'Invalid file was changed')
  assert(read(gtk4) === '/* user */', 'Independent GTK 4 cleanup was skipped')
  GLib.file_set_contents(gtk3, '')
})
test('Independent signal cleanup proceeds after disconnect failure', () => {
  const signals = new Handlers.Signals()
  let attempted = 0
  const object = { connect: () => ++attempted, disconnect: () => { attempted++; throw new Error('injected') } }
  signals.connect(object, 'first', () => {})
  signals.connect(object, 'second', () => {})
  throws(() => signals.disconnectAll(), 'Disconnect failure disappeared')
  assert(attempted === 4 && signals.signals.size === 0, 'Handlers were retained/skipped')
})
test('Completed idle/timeout/interval ownership expires', () => {
  const sources = new Handlers.Timeouts()
  let count = 0
  sources.idle(() => count++)
  sources.timeout(1, () => count++)
  sources.interval(1, () => { count++; return false })
  const loop = new GLib.MainLoop(null, false)
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => { loop.quit(); return GLib.SOURCE_REMOVE })
  loop.run()
  assert(count === 3, 'Scheduled callbacks did not execute exactly once')
  assert(sources.store.size === 0, 'Completed source IDs remain owned')
  sources.removeAll()
  const key = sources.timeout(1000, () => { throw new Error('Cancelled callback executed') })
  sources.remove(key)
  sources.remove(key)
  assert(sources.store.size === 0, 'Cancelled source remains owned')
})
test('Throwing source callback expires ownership and propagates failure', () => {
  let callback
  const fakeGLib = Object.create(GLib)
  fakeGLib.idle_add = (_priority, handler) => { callback = handler; return 123 }
  const { Timeouts } = loadModule(`${root}/unite-next@lucastsudaka.github.io/handlers.js`,
    { Gio, GLib: fakeGLib, St, Main, Convenience, InjectionManager: class {} }, ['Timeouts'])
  const sources = new Timeouts()
  sources.idle(() => { throw new Error('original source error') })
  assert(throws(callback, 'Source failure disappeared').message === 'original source error', 'Original error changed')
  assert(sources.store.size === 0, 'Throwing source remains owned')
})

function eventObject() {
  return { handlers: new Map(), serial: 0,
    connect(name, callback) { this.handlers.set(++this.serial, { name, callback }); return this.serial },
    disconnect(id) { assert(this.handlers.delete(id), 'Invalid signal ID') } }
}
function context() {
  const setting = { ...eventObject(), exists: () => true,
    getSetting: key => key === 'hide-window-titlebars' ? 'never' : false }
  return { settings: { extension: setting }, appSystem: eventObject(), windowTracker: {}, display: eventObject() }
}

// These are the native 50/51 manager boundary states, not product helpers.
const ExtensionState = { ACTIVE: 1, INACTIVE: 2, ERROR: 3, DEACTIVATING: 7, ACTIVATING: 8 }
const UPSTREAM_UUID = 'unite@hardpixel.eu'
const FORK_UUID = 'unite-next@test.invalid'

function extensionFixture({ upstreamState, activationFault, cleanupFaults = [], deferred = false,
  requestFailure, membershipOutcome = 'both', modeExtensions = [],
  enabledMembership = [FORK_UUID, UPSTREAM_UUID], userExtensionsDisabled = false } = {}) {
  const events = []
  const emitter = {}
  imports.signals.addSignalMethods(emitter)
  const connections = new Set()
  const upstream = upstreamState === undefined ? null : { uuid: UPSTREAM_UUID, state: upstreamState }
  const fork = { uuid: FORK_UUID, state: ExtensionState.INACTIVE }
  const cleanupErrors = new Map(cleanupFaults.map(name => [name, new Error(name)]))
  const requestError = new Error('injected request failure')
  let enabled = [...enabledMembership]
  let disabled = []
  let owner
  let nativeDisable
  const manager = {
    reports: [],
    notifications: [],
    lookup(uuid) { return uuid === UPSTREAM_UUID ? upstream : uuid === FORK_UUID ? fork : undefined },
    connect(name, callback) {
      events.push('observer:connect')
      if (activationFault === 'observer:connect') throw new Error(activationFault)
      const id = emitter.connect(name, (_emitter, ...args) => callback(this, ...args))
      connections.add(id)
      return id
    },
    disconnect(id) {
      events.push('observer:disconnect')
      emitter.disconnect(id)
      assert(connections.delete(id), 'Conflict observer was disconnected more than once')
    },
    change(extension, state) {
      extension.state = state
      emitter.emit('extension-state-changed', extension)
    },
    disableExtension(uuid) {
      events.push('native:request')
      assert(uuid === FORK_UUID, 'Conflict changed upstream enabled membership')
      if (requestFailure === 'reject') return false
      if (requestFailure === 'throw') throw requestError
      if (requestFailure === 'unchanged') return true // Native API ignores failed set_strv booleans.
      if (membershipOutcome !== 'disabled') enabled = enabled.filter(item => item !== uuid)
      if (membershipOutcome !== 'removed') disabled.push(uuid)
      nativeDisable = () => {
        events.push('native:disable')
        this.change(fork, ExtensionState.DEACTIVATING)
        try { owner.disable() } catch (error) { this.logExtensionError(uuid, error) }
        if (fork.state !== ExtensionState.ERROR) this.change(fork, ExtensionState.INACTIVE)
      }
      if (!deferred) this.finishNativeDisable()
      return true
    },
    finishNativeDisable() {
      const callback = nativeDisable
      nativeDisable = null
      callback?.()
    },
    logExtensionError(uuid, error) {
      events.push('native:error')
      assert(uuid === FORK_UUID, 'Conflict changed upstream native state')
      assert(connections.size === 0, 'Native error was reported before observer cleanup')
      this.reports.push(error)
      this.change(fork, ExtensionState.ERROR)
    }
  }
  const acquire = name => class {
    constructor() { events.push(`${name}:new`) }
    activate() {
      events.push(`${name}:activate`)
      if (activationFault === `${name}:activate`) throw new Error(activationFault)
    }
    destroy() {
      events.push(`${name}:destroy`)
      if (cleanupErrors.has(`${name}:destroy`)) throw cleanupErrors.get(`${name}:destroy`)
    }
  }
  const main = { extensionManager: manager, sessionMode: { enabledExtensions: modeExtensions },
    notifyError(title, message) { events.push('notification'); manager.notifications.push({ title, message }) }, panel: {
    statusArea: {},
    add_style_class_name() { events.push('class:add') },
    remove_style_class_name() { events.push('class:remove') }
  } }
  const helpers = { ...Handlers,
    resetGtkStyles() {
      events.push('GTK')
      if (fork.state === ExtensionState.ACTIVE && cleanupErrors.has('GTK')) throw cleanupErrors.get('GTK')
    },
    Styles: class {
      constructor() { events.push('Style:new') }
      addShellStyle(_name, path) {
        events.push(`Style:load:${path}`)
        if (activationFault === 'Style:load') throw new Error(activationFault)
      }
      removeAll() {
        events.push('Style:unload')
        if (cleanupErrors.has('Style:unload')) throw cleanupErrors.get('Style:unload')
      }
    }
  }
  globalThis.global = { display: {}, settings: {
    get_boolean(key) {
      assert(key === 'disable-user-extensions', 'Unexpected native user-extension setting read')
      return userExtensionsDisabled
    },
    get_strv(key) {
      assert(['enabled-extensions', 'disabled-extensions'].includes(key), 'Unexpected native membership read')
      return [...(key === 'enabled-extensions' ? enabled : disabled)]
    }
  } }
  const { UniteNextExtension } = loadModule(`${root}/unite-next@lucastsudaka.github.io/extension.js`, {
    Extension: class { get uuid() { return FORK_UUID } getSettings() { events.push('settings'); return {} } },
    ExtensionState, Main: main, Handlers: helpers,
    Convenience: { adaptSettings: x => x, getPreferences: () => ({}), getInterface: () => ({}) },
    Shell: { AppSystem: { get_default: () => ({}) }, WindowTracker: { get_default: () => ({}) } },
    WindowManager: acquire('Window'), PanelManager: acquire('Panel'), LayoutManager: acquire('Layout')
  }, ['UniteNextExtension'])
  owner = new UniteNextExtension()
  return { extension: owner, events, manager, connections, upstream, fork, cleanupErrors, requestError }
}

test('Root stylesheet cannot acquire effects before the conflict check', () => {
  assert(!GLib.file_test(`${root}/unite-next@lucastsudaka.github.io/stylesheet.css`, GLib.FileTest.EXISTS),
    'GNOME can load the root stylesheet before enable performs its conflict check')
  assert(GLib.file_test(`${root}/unite-next@lucastsudaka.github.io/styles/shell.css`, GLib.FileTest.IS_REGULAR),
    'The explicit activation-owned Shell stylesheet is missing')
})
test('Active or activating upstream rejects fork activation without acquiring effects', () => {
  for (const upstreamState of [ExtensionState.ACTIVE, ExtensionState.ACTIVATING]) {
    const fixture = extensionFixture({ upstreamState })
    const error = throws(() => fixture.extension.enable(), 'Conflicting fork activation succeeded')
    assert(error.message.includes(UPSTREAM_UUID), 'Conflict diagnostic omits the upstream identity')
    assert(fixture.events.length === 0, 'Conflict acquired or cleaned effects before rejection')
    assert(fixture.upstream.state === upstreamState, 'Startup changed upstream state')
  }
})
test('Upstream activation releases fork effects before immediate or queued native deactivation', () => {
  for (const deferred of [false, true]) {
    const fixture = extensionFixture({ upstreamState: ExtensionState.INACTIVE, deferred })
    fixture.extension.enable()
    fixture.fork.state = ExtensionState.ACTIVE
    fixture.events.length = 0
    fixture.manager.change(fixture.upstream, ExtensionState.ACTIVATING)
    assert(fixture.events[0] === 'observer:disconnect', 'Conflict observer was not disconnected first')
    for (const event of ['Panel:destroy', 'Layout:destroy', 'Window:destroy', 'Style:unload', 'GTK', 'class:remove'])
      assert(fixture.events.includes(event), `Conflict omitted ${event}`)
    assert(fixture.events.indexOf('native:request') > fixture.events.indexOf('class:remove'),
      'Native deactivation was requested before synchronous teardown')
    assert(fixture.manager.reports.length === 0 && fixture.manager.notifications.length === 1 &&
      fixture.manager.notifications[0].message.includes(UPSTREAM_UUID), 'Normal conflict was hidden or fabricated an error')
    assert(!fixture.extension.context && fixture.connections.size === 0, 'Conflict retained context or observer')
    fixture.manager.finishNativeDisable()
    assert(fixture.fork.state === ExtensionState.INACTIVE && fixture.upstream.state === ExtensionState.ACTIVATING,
      'Conflict did not preserve native inactive/upstream states')
    assert(fixture.events.filter(event => event === 'Style:unload').length === 1,
      'Native repeated cleanup unloaded owned resources twice')
    const reports = fixture.manager.reports.length
    fixture.manager.change(fixture.upstream, ExtensionState.ACTIVE)
    assert(fixture.manager.reports.length === reports, 'Disconnected conflict observer ran again')
  }
})
test('Conflict cleanup attempts every owner and reports all cleanup failures', () => {
  for (const deferred of [false, true]) {
    const fixture = extensionFixture({ upstreamState: ExtensionState.INACTIVE, deferred,
      cleanupFaults: ['Panel:destroy', 'Style:unload', 'GTK'] })
    fixture.extension.enable()
    fixture.fork.state = ExtensionState.ACTIVE
    fixture.events.length = 0
    fixture.manager.change(fixture.upstream, ExtensionState.ACTIVATING)
    const original = deferred ? fixture.extension.pendingDisableError : fixture.manager.reports[0]
    if (deferred) assert(fixture.manager.reports.length === 0, 'Cleanup error bypassed native deactivation bookkeeping')
    fixture.manager.finishNativeDisable()
    const error = fixture.manager.reports[0]
    assert(error === original && error instanceof AggregateError && error.errors.length === 3,
      'Native deactivation replaced the original cleanup errors')
    for (const detail of ['Panel:destroy', 'Style:unload', 'GTK'])
      assert(error.message.includes(detail), `Native error hides ${detail}`)
    for (const event of ['Layout:destroy', 'Window:destroy', 'class:remove'])
      assert(fixture.events.includes(event), `A cleanup error skipped ${event}`)
    assert(fixture.connections.size === 0 && !fixture.extension.context, 'Failed cleanup retained ownership')
    assert(fixture.fork.state === ExtensionState.ERROR && fixture.extension.pendingDisableError === null,
      'Failed cleanup was reported as inactive or remained queued')
  }
})
test('Native deactivation request failures remain visible without claiming inactive state', () => {
  for (const requestFailure of ['reject', 'throw', 'unchanged']) {
    for (const cleanupFaults of [[], ['Panel:destroy']]) {
      const fixture = extensionFixture({ upstreamState: ExtensionState.INACTIVE, requestFailure, cleanupFaults })
      fixture.extension.enable()
      fixture.fork.state = ExtensionState.ACTIVE
      fixture.manager.change(fixture.upstream, ExtensionState.ACTIVATING)
      const error = fixture.manager.reports[0]
      assert(error && error.message.includes('deactivation failed'), 'Request failure disappeared')
      if (cleanupFaults.length) {
        assert(error instanceof AggregateError && error.errors.length === 2 &&
          error.errors[0] === fixture.cleanupErrors.get('Panel:destroy') && error.cause === error.errors[0],
        'Request failure replaced the original cleanup error')
      }
      const cause = cleanupFaults.length ? error.errors[1] : error.cause
      if (requestFailure === 'throw')
        assert(cause === fixture.requestError, 'Request failure replaced the thrown native error')
      else
        assert(cause.message.includes(requestFailure === 'reject' ? 'rejected' : 'effective enabled membership'),
          'Request diagnostic does not identify the native failure')
      assert(fixture.fork.state === ExtensionState.ERROR && fixture.extension.pendingDisableError === null,
        'Rejected request was reported as successful or left an unowned pending error')
      assert(fixture.manager.notifications.length === 1 &&
        fixture.manager.notifications[0].title === 'Unite Next could not deactivate' &&
        !fixture.extension.context && fixture.connections.size === 0 && !fixture.events.includes('native:disable'),
      'Request failure claimed success or retained owned resources')
      assert(global.settings.get_strv('enabled-extensions').includes(FORK_UUID) &&
        !global.settings.get_strv('disabled-extensions').includes(FORK_UUID), 'Failure fixture changed fork membership')
      assert(global.settings.get_strv('enabled-extensions').includes(UPSTREAM_UUID) &&
        !global.settings.get_strv('disabled-extensions').includes(UPSTREAM_UUID), 'Request failure changed upstream membership')
    }
  }
})
test('Effective native membership accepts own removal or disabled-list precedence', () => {
  for (const membershipOutcome of ['both', 'removed', 'disabled']) {
    const fixture = extensionFixture({ upstreamState: ExtensionState.INACTIVE, membershipOutcome, deferred: true })
    fixture.extension.enable()
    fixture.fork.state = ExtensionState.ACTIVE
    fixture.manager.change(fixture.upstream, ExtensionState.ACTIVATING)
    fixture.manager.finishNativeDisable()
    assert(fixture.fork.state === ExtensionState.INACTIVE && fixture.manager.reports.length === 0,
      `Effective native deactivation was rejected: ${membershipOutcome}`)
    assert(global.settings.get_strv('enabled-extensions').includes(UPSTREAM_UUID) &&
      !global.settings.get_strv('disabled-extensions').includes(UPSTREAM_UUID), 'Successful handoff changed upstream membership')
  }
})
test('Locked disabled membership cannot claim deactivation of a session-mode extension', () => {
  for (const userExtensionsDisabled of [false, true]) {
    for (const cleanupFaults of [[], ['Panel:destroy']]) {
      const fixture = extensionFixture({ upstreamState: ExtensionState.INACTIVE,
        modeExtensions: [FORK_UUID], enabledMembership: [UPSTREAM_UUID], userExtensionsDisabled,
        requestFailure: 'unchanged', cleanupFaults })
      fixture.extension.enable()
      fixture.fork.state = ExtensionState.ACTIVE
      fixture.manager.change(fixture.upstream, ExtensionState.ACTIVATING)
      const error = fixture.manager.reports[0]
      assert(error && error.message.includes('effective enabled membership'),
        'Session-mode membership was ignored after the disabled-list write failed')
      if (cleanupFaults.length)
        assert(error.errors[0] === fixture.cleanupErrors.get('Panel:destroy'),
          'Session-mode request failure replaced the original cleanup error')
      assert(fixture.fork.state === ExtensionState.ERROR && fixture.extension.pendingDisableError === null &&
        fixture.manager.notifications[0]?.title === 'Unite Next could not deactivate',
      'Locked session-mode membership claimed successful native deactivation')
      assert(!fixture.events.includes('native:disable') && fixture.connections.size === 0 && !fixture.extension.context,
        'Failed session-mode request fabricated native cleanup or retained effects')
      assert(global.settings.get_strv('enabled-extensions').join(',') === UPSTREAM_UUID &&
        global.settings.get_strv('disabled-extensions').length === 0, 'Session-mode failure changed foreign membership')
    }
  }
})
test('Disabled-list precedence deactivates session-mode extensions with user extensions enabled or disabled', () => {
  for (const userExtensionsDisabled of [false, true]) {
    const fixture = extensionFixture({ upstreamState: ExtensionState.INACTIVE,
      modeExtensions: [FORK_UUID], enabledMembership: [UPSTREAM_UUID], userExtensionsDisabled, deferred: true })
    fixture.extension.enable()
    fixture.fork.state = ExtensionState.ACTIVE
    fixture.manager.change(fixture.upstream, ExtensionState.ACTIVATING)
    fixture.manager.finishNativeDisable()
    assert(fixture.fork.state === ExtensionState.INACTIVE && fixture.manager.reports.length === 0 &&
      global.settings.get_strv('disabled-extensions').includes(FORK_UUID),
    'Session-mode membership incorrectly overrode native disabled-list precedence')
    assert(global.settings.get_strv('enabled-extensions').join(',') === UPSTREAM_UUID &&
      !global.settings.get_strv('disabled-extensions').includes(UPSTREAM_UUID), 'Session-mode handoff changed upstream membership')
  }
})
test('Inactive or absent upstream permits owned styles and observer cleanup over three cycles', () => {
  for (const upstreamState of [undefined, ExtensionState.INACTIVE]) {
    const fixture = extensionFixture({ upstreamState })
    for (let index = 0; index < 3; index++) {
      fixture.extension.enable()
      assert(fixture.connections.size === 1, 'Activation does not own exactly one conflict observer')
      assert(fixture.events.includes('Style:load:@/styles/shell.css'), 'Shell stylesheet was not explicitly loaded')
      fixture.manager.change({ uuid: 'unrelated@test.invalid' }, ExtensionState.ACTIVATING)
      assert(fixture.extension.context, 'An unrelated extension caused teardown')
      fixture.extension.disable()
      assert(fixture.connections.size === 0 && !fixture.extension.context, 'Disable retained the conflict observer')
    }
    assert(fixture.manager.reports.length === 0, 'Normal operation fabricated a conflict')
    assert(fixture.events.filter(event => event === 'Style:unload').length === 3, 'Styles leaked or unloaded twice')
  }
})
test('Observer, stylesheet or later activation failure releases acquired ownership', () => {
  for (const activationFault of ['observer:connect', 'Style:load', 'Panel:activate', 'Window:activate']) {
    const fixture = extensionFixture({ activationFault })
    assert(throws(() => fixture.extension.enable(), 'Injected activation fault disappeared').message === activationFault,
      'Activation replaced its original failure')
    assert(fixture.connections.size === 0 && !fixture.extension.context, 'Partial activation retained an observer')
    if (activationFault !== 'observer:connect')
      assert(fixture.events.includes('Style:unload'), 'Partial activation did not release its stylesheet')
  }
})

test('Settings-driven activation failure immediately releases partial resources', () => {
  const ctx = context()
  let enabled = false
  let resource = false
  let destroyed = 0
  ctx.settings.extension.getSetting = () => enabled
  class PartialFeature extends Handlers.Feature {
    constructor(context) { super(context, 'feature', value => value) }
    activate() { resource = true; throw new Error('dynamic activation fault') }
    destroy() { resource = false; destroyed++ }
  }
  const features = new Handlers.Features(ctx)
  features.add(PartialFeature)
  features.activate()
  enabled = true
  const callback = [...ctx.settings.extension.handlers.values()][0].callback
  throws(callback, 'Dynamic activation failure disappeared')
  assert(!resource && destroyed === 1 && !features.features[0].activated,
    'Dynamic partial activation was not immediately unwound')
  features.destroy()
  assert(destroyed === 1 && ctx.settings.extension.handlers.size === 0, 'Cleanup was repeated or retained handlers')
})

test('Activation failures unwind acquired managers and clear references', () => {
  for (const boundary of ['Style:new', 'Style:load', 'Window:new', 'Panel:new', 'Layout:new', 'GTK', 'Panel:activate', 'Layout:activate', 'Window:activate', 'class:add']) {
    const events = []
    const acquire = name => class {
      constructor() { events.push(`${name}:new`); if (boundary === `${name}:new`) throw new Error(boundary) }
      activate() { events.push(`${name}:activate`); if (boundary === `${name}:activate`) throw new Error(boundary) }
      destroy() { events.push(`${name}:destroy`) }
    }
    let gtk = 0
    const helpers = { ...Handlers,
      resetGtkStyles: () => { events.push('GTK'); if (boundary === 'GTK' && gtk++ === 0) throw new Error(boundary) },
      Styles: class {
        constructor() { if (boundary === 'Style:new') throw new Error(boundary) }
        addShellStyle() { if (boundary === 'Style:load') throw new Error(boundary) }
        removeAll() { events.push('Style:unload') }
      }
    }
    const main = { extensionManager: { ...eventObject(), lookup: () => undefined }, panel: {
      statusArea: {}, add_style_class_name() { if (boundary === 'class:add') throw new Error(boundary) },
      remove_style_class_name() { events.push('class:remove') }
    } }
    globalThis.global = { display: {} }
    const { UniteNextExtension } = loadModule(`${root}/unite-next@lucastsudaka.github.io/extension.js`, {
      Extension: class { getSettings() { return {} } }, ExtensionState, Main: main, Handlers: helpers,
      Convenience: { adaptSettings: x => x, getPreferences: () => ({}), getInterface: () => ({}) },
      Shell: { AppSystem: { get_default: () => ({}) }, WindowTracker: { get_default: () => ({}) } },
      WindowManager: acquire('Window'), PanelManager: acquire('Panel'), LayoutManager: acquire('Layout')
    }, ['UniteNextExtension'])
    const extension = new UniteNextExtension()
    throws(() => extension.enable(), `Activation ${boundary} unexpectedly succeeded`)
    for (const name of ['Window', 'Panel', 'Layout']) {
      if (events.includes(`${name}:new`) && boundary !== `${name}:new`)
        assert(events.includes(`${name}:destroy`), `${boundary} leaked ${name}`)
    }
    assert(!extension.context && !extension.windowManager && !extension.panelManager && !extension.layoutManager &&
      !extension.styles && !extension.conflictSignals && main.extensionManager.handlers.size === 0,
      `${boundary} retained extension references`)
  }
})
test('Disable attempts every cleanup despite each individual fault', () => {
  for (let fault = 0; fault < 7; fault++) {
    const calls = []
    const step = index => () => { calls.push(index); if (index === fault) throw new Error(`fault ${fault}`) }
    const { UniteNextExtension } = loadModule(`${root}/unite-next@lucastsudaka.github.io/extension.js`, {
      Extension: class {}, ExtensionState, Main: { panel: { remove_style_class_name: step(6) } },
      Handlers: { ...Handlers, resetGtkStyles: step(5) }, Shell: {}, Convenience: {},
      WindowManager: class {}, PanelManager: class {}, LayoutManager: class {}
    }, ['UniteNextExtension'])
    const extension = new UniteNextExtension()
    extension.context = {}
    extension.conflictSignals = { disconnectAll: step(0) }
    extension.panelManager = { destroy: step(1) }
    extension.layoutManager = { destroy: step(2) }
    extension.windowManager = { destroy: step(3) }
    extension.styles = { removeAll: step(4) }
    throws(() => extension.disable(), 'Cleanup fault disappeared')
    assert(calls.join(',') === '0,1,2,3,4,5,6' && extension.context === null &&
      !extension.conflictSignals && !extension.styles, 'Cleanup short-circuited or retained context')
  }
})

const Meta = { WindowType: { NORMAL: 1, DIALOG: 2, MODAL_DIALOG: 3, UTILITY: 4 },
  WindowClientType: { WAYLAND: 1 }, FrameType: { BORDER: 1 } }
const GObject = { Object: class { constructor(...args) { this._init(...args) } _init() {} }, registerClass: klass => klass }
test('Open windows retain no unmanaged/settings handlers after three cycles', () => {
  const window = { ...eventObject(), get_description: () => 'native', get_id: () => 7,
    get_client_type: () => 1, has_focus: () => false, get_title: () => 'title' }
  const { WindowManager } = loadModule(`${root}/unite-next@lucastsudaka.github.io/window.js`,
    { GObject, Shell: {}, Meta, Gio, Main, Handlers, Convenience }, ['WindowManager'])
  for (let index = 0; index < 3; index++) {
    const ctx = context()
    const manager = new WindowManager(ctx)
    manager.setWindow(window)
    assert(window.handlers.size === 3, 'Expected one unmanaged and two window handlers')
    manager.destroy()
    assert(window.handlers.size === 0 && ctx.settings.extension.handlers.size === 0, 'Destroyed window owner retains signals')
    assert(!window._uniteNextManaged && manager.windows.size === 0, 'Window remains managed')
  }
})

test('Motif ownership preserves fields, absence and foreign updates', () => {
  for (const initial of [null, { type: 99, format: 32, data: [1, 4, 1, 17, 42, 0xffffffff] }]) {
    let property = initial
    let writes = 0
    const mockGio = { SubprocessFlags: Gio.SubprocessFlags, Subprocess: { new: () => ({
      communicate_utf8(input) {
        const request = JSON.parse(input)
        this.ok = true
        if (request.operation === 'read') return [true, JSON.stringify({ value: property, type: 77 }), '']
        if (JSON.stringify(property) === JSON.stringify(request.value)) return [true, JSON.stringify({ changed: false }), '']
        if (JSON.stringify(property) !== JSON.stringify(request.expected)) {
          this.ok = false; return [true, '', 'Ownership conflict: foreign update']
        }
        property = request.value; writes++; return [true, JSON.stringify({ changed: true }), '']
      }, get_successful() { return this.ok }
    }) } }
    const { ServerDecorations } = loadModule(`${root}/unite-next@lucastsudaka.github.io/window.js`,
      { GObject, Shell: {}, Meta, Gio: mockGio, Main, Handlers, Convenience }, ['ServerDecorations'])
    const decoration = new ServerDecorations({ xid: '0x7', win: { decorated: true, get_frame_type: () => 0 } })
    decoration.reset()
    assert(writes === 0, 'Never-modified window received a write')
    decoration.hide()
    if (initial) {
      assert(property.type === 99 && property.data.join(',') === '3,4,2,17,42,4294967295', 'Unrelated Motif state was lost')
    }
    decoration.reset()
    assert(JSON.stringify(property) === JSON.stringify(initial), 'Original property/absence not restored')
    decoration.hide()
    property = { type: 99, format: 32, data: [3, 8, 1, 0, 0] }
    throws(() => decoration.reset(), 'Foreign update was overwritten silently')
    assert(property.data[1] === 8 && decoration.owned === null, 'Foreign property was overwritten/retained as owned')
  }
})

test('Motif apply conflict releases ownership before later teardown', () => {
  let calls = 0
  const mockGio = { SubprocessFlags: Gio.SubprocessFlags, Subprocess: { new: () => ({
    communicate_utf8(input) {
      const request = JSON.parse(input)
      calls++
      this.ok = request.operation === 'read'
      return this.ok ? [true, JSON.stringify({ value: null, type: 77 }), ''] :
        [true, '', 'Ownership conflict: application changed _MOTIF_WM_HINTS']
    }, get_successful() { return this.ok }
  }) } }
  const { ServerDecorations } = loadModule(`${root}/unite-next@lucastsudaka.github.io/window.js`,
    { GObject, Shell: {}, Meta, Gio: mockGio, Main, Handlers, Convenience }, ['ServerDecorations'])
  const decoration = new ServerDecorations({ xid: '0x7', win: { decorated: true, get_frame_type: () => 0 } })
  throws(() => decoration.hide(), 'Observed foreign update was not reported')
  assert(decoration.owned === null && decoration.conflicted, 'Foreign state remains falsely owned')
  decoration.reset()
  decoration.hide()
  assert(calls === 2, 'Later teardown/updates attempted to overwrite conflicting foreign state')
})

test('Cleanup retains the original single error and every aggregated diagnostic', () => {
  const original = new Error('first boundary failure')
  assert(throws(() => Handlers.runCleanup([() => { throw original }]), 'Error disappeared') === original,
    'Single failure lost its original stack/object')
  const combined = throws(() => Handlers.runCleanup([
    () => { throw original }, () => { throw new Error('second boundary failure') }
  ]), 'Aggregate failure disappeared')
  assert(combined.errors.length === 2 && combined.cause === original &&
    combined.message.includes('first boundary failure') && combined.message.includes('second boundary failure'),
    'GNOME error reporting cannot observe every failure')
})

print(`${passed} passed; ${failed} failed`)
if (failed) throw new Error('Lifecycle acceptance failed')
