import GObject from 'gi://GObject'
import St from 'gi://St'
import Clutter from 'gi://Clutter'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Handlers from './handlers.js'

class Messages extends Handlers.Feature {
  constructor(context) {
    super(context, 'notifications-position', setting => setting != 'center')
  }

  activate() {
    this.settings = new Handlers.Settings(this.context)
    this.signals = new Handlers.Signals()
    this.banner = Main.messageTray._bannerBin
    this.originalAlign = Main.messageTray.bannerAlignment
    this.originalWidth = this.banner.width_set ? this.banner.width : -1
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

  _onPositionChange() {
    const position = Clutter.ActorAlign[this.position]

    Main.messageTray.bannerAlignment = position
    this.banner.set_width(390 * this.themeContext.scale_factor)
  }

  destroy() {
    Handlers.runCleanup([
      () => this.signals?.disconnectAll(),
      () => this.settings?.disconnectAll(),
      () => {
        if (this.originalAlign !== undefined) Main.messageTray.bannerAlignment = this.originalAlign
      },
      () => {
        if (this.originalWidth !== undefined) this.banner.set_width(this.originalWidth)
      },
      () => { this.banner = this.themeContext = null }
    ])
  }
}

class PanelSpacing extends Handlers.Feature {
  constructor(context) {
    super(context, 'reduce-panel-spacing', setting => setting == true)
  }

  activate() {
    this.styles = new Handlers.Styles()
    this._dateMenu = Main.panel.statusArea.dateMenu
    this._dateMenuPadding = [this._dateMenu._minHPadding, this._dateMenu._natHPadding]
    this._injectStyles()

    Main.panel.add_style_class_name('unite-next-reduce-spacing')
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
    Handlers.runCleanup([
      () => Main.panel.remove_style_class_name('unite-next-reduce-spacing'),
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

export const LayoutManager = GObject.registerClass(
  class UniteNextLayoutManager extends GObject.Object {
    _init(context) {
      super._init()
      this.features = new Handlers.Features(context)

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
