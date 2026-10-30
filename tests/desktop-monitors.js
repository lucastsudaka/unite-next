// REQ-PANEL-001/THEME-001/VERIFY-001: temporary private DisplayConfig acceptance.
// Signatures: Mutter 50.5/51.0 data/dbus-interfaces/org.gnome.Mutter.DisplayConfig.xml.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import St from 'gi://St'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'
import { runInput } from './desktop-input.js'

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

export async function runMonitors(owner, settings, wm, win) {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Monitor tests require a private session')
  const initial = await state()
  const physical = currentPhysical(initial)
  const original = applyLogical(initial.logical, physical)
  const properties = globalProperties(initial)
  const scenarios = []
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
    settings.set_string('notifications-position', 'right')
    for (const [primaryScale, otherScale] of targets) {
      const topHeight = otherOutput.mode[2] / (layoutMode === 1 ? otherScale : 1)
      assert(Number.isInteger(topHeight) && topHeight > 0, 'Virtual mode has invalid logical monitor height')
      const configuration = [
        [0, 0, otherScale, 0, false, [[otherOutput.spec[0], otherOutput.mode[0], otherOutput.properties]]],
        [0, topHeight, primaryScale, 0, true, [[primaryOutput.spec[0], primaryOutput.mode[0], primaryOutput.properties]]]
      ]
      modified = true // An apply error may still require restoration of observed state.
      await apply(configuration, properties)
      await until(() => Main.layoutManager.primaryMonitor?.y === topHeight &&
        Main.panel.get_transformed_position()[1] === topHeight,
      `vertical primary panel at stage Y ${topHeight}, scale ${primaryScale}`)
      const current = await state()
      assert(JSON.stringify(geometry(current.logical)) === JSON.stringify(geometry(configuration)),
        'Applied logical monitor geometry/scale differs from the requested temporary configuration')
      win.move_to_monitor(Main.layoutManager.primaryIndex)
      win.unminimize()
      Main.activateWindow(win)
      win.set_maximize_flags(Meta.MaximizeFlags.BOTH)
      await until(() => owner.context.focusWindow?.win === win && win.is_on_primary_monitor() &&
        win.maximized_horizontally && win.maximized_vertically, 'fixture maximized on vertical primary monitor')
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
        win.move_to_monitor(initialMonitor)
        Main.activateWindow(win)
        if (initialMaximized) win.set_maximize_flags(Meta.MaximizeFlags.BOTH)
      } catch (error) { errors.push(error) }
    }
  }
  if (errors.length) throw new AggregateError(errors,
    `Native monitor acceptance failed: ${errors.map(error => error.message).join('; ')}`)
  const result = { scenarios, pending }
  print(`${pending.length ? 'UNITE_MONITORS_PENDING_RESULT' : 'UNITE_MONITORS_PASS'} ${JSON.stringify(result)}`)
  return result
}
