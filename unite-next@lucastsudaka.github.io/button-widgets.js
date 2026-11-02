import { runCleanup } from './resources.js'

export const WINDOW_CONTROLS_SCOPE = 'unite-next-window-controls'

// Native entrypoints call this once; tests supply the same desktop type/service ports.
export function createButtonWidgets({ GObject, St, Clutter, gettext: _, AppMenu, Main, PanelMenu, Animation }) {
  const AppmenuLabel = GObject.registerClass(
    class UniteNextAppmenuLabel extends PanelMenu.Button {
      _init(text) {
        super._init(0.0, null, true)

        try {
          this._initialize(text)
        } catch (error) {
          runCleanup([() => this.destroy(), () => { throw error }])
        }
      }

      _initialize(text) {

        const bin = new St.Bin({ name: 'appMenu' })
        this.add_child(bin)

        this.bind_property('reactive', this, 'can-focus', 0)
        this.reactive = false

        this._container = new St.BoxLayout({ style_class: 'panel-status-menu-box' })
        bin.set_child(this._container)

        this._icon = new St.Icon()
        this._icon.set_icon_size(16)
        this._icon.set_fallback_gicon(null)

        this._iconBox = new St.Bin({ style_class: 'app-menu-icon', y_align: Clutter.ActorAlign.CENTER })
        this._iconBox.set_child(this._icon)
        this._container.add_child(this._iconBox)

        this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER })
        this._container.add_child(this._label)

        this._spinner = new Animation.Spinner(14, { animate: true, hideOnStop: true })
        this._container.add_child(this._spinner)

        const menu = new AppMenu(this)
        this._menuManager = Main.panel.menuManager
        this.setMenu(menu)

        this._menuManager.addMenu(menu)

        const iconEffect = new Clutter.DesaturateEffect()
        this._iconBox.add_effect(iconEffect)

        this._iconBox.connect('style-changed', () => {
          const themeNode = this._iconBox.get_theme_node()
          iconEffect.enabled = themeNode.get_icon_style() === St.IconStyle.SYMBOLIC
        })

        this.setText(text || '')
        this.add_style_class_name('app-menu-label')
      }

      setApp(app) {
        this.setIcon(app.get_icon())
        this.setText(app.get_name())
        this.menu.setApp(app)
      }

      setIcon(icon) {
        this._icon.set_gicon(icon)
      }

      setText(text) {
        this._label.set_text(text)
      }

      setReactive(reactive) {
        this.reactive = reactive
      }

      setVisible(visible) {
        if (this.container.visible != visible) {
          this.container.visible = visible
          this.set_hover(false)
        }
      }

      toggleIcon(hidden) {
        this._iconBox.visible = !hidden
      }

      stopAnimation() {
        this._spinner.stop()
      }

      startAnimation() {
        this._spinner.play()
      }

      _onDestroy() {
        const menu = this.menu
        this.menu = null
        runCleanup([
          () => {
            if (menu) this._menuManager?.removeMenu(menu)
          },
          () => menu?.setApp?.(null),
          () => menu?.destroy(),
          () => this.setMenu(null),
          () => { this._menuManager = null },
          () => super._onDestroy()
        ])
      }
    }
  )

  const DesktopLabel = GObject.registerClass(
    class UniteNextDesktopLabel extends PanelMenu.Button {
      _init(text) {
        super._init(0.0, null, true)

        this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER })
        this.add_child(this._label)

        this.reactive = false
        this.label_actor = this._label

        this.setText(text || 'Desktop')
        this.add_style_class_name('desktop-name-label')
      }

      setText(text) {
        this._label.set_text(text)
      }

      setVisible(visible) {
        this.container.visible = visible
      }
    }
  )

  const WindowControls = GObject.registerClass(
    class UniteNextWindowControls extends PanelMenu.Button {
      _init(getTarget) {
        super._init(0.0, null, true)
        this._getTarget = getTarget
        this._buttons = new Map()

        this.container.add_style_class_name(WINDOW_CONTROLS_SCOPE)
        this.add_style_class_name(WINDOW_CONTROLS_SCOPE)
        this._controls = new St.BoxLayout({ style_class: `window-controls-box ${WINDOW_CONTROLS_SCOPE}` })
        this.add_child(this._controls)

        this.add_style_class_name('window-controls')
        this.remove_style_class_name('panel-button')
      }

      setControlThemeParams(params) {
        this._actionIcons = params.actionIcons
        this._iconScaleWorkaround = params.iconScaleWorkaround
      }

      _addButton(action) {
        const pos = Clutter.ActorAlign.CENTER
        const bin = new St.Bin({ style_class: `icon ${WINDOW_CONTROLS_SCOPE}`, x_align: pos, y_align: pos })
        const btn = new St.Button({
          style_class: WINDOW_CONTROLS_SCOPE,
          track_hover: true,
          can_focus: true,
          accessible_name: this._actionName(action)
        })

        if (this._iconScaleWorkaround) {
          // A workaround for multi-scaling setups https://github.com/hardpixel/unite-shell/issues/106
          const gicon = this._actionIcons[action]
          const icon = new St.Icon({
            style_class: WINDOW_CONTROLS_SCOPE,
            x_align: pos,
            y_align: pos,
            gicon: gicon.default
          })
          const syncIcon = () => {
            icon.set_gicon(btn.pressed ? gicon.active : btn.hover ? gicon.hover : gicon.default)
          }
          btn.connect('notify::hover', syncIcon)
          btn.connect('notify::pressed', syncIcon)
          bin.set_child(icon)
          // Add only root class name for button sizing
          btn.add_style_class_name('window-button')
        } else {
          // Normal approach with CSS-based icons
          btn.add_style_class_name(`window-button ${action}`)
        }

        btn.set_child(bin)

        btn.connect('clicked', () => {
          const target = this._getTarget()
          const method = target && target[action]

          method && method.call(target)
        })

        this._controls.add_child(btn)
        this._buttons.set(action, btn)
      }

      addButtons(buttons) {
        this._controls.destroy_all_children()
        this._buttons.clear()
        buttons && buttons.forEach(this._addButton.bind(this))
      }

      setVisible(visible) {
        this.container.visible = Boolean(visible)
        for (const [action, button] of this._buttons) {
          button.accessible_name = this._actionName(action)
        }
      }

      _actionName(action) {
        switch (action) {
          case 'close': return _('Close')
          case 'minimize': return _('Minimize')
          case 'maximize': return this._getTarget()?.maximized ? _('Restore') : _('Maximize')
        }
        throw new Error(`Unknown window control action: ${action}`)
      }
    }
  )

  return { AppmenuLabel, DesktopLabel, WindowControls }
}
