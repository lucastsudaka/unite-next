// REQ-FEATURE-003/PANEL-001/THEME-001/VERIFY-001: private state/DisplayConfig acceptance.
// Signatures: Mutter 50.5/51.0 data/dbus-interfaces/org.gnome.Mutter.DisplayConfig.xml.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import St from 'gi://St'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'
import { inputSceneReady, runInput } from './desktop-input.js'

const NAME = 'org.gnome.Mutter.DisplayConfig'
const PATH = '/org/gnome/Mutter/DisplayConfig'
const STATE_TYPE = '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})'
const APPLY_TYPE = '(uua(iiduba(ssa{sv}))a{sv})'
const unpack = value => value instanceof GLib.Variant ? value.deepUnpack() : value
function assert(value, message) { if (!value) throw new Error(message) }

function call(method, parameters, replyType) {
  // Mutter owns this name in the calling Shell process: synchronous D-Bus calls
  // would block the same main loop needed to serve the request.
  return new Promise((resolve, reject) => Gio.DBus.session.call(NAME, PATH, NAME,
    method, parameters, new GLib.VariantType(replyType), Gio.DBusCallFlags.NONE,
    3000, null, (connection, result) => {
      try { resolve(connection.call_finish(result).deepUnpack()) }
      catch (error) { reject(error) }
    }))
}

async function state() {
  const [serial, monitors, logical, properties] = await call('GetCurrentState', null, STATE_TYPE)
  return { serial, monitors, logical, properties }
}

async function until(predicate, description) {
  const deadline = GLib.get_monotonic_time() + 5000000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Monitor timeout: ${description}`)
    await Scripting.sleep(16)
  }
}

function currentPhysical(snapshot) {
  return new Map(snapshot.monitors.map(([spec, modes, properties]) => {
    const current = modes.find(mode => unpack(mode[6]['is-current']))
    assert(current, `No current mode for private monitor ${spec[0]}`)
    const outputProperties = {}
    if ('is-underscanning' in properties)
      outputProperties.underscanning = new GLib.Variant('b', unpack(properties['is-underscanning']))
    if ('color-mode' in properties)
      outputProperties['color-mode'] = new GLib.Variant('u', unpack(properties['color-mode']))
    return [spec[0], { spec, mode: current, properties: outputProperties }]
  }))
}

function applyLogical(logical, physical) {
  return logical.map(([x, y, scale, transform, primary, monitors]) => [
    x, y, scale, transform, primary,
    monitors.map(([connector]) => {
      const item = physical.get(connector)
      return [connector, item.mode[0], item.properties]
    })
  ])
}

function globalProperties(snapshot) {
  return unpack(snapshot.properties['supports-changing-layout-mode']) ?
    { 'layout-mode': new GLib.Variant('u', unpack(snapshot.properties['layout-mode'])) } : {}
}

async function apply(configuration, properties) {
  const current = await state()
  // 1 = temporary. No monitor configuration is persisted.
  await call('ApplyMonitorsConfig', new GLib.Variant(APPLY_TYPE,
    [current.serial, 1, configuration, properties]), '()')
}

function geometry(logical) {
  return logical.map(item => [item[5][0][0], ...item.slice(0, 5)])
    .sort((left, right) => left[0].localeCompare(right[0]))
}

function moveFixtureToMonitor(win, monitor) {
  // Mutter dereferences the source monitor without a null check. A recently
  // unmanaged fixture reports -1 and must fail before crossing that native API.
  assert(win.get_monitor() >= 0, 'Cannot move an unmanaged fixture window to another monitor')
  const count = global.display.get_n_monitors()
  assert(Number.isInteger(monitor) && monitor >= 0 && monitor < count,
    `Invalid fixture monitor destination: ${monitor}; native monitor count: ${count}`)
  win.move_to_monitor(monitor)
}

const frameRect = win => {
  const { x, y, width, height } = win.get_frame_rect()
  return { x, y, width, height }
}

export async function runWindowStateTransitions(owner, settings, win) {
  const initial = await state()
  const original = applyLogical(initial.logical, currentPhysical(initial))
  const properties = globalProperties(initial)
  const savedRect = frameRect(win)
  const savedFlags = win.get_maximize_flags()
  const savedSettings = ['restrict-to-primary-screen', 'show-window-buttons', 'hide-window-titlebars']
    .map(key => [key, settings.get_user_value(key)])
  const controls = Main.panel.statusArea.uniteNextWindowControls
  const scenarios = []
  const errors = []
  const handlers = []
  let monitorChanged = false
  const observe = (object, signal, callback) => handlers.push([object, object.connect(signal, callback)])
  try {
    settings.set_string('hide-window-titlebars', 'never')
    settings.set_boolean('restrict-to-primary-screen', false)
    settings.set_string('show-window-buttons', 'maximized')
    win.set_unmaximize_flags(Meta.MaximizeFlags.BOTH)
    Main.activateWindow(win)
    await until(() => !win.maximized_horizontally && !win.maximized_vertically && inputSceneReady(win),
      'normal fixture before same-size maximization')
    const { x, y, width, height } = win.get_work_area_current_monitor()
    const workArea = { x, y, width, height }
    win.move_resize_frame(false, x, y, width, height)
    await until(() => JSON.stringify(frameRect(win)) === JSON.stringify(workArea) && inputSceneReady(win),
      'normal fixture already fills the work area')
    assert(!controls.container.visible, 'Normal work-area-sized window exposes maximized controls')
    let sizeEvents = 0
    observe(win, 'size-changed', () => sizeEvents++)
    win.set_maximize_flags(Meta.MaximizeFlags.BOTH)
    await until(() => win.maximized_horizontally && win.maximized_vertically && inputSceneReady(win),
      'same-size maximization state')
    await until(() => controls.container.visible, 'maximization refresh without a size event')
    assert(sizeEvents === 0 && JSON.stringify(frameRect(win)) === JSON.stringify(workArea),
      'Maximization regression fixture unexpectedly changed size or geometry')
    scenarios.push({ name: 'maximization without resize', frame: frameRect(win), sizeEvents,
      controlsVisible: controls.container.visible })
    print(`UNITE_WINDOW_STATE_SCENARIO ${JSON.stringify(scenarios.at(-1))}`)

    win.set_unmaximize_flags(Meta.MaximizeFlags.BOTH)
    await until(() => !win.maximized_horizontally && !win.maximized_vertically && inputSceneReady(win),
      'normal fixture before primary-only change')
    const monitor = Main.layoutManager.primaryMonitor
    const primaryIndex = Main.layoutManager.primaryIndex
    const secondaryIndex = Main.layoutManager.monitors.findIndex((_monitor, index) => index !== primaryIndex)
    // Earlier restore operations can leave a different native preferred monitor.
    // Mutter skips updating that preference when moving to the current monitor;
    // make two real moves before measuring a stationary reconfiguration.
    moveFixtureToMonitor(win, secondaryIndex)
    await until(() => win.get_monitor() === secondaryIndex && inputSceneReady(win),
      'primary-only fixture leaves its inherited preferred monitor')
    moveFixtureToMonitor(win, primaryIndex)
    await until(() => win.get_monitor() === primaryIndex && inputSceneReady(win),
      'primary-only fixture establishes its preferred monitor')
    const normalRect = { x: monitor.x + 200, y: monitor.y + 200, width: 640, height: 480 }
    win.move_resize_frame(false, normalRect.x, normalRect.y, normalRect.width, normalRect.height)
    await until(() => win.is_on_primary_monitor() && inputSceneReady(win) &&
      JSON.stringify(frameRect(win)) === JSON.stringify(normalRect), 'stationary primary fixture')
    settings.set_boolean('restrict-to-primary-screen', true)
    settings.set_string('show-window-buttons', 'always')
    await until(() => controls.container.visible, 'primary fixture controls before reconfiguration')
    const before = frameRect(win)
    const snapshot = await state()
    const switched = applyLogical(snapshot.logical, currentPhysical(snapshot))
      .map(([lx, ly, scale, transform, primary, monitors]) => [lx, ly, scale, transform, !primary, monitors])
    let enteredEvents = 0
    sizeEvents = 0
    observe(global.display, 'window-entered-monitor', (_display, _index, window) => {
      if (window === win) enteredEvents++
    })
    monitorChanged = true
    await apply(switched, properties)
    await until(() => !win.is_on_primary_monitor() && inputSceneReady(win), 'primary-only configuration applied')
    await until(() => !controls.container.visible, 'stationary window loses primary-only controls')
    assert(JSON.stringify(frameRect(win)) === JSON.stringify(before) && sizeEvents === 0,
      'Primary-only regression fixture changed window geometry')
    scenarios.push({ name: 'primary-only monitor change', frame: frameRect(win), sizeEvents,
      enteredEvents, primary: win.is_on_primary_monitor(), controlsVisible: controls.container.visible })
    print(`UNITE_WINDOW_STATE_SCENARIO ${JSON.stringify(scenarios.at(-1))}`)
  } catch (error) {
    errors.push(error)
  } finally {
    const cleanup = async callback => { try { await callback() } catch (error) { errors.push(error) } }
    for (const [object, id] of handlers) await cleanup(() => object.disconnect(id))
    if (monitorChanged) await cleanup(async () => {
      await apply(original, properties)
      const restored = await state()
      assert(JSON.stringify(geometry(restored.logical)) === JSON.stringify(geometry(initial.logical)),
        'State-transition regression did not restore the original monitor configuration')
    })
    await cleanup(async () => {
      win.set_unmaximize_flags(Meta.MaximizeFlags.BOTH)
      await until(() => !win.maximized_horizontally && !win.maximized_vertically && inputSceneReady(win),
        'state-transition restoration starts from a normal fixture')
      win.move_resize_frame(false, savedRect.x, savedRect.y, savedRect.width, savedRect.height)
      if (savedFlags) win.set_maximize_flags(savedFlags)
      Main.activateWindow(win)
      await until(() => win.get_maximize_flags() === savedFlags && inputSceneReady(win),
        'state-transition fixture restored')
    })
    for (const [key, value] of savedSettings) await cleanup(() =>
      value === null ? settings.reset(key) : settings.set_value(key, value))
  }
  if (errors.length) throw new AggregateError(errors,
    `Native window-state acceptance failed: ${errors.map(error => error.message).join('; ')}`)
  return scenarios
}

export async function runMonitors(owner, settings, wm, win) {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Monitor tests require a private session')
  const initial = await state()
  const physical = currentPhysical(initial)
  const original = applyLogical(initial.logical, physical)
  const properties = globalProperties(initial)
  const scenarios = []
  let stateTransitions = []
  const pending = []
  const errors = []
  let modified = false
  const initialMonitor = win.get_monitor()
  const initialMaximized = win.maximized_horizontally && win.maximized_vertically
  const notificationPosition = settings.get_user_value('notifications-position')
  const reportPending = reason => {
    pending.push(reason)
    print(`UNITE_MONITORS_PENDING ${reason}`)
  }

  if (initial.logical.length !== 2 || initial.logical.some(item => item[5].length !== 1 || item[3] !== 0)) {
    reportPending('Acceptance requires exactly two enabled unrotated, uncloned private virtual monitors')
    return { scenarios, pending }
  }
  const primary = initial.logical.find(item => item[4])
  const other = initial.logical.find(item => !item[4])
  assert(primary && other, 'Private monitor configuration lacks a unique primary')
  const primaryOutput = physical.get(primary[5][0][0])
  const otherOutput = physical.get(other[5][0][0])
  const supported = (output, scale) => output.mode[5].some(value => Math.abs(value - scale) < 0.001)
  if (!supported(primaryOutput, 1) || !supported(otherOutput, 1)) {
    reportPending('Private virtual monitor modes do not advertise scale 1')
    return { scenarios, pending }
  }
  const globalScale = Boolean(unpack(initial.properties['global-scale-required']))
  const layoutMode = unpack(initial.properties['layout-mode']) || 1
  const targets = [[1, 1]]
  if (supported(primaryOutput, 2) && (!globalScale || supported(otherOutput, 2)))
    targets.push([2, globalScale ? 2 : 1])
  else
    reportPending('Scale 2 is not advertised by the private virtual modes under their global-scale constraint')

  try {
    stateTransitions = await runWindowStateTransitions(owner, settings, win)
    settings.set_string('notifications-position', 'right')
    for (const [primaryScale, otherScale] of targets) {
      await until(() => inputSceneReady(win), 'previous fixture scene completed before monitor change')
      const topHeight = otherOutput.mode[2] / (layoutMode === 1 ? otherScale : 1)
      const primaryWidth = primaryOutput.mode[1] / (layoutMode === 1 ? primaryScale : 1)
      const primaryHeight = primaryOutput.mode[2] / (layoutMode === 1 ? primaryScale : 1)
      assert(Number.isInteger(topHeight) && topHeight > 0, 'Virtual mode has invalid logical monitor height')
      const configuration = [
        [0, 0, otherScale, 0, false, [[otherOutput.spec[0], otherOutput.mode[0], otherOutput.properties]]],
        [0, topHeight, primaryScale, 0, true, [[primaryOutput.spec[0], primaryOutput.mode[0], primaryOutput.properties]]]
      ]
      modified = true // An apply error may still require restoration of observed state.
      await apply(configuration, properties)
      await until(() => Main.layoutManager.primaryMonitor?.y === topHeight &&
        Main.layoutManager.primaryMonitor.width === primaryWidth &&
        Main.layoutManager.primaryMonitor.height === primaryHeight &&
        Main.panel.get_transformed_position()[1] === topHeight &&
        Main.panel.get_transformed_size()[0] === primaryWidth,
      `vertical primary panel at stage Y ${topHeight}, scale ${primaryScale}`)
      const current = await state()
      assert(JSON.stringify(geometry(current.logical)) === JSON.stringify(geometry(configuration)),
        'Applied logical monitor geometry/scale differs from the requested temporary configuration')
      await until(() => inputSceneReady(win), 'monitor relayout released overview and window animations')
      moveFixtureToMonitor(win, Main.layoutManager.primaryIndex)
      win.unminimize()
      Main.activateWindow(win)
      win.set_maximize_flags(Meta.MaximizeFlags.BOTH)
      await until(() => owner.context.focusWindow?.win === win && win.is_on_primary_monitor() &&
        win.maximized_horizontally && win.maximized_vertically && inputSceneReady(win),
      'fixture scene maximized on vertical primary monitor')
      const input = await runInput(owner, settings, wm, win)
      const themeScale = St.ThemeContext.get_for_stage(global.stage).scale_factor
      // Mutter keeps UI scale at 1 when stage views perform output scaling;
      // otherwise UI scale supplies it. Observe the native rendering product.
      const viewScales = Main.panel.peek_stage_views().map(view => view.get_scale())
      assert(viewScales.some(scale => Math.abs(scale * themeScale - primaryScale) < 0.001),
        `Native panel view/UI scale does not match primary scale ${primaryScale}: ${viewScales}/${themeScale}`)
      await until(() => Main.messageTray._bannerBin.width === 390 * themeScale,
        'notification width follows the native monitor/theme scale')
      scenarios.push({ primaryScale, otherScale, panelY: topHeight, themeScale, viewScales,
        monitors: geometry(current.logical), input: input.scenarios })
      print(`UNITE_MONITORS_SCENARIO ${JSON.stringify(scenarios.at(-1))}`)
    }
  } catch (error) {
    errors.push(error)
  } finally {
    try {
      if (notificationPosition === null) settings.reset('notifications-position')
      else settings.set_value('notifications-position', notificationPosition)
    } catch (error) { errors.push(error) }
    if (modified) {
      try {
        await apply(original, properties)
        const restored = await state()
        assert(JSON.stringify(geometry(restored.logical)) === JSON.stringify(geometry(initial.logical)),
          'Original private monitor configuration was not restored')
        const expected = initial.logical.find(item => item[4])
        await until(() => Main.layoutManager.primaryMonitor?.x === expected[0] &&
          Main.layoutManager.primaryMonitor?.y === expected[1], 'original primary monitor restored')
        moveFixtureToMonitor(win, initialMonitor)
        Main.activateWindow(win)
        if (initialMaximized) win.set_maximize_flags(Meta.MaximizeFlags.BOTH)
        await until(() => win.get_monitor() === initialMonitor && inputSceneReady(win),
          'original fixture monitor and scene restored')
      } catch (error) { errors.push(error) }
    }
  }
  if (errors.length) throw new AggregateError(errors,
    `Native monitor acceptance failed: ${errors.map(error => error.message).join('; ')}`)
  const result = { scenarios, stateTransitions, pending }
  print(`${pending.length ? 'UNITE_MONITORS_PENDING_RESULT' : 'UNITE_MONITORS_PASS'} ${JSON.stringify(result)}`)
  return result
}
