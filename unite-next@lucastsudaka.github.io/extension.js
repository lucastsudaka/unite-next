import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import Shell from 'gi://Shell'
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js'
import * as Convenience from './convenience.js'
import { Styles } from './styles.js'
import { resetGtkStyles } from './gtk-styles.js'
import { PanelManager } from './panel.js'
import { LayoutManager } from './layout.js'
import { WindowManager } from './window.js'

import { createExtensionClass } from './extension-lifecycle.js'

export default createExtensionClass({
  Extension, Main, Shell, ExtensionState, Convenience, WindowManager, PanelManager,
  LayoutManager, Styles, resetGtkStyles, global
})
