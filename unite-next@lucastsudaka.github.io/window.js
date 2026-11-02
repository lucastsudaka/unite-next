import GObject from 'gi://GObject'
import Shell from 'gi://Shell'
import Meta from 'gi://Meta'
import Gio from 'gi://Gio'
import { Signals, Timeouts, runCleanup } from './resources.js'
import { Settings } from './settings.js'
import { Styles } from './styles.js'
import * as Convenience from './convenience.js'
import { ClientDecorations, ServerDecorations } from './decorations.js'
import { windowPolicyApplies } from './window-policy.js'

const VALID_TYPES = [
  Meta.WindowType.NORMAL,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  Meta.WindowType.UTILITY
]

function isValid(win) {
  return win && VALID_TYPES.includes(win.window_type)
}

function getId(win) {
  return win && win.get_id ? win.get_id() : win
}

function getXid(win) {
  const desc  = win.get_description()
  const match = desc && desc.match(/0x[0-9a-f]+/)

  return match && match[0]
}

function motifRequest(request) {
  const helper = Convenience.getDir().get_child('x11.py').get_path()
  const process = Gio.Subprocess.new(['/usr/bin/python3', helper],
    Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
  const [, output, errors] = process.communicate_utf8(JSON.stringify(request), null)
  if (!process.get_successful()) throw new Error(errors.trim() || 'Unite Motif helper failed')
  return JSON.parse(output)
}

const MetaWindow = GObject.registerClass(
  class UniteNextMetaWindow extends GObject.Object {
    _init(win, context, invalidatePresentation) {
      super._init()
      this.context = context
      this.invalidatePresentation = invalidatePresentation
      this.win = win
      this.xid = getXid(win)

      this.signals  = new Signals()
      this.settings = new Settings(context)

      if (this.xid && !this.clientDecorated) {
        this.decorations = new ServerDecorations(this, { request: motifRequest, border: Meta.FrameType.BORDER })
      } else {
        this.decorations = new ClientDecorations(this)
      }

    }

    activate(onUnmanaged) {
      this.win._uniteNextManaged = true
      const win = this.win
      this.signals.connect(win, 'unmanaged', onUnmanaged)
      this.signals.connect(
        win, 'size-changed', this._onStateChanged.bind(this)
      )

      // Maximization can change while the frame already fills the work area.
      for (const axis of ['horizontally', 'vertically']) {
        this.signals.connect(
          win, `notify::maximized-${axis}`, this._onStateChanged.bind(this)
        )
      }

      this.signals.connect(
        win, 'notify::title', this._onTitleChanged.bind(this)
      )

      this.signals.connect(
        win, 'notify::skip-taskbar', this.invalidatePresentation
      )

      this.settings.connect(
        'restrict-to-primary-screen', this.syncComponents.bind(this)
      )

      this.settings.connect(
        'hide-window-titlebars', this.syncDecorations.bind(this)
      )

      this.settings.connect(
        'show-window-buttons', this.invalidatePresentation
      )

      this.settings.connect(
        'show-window-title', this.invalidatePresentation
      )

      this.syncComponents()
    }

    get app() {
      return this.context.windowTracker.get_window_app(this.win)
    }

    get hasFocus() {
      return this.win.has_focus()
    }

    get title() {
      if (this.showTitle) {
        return this.win.get_title()
      } else {
        return this.app?.get_name() || this.win.get_title()
      }
    }

    get clientDecorated() {
      return this.win.get_client_type() === Meta.WindowClientType.WAYLAND
    }

    get skipTaskbar() {
      return this.win.skip_taskbar
    }

    get primaryScreen() {
      return this.win.is_on_primary_monitor()
    }

    get minimized() {
      return this.win.minimized
    }

    get anyMaximized() {
      return this.win.maximized_horizontally || this.win.maximized_vertically
    }

    get maximized() {
      return this.win.maximized_horizontally && this.win.maximized_vertically
    }

    get tiled() {
      return !this.maximized && this.anyMaximized
    }

    get restrictToPrimary() {
      return this.settings.get('restrict-to-primary-screen')
    }

    get showTitle() {
      return this._parseEnumSetting('show-window-title')
    }

    get showButtons() {
      return this._parseEnumSetting('show-window-buttons')
    }

    get hideTitlebars() {
      return this._parseEnumSetting('hide-window-titlebars')
    }

    setMaximizeFlags(flags) {
      this.win.set_maximize_flags(flags)
    }

    setUnmaximizeFlags(flags) {
      this.win.set_unmaximize_flags(flags)
    }

    minimize() {
      if (this.minimized) {
        this.win.unminimize()
      } else {
        this.win.minimize()
      }
    }

    maximize() {
      if (this.maximized) {
        this.setUnmaximizeFlags(Meta.MaximizeFlags.BOTH)
      } else {
        this.setMaximizeFlags(Meta.MaximizeFlags.BOTH)
      }
    }

    maximizeX() {
      if (this.win.maximized_horizontally) {
        this.setUnmaximizeFlags(Meta.MaximizeFlags.HORIZONTAL)
      } else {
        this.setMaximizeFlags(Meta.MaximizeFlags.HORIZONTAL)
      }
    }

    maximizeY() {
      if (this.win.maximized_vertically) {
        this.setUnmaximizeFlags(Meta.MaximizeFlags.VERTICAL)
      } else {
        this.setMaximizeFlags(Meta.MaximizeFlags.VERTICAL)
      }
    }

    lower() {
      this.win.lower()
    }

    close() {
      const time = this.context.getCurrentTime()
      time && this.win.delete(time)
    }

    syncDecorations() {
      if (this.hideTitlebars) {
        this.decorations.hide()
      } else {
        this.decorations.show()
      }
    }

    syncComponents() {
      this.syncDecorations()
      this.invalidatePresentation()
    }

    _parseEnumSetting(name) {
      return windowPolicyApplies(this.settings.get(name), this)
    }

    _onStateChanged() {
      this.syncComponents()
    }

    _onTitleChanged() {
      this.invalidatePresentation()
    }

    destroy(reset = true) {
      try {
        runCleanup([
          () => this.signals.disconnectAll(),
          () => this.settings.disconnectAll(),
          () => { if (reset) this.decorations.reset() }
        ])
      } finally {
        this.win._uniteNextManaged = false
      }
    }
  }
)

export const WindowManager = GObject.registerClass(
  class UniteNextWindowManager extends GObject.Object {
    _init(context) {
      super._init()
      this.context = context
      this.windows  = new Map()
      this.signals  = new Signals()
      this.settings = new Settings(context)
      this.timeouts = new Timeouts()
      this.styles   = new Styles()

      this._focusWindow  = null
      this._startingApps = []
      this._presentationObserver = null
    }

    // A GObject signal logs observer exceptions instead of propagating them.
    // Keep this acquisition boundary synchronous so window rollback can run.
    observePresentation(callback) {
      if (typeof callback !== 'function') throw new TypeError('Presentation observer must be a function')
      if (this._presentationObserver) throw new Error('Window presentation already has an owner')
      const observer = { callback }
      this._presentationObserver = observer
      return () => {
        if (this._presentationObserver === observer) this._presentationObserver = null
      }
    }

    _notifyPresentation() {
      if (this._presentationObserver) this._presentationObserver.callback()
    }

    _connect() {
      this.signals.connect(
        this.context.display, 'window-created', this._onWindowCreated.bind(this)
      )

      this.signals.connect(
        this.context.display, 'window-entered-monitor', this._onWindowEntered.bind(this)
      )

      // Mutter can retain a logical monitor when only its primary flag changes.
      this.signals.connect(
        this.context.monitorManager, 'monitors-changed', this._onMonitorsChanged.bind(this)
      )

      this.signals.connect(
        this.context.display, 'notify::focus-window', this._onFocusWindow.bind(this)
      )

      this.signals.connect(
        this.context.display, 'window-demands-attention', this._onAttention.bind(this)
      )

      this.signals.connect(
        this.context.appSystem, 'app-state-changed', this._onAppStateChanged.bind(this)
      )

      this.settings.connect(
        'hide-window-titlebars', this._onStylesChange.bind(this)
      )

      this.settings.connect(
        'restrict-to-primary-screen', this._onStylesChange.bind(this)
      )

      this.settings.connect(
        'button-layout', this._onStylesChange.bind(this)
      )
    }

    get focusApp() {
      const focusApps = [this.context.windowTracker.focus_app].concat(this._startingApps)
      const workspace = this.context.workspaceManager.get_active_workspace()

      return focusApps.find(app => app && app.is_on_workspace(workspace))
    }

    get focusWindow() {
      if (this._focusWindow) {
        return this.getWindow(this._focusWindow)
      }
    }

    get hideTitlebars() {
      return this.settings.get('hide-window-titlebars')
    }

    hasWindow(win) {
      return win && this.windows.has(getId(win))
    }

    getWindow(win) {
      return win && this.windows.get(getId(win))
    }

    setWindow(win) {
      if (!this.hasWindow(win)) {
        const meta = new MetaWindow(win, this.context, () => this._notifyPresentation())
        this.windows.set(getId(win), meta)
        try {
          meta.activate(() => this.deleteWindow(win, false))
        } catch (error) {
          runCleanup([() => { throw error }, () => this._removeWindow(win)])
        }
      }
    }

    _removeWindow(win, reset = true) {
      if (this.hasWindow(win)) {
        const meta = this.getWindow(win)
        this.windows.delete(getId(win))
        meta.destroy(reset)
        return true
      }
      return false
    }

    deleteWindow(win, reset = true) {
      if (this._removeWindow(win, reset)) this._notifyPresentation()
    }

    clearWindows() {
      runCleanup([...this.windows.keys()].map(key => () => this.deleteWindow(key)))
    }

    registerWindow(meta_window) {
      if (isValid(meta_window)) {
        this.setWindow(meta_window)
      }
    }

    registerActor({ meta_window }) {
      this.registerWindow(meta_window)
    }

    _onWindowCreated(display, meta_window) {
      this.registerWindow(meta_window)
    }

    _onWindowEntered(display, index, meta_window) {
      const meta = this.getWindow(meta_window)

      if (meta) {
        meta.syncComponents()
      } else {
        this.registerWindow(meta_window)
      }
    }

    _onMonitorsChanged() {
      runCleanup([...this.windows.values()].map(window => () => window.syncComponents()))
    }

    _onFocusWindow(display) {
      this._focusWindow = display.focus_window

      if (this.focusWindow) {
        this.focusWindow.syncComponents()
      } else {
        this._notifyPresentation()
      }
    }

    _onAppStateChanged(appSys, app) {
      if (app.state == Shell.AppState.STARTING) {
        this._startingApps.push(app)
      } else {
        this._startingApps = this._startingApps.filter(item => item !== app)
      }
      this._notifyPresentation()
    }

    _onAttention(actor, win) {
      const auto = this.settings.get('autofocus-windows')
      const time = this.context.getCurrentTime()

      auto && this.context.activateWindow(win, time)
    }

    _onStylesChange() {
      if (!this.settings.get('restrict-to-primary-screen') && this.hideTitlebars != 'never') {
        const side = this.settings.get('window-buttons-position')
        const path = `@/buttons-${side}/${this.hideTitlebars}.css`

        this.styles.addGtkStyle('windowDecorations', path)
      } else {
        this.styles.deleteStyle('windowDecorations')
      }
    }

    activate() {
      this._connect()
      this.timeouts.idle(() => {
        const actors = this.context.getWindowActors()
        actors.forEach(actor => this.registerActor(actor))
      })

      this._onFocusWindow(this.context.display)
      this._onStylesChange()
    }

    destroy() {
      this._focusWindow  = null
      this._startingApps = []
      this._presentationObserver = null

      runCleanup([
        () => this.timeouts.removeAll(),
        () => this.signals.disconnectAll(),
        () => this.settings.disconnectAll(),
        () => this.styles.removeAll(),
        () => this.clearWindows()
      ])
    }
  }
)
