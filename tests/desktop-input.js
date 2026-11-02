// REQ-PANEL-001, REQ-PREF-002, REQ-VERIFY-001: private native input acceptance.
import Clutter from 'gi://Clutter'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import St from 'gi://St'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'

function assert(value, message) { if (!value) throw new Error(message) }

async function until(predicate, description, milliseconds = 3000) {
  const deadline = GLib.get_monotonic_time() + milliseconds * 1000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Input timeout: ${description}`)
    await Scripting.sleep(8) // Bounded observation; no product retries or timing fallback.
  }
}

function blankPanelPoint(win, requireWindowBelow = true) {
  const [x, y] = Main.panel.get_transformed_position()
  const [width, height] = Main.panel.get_transformed_size()
  const frame = win.get_frame_rect()
  let longest = []
  let current = []
  for (let offset = 12; offset < width - 12; offset += 4) {
    const point = { x: x + offset, y: y + Math.floor(height / 2) }
    if ((!requireWindowBelow || point.x >= frame.x && point.x < frame.x + frame.width) &&
        global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, point.x, point.y) === Main.panel) {
      current.push(point)
    } else {
      if (current.length > longest.length) longest = current
      current = []
    }
  }
  if (current.length > longest.length) longest = current
  // Use the interior of a real blank region. The first few pixels beside an
  // appmenu can become its reactive hover edge after a native relayout.
  if (longest.length) return longest[Math.floor(longest.length / 2)]
  throw new Error('No reactive blank panel point above the fixture window')
}

function maximized(win) { return win.maximized_horizontally && win.maximized_vertically }

export function inputSceneReady(win) {
  const actor = win.get_compositor_private()
  if (Main.overview.visible || Main.overview.visibleTarget || Main.modalCount !== 0 ||
      !actor?.mapped || !actor.has_allocation()) return false

  // Native 50/51 size changes can publish MetaWindow flags before the clone,
  // frozen content and actor transforms finish. Observe their actual owners.
  const effects = ['_mapping', '_minimizing', '_unminimizing', '_resizePending', '_resizing']
  const transitions = ['opacity', 'x', 'y', 'translation-x', 'translation-y', 'scale-x', 'scale-y']
  return effects.every(name => !Main.wm[name].has(actor)) &&
    transitions.every(name => actor.get_transition(name) === null) &&
    actor.scale_x === 1 && actor.scale_y === 1 &&
    actor.translation_x === 0 && actor.translation_y === 0 && actor.opacity === 255
}

// The caller owns the maximized, focused fixture window and the private session.
export async function runInput(owner, settings, wm, win) {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Native input requires a private test session')
  await until(() => owner.context?.focusWindow?.win === win && maximized(win) &&
    win.is_on_primary_monitor() && inputSceneReady(win), 'focused primary fixture scene ready')
  assert(owner.context?.focusWindow?.win === win && maximized(win), 'Focused maximized fixture required')
  const extensionKeys = ['enable-titlebar-actions', 'hide-window-titlebars', 'show-window-buttons',
    'restrict-to-primary-screen']
  const wmKeys = ['button-layout', 'action-double-click-titlebar', 'action-middle-click-titlebar', 'action-right-click-titlebar']
  const saved = [
    ...extensionKeys.map(key => [settings, key, settings.get_user_value(key)]),
    ...wmKeys.map(key => [wm, key, wm.get_user_value(key)])
  ]
  const previousPointer = global.get_pointer()
  const previousFocus = global.stage.get_key_focus()
  const previousOverview = Main.overview.visibleTarget
  const previousMinimized = win.minimized
  const previousMonitor = win.get_monitor()
  const previousFlags = (win.maximized_horizontally ? Meta.MaximizeFlags.HORIZONTAL : 0) |
    (win.maximized_vertically ? Meta.MaximizeFlags.VERTICAL : 0)
  const signals = []
  const pressed = new Set()
  const keys = new Set()
  const counts = { press: 0, release: 0, grab: 0, end: 0, unite: 0 }
  let deliveredMotions = 0
  let deliveredPosition = null
  let positionTracker = null
  const scenarios = []
  const errors = []
  let pointer = null
  let keyboard = null
  let descendant = null
  let modal = null
  let modalGrab = null
  let rightGeometry = null
  const menuManager = Main.wm._windowMenuManager
  const connect = (object, name, callback) => signals.push([object, object.connect(name, callback)])
  const disconnectObject = object => {
    for (let index = signals.length - 1; index >= 0; index--) {
      if (signals[index][0] !== object) continue
      object.disconnect(signals[index][1])
      signals.splice(index, 1)
    }
  }
  const check = (condition, message) => assert(condition, `Native input: ${message}`)
  const record = name => { scenarios.push(name); print(`UNITE_INPUT_SCENARIO ${name}`) }
  const fixtureState = phase => {
    const managed = owner.context?.focusWindow
    const { x, y, width, height } = win.get_frame_rect()
    const state = { phase, monitor: win.get_monitor(), primary: Main.layoutManager.primaryIndex,
      onPrimary: win.is_on_primary_monitor(), frame: { x, y, width, height }, maximized: maximized(win),
      minimized: win.minimized, focused: win.has_focus(), contextFocus: managed?.win === win,
      hideTitlebars: managed?.hideTitlebars,
      restricted: settings.get_boolean('restrict-to-primary-screen'), sceneReady: inputSceneReady(win),
      panelPosition: Main.panel.get_transformed_position(), counts: { ...counts } }
    print(`UNITE_INPUT_FIXTURE_STATE ${JSON.stringify(state)}`)
    return state
  }
  const placeFixture = monitor => {
    check(win.get_monitor() >= 0, 'Cannot move an unmanaged input fixture')
    check(Number.isInteger(monitor) && monitor >= 0 && monitor < global.display.get_n_monitors(),
      `Invalid input fixture monitor: ${monitor}`)
    win.move_to_monitor(monitor)
  }

  async function move(point) {
    const atPoint = coords => coords && Math.abs(coords[0] - point.x) < 2 && Math.abs(coords[1] - point.y) < 2
    if (atPoint(deliveredPosition) && atPoint(global.get_pointer())) return
    const observed = deliveredMotions
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), point.x, point.y)
    try {
      await until(() => deliveredMotions > observed && atPoint(deliveredPosition) && atPoint(global.get_pointer()),
        `pointer motion delivered at ${point.x},${point.y}`)
    } catch (error) {
      throw new Error(`${error.message}; observed pointer=${JSON.stringify(global.get_pointer())}, processed position=${JSON.stringify(deliveredPosition)}, events=${JSON.stringify(counts)}`)
    }
  }
  async function press(button) {
    const observed = counts.press
    const grabbed = counts.grab
    pressed.add(button)
    // Native Mutter converts Clutter button numbers to evdev internally.
    pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.PRESSED)
    await until(() => counts.press > observed || counts.grab > grabbed, `button ${button} press delivered`)
  }
  async function release(button) {
    const observed = counts.release
    const ended = counts.end
    const mask = Clutter.ModifierType[`BUTTON${button}_MASK`]
    pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED)
    pressed.delete(button)
    // Window grabs or a focus-changing action can consume a release before the
    // Clutter stage sees it. The native seat must independently clear its mask.
    await until(() => counts.release > observed || counts.end > ended ||
      !(global.get_pointer()[2] & mask), `button ${button} release delivered`)
  }
  async function click(button, point, panelTarget = false) {
    await move(point)
    if (panelTarget) {
      const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, point.x, point.y)
      check(actor === Main.panel, `Panel target changed before button ${button}: ${actor}`)
    }
    await press(button)
    await release(button)
  }
  async function frameReady(description) {
    let painted = false
    const id = global.stage.connect('after-paint', () => { painted = true })
    try {
      global.stage.queue_redraw()
      await until(() => painted, description)
    } finally {
      global.stage.disconnect(id)
    }
  }
  async function focusFixture() {
    win.unminimize()
    Main.activateWindow(win)
    await until(() => owner.context.focusWindow?.win === win && win.has_focus(), 'fixture focused')
    await until(() => inputSceneReady(win), 'focused fixture animation and overview completed')
    await frameReady('focused fixture frame painted before picking input targets')
  }
  async function maximizeFixture() {
    await focusFixture()
    // Native unmaximize restores saved stage coordinates, which can belong to
    // another monitor after temporary display rearrangement. Each eligible
    // primary-input scenario owns its placement as well as its maximize flags.
    placeFixture(previousMonitor)
    await until(() => win.get_monitor() === previousMonitor && win.is_on_primary_monitor() && inputSceneReady(win),
      'fixture placed on its original primary monitor before maximize')
    win.set_maximize_flags(Meta.MaximizeFlags.BOTH)
    await until(() => maximized(win), 'fixture maximized')
    await until(() => inputSceneReady(win), 'maximized fixture scene completed')
    await frameReady('maximized fixture frame painted before picking input targets')
  }

  try {
    const backend = global.stage.get_context().get_backend()
    const seat = backend.get_default_seat()
    pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE)
    keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE)
    const sprite = backend.get_pointer_sprite(global.stage)
    assert(sprite, 'Native pointer sprite required')
    positionTracker = global.backend.get_cursor_tracker()
    // MetaBackend emits this after handling pointer motion, including motion
    // consumed by a Wayland client before Clutter's captured-event signal.
    connect(positionTracker, 'position-invalidated', () => {
      const position = sprite.get_coords()
      deliveredPosition = [position.x, position.y]
      deliveredMotions++
    })
    connect(global.stage, 'captured-event', (_actor, event) => {
      if (event.type() === Clutter.EventType.BUTTON_PRESS) counts.press++
      if (event.type() === Clutter.EventType.BUTTON_RELEASE) counts.release++
      if (event.type() === Clutter.EventType.MOTION) {
        counts.motion = event.get_coords()
      }
      return Clutter.EVENT_PROPAGATE
    })
    connect(global.display, 'grab-op-begin', (_display, window, operation) => {
      if (window === win && operation === Meta.GrabOp.MOVING) counts.grab++
    })
    connect(global.display, 'grab-op-end', (_display, window) => {
      if (window === win) counts.end++
    })
    settings.set_boolean('enable-titlebar-actions', true)
    settings.set_boolean('restrict-to-primary-screen', true)
    settings.set_string('hide-window-titlebars', 'always')
    settings.set_string('show-window-buttons', 'always')
    wm.set_string('button-layout', 'minimize,maximize,close:')
    wm.set_string('action-double-click-titlebar', 'toggle-maximize')
    wm.set_string('action-middle-click-titlebar', 'minimize')
    wm.set_string('action-right-click-titlebar', 'menu')
    await until(() => Main.panel.get_action('unite-next-titlebar-3') && owner.context.focusWindow.hideTitlebars,
      'titlebar gestures active')
    await until(() => {
      const buttons = Main.panel.statusArea.uniteNextWindowControls?._buttons
      return buttons?.size === 3 && [...buttons.values()].every(button => button.mapped && button.has_allocation())
    }, 'three fixture controls allocated after native layout update')
    for (const button of [2, 3])
      connect(Main.panel.get_action(`unite-next-titlebar-${button}`), 'recognize', () => counts.unite++)
    connect(Main.panel.get_action('unite-next-titlebar-3'), 'may-recognize', gesture => {
      const coords = gesture.get_coords_abs()
      rightGeometry = { pointer: [coords.x, coords.y],
        position: Main.panel.get_transformed_position(), size: Main.panel.get_transformed_size() }
      print(`UNITE_INPUT_MENU_BEFORE ${JSON.stringify(rightGeometry)}`)
      return true
    })
    let point = blankPanelPoint(win)
    // The headless seat starts at the hot corner. Its real pointer barriers can
    // constrain a direct diagonal move along the panel edge. Leave the corner
    // through the monitor interior before approaching the panel from below.
    const monitor = Main.layoutManager.primaryMonitor
    const interiorY = monitor.y + Math.floor(monitor.height / 2)
    await move({ x: previousPointer[0], y: interiorY })
    await move({ x: point.x, y: interiorY })

    // One primary press must still enter Mutter's real moving grab, without
    // interpreting the first half of a double click as Unite's window action.
    const nativeGrabs = counts.grab
    const actionsBeforeDrag = counts.unite
    await move(point)
    check(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, point.x, point.y) === Main.panel,
      'Blank panel target changed before the first native drag press')
    await press(1)
    await until(() => counts.grab === nativeGrabs + 1, 'native first-click drag grab')
    await release(1)
    check(counts.unite === actionsBeforeDrag, 'First click invoked the double-click action')
    record('native primary press starts and releases window dragging')

    // Deliberately separate sequences by the platform's double-click interval;
    // this is protocol setup, not a retry for a failed event or product delay.
    await Scripting.sleep(global.stage.get_context().get_settings().double_click_time + 20)
    point = blankPanelPoint(win)
    const grabsBeforeDouble = counts.grab
    fixtureState('before primary double click')
    await click(1, point, true)
    check(maximized(win), 'First primary press changed maximization before the second click')
    await click(1, point, true)
    await until(() => !win.maximized_horizontally && !win.maximized_vertically,
      'native double-click restored window')
    check(counts.grab === grabsBeforeDouble + 1, 'Double click did not veto only its second native drag')
    fixtureState('after primary double-click restore')
    record('native primary double click restores maximized window once')
    await maximizeFixture()
    point = blankPanelPoint(win)

    const beforeMiddle = counts.unite
    fixtureState('before primary middle click')
    check(win.get_monitor() === previousMonitor && win.is_on_primary_monitor() &&
      owner.context.focusWindow?.win === win && owner.context.focusWindow.hideTitlebars,
    'Expected-eligible middle click requires the focused primary fixture')
    await click(2, point, true)
    try { await until(() => win.minimized, 'native middle-click minimized window') }
    catch (error) { fixtureState('middle-click timeout'); throw error }
    check(counts.unite === beforeMiddle + 1, 'Middle click did not execute exactly once')
    record('native middle click minimizes focused window')
    await maximizeFixture()
    point = blankPanelPoint(win)

    const beforeRight = counts.unite
    await click(3, point, true)
    await until(() => menuManager._manager.activeMenu?.isOpen, 'native right-click window menu')
    const menu = menuManager._manager.activeMenu
    const source = menuManager._sourceActor
    const afterGeometry = { x: source.x, y: source.y, width: source.width, height: source.height,
      position: source.get_transformed_position(), size: source.get_transformed_size() }
    print(`UNITE_INPUT_MENU_AFTER ${JSON.stringify(afterGeometry)}`)
    check(rightGeometry && [...rightGeometry.pointer, ...rightGeometry.position, ...rightGeometry.size,
      afterGeometry.x, afterGeometry.y, afterGeometry.width, afterGeometry.height,
      ...afterGeometry.position, ...afterGeometry.size].every(Number.isFinite),
    'Window menu received non-finite native pointer/panel/source geometry')
    await until(() => menu.actor.mapped && menu.actor.width > 0 && menu.actor.height > 0,
      'native window menu allocated')
    check(counts.unite === beforeRight + 1, 'Right click did not execute exactly once')
    const [, panelY] = Main.panel.get_transformed_position()
    check(Math.abs(menuManager._sourceActor.y - panelY) < 1, 'Window menu source is on the wrong stage Y')
    menu.close()
    await until(() => !menuManager._manager.activeMenu?.isOpen, 'window menu closed')
    await until(() => !menuManager._sourceActor.visible, 'window menu source hidden')
    record('native right click opens window menu at panel stage coordinates')
    await focusFixture()

    // A real descendant button must retain its native clicked handling.
    descendant = new St.Button({ label: 'Private panel input fixture', can_focus: true })
    Main.panel._leftBox.add_child(descendant)
    let descendantClicks = 0
    connect(descendant, 'clicked', () => descendantClicks++)
    await until(() => descendant.mapped && descendant.has_allocation() && descendant.width > 0,
      'descendant fixture allocated')
    const [childX, childY] = descendant.get_transformed_position()
    const [childWidth, childHeight] = descendant.get_transformed_size()
    const beforeDescendant = counts.unite
    await click(1, { x: childX + childWidth / 2, y: childY + childHeight / 2 })
    await until(() => descendantClicks === 1, 'native descendant clicked')
    check(counts.unite === beforeDescendant && maximized(win), 'Panel action intercepted its descendant')
    disconnectObject(descendant)
    descendant.destroy()
    descendant = null
    record('interactive panel descendant preserves its native click')

    // Use a real Shell modal grab rather than assigning Main.modalCount.
    modal = new St.Widget({ reactive: true, can_focus: true, width: global.stage.width, height: global.stage.height })
    Main.uiGroup.add_child(modal)
    await until(() => modal.mapped && modal.has_allocation(), 'modal fixture allocated')
    connect(modal, 'button-press-event', () => { counts.press++; return Clutter.EVENT_STOP })
    connect(modal, 'button-release-event', () => { counts.release++; return Clutter.EVENT_STOP })
    modalGrab = Main.pushModal(modal)
    check(Main.modalCount > 0, 'Modal fixture did not acquire a Shell grab')
    const beforeModal = counts.unite
    await click(2, point)
    check(counts.unite === beforeModal && !win.minimized, 'Panel action escaped the modal grab')
    Main.popModal(modalGrab)
    modalGrab = null
    disconnectObject(modal)
    modal.destroy()
    modal = null
    record('real modal grab preserves modal operation')

    Main.overview.show()
    await until(() => Main.overview.visible && Main.overview.visibleTarget, 'overview visible')
    const beforeOverview = counts.unite
    await click(2, point)
    check(counts.unite === beforeOverview && Main.overview.visibleTarget && !win.minimized,
      'Panel action interfered with overview operation')
    Main.overview.hide()
    await until(() => !Main.overview.visibleTarget && !Main.overview.visible, 'overview hidden')
    await focusFixture()
    record('real overview preserves overview operation')

    settings.set_string('hide-window-titlebars', 'never')
    await until(() => !owner.context.focusWindow.hideTitlebars, 'window ineligible for titlebar actions')
    const beforeIneligible = counts.unite
    point = blankPanelPoint(win)
    await click(2, point)
    check(counts.unite === beforeIneligible && !win.minimized && maximized(win),
      'Ineligible window received a titlebar action')
    settings.set_string('hide-window-titlebars', 'always')
    await until(() => owner.context.focusWindow.hideTitlebars, 'window eligibility restored')
    record('ineligible focused window preserves native panel interaction')

    const secondary = Main.layoutManager.monitors.findIndex((_, index) => index !== Main.layoutManager.primaryIndex)
    check(secondary >= 0, 'Two native monitors required for panel policy proof')
    placeFixture(secondary)
    await focusFixture()
    await until(() => win.get_monitor() === secondary, 'secondary fixture placed')
    await until(() => !Main.panel.statusArea.uniteNextWindowControls.container.visible,
      'restricted secondary panel hides controls')
    point = blankPanelPoint(win, false)
    const beforeRestricted = counts.unite
    await click(2, point, true)
    await frameReady('restricted secondary input frame completed')
    check(counts.unite === beforeRestricted && !win.minimized && win.get_monitor() === secondary,
      'Restricted secondary window received a panel titlebar action')
    record('restricted secondary Always hides controls and rejects native panel action')

    settings.set_boolean('restrict-to-primary-screen', false)
    await until(() => Main.panel.statusArea.uniteNextWindowControls.container.visible,
      'unrestricted secondary controls restored')
    await frameReady('unrestricted secondary panel layout painted')
    point = blankPanelPoint(win, false)
    const beforeUnrestricted = counts.unite
    await click(2, point, true)
    await until(() => win.minimized, 'unrestricted secondary native middle click minimized window')
    check(counts.unite === beforeUnrestricted + 1, 'Secondary panel action did not execute exactly once')
    await focusFixture()
    settings.set_boolean('restrict-to-primary-screen', true)
    await until(() => !Main.panel.statusArea.uniteNextWindowControls.container.visible,
      'restriction reapplies to existing secondary controls')
    placeFixture(Main.layoutManager.primaryIndex)
    await maximizeFixture()
    await until(() => win.is_on_primary_monitor() &&
      Main.panel.statusArea.uniteNextWindowControls.container.visible,
    'primary return restores controls while restricted')
    record('unrestricted secondary native panel action resumes; primary return restores eligibility')

    // Invoke the actual St.Button key handling, not its clicked signal directly.
    const button = Main.panel.statusArea.uniteNextWindowControls._buttons.get('maximize')
    check(button instanceof St.Button && button.can_focus && button.accessible_name,
      'Maximize control lacks native focus or accessible name')
    check(button.get_accessible().get_name() === button.accessible_name,
      'Accessible object does not expose the translated action name')
    let keyboardClicks = 0
    connect(button, 'clicked', () => keyboardClicks++)
    button.grab_key_focus()
    await until(() => global.stage.get_key_focus() === button, 'native window control keyboard focus')
    keys.add(Clutter.KEY_space)
    keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_space, Clutter.KeyState.PRESSED)
    keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_space, Clutter.KeyState.RELEASED)
    keys.delete(Clutter.KEY_space)
    await until(() => keyboardClicks === 1 && !win.maximized_horizontally && !win.maximized_vertically,
      'Space activated native maximize/restore control')
    record('accessible native window control responds to keyboard Space')
  } catch (error) {
    errors.push(error)
  } finally {
    const cleanup = callback => { try { callback() } catch (error) { errors.push(error) } }
    for (const button of pressed)
      cleanup(() => pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED))
    for (const key of keys)
      cleanup(() => keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED))
    cleanup(() => menuManager._manager.activeMenu?.close())
    cleanup(() => { if (modalGrab) Main.popModal(modalGrab) })
    for (const [object, id] of signals)
      if (object !== global.stage && object !== positionTracker) cleanup(() => object.disconnect(id))
    cleanup(() => modal?.destroy())
    cleanup(() => descendant?.destroy())
    for (const [object, key, value] of saved)
      cleanup(() => value === null ? object.reset(key) : object.set_value(key, value))
    cleanup(() => placeFixture(previousMonitor))
    cleanup(() => win.set_unmaximize_flags(Meta.MaximizeFlags.BOTH))
    cleanup(() => { if (previousFlags) win.set_maximize_flags(previousFlags) })
    cleanup(() => previousMinimized ? win.minimize() : Main.activateWindow(win))
    cleanup(() => global.stage.set_key_focus(previousFocus))
    if (pointer) {
      // Native virtual-device calls queue work on the input thread. Observe the
      // final native delivery before restoring overview: returning to a hot
      // corner can legitimately toggle it after the backend pointer has moved.
      try { await move({ x: previousPointer[0], y: previousPointer[1] }) }
      catch (error) { errors.push(error) }
    }
    cleanup(() => previousOverview ? Main.overview.show() : Main.overview.hide())
    try {
      await until(() => win.maximized_horizontally === Boolean(previousFlags & Meta.MaximizeFlags.HORIZONTAL) &&
        win.maximized_vertically === Boolean(previousFlags & Meta.MaximizeFlags.VERTICAL), 'fixture maximize state restored')
      await until(() => previousOverview
        ? Main.overview.visible && Main.overview.visibleTarget
        : !Main.overview.visible && !Main.overview.visibleTarget, 'fixture overview state restored')
      if (!previousMinimized && !previousOverview)
        await until(() => inputSceneReady(win), 'restored fixture scene completed before returning')
    } catch (error) { errors.push(error) }
    for (const [object, id] of signals)
      if (object === global.stage || object === positionTracker) cleanup(() => object.disconnect(id))
    cleanup(() => keyboard?.run_dispose())
    cleanup(() => pointer?.run_dispose())
  }
  if (errors.length) throw new AggregateError(errors,
    `Native input acceptance failed: ${errors.map(error => error.message).join('; ')}`)
  const result = { scenarios, delivered: counts }
  print(`UNITE_INPUT_PASS ${JSON.stringify(result)}`)
  return result
}
