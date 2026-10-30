import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'
import GLib from 'gi://GLib'
import St from 'gi://St'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'

function assert(value, message) { if (!value) throw new Error(message) }

// This fixture is installed only into the disposable acceptance environment.
export default class UpstreamConflictFixture extends Extension {
  enable() {
    assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private conflict fixture state required')
    const uuid = GLib.getenv('UNITE_CONFLICT_FORK_UUID')
    const fork = Main.extensionManager.lookup(uuid)
    const owner = fork?.stateObj
    assert(owner, 'The fork must be loaded before the upstream fixture activates')

    const styles = St.ThemeContext.get_for_stage(global.stage).get_theme().get_custom_stylesheets()
    const entry = {
      forkState: fork.state,
      contextReleased: owner.context === null,
      managersReleased: owner.windowManager === null && owner.panelManager === null && owner.layoutManager === null,
      observerReleased: owner.conflictSignals === null,
      stylesReleased: owner.styles === null && !styles.some(file => file.has_prefix(fork.dir))
    }
    this.entries ??= []
    this.entries.push(entry)
    this.enableCount = (this.enableCount || 0) + 1
    print(`UNITE_UPSTREAM_FIXTURE_ENTRY ${JSON.stringify(entry)}`)
    assert(entry.contextReleased && entry.managersReleased && entry.observerReleased && entry.stylesReleased,
      'The fork retained effects when native upstream enable began')
  }

  disable() {
    this.disableCount = (this.disableCount || 0) + 1
  }
}
