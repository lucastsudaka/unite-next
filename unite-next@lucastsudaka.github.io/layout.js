import GObject from 'gi://GObject'
import St from 'gi://St'
import Clutter from 'gi://Clutter'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { Styles } from './styles.js'
import { createLayoutFeatures, createLayoutManager } from './layout-features.js'

const featureTypes = createLayoutFeatures({
  St, Clutter, Main, Styles, global, warn: message => console.warn(message)
})

export const LayoutManager = createLayoutManager({ GObject, featureTypes })
