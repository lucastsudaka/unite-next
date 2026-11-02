import { Signals, runCleanup } from './resources.js'
import { Settings } from './settings.js'
import { Feature, Features } from './features.js'

export function createLayoutFeatures({ St, Clutter, Main, Styles, global, warn }) {
  class Messages extends Feature {
    constructor(context) {
      super(context, 'notifications-position', setting => setting != 'center')
    }

    activate() {
      this.settings = new Settings(this.context)
      this.signals = new Signals()
      this.banner = Main.messageTray._bannerBin
      this.originalAlign = Main.messageTray.bannerAlignment
      this.originalWidth = this._widthRequests()
      this.ownedWidth = null
      this.ownedAlign = undefined
      this.widthConflict = this.alignConflict = false
      this.themeContext = St.ThemeContext.get_for_stage(global.stage)

      this.settings.connect(
        'notifications-position', this._onPositionChange.bind(this)
      )
      this.signals.connect(
        this.themeContext, 'notify::scale-factor', this._onPositionChange.bind(this)
      )

      this._onPositionChange()
    }

    get position() {
      const mapping = { left: 'START', right: 'END' }
      const setting = this.settings.get('notifications-position')

      return mapping[setting]
    }

    _widthRequests() {
      return [this.banner.min_width, this.banner.min_width_set,
        this.banner.natural_width, this.banner.natural_width_set]
    }

    _ownsWidth() {
      if (!this.widthConflict && this.ownedWidth &&
        this._widthRequests().some((value, index) => value !== this.ownedWidth[index])) {
        this.widthConflict = true
        warn('Unite Next notification width ownership conflict; preserving foreign requests')
      }
      return !this.widthConflict
    }

    _ownsAlignment() {
      if (!this.alignConflict && this.ownedAlign !== undefined &&
        Main.messageTray.bannerAlignment !== this.ownedAlign) {
        this.alignConflict = true
        warn('Unite Next notification alignment ownership conflict; preserving foreign alignment')
      }
      return !this.alignConflict
    }

    _onPositionChange() {
      if (this._ownsAlignment()) {
        this.ownedAlign = Clutter.ActorAlign[this.position]
        Main.messageTray.bannerAlignment = this.ownedAlign
      }
      if (this._ownsWidth()) {
        const width = 390 * this.themeContext.scale_factor
        this.ownedWidth = [width, true, width, true]
        this.banner.set_width(width)
      }
    }

    _restoreWidth() {
      if (!this.ownedWidth || !this._ownsWidth()) return
      const [minimum, minimumSet, natural, naturalSet] = this.originalWidth
      this.banner.freeze_notify()
      try {
        // Setting a request also enables its override: restore flags last.
        this.banner.min_width = minimum
        this.banner.natural_width = natural
        this.banner.min_width_set = minimumSet
        this.banner.natural_width_set = naturalSet
      } finally {
        this.banner.thaw_notify()
      }
    }

    destroy() {
      runCleanup([
        () => this.signals?.disconnectAll(),
        () => this.settings?.disconnectAll(),
        () => {
          if (this.ownedAlign !== undefined && this._ownsAlignment())
            Main.messageTray.bannerAlignment = this.originalAlign
        },
        () => this._restoreWidth(),
        () => { this.banner = this.themeContext = null }
      ])
    }
  }

  class PanelSpacing extends Feature {
    constructor(context) {
      super(context, 'reduce-panel-spacing', setting => setting == true)
    }

    activate() {
      this.styles = new Styles()
      this._dateMenu = Main.panel.statusArea.dateMenu
      this._dateMenuPadding = [this._dateMenu._minHPadding, this._dateMenu._natHPadding]
      this._injectStyles()

      this._syncLayout()
    }

    _injectStyles() {
      this.styles.addShellStyle('spacing', '@/styles/shell/spacing.css')
    }

    _syncLayout() {
      // Fix dateMenu paddings when reduce spacing enabled
      // when returning from lock screen
      const dateMenu = this._dateMenu
      dateMenu._minHPadding = 0
      dateMenu._natHPadding = 0

      dateMenu.queue_relayout()
    }

    destroy() {
      runCleanup([
        () => this.styles?.removeAll(),
        () => {
          if (this._dateMenuPadding) {
            [this._dateMenu._minHPadding, this._dateMenu._natHPadding] = this._dateMenuPadding
            this._dateMenu.queue_relayout()
          }
        },
        () => { this._dateMenu = this._dateMenuPadding = null }
      ])
    }
  }

  return { Messages, PanelSpacing }
}

export function createLayoutManager({ GObject, featureTypes }) {
  const { Messages, PanelSpacing } = featureTypes
  return GObject.registerClass(
    class UniteNextLayoutManager extends GObject.Object {
      _init(context) {
        super._init()
        this.features = new Features(context)
        this.features.add(Messages)
        this.features.add(PanelSpacing)
      }

      activate() {
        this.features.activate()
      }

      destroy() {
        this.features.destroy()
      }
    }
  )
}
