// REQ-FORK-CONFLICT-001/OWN-001: real native-manager activation and recovery.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import St from 'gi://St'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js'

const UPSTREAM_UUID = 'unite@hardpixel.eu'
const CONFLICT = `Unite Next cannot run while ${UPSTREAM_UUID} is active or activating`
const CLEANUP_FAILURE = 'Injected native fork conflict cleanup failure'
function assert(value, message) { if (!value) throw new Error(message) }
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

async function until(predicate, description) {
  const deadline = GLib.get_monotonic_time() + 5000000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Conflict fixture timeout: ${description}`)
    await Scripting.sleep(16)
  }
}

function directory(file) {
  if (!file.query_exists(null)) file.make_directory_with_parents(null)
  assert(file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY,
    `Expected a private directory: ${file.get_path()}`)
}

function visit(file, callback, relative = '') {
  const children = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
  try {
    let info
    while ((info = children.next_file(null))) {
      const child = file.get_child(info.get_name())
      const name = `${relative}${info.get_name()}`
      if (info.get_file_type() === Gio.FileType.DIRECTORY) visit(child, callback, `${name}/`)
      else {
        assert(info.get_file_type() === Gio.FileType.REGULAR, `Unexpected private theme resource: ${name}`)
        callback(child, name)
      }
    }
  } finally {
    children.close(null)
  }
}

function themeSnapshot(file) {
  const files = {}
  visit(file, (child, name) => { files[name] = [...child.load_contents(null)[1]] })
  return JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
}

function ownedStyles(owner) {
  return St.ThemeContext.get_for_stage(global.stage).get_theme().get_custom_stylesheets()
    .filter(file => file.has_prefix(owner.dir))
}

function resources(owner) {
  const features = owner.panelManager.features.features
  const actors = new Set(features.flatMap(feature =>
    [feature.button, feature.controls, feature.label, feature.indicators].filter(Boolean)))
  const slots = Object.entries(Main.panel.statusArea).filter(([, actor]) => actors.has(actor))
  assert(slots.length > 0 && ownedStyles(owner).length > 0, 'The conflict fixture did not acquire real panel/style effects')
  return { windows: owner.windowManager, observer: owner.conflictSignals, styles: owner.styles,
    actions: features.flatMap(feature => feature.actions || []), slots }
}

function released(owner, previous) {
  assert(owner.context === null && owner.windowManager === null && owner.panelManager === null &&
    owner.layoutManager === null && owner.conflictSignals === null && owner.styles === null,
  'Conflict teardown retained an activation owner')
  assert(previous.observer.signals.size === 0 && previous.styles.styles.size === 0 &&
    previous.windows.windows.size === 0 && previous.windows.signals.signals.size === 0 &&
    previous.windows.timeouts.store.size === 0, 'Conflict teardown retained handlers, styles or windows')
  assert(previous.slots.every(([name, actor]) => Main.panel.statusArea[name] !== actor) &&
    previous.actions.every(action => action.get_actor() === null) && ownedStyles(owner).length === 0,
  'Conflict teardown retained native panel actors, actions or stylesheets')
}

export async function run() {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private conflict session required')
  const uuid = GLib.getenv('UNITE_CONFLICT_FORK_UUID')
  assert(uuid && uuid !== UPSTREAM_UUID, 'Independent fork UUID required')
  const manager = Main.extensionManager
  const fork = () => manager.lookup(uuid)
  const upstream = () => manager.lookup(UPSTREAM_UUID)
  await until(() => fork()?.state === ExtensionState.ACTIVE || fork()?.error, 'initial fork activation')
  assert(fork().state === ExtensionState.ACTIVE && fork().stateObj.context, `Initial fork failed: ${fork()?.error}`)
  let owner = fork().stateObj
  const scenarios = []
  const record = name => { scenarios.push(name); print(`UNITE_CONFLICT_SCENARIO ${name}`) }
  const deactivate = async id => {
    assert(manager.disableExtension(id), `Native deactivation rejected ${id}`)
    await until(() => manager.lookup(id)?.state === ExtensionState.INACTIVE, `native inactive ${id}`)
  }
  const activateFork = async () => {
    assert(manager.enableExtension(uuid), 'Native fork activation was rejected')
    await until(() => fork()?.state === ExtensionState.ACTIVE || fork()?.error, 'native fork activation')
    assert(fork().state === ExtensionState.ACTIVE && fork().stateObj.context, `Fork activation failed: ${fork().error}`)
    owner = fork().stateObj
  }
  const expectedError = async (phase, message, action) => {
    print(`UNITE_CONFLICT_EXPECT_ERROR ${JSON.stringify({ phase, uuid, message })}`)
    action()
    await until(() => fork()?.state === ExtensionState.ERROR, `${phase} native ERROR`)
    assert(fork().error.includes(message) && fork().errors.at(-1).includes(message),
      `${phase} did not expose its original native error`)
    print(`UNITE_CONFLICT_OBSERVED_ERROR ${JSON.stringify({ phase, uuid, error: fork().error })}`)
  }

  const first = resources(owner)
  await deactivate(uuid)
  released(owner, first)
  const home = Gio.File.new_for_path(GLib.get_home_dir())
  const data = Gio.File.new_for_path(GLib.get_user_data_dir())
  const config = Gio.File.new_for_path(GLib.get_user_config_dir())
  assert(data.has_prefix(home) && config.has_prefix(home), 'Conflict fixture requires private user directories')
  const theme = data.resolve_relative_path('unite-shell/themes/upstream-conflict-only')
  directory(theme)
  visit(owner.dir.resolve_relative_path('themes/default'), (source, name) => {
    const target = theme.resolve_relative_path(name)
    directory(target.get_parent())
    source.copy(target, Gio.FileCopyFlags.NONE, null, null)
  })
  const originalTheme = themeSnapshot(theme)
  const foreign = '/* UNITE upstream fixture */\nlabel { color: rgb(17, 34, 51); }\n/* upstream fixture UNITE */\n/* Foreign café */\n'
  const gtkFiles = [3, 4].map(version => config.resolve_relative_path(`gtk-${version}.0/gtk.css`))
  for (const file of gtkFiles) {
    directory(file.get_parent())
    file.replace_contents(foreign, null, false, Gio.FileCreateFlags.PRIVATE, null)
  }
  assert(manager.enableExtension(UPSTREAM_UUID), 'Upstream fixture activation was rejected')
  await until(() => upstream()?.state === ExtensionState.ACTIVE, 'upstream fixture active')
  const upstreamOwner = upstream().stateObj
  const upstreamSettings = upstreamOwner.getSettings()
  upstreamSettings.set_string('desktop-name-text', 'Preserved upstream café')
  upstreamSettings.set_string('window-buttons-theme', 'upstream-conflict-only')
  const preserved = () => {
    assert(upstreamSettings.get_string('desktop-name-text') === 'Preserved upstream café' &&
      upstreamSettings.get_string('window-buttons-theme') === 'upstream-conflict-only', 'Fork changed upstream settings')
    assert(themeSnapshot(theme) === originalTheme, 'Fork changed upstream user themes')
    assert(gtkFiles.every(file => decode(file.load_contents(null)[1]) === foreign), 'Fork cleanup changed foreign GTK bytes')
  }

  await expectedError('startup', CONFLICT, () => manager.enableExtension(uuid))
  released(owner, first)
  preserved()
  record('active upstream rejects native fork startup without acquiring effects or changing upstream data')
  await deactivate(UPSTREAM_UUID)
  await manager.reloadExtension(fork()) // Failed startup never entered the native active order.
  await until(() => fork()?.state === ExtensionState.ACTIVE, 'recovery from rejected startup')
  owner = fork().stateObj
  owner.getSettings().set_string('desktop-name-text', 'Independent fork value')
  assert(upstreamSettings.get_string('desktop-name-text') === 'Preserved upstream café', 'The settings paths are shared')
  const { WindowControlsThemes } = await import(owner.dir.get_child('theme.js').get_uri())
  assert(!new WindowControlsThemes().available.some(item => item.uuid === 'upstream-conflict-only'),
    'Fork discovers the upstream user-theme namespace')
  record('native reload recovers rejected startup with independent settings and theme discovery')

  await Scripting.createTestWindow({ maximized: true })
  await Scripting.waitTestWindows()
  await until(() => owner.windowManager.windows.size > 0, 'real window acquired')
  const normal = resources(owner)
  assert(manager.enableExtension(UPSTREAM_UUID), 'Late upstream activation was rejected')
  await until(() => upstream().state === ExtensionState.ACTIVE && fork().state === ExtensionState.INACTIVE,
    'normal native conflict handoff')
  released(owner, normal)
  preserved()
  assert(global.settings.get_strv('enabled-extensions').includes(UPSTREAM_UUID) &&
    !global.settings.get_strv('disabled-extensions').includes(UPSTREAM_UUID), 'Fork removed upstream enabled membership')
  const nativeCounts = { enables: upstreamOwner.enableCount, disables: upstreamOwner.disableCount || 0 }
  record('late upstream ACTIVATING releases real fork effects before upstream enable and reaches native INACTIVE')
  await deactivate(UPSTREAM_UUID)
  for (let cycle = 0; cycle < 3; cycle++) {
    await activateFork()
    const previous = resources(owner)
    await deactivate(uuid)
    released(owner, previous)
    preserved()
  }
  record('three ordinary native cycles recover after disabling upstream without private-order mutation')

  await activateFork()
  const failing = resources(owner)
  const panel = owner.panelManager
  const destroy = panel.destroy
  const original = new Error(CLEANUP_FAILURE)
  panel.destroy = function () { destroy.call(this); throw original }
  await expectedError('cleanup', CLEANUP_FAILURE, () => manager.enableExtension(UPSTREAM_UUID))
  await until(() => upstream().state === ExtensionState.ACTIVE, 'upstream after cleanup failure')
  released(owner, failing)
  preserved()
  assert(owner.pendingDisableError === null, 'Native deactivation did not consume the original cleanup error')
  await deactivate(UPSTREAM_UUID)
  await manager.reloadExtension(fork())
  await activateFork()
  const recovered = resources(owner)
  await deactivate(uuid)
  released(owner, recovered)
  preserved()
  record('actual cleanup error remains visible through native bookkeeping and later native reload recovers')
  await Scripting.destroyTestWindows()
  assert(upstreamOwner.entries.every(entry => entry.contextReleased && entry.managersReleased &&
    entry.observerReleased && entry.stylesReleased), 'Native upstream entry overlapped fork effects')
  print(`UNITE_CONFLICT_PASS ${JSON.stringify({ scenarios, nativeCounts, upstreamEntries: upstreamOwner.entries })}`)
}
