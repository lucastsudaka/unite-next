import GObject from 'gi://GObject'
import St from 'gi://St'
import Pango from 'gi://Pango'
import Clutter from 'gi://Clutter'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Buttons from './buttons.js'
import * as Theme from './theme.js'
import { Styles } from './styles.js'
import { createPanelFeatures, createPanelManager } from './panel-features.js'

const featureTypes = createPanelFeatures({
  St, Pango, Clutter, Meta, Shell, Main, InjectionManager, Buttons, Theme, Styles, global
})

export const PanelManager = createPanelManager({ GObject, featureTypes })
