import { Signals, runCleanup } from './resources.js'

// Native composition is explicit; active services are acquired only by enable().
export function createExtensionClass({ Extension, Main, Shell, ExtensionState, Convenience,
  WindowManager, PanelManager, LayoutManager, Styles, resetGtkStyles, global }) {
  const UPSTREAM_UUID = 'unite@hardpixel.eu'

  function conflictsWithUpstream(extension) {
    return extension?.uuid === UPSTREAM_UUID &&
      [ExtensionState.ACTIVE, ExtensionState.ACTIVATING].includes(extension.state)
  }

  function upstreamConflict() {
    return new Error(`Unite Next cannot run while ${UPSTREAM_UUID} is active or activating`)
  }

  return class UniteNextExtension extends Extension {
    enable() {
      // REQ-FORK-CONFLICT-001: reject before acquiring settings, styles or actors.
      const extensionManager = Main.extensionManager
      if (conflictsWithUpstream(extensionManager.lookup(UPSTREAM_UUID))) throw upstreamConflict()

      const owner = this
      try {
        this.conflictSignals = new Signals()
        this.conflictSignals.connect(extensionManager, 'extension-state-changed',
          (manager, extension) => this._onExtensionStateChanged(manager, extension))
        this.styles = new Styles()
        this.styles.addShellStyle('unite-next-shell', '@/styles/shell.css')

        this.context = {
          settings: {
            extension: Convenience.adaptSettings(this.getSettings()),
            preferences: Convenience.getPreferences(),
            interface: Convenience.getInterface()
          },
          display: global.display,
          monitorManager: global.backend.get_monitor_manager(),
          workspaceManager: global.workspace_manager,
          getWindowActors: () => global.get_window_actors(),
          getCurrentTime: () => global.get_current_time(),
          activateWindow: (window, time) => Main.activateWindow(window, time),
          appSystem: Shell.AppSystem.get_default(),
          windowTracker: Shell.WindowTracker.get_default(),
          activities: Main.panel.statusArea.activities,
          get focusApp() { return owner.windowManager?.focusApp },
          get focusWindow() { return owner.windowManager?.focusWindow }
        }
        this.windowManager = new WindowManager(this.context)
        this.panelManager  = new PanelManager(this.context, this.windowManager)
        this.layoutManager = new LayoutManager(this.context)

        resetGtkStyles()
        this.panelManager.activate()
        this.layoutManager.activate()
        this.windowManager.activate()
        Main.panel.add_style_class_name('unite-next-shell')
      } catch (error) {
        runCleanup([() => { throw error }, () => this.disable()])
      }
    }

    _onExtensionStateChanged(manager, extension) {
      if (!conflictsWithUpstream(extension)) return

      const conflict = upstreamConflict()
      let cleanupError = null
      try {
        this.disable()
      } catch (error) {
        cleanupError = error
      }
      // Let native deactivation finish its ordering bookkeeping before an actual
      // cleanup failure becomes ERROR. The native callback consumes this error.
      this.pendingDisableError = cleanupError
      try {
        if (!manager.disableExtension(this.uuid)) throw new Error('Native deactivation request was rejected')
        // Native disableExtension() returns true even when locked GSettings writes
        // fail. Match native mode/user membership; the disabled list wins both.
        const enabled = global.settings.get_strv('enabled-extensions')
        const disabled = global.settings.get_strv('disabled-extensions')
        const modeExtensions = Main.sessionMode.enabledExtensions
        const modeEnabled = Array.isArray(modeExtensions) && modeExtensions.includes(this.uuid)
        const userEnabled = !global.settings.get_boolean('disable-user-extensions') && enabled.includes(this.uuid)
        if ((modeEnabled || userEnabled) && !disabled.includes(this.uuid))
          throw new Error('Native deactivation did not change effective enabled membership')
      } catch (requestError) {
        this.pendingDisableError = null
        const message = `${conflict.message}; native deactivation failed: ${requestError.message}`
        const failure = cleanupError
          ? new AggregateError([cleanupError, requestError], `${message}; cleanup failed: ${cleanupError.message}`, { cause: cleanupError })
          : new Error(message, { cause: requestError })
        manager.logExtensionError(this.uuid, failure)
        Main.notifyError('Unite Next could not deactivate', failure.message)
        return
      }
      Main.notifyError('Unite Next deactivated', conflict.message)
    }

    disable() {
      const pendingDisableError = this.pendingDisableError
      this.pendingDisableError = null
      const conflictSignals = this.conflictSignals
      const styles = this.styles
      const managers = [this.panelManager, this.layoutManager, this.windowManager]
      this.conflictSignals = null
      this.styles = null
      this.panelManager = null
      this.layoutManager = null
      this.windowManager = null
      try {
        runCleanup([
          () => conflictSignals?.disconnectAll(),
          () => { if (pendingDisableError) throw pendingDisableError },
          ...managers.map(manager => () => manager?.destroy()),
          () => styles?.removeAll(),
          () => resetGtkStyles(),
          () => Main.panel.remove_style_class_name('unite-next-shell')
        ])
      } finally {
        this.context = null
      }
    }
  }
}
