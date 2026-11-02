// GNOME 50/51 scripting installs its startup-complete listener after init().
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { assertStartupPending } from './startup-guard.js'

export function init() {
  assertStartupPending(Main.layoutManager)
}
