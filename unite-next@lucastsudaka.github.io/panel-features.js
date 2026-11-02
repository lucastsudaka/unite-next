import { Signals, Timeouts, runCleanup } from './resources.js'
import { Settings } from './settings.js'
import { Feature, Features } from './features.js'
import { isWindowControlsVisible } from './window-policy.js'

// These are native desktop ports, not alternate policy or lifecycle implementations.
export function createPanelFeatures({ St, Pango, Clutter, Meta, Shell, Main, InjectionManager, Buttons, Theme, Styles, global }) {
  class AppmenuButton extends Feature {
    constructor(context) {
      super(context, 'show-appmenu-button', setting => setting == true)
    }

    activate() {
      this.signals  = new Signals()
      this.settings = new Settings(this.context)
      this.timeouts = new Timeouts()
      this.button   = new Buttons.AppmenuLabel()
      this.tooltip  = new St.Label({ visible: false, style_class: 'dash-label' })
      this.tooltipTimeout = null
      this.focused  = null
      this.appSignals = new Signals()

      this.signals.connect(
        Main.overview, 'showing', this._syncState.bind(this)
      )

      this.signals.connect(
        Main.overview, 'hiding', this._syncState.bind(this)
      )

      this.signals.connect(
        this.context.appSystem, 'app-state-changed', this._syncState.bind(this)
      )

      this.signals.connect(
        this.context.windowTracker, 'notify::focus-app', this._onFocusAppChanged.bind(this)
      )

      this.settings.connect(
        'hide-app-menu-icon', this._onHideIconChange.bind(this)
      )

      this.settings.connect(
        'app-menu-max-width', this._onMaxWidthChange.bind(this)
      )

      this.settings.connect(
        'app-menu-ellipsize-mode', this._onEllipsizeModeChange.bind(this)
      )

      this.button.connect(
        'notify::hover', this._onAppMenuHover.bind(this)
      )

      this.signals.connect(
        this.button.menu, 'open-state-changed', this._hideTooltip.bind(this)
      )

      Main.uiGroup.add_child(this.tooltip)

      Main.panel.addToStatusArea(
        'uniteNextAppMenu', this.button, 1, 'left'
      )

      this._onHideIconChange()
      this._onMaxWidthChange()

      this._syncState()
    }

    get hideIcon() {
      return this.settings.get('hide-app-menu-icon')
    }

    get maxWidth() {
      return this.settings.get('app-menu-max-width')
    }

    get ellipsizeMode() {
      return this.settings.get('app-menu-ellipsize-mode')
    }

    setLabelMaxWidth(width) {
      this.button._label.set_style(width > 0 ? `max-width: ${width}px;` : '')
    }

    setTextEllipsizeMode(mode) {
      const type = mode.toUpperCase()
      this.button._label.get_clutter_text().set_ellipsize(Pango.EllipsizeMode[type])
    }

    _onFocusAppChanged() {
      if (!this.context.windowTracker.focus_app) {
        if (global.stage.key_focus != null)
          return
      }

      this._syncState()
    }

    _syncState() {
      const astates = Shell.AppState.STARTING
      const focused = this.context.focusApp
      const visible = focused != null && !Main.overview.visibleTarget
      const loading = focused != null && (focused.get_state() == astates || focused.get_busy())

      if (focused !== this.focused) {
        this.appSignals.disconnectAll()
        this.focused = focused

        if (this.focused) {
          this.appSignals.connect(this.focused, 'notify::busy', this._syncState.bind(this))
          this.button.setApp(this.focused)
        }
      }

      if (loading) {
        this.button.startAnimation()
      } else {
        this.button.stopAnimation()
      }

      this.button.setReactive(visible && !loading)
      this.button.setVisible(visible)
      this._syncTitle()
    }

    _syncTitle() {
      const win = this.context.focusWindow
      if (win?.hasFocus && win.title) this.button.setText(win.title.replace(/\r?\n|\r/g, ' '))
    }

    _onAppMenuHover(appMenu) {
      this._hideTooltip()
      if (!appMenu.get_hover() || !this.maxWidth || appMenu.menu.isOpen) return

      this.tooltipTimeout = this.timeouts.timeout(400, () => {
        this.tooltipTimeout = null
        if (appMenu.get_hover() && !appMenu.menu.isOpen && !this.tooltip.visible) {
          const [mouseX, mouseY] = global.get_pointer()

          this.tooltip.set_position(mouseX + 20, mouseY)
          this.tooltip.set_text(this.button._label.get_text())
          this.tooltip.show()
        }
      })
    }

    _hideTooltip() {
      if (this.tooltipTimeout) {
        this.timeouts.remove(this.tooltipTimeout)
        this.tooltipTimeout = null
      }
      this.tooltip.hide()
    }

    _onHideIconChange() {
      this.button.toggleIcon(this.hideIcon)
    }

    _onMaxWidthChange() {
      this.setLabelMaxWidth(this.maxWidth)
      this.setTextEllipsizeMode(this.ellipsizeMode)
    }

    _onEllipsizeModeChange() {
      this.setTextEllipsizeMode(this.ellipsizeMode)
    }

    destroy() {
      runCleanup([
        () => this.appSignals?.disconnectAll(),
        () => this.timeouts?.removeAll(),
        () => this.signals?.disconnectAll(),
        () => this.settings?.disconnectAll(),
        () => this.button?.destroy(),
        () => this.tooltip?.destroy(),
        () => { this.focused = this.button = this.tooltip = null }
      ])
    }
  }

  class WindowButtons extends Feature {
    constructor(context) {
      super(context, 'show-window-buttons', setting => setting != 'never')
    }

    activate() {
      this.signals  = new Signals()
      this.settings = new Settings(this.context)
      this.styles   = new Styles()
      this.controls = new Buttons.WindowControls(() => this.context.focusWindow)
      this.themes   = new Theme.WindowControlsThemes()
      this.theme    = this.themes.default
      this.isDark   = Theme.isColorDark(Main.panel.get_theme_node().get_background_color())

      this.signals.connect(
        Main.overview, 'showing', this._syncVisible.bind(this)
      )

      this.signals.connect(
        Main.overview, 'hiding', this._syncVisible.bind(this)
      )

      this.signals.connect(
        this.context.windowTracker, 'notify::focus-app', this._onFocusAppChanged.bind(this)
      )

      this.signals.connect(
        Main.panel, 'style-changed', this._onPanelStyleChange.bind(this)
      )

      this.settings.connect(
        'button-layout', this._onPositionChange.bind(this)
      )

      this.settings.connect(
        'window-buttons-placement', this._onPositionChange.bind(this)
      )

      this.settings.connect(
        'window-buttons-theme', this._onThemeSelectionChanged.bind(this)
      )

      this.settings.connect(
        'gtk-theme', this._onAutoThemeChange.bind(this)
      )

      this.settings.connect(
        'icon-scale-workaround', this._updateIconScaleWorkaround.bind(this, true)
      )

      Main.panel.addToStatusArea(
        'uniteNextWindowControls', this.controls, this.index, this.side
      )

      this._onThemeChange()
      this._positionControls()
      this._syncVisible()
    }

    get gtkTheme() {
      return this.settings.get('gtk-theme')
    }

    get themeName() {
      return this.settings.get('window-buttons-theme')
    }

    get position() {
      return this.settings.get('window-buttons-position')
    }

    get placement() {
      return this.settings.get('window-buttons-placement')
    }

    get iconScaleWorkaround() {
      return this.settings.get('icon-scale-workaround')
    }

    get side() {
      const sides = { first: 'left', last: 'right', auto: this.position }
      return sides[this.placement] || this.placement
    }

    get index() {
      if (this.placement == 'first') return 0
      if (this.placement == 'last') return -1

      return null
    }

    get sibling() {
      if (this.side == 'left') {
        return Main.panel.statusArea.uniteNextAppMenu || Main.panel.statusArea.activities
      } else {
        return Main.panel.statusArea.quickSettings
      }
    }

    get container() {
      if (this.side == 'left') {
        return Main.panel._leftBox
      } else {
        return Main.panel._rightBox
      }
    }

    _onLayoutChange() {
      const buttons = [...(this.settings.get('window-buttons-layout') || [])]

      if (this.side != this.position) {
        buttons.reverse()
      }

      this.controls.addButtons(buttons)
      this._syncVisible()
    }

    _positionControls() {
      const controls  = this.controls.container
      const container = controls.get_parent()

      controls.add_style_class_name('window-controls-container')

      if (container) {
        container.remove_child(controls)
        this.container.add_child(controls)
      }

      if (this.index != null) {
        this.container.set_child_at_index(controls, this.index)
      } else {
        this.container.set_child_below_sibling(controls, this.sibling.get_parent())
      }

    }

    _onPositionChange() {
      this._positionControls()
      this._onLayoutChange()
    }

    _onThemeChange() {
      this.controls.remove_style_class_name(this.theme.uuid)

      this.theme = this.themes.locate(this.themeName, this.gtkTheme)
      this.styles.addScopedShellStyle('windowButtons', this.theme.getStyle(this.isDark), Buttons.WINDOW_CONTROLS_SCOPE)

      this.controls.add_style_class_name(this.theme.uuid)

      this._updateIconScaleWorkaround(true)
    }

    _onThemeSelectionChanged() {
      this.themes.update()
      this._onThemeChange()
    }

    _onPanelStyleChange() {
      const node = Main.panel.get_theme_node()
      const dark = Theme.isColorDark(node.get_background_color())

      if (this.isDark != dark) {
        this.isDark = dark
        this._onThemeChange()
      }
    }

    _onAutoThemeChange() {
      if (this.themeName == 'auto') {
        this._onThemeSelectionChanged()
      }
    }

    _onFocusAppChanged() {
      if (global.stage.key_focus == null) {
        this._syncVisible()
      }
    }

    _syncVisible() {
      this.controls.setVisible(isWindowControlsVisible({
        overviewVisible: Main.overview.visibleTarget,
        appRunning: this.context.focusApp?.state === Shell.AppState.RUNNING,
        window: this.context.focusWindow
      }))
    }

    _updateIconScaleWorkaround(forceLayoutChange = false) {
      this.controls.setControlThemeParams({
        actionIcons: this.theme.getActionIcons(this.isDark),
        iconScaleWorkaround: this.iconScaleWorkaround
      })

      if (forceLayoutChange) {
        this._onLayoutChange()
      }
    }

    destroy() {
      runCleanup([
        () => this.signals?.disconnectAll(),
        () => this.settings?.disconnectAll(),
        () => this.styles?.removeAll(),
        () => this.controls?.destroy(),
        () => { this.controls = this.theme = this.themes = null }
      ])
    }
  }

  class ExtendLeftBox extends Feature {
    constructor(context) {
      super(context, 'extend-left-box', setting => setting == true)
    }

    activate() {
      this.injections = new InjectionManager()
      this.injections.overrideMethod(
        Object.getPrototypeOf(Main.panel), 'vfunc_allocate', () => this._allocate.bind(this)
      )

      Main.panel.queue_relayout()
    }

    _allocate(box) {
      Main.panel.set_allocation(box)

      const leftBox     = Main.panel._leftBox
      const centerBox   = Main.panel._centerBox
      const rightBox    = Main.panel._rightBox
      const childBox    = new Clutter.ActorBox()

      const leftWidth   = leftBox.get_preferred_width(-1)[1]
      const centerWidth = centerBox.get_preferred_width(-1)[1]
      const rightWidth  = rightBox.get_preferred_width(-1)[1]

      const allocWidth  = box.x2 - box.x1
      const allocHeight = box.y2 - box.y1
      const sideWidth   = Math.max(0, Math.floor(allocWidth - centerWidth - rightWidth))

      const rtlTextDir  = Main.panel.get_text_direction() == Clutter.TextDirection.RTL

      childBox.y1 = 0
      childBox.y2 = allocHeight

      if (rtlTextDir) {
        childBox.x1 = allocWidth - Math.min(sideWidth, leftWidth)
        childBox.x2 = allocWidth
      } else {
        childBox.x1 = 0
        childBox.x2 = Math.min(sideWidth, leftWidth)
      }

      leftBox.allocate(childBox)

      childBox.y1 = 0
      childBox.y2 = allocHeight

      if (rtlTextDir) {
        childBox.x1 = rightWidth
        childBox.x2 = childBox.x1 + centerWidth
      } else {
        childBox.x1 = allocWidth - centerWidth - rightWidth
        childBox.x2 = childBox.x1 + centerWidth
      }

      centerBox.allocate(childBox)

      childBox.y1 = 0
      childBox.y2 = allocHeight

      if (rtlTextDir) {
        childBox.x1 = 0
        childBox.x2 = rightWidth
      } else {
        childBox.x1 = allocWidth - rightWidth
        childBox.x2 = allocWidth
      }

      rightBox.allocate(childBox)
    }

    destroy() {
      runCleanup([
        () => this.injections?.clear(),
        () => Main.panel.queue_relayout()
      ])
    }
  }

  class ActivitiesButton extends Feature {
    constructor(context) {
      super(context, 'hide-activities-button', setting => setting != 'never')
    }

    activate() {
      this.originalVisible = this.context.activities.container.visible
      this.signals  = new Signals()
      this.settings = new Settings(this.context)

      this.signals.connect(
        Main.overview, 'showing', this._syncVisible.bind(this)
      )

      this.signals.connect(
        Main.overview, 'hiding', this._syncVisible.bind(this)
      )

      this.signals.connect(
        this.context.appSystem, 'app-state-changed', this._syncVisible.bind(this)
      )

      this.signals.connect(
        this.context.windowTracker, 'notify::focus-app', this._onFocusAppChanged.bind(this)
      )

      this.settings.connect(
        'hide-activities-button', this._syncVisible.bind(this)
      )

      this.settings.connect(
        'show-desktop-name', this._syncVisible.bind(this)
      )

      this._syncVisible()
    }

    get hideButton() {
      return this.settings.get('hide-activities-button')
    }

    get showDesktop() {
      return this.settings.get('show-desktop-name')
    }

    _onFocusAppChanged() {
      if (global.stage.key_focus == null) {
        this._syncVisible()
      }
    }

    _syncVisible() {
      const button   = this.context.activities.container
      const overview = Main.overview.visibleTarget
      const focusApp = this.context.focusApp

      if (this.hideButton == 'always') {
        return button.hide()
      }

      if (this.showDesktop) {
        button.visible = overview
      } else {
        button.visible = overview || focusApp == null
      }
    }

    destroy() {
      runCleanup([
        () => this.signals?.disconnectAll(),
        () => this.settings?.disconnectAll(),
        () => {
          if (this.originalVisible !== undefined && !Main.overview.isDummy) {
            this.context.activities.container.visible = this.originalVisible
          }
        }
      ])
    }
  }

  class ActivitiesText extends Feature {
    constructor(context) {
      super(context, 'use-activities-text', setting => setting == true)
    }

    activate() {
      this.label = new St.Label({ y_align: Clutter.ActorAlign.CENTER })
      this.label.set_text(this.context.activities.get_accessible_name())

      this.switcher = this.context.activities.get_first_child()
      this.context.activities.remove_child(this.switcher)

      this.context.activities.add_child(this.label)
    }

    destroy() {
      runCleanup([
        () => this.label?.destroy(),
        () => {
          if (this.switcher && !this.switcher.get_parent()) {
            this.context.activities.add_child(this.switcher)
          }
        },
        () => { this.switcher = this.label = null }
      ])
    }
  }

  class DesktopName extends Feature {
    constructor(context) {
      super(context, 'show-desktop-name', setting => setting == true)
    }

    activate() {
      this.signals  = new Signals()
      this.settings = new Settings(this.context)
      this.label    = new Buttons.DesktopLabel()

      this.signals.connect(
        Main.overview, 'showing', this._syncVisible.bind(this)
      )

      this.signals.connect(
        Main.overview, 'hiding', this._syncVisible.bind(this)
      )

      this.signals.connect(
        this.context.appSystem, 'app-state-changed', this._syncVisible.bind(this)
      )

      this.signals.connect(
        this.context.windowTracker, 'notify::focus-app', this._onFocusAppChanged.bind(this)
      )

      this.settings.connect(
        'desktop-name-text', this._onTextChanged.bind(this)
      )

      Main.panel.addToStatusArea(
        'uniteNextDesktopLabel', this.label, 1, 'left'
      )

      this._onTextChanged()
      this._syncVisible()
    }

    _onFocusAppChanged() {
      if (global.stage.key_focus == null) {
        this._syncVisible()
      }
    }

    _syncVisible() {
      const overview = Main.overview.visibleTarget
      const focusApp = this.context.focusApp

      this.label.setVisible(!overview && focusApp == null)
    }

    _onTextChanged() {
      const text = this.settings.get('desktop-name-text')
      this.label.setText(text)
    }

    destroy() {
      runCleanup([
        () => this.signals?.disconnectAll(),
        () => this.settings?.disconnectAll(),
        () => this.label?.destroy(),
        () => { this.label = null }
      ])
    }
  }

  class TitlebarActions extends Feature {
    constructor(context) {
      super(context, 'enable-titlebar-actions', setting => setting == true)
    }

    activate() {
      this.signals = new Signals()
      this.settings = new Settings(this.context)
      this.actions = []

      const drag = Main.panel.get_action('window-drag')
      if (!(drag instanceof Clutter.ClickGesture)) {
        throw new Error('GNOME panel window-drag action is not a ClickGesture')
      }
      this.signals.connect(drag, 'may-recognize', gesture => {
        const target = this._getAction(gesture.get_button(), gesture.get_n_presses())
        if (!target) return true

        // A real first-click window grab cancels other pending gestures. The
        // native drag gesture retains its press count, so dispatch the second
        // primary press here before vetoing that press's native drag operation.
        if (gesture.get_button() == 1) this._performAction(target, gesture)
        return false
      })

      for (const button of [2, 3]) {
        const gesture = new Clutter.ClickGesture({
          required_button: button,
          n_clicks_required: 1,
          recognize_on_press: true
        })
        this.actions.push(gesture)

        this.signals.connect(gesture, 'should-handle-sequence', (action, event) => {
          const pressed = event.type() == Clutter.EventType.TOUCH_BEGIN ? 1 : event.get_button()
          return pressed == button && this._getAction(button, 1) != null
        })
        this.signals.connect(gesture, 'may-recognize', action => {
          return this._getAction(action.get_button(), action.get_n_presses()) != null
        })
        this.signals.connect(gesture, 'recognize', this._onRecognize.bind(this))
        Main.panel.add_action_full(`unite-next-titlebar-${button}`, Clutter.EventPhase.TARGET, gesture)
      }
    }

    _getAction(button, presses) {
      const win = this.context.focusWindow
      if (Main.modalCount > 0 || Main.overview.visibleTarget || !win?.hideTitlebars) {
        return null
      }

      const keys = {
        1: 'action-double-click-titlebar',
        2: 'action-middle-click-titlebar',
        3: 'action-right-click-titlebar'
      }
      if (!keys[button] || (button == 1 && presses != 2)) return null

      const action = this.settings.get(keys[button])
      const methods = {
        'toggle-maximize': 'maximize',
        'toggle-maximize-horizontally': 'maximizeX',
        'toggle-maximize-vertically': 'maximizeY',
        'minimize': 'minimize',
        'lower': 'lower'
      }
      const method = methods[action]
      if (action == 'menu' || (method && typeof win[method] == 'function')) {
        return { win, action, method }
      }
      return null
    }

    _onRecognize(gesture) {
      const target = this._getAction(gesture.get_button(), gesture.get_n_presses())
      if (!target) return
      this._performAction(target, gesture)
    }

    _performAction(target, gesture) {
      if (target.action == 'menu') {
        const rect = this._menuPositionRect(gesture.get_coords_abs().x)
        Main.wm._windowMenuManager.showWindowMenuForWindow(target.win.win, Meta.WindowMenuType.WM, rect)
      } else {
        target.win[target.method]()
      }
    }

    _menuPositionRect(x) {
      const [, y] = Main.panel.get_transformed_position()
      const [, height] = Main.panel.get_transformed_size()
      return { x: x - height, y, width: height * 2, height }
    }

    destroy() {
      runCleanup([
        () => this.signals?.disconnectAll(),
        () => this.settings?.disconnectAll(),
        ...(this.actions || []).map(action => () => {
          if (action.get_actor() == Main.panel) Main.panel.remove_action(action)
        }),
        () => { this.actions = [] }
      ])
    }
  }

  return { AppmenuButton, WindowButtons, ExtendLeftBox, ActivitiesButton, ActivitiesText, DesktopName, TitlebarActions }
}

export function createPanelManager({ GObject, featureTypes }) {
  const { AppmenuButton, WindowButtons, ExtendLeftBox, ActivitiesButton, ActivitiesText, DesktopName, TitlebarActions } = featureTypes
  return GObject.registerClass(
    class UniteNextPanelManager extends GObject.Object {
      _init(context, windowManager) {
        super._init()
        this.windowManager = windowManager
        this.disconnectPresentation = null
        this.features = new Features(context)

        this.appmenu = this.features.add(AppmenuButton)
        this.windowButtons = this.features.add(WindowButtons)
        this.features.add(ExtendLeftBox)
        this.features.add(ActivitiesButton)
        this.features.add(ActivitiesText)
        this.features.add(DesktopName)
        this.titlebarActions = this.features.add(TitlebarActions)
      }

      _syncPresentation() {
        if (this.appmenu.button) this.appmenu._syncState()
        if (this.windowButtons.controls) this.windowButtons._syncVisible()
      }

      activate() {
        this.disconnectPresentation = this.windowManager.observePresentation(() => this._syncPresentation())
        this.features.activate()
      }

      destroy() {
        const disconnect = this.disconnectPresentation
        this.disconnectPresentation = null
        runCleanup([
          () => { if (disconnect) disconnect() },
          () => this.features.destroy(),
          () => { this.windowManager = null }
        ])
      }
    }
  )
}
