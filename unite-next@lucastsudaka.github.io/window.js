import GObject from 'gi://GObject'
import Shell from 'gi://Shell'
import Meta from 'gi://Meta'
import Gio from 'gi://Gio'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Handlers from './handlers.js'
import * as Convenience from './convenience.js'

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

class ClientDecorations {
  show() {
    return false
  }

  hide() {
    return false
  }

  reset() {
    return false
  }
}

class ServerDecorations {
  constructor({ xid, win }) {
    this.xid = xid
    this.win = win
    this.owned = null
    this.conflicted = false
  }

  get decorated() {
    return this.win.get_frame_type() !== Meta.FrameType.BORDER
  }

  get handle() {
    return this.win.decorated
  }

  show() {
    this.reset()
  }

  hide() {
    if (!this.handle || !this.decorated || this.owned || this.conflicted) return
    const result = motifRequest({ operation: 'read', xid: this.xid })
    const original = result.value
    // Type atoms are server-local and remain valid for this window's lifetime.
    const value = original ? { ...original, data: [...original.data] } :
      { type: result.type, format: 32, data: [2, 0, 2, 0, 0] }
    this.owned = { original, value }
    if (original) {
      value.data[0] = (value.data[0] | 2) >>> 0
      value.data[2] = 2
    }
    try {
      const applied = motifRequest({ operation: 'replace', xid: this.xid,
        expected: original, value: this.owned.value })
      if (!applied.changed) this.owned = null
    } catch (error) {
      if (error.message.includes('Ownership conflict:')) {
        this.owned = null
        this.conflicted = true
      }
      throw error
    }
  }

  reset() {
    if (!this.owned) return
    const { original, value } = this.owned
    try {
      motifRequest({ operation: 'replace', xid: this.xid, expected: value, value: original })
      this.owned = null
    } catch (error) {
      if (error.message.includes('Ownership conflict:')) {
        this.owned = null
        this.conflicted = true
      }
      throw error
    }
  }
}

const MetaWindow = GObject.registerClass(
  class UniteNextMetaWindow extends GObject.Object {
    _init(win, context) {
      super._init()
      this.context = context
      this.win = win
      this.xid = getXid(win)

      this.signals  = new Handlers.Signals()
      this.settings = new Handlers.Settings(context)

      if (this.xid && !this.clientDecorated) {
        this.decorations = new ServerDecorations(this)
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

      this.signals.connect(
        win, 'notify::title', this._onTitleChanged.bind(this)
      )

      this.settings.connect(
        'restrict-to-primary-screen', this.syncComponents.bind(this)
      )

      this.settings.connect(
        'hide-window-titlebars', this.syncDecorations.bind(this)
      )

      this.settings.connect(
        'show-window-buttons', this.syncControls.bind(this)
      )

      this.settings.connect(
        'show-window-title', this.syncAppmenu.bind(this)
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

    get handleScreen() {
      return this.primaryScreen || !this.restrictToPrimary
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
      const time = global.get_current_time()
      time && this.win.delete(time)
    }

    syncDecorations() {
      if (this.hideTitlebars) {
        this.decorations.hide()
      } else {
        this.decorations.show()
      }
    }

    syncControls() {
      if (this.hasFocus) {
        const overview = Main.overview.visibleTarget
        const controls = Main.panel.statusArea.uniteNextWindowControls

        controls && controls.setVisible(
          !overview && !this.skipTaskbar && this.showButtons
        )
      }
    }

    syncAppmenu() {
      const appmenu = Main.panel.statusArea.uniteNextAppMenu

      if (appmenu && this.hasFocus && this.title) {
        const title = this.title.replace(/\r?\n|\r/g, ' ')
        appmenu.setText(title)
      }
    }

    syncComponents() {
      this.syncDecorations()
      this.syncControls()
      this.syncAppmenu()
    }

    _parseEnumSetting(name) {
      switch (this.settings.get(name)) {
        case 'always':    return true
        case 'never':     return false
        case 'tiled':     return this.handleScreen && this.tiled
        case 'maximized': return this.handleScreen && this.maximized
        case 'both':      return this.handleScreen && this.anyMaximized
      }
    }

    _onStateChanged() {
      this.syncComponents()
    }

    _onTitleChanged() {
      this.syncAppmenu()
    }

    destroy(reset = true) {
      try {
        Handlers.runCleanup([
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
      this.signals  = new Handlers.Signals()
      this.settings = new Handlers.Settings(context)
      this.timeouts = new Handlers.Timeouts()
      this.styles   = new Handlers.Styles()

      this._focusWindow  = null
      this._startingApps = []
    }

    _connect() {
      this.signals.connect(
        this.context.display, 'window-created', this._onWindowCreated.bind(this)
      )

      this.signals.connect(
        this.context.display, 'window-entered-monitor', this._onWindowEntered.bind(this)
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
        'button-layout', this._onStylesChange.bind(this)
      )
    }

    get focusApp() {
      const focusApps = [this.context.windowTracker.focus_app].concat(this._startingApps)
      const workspace = global.workspace_manager.get_active_workspace()

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
        const meta = new MetaWindow(win, this.context)
        this.windows.set(getId(win), meta)
        try {
          meta.activate(() => this.deleteWindow(win, false))
        } catch (error) {
          Handlers.runCleanup([() => { throw error }, () => this.deleteWindow(win)])
        }
      }
    }

    deleteWindow(win, reset = true) {
      if (this.hasWindow(win)) {
        const meta = this.getWindow(win)
        this.windows.delete(getId(win))
        meta.destroy(reset)
      }
    }

    clearWindows() {
      Handlers.runCleanup([...this.windows.keys()].map(key => () => this.deleteWindow(key)))
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

    _onFocusWindow(display) {
      this._focusWindow = display.focus_window

      if (this.focusWindow) {
        this.focusWindow.syncComponents()
      }
    }

    _onAppStateChanged(appSys, app) {
      if (app.state == Shell.AppState.STARTING) {
        this._startingApps.push(app)
      } else {
        this._startingApps = this._startingApps.filter(item => item !== app)
      }
    }

    _onAttention(actor, win) {
      const auto = this.settings.get('autofocus-windows')
      const time = global.get_current_time()

      auto && Main.activateWindow(win, time)
    }

    _onStylesChange() {
      if (this.hideTitlebars != 'never') {
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
        const actors = global.get_window_actors()
        actors.forEach(actor => this.registerActor(actor))
      })

      this._onFocusWindow(this.context.display)
      this._onStylesChange()
    }

    destroy() {
      this._focusWindow  = null
      this._startingApps = []

      Handlers.runCleanup([
        () => this.timeouts.removeAll(),
        () => this.signals.disconnectAll(),
        () => this.settings.disconnectAll(),
        () => this.styles.removeAll(),
        () => this.clearWindows()
      ])
    }
  }
)
