import GObject from 'gi://GObject'
import St from 'gi://St'
import Clutter from 'gi://Clutter'
import { gettext } from 'resource:///org/gnome/shell/extensions/extension.js'
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js'
import { createButtonWidgets } from './button-widgets.js'

export { WINDOW_CONTROLS_SCOPE } from './button-widgets.js'

export const { AppmenuLabel, DesktopLabel, WindowControls } = createButtonWidgets({
  GObject, St, Clutter, gettext, AppMenu, Main, PanelMenu, Animation
})
