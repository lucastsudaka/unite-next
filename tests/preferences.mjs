import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import { adaptSettings, getPreferences, getInterface } from '../unite-next@lucastsudaka.github.io/convenience.js'
import { bindChoice, enumChoices } from '../unite-next@lucastsudaka.github.io/preferences-bindings.js'
import { WindowControlsTheme, WindowControlsThemes } from '../unite-next@lucastsudaka.github.io/theme.js'
import { loadModule } from './load-module.js'

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') {
  throw new Error('Run this test with GSETTINGS_BACKEND=memory; real settings are never test fixtures')
}

let assertions = 0
function equal(actual, expected, message) {
  assertions++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`)
  }
}
function check(condition, message) {
  equal(Boolean(condition), true, message)
}
function throws(callback, message) {
  let failed = false
  try { callback() } catch { failed = true }
  check(failed, message)
}
function write(path, contents) {
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700)
  GLib.file_set_contents(path, contents)
}
function removeTree(path) {
  const file = Gio.File.new_for_path(path)
  if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
    const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)
    try {
      for (let info = children.next_file(null); info; info = children.next_file(null)) {
        removeTree(GLib.build_filenamev([path, info.get_name()]))
      }
    } finally {
      children.close(null)
    }
  }
  file.delete(null)
}

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path()
const temp = GLib.dir_make_tmp('unite-preferences-XXXXXX')
const schemaDir = GLib.build_filenamev([temp, 'schemas'])
const schemaId = 'org.gnome.shell.extensions.unite-next'
const baseline = {
  'extend-left-box': ['b', true], 'show-legacy-tray': ['b', true],
  'greyscale-tray-icons': ['b', false], 'autofocus-windows': ['b', true],
  'show-appmenu-button': ['b', true], 'use-activities-text': ['b', true],
  'show-desktop-name': ['b', true], 'desktop-name-text': ['s', 'GNOME Desktop'],
  'enable-titlebar-actions': ['b', true], 'restrict-to-primary-screen': ['b', true],
  'hide-app-menu-icon': ['b', true], 'app-menu-max-width': ['i', 0],
  'app-menu-ellipsize-mode': ['s', 'end'], 'reduce-panel-spacing': ['b', true],
  'window-buttons-placement': ['s', 'auto'], 'show-window-title': ['s', 'maximized'],
  'show-window-buttons': ['s', 'maximized'], 'window-buttons-theme': ['s', 'default'],
  'hide-window-titlebars': ['s', 'maximized'], 'notifications-position': ['s', 'right'],
  'hide-activities-button': ['s', 'auto'], 'icon-scale-workaround': ['b', false]
}
const choiceValues = {
  'show-window-title': ['never', 'tiled', 'maximized', 'both', 'always'],
  'show-window-buttons': ['never', 'tiled', 'maximized', 'both', 'always'],
  'hide-window-titlebars': ['never', 'tiled', 'maximized', 'both', 'always'],
  'notifications-position': ['center', 'left', 'right'],
  'hide-activities-button': ['never', 'auto', 'always'],
  'window-buttons-placement': ['auto', 'left', 'right', 'first', 'last'],
  'app-menu-ellipsize-mode': ['start', 'middle', 'end']
}
const Row = GObject.registerClass({
  Properties: {
    selected: GObject.ParamSpec.uint('selected', 'selected', 'selected', GObject.ParamFlags.READWRITE, 0, 0xffffffff, 0),
    active: GObject.ParamSpec.boolean('active', 'active', 'active', GObject.ParamFlags.READWRITE, false),
    text: GObject.ParamSpec.string('text', 'text', 'text', GObject.ParamFlags.READWRITE, ''),
    value: GObject.ParamSpec.double('value', 'value', 'value', GObject.ParamFlags.READWRITE, -2147483648, 2147483647, 0),
    sensitive: GObject.ParamSpec.boolean('sensitive', 'sensitive', 'sensitive', GObject.ParamFlags.READWRITE, true)
  },
  Signals: { destroy: {} }
}, class ChoiceTestRow extends GObject.Object {})

try {
  GLib.mkdir_with_parents(schemaDir, 0o700)
  Gio.File.new_for_path(`${root}/unite-next@lucastsudaka.github.io/schemas/${schemaId}.gschema.xml`)
    .copy(Gio.File.new_for_path(`${schemaDir}/${schemaId}.gschema.xml`), Gio.FileCopyFlags.NONE, null, null)
  const [, , stderr, status] = GLib.spawn_sync(
    null, ['glib-compile-schemas', '--strict', schemaDir], null, GLib.SpawnFlags.SEARCH_PATH, null
  )
  equal(status, 0, `Temporary schema compilation: ${new TextDecoder().decode(stderr)}`)
  const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(), false)
  const schema = source.lookup(schemaId, true)
  const backend = Gio.memory_settings_backend_new()
  const settings = Gio.Settings.new_full(schema, backend, null)
  const writer = Gio.Settings.new_full(schema, backend, null)
  const adapter = adaptSettings(settings)
  const actualChoices = enumChoices(label => label)
  equal(Object.keys(actualChoices).sort(), Object.keys(choiceValues).sort(), 'Every actual enum row is covered')
  const expectedLabels = { never: 'Never', tiled: 'Tiled', maximized: 'Maximized', both: 'Both', always: 'Always', auto: 'Auto', center: 'Center', left: 'Left', right: 'Right', first: 'First', last: 'Last', start: 'Start', middle: 'Middle', end: 'End' }
  for (const [key, nicks] of Object.entries(choiceValues)) {
    equal(actualChoices[key], nicks.map(nick => [nick, expectedLabels[nick]]), `Actual stable IDs and labels ${key}`)
  }

  const { UniteNextPreferencesWidget } = loadModule(`${root}/unite-next@lucastsudaka.github.io/prefs.js`, {
    ExtensionPreferences: class {}
  }, ['UniteNextPreferencesWidget'])
  const autoTheme = new WindowControlsTheme('auto', `${root}/unite-next@lucastsudaka.github.io/themes/default`)
  equal(autoTheme.valid, true, 'Asset-valid themes may carry the reserved auto UUID')
  let themeEntries = null
  UniteNextPreferencesWidget.prototype._bindThemes.call({
    _gettext: label => label,
    _themes: { available: [
      { uuid: 'custom-theme', name: 'Custom Theme' },
      { uuid: 'default', name: 'User Default' },
      autoTheme,
      { uuid: 'auto-other', name: 'Other Auto' }
    ] },
    _bindChoices(key, entries, unknownLabel) {
      equal(key, 'window-buttons-theme', 'Actual theme model binds the schema theme key')
      equal(unknownLabel, 'Unavailable theme', 'Actual theme model retains unavailable selection handling')
      themeEntries = entries
    }
  })
  equal(themeEntries, [
    ['auto', 'Auto'], ['default', 'Default'],
    ['auto-other', 'Other Auto'], ['custom-theme', 'Custom Theme']
  ], 'Reserved theme sentinels occur once and ordinary user IDs retain their labels')
  const modelRow = new Row()
  const disposeModel = bindChoice(settings, 'window-buttons-theme', modelRow, themeEntries.map(([value]) => value))
  equal(settings.get_user_value('window-buttons-theme'), null, 'Theme model construction preserves unset persisted state')
  equal(modelRow.selected, 1, 'Theme model selects the existing default sentinel')
  writer.set_string('window-buttons-theme', 'auto')
  equal(modelRow.selected, 0, 'Persisted auto keeps automatic-selection semantics')
  equal(settings.get_string('window-buttons-theme'), 'auto', 'Reserved user theme does not rewrite persisted auto')
  disposeModel()
  writer.reset('window-buttons-theme')

  equal(schema.list_keys().sort(), Object.keys(baseline).sort(), 'REQ-FEATURE-001: baseline key inventory')
  for (const [key, [type, value]] of Object.entries(baseline)) {
    equal(schema.get_key(key).get_value_type().dup_string(), type, `Baseline type ${key}`)
    equal(adapter.getSetting(key), value, `Baseline value ${key}`)
    check(adapter.exists(key), `Schema-driven existence ${key}`)
  }
  equal(adapter.exists('absent-key'), false, 'Unknown adapter key')
  equal(adapter.getSetting('absent-key'), undefined, 'Unknown adapter read')
  equal(adapter.setSetting('absent-key', 1), false, 'Unknown adapter write')
  for (const [key, value] of [['app-menu-max-width', 117], ['desktop-name-text', 'Custom'], ['extend-left-box', false]]) {
    equal(adapter.setSetting(key, value), true, `Adapter setter ${key}`)
    equal(settings.get_value(key).deepUnpack(), value, `Adapter native persistence ${key}`)
    settings.reset(key)
  }
  throws(() => adapter.setSetting('show-window-buttons', 'invalid'), 'Reject out-of-range enum')
  let notifications = 0
  const adapterSignal = adapter.connect('changed::desktop-name-text', () => notifications++)
  writer.set_string('desktop-name-text', 'Changed')
  equal(notifications, 1, 'Adapter signal forwarding')
  adapter.disconnect(adapterSignal)
  writer.reset('desktop-name-text')
  equal(notifications, 1, 'Adapter disconnect')

  for (const [key, [type, value]] of Object.entries(baseline)) {
    if (key in choiceValues || key === 'window-buttons-theme') continue
    const property = { b: 'active', s: 'text', i: 'value' }[type]
    const row = new Row()
    settings.bind(key, row, property, Gio.SettingsBindFlags.DEFAULT)
    equal(row[property], value, `Native initial property ${key}`)
    equal(settings.get_user_value(key), null, `Native binding does not write initially ${key}`)
    const fromRow = type === 'b' ? !value : type === 's' ? 'Native binding sample' : 137
    row[property] = fromRow
    equal(settings.get_value(key).deepUnpack(), fromRow, `Native control write ${key}`)
    writer.set_value(key, new GLib.Variant(type, value))
    equal(row[property], value, `Native external update ${key}`)
    writer.reset(key)
    equal(row[property], value, `Native external reset ${key}`)
    Gio.Settings.unbind(row, property)
    Gio.Settings.unbind(row, 'sensitive')
  }

  for (const [key, nicks] of Object.entries(choiceValues)) {
    const row = new Row()
    const dispose = bindChoice(settings, key, row, [...nicks])
    equal(settings.get_user_value(key), null, `Initial binding does not write ${key}`)
    equal(row.selected, nicks.indexOf(baseline[key][1]), `Initial enum selection ${key}`)
    for (const [index, nick] of nicks.entries()) {
      row.selected = index
      equal(settings.get_string(key), nick, `Row-to-settings ${key}/${nick}`)
      equal(settings.get_enum(key), index, `Preserved enum numeric value ${key}/${nick}`)
    }
    writer.set_string(key, nicks[0])
    equal(row.selected, 0, `External writer ${key}`)
    writer.reset(key)
    equal(row.selected, nicks.indexOf(baseline[key][1]), `External reset ${key}`)
    dispose()
    dispose()
    row.selected = 0
    equal(settings.get_string(key), baseline[key][1], `Disposed row does not write ${key}`)
    row.selected = 100
    writer.set_string(key, nicks[0])
    equal(row.selected, 100, `Disposed row receives no settings update ${key}`)
    writer.reset(key)
  }

  const locked = Gio.Settings.new_full(schema, Gio.null_settings_backend_new(), null)
  const lockedRow = new Row()
  const disposeLocked = bindChoice(locked, 'show-window-buttons', lockedRow, [...choiceValues['show-window-buttons']])
  equal(lockedRow.sensitive, false, 'Null backend makes control insensitive')
  lockedRow.selected = 0
  equal(lockedRow.selected, 2, 'Locked selection is restored')
  equal(locked.get_string('show-window-buttons'), 'maximized', 'Locked backend remains unchanged')
  disposeLocked()

  const writableRow = new Row()
  const disposeWritable = bindChoice(settings, 'show-window-buttons', writableRow, [...choiceValues['show-window-buttons']])
  const nativeWritable = settings.is_writable.bind(settings)
  settings.is_writable = () => false
  settings.emit('writable-changed::show-window-buttons', 'show-window-buttons')
  equal(writableRow.sensitive, false, 'Writability signal disables control')
  writableRow.selected = 0
  equal(settings.get_string('show-window-buttons'), 'maximized', 'Writability change prevents writes')
  settings.is_writable = nativeWritable
  settings.emit('writable-changed::show-window-buttons', 'show-window-buttons')
  equal(writableRow.sensitive, true, 'Writability signal enables control')
  writableRow.emit('destroy')
  writer.set_string('show-window-buttons', 'always')
  equal(writableRow.selected, 2, 'Destroyed row receives no updates')
  disposeWritable()
  writer.reset('show-window-buttons')

  const themeValues = ['auto', 'default']
  const unavailable = []
  writer.set_string('window-buttons-theme', 'missing-personal-theme')
  const themeRow = new Row()
  const disposeTheme = bindChoice(settings, 'window-buttons-theme', themeRow, themeValues, value => {
    unavailable.push(value)
    themeValues.push(value)
    return themeValues.length - 1
  })
  equal(unavailable, ['missing-personal-theme'], 'Unavailable ID is presented explicitly')
  equal(themeRow.selected, 2, 'Unavailable ID remains selected')
  equal(settings.get_string('window-buttons-theme'), 'missing-personal-theme', 'Unavailable binding preserves stored ID')
  writer.set_string('window-buttons-theme', 'another-missing-theme')
  equal(themeRow.selected, 3, 'External unavailable selection is represented')
  disposeTheme()

  const wm = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' })
  const preferences = getPreferences()
  wm.set_string('button-layout', ':')
  equal(preferences.getSetting('window-buttons-layout'), [], 'Empty native layout')
  equal(preferences.getSetting('window-buttons-position'), 'right', 'Empty native layout side')
  wm.set_string('button-layout', 'close,minimize:maximize')
  equal(preferences.getSetting('window-buttons-layout'), ['close', 'minimize', 'maximize'], 'Native ordered layout')
  equal(preferences.getSetting('window-buttons-position'), 'left', 'Native left placement')
  equal(preferences.setSetting('button-layout', ':'), false, 'Preferences adapter cannot mutate system settings')
  equal(getInterface().setSetting('gtk-theme', 'Invalid'), false, 'Interface adapter cannot mutate system settings')

  const bundled = `${root}/unite-next@lucastsudaka.github.io/themes`
  const warnings = []
  const themes = new WindowControlsThemes({ directories: [bundled], warn: message => warnings.push(message) })
  equal(themes.available.length, 26, 'All 26 shipped themes load')
  equal(warnings, [], 'Shipped themes require no fallback diagnostic')
  const special = {
    nordic: {
      'close-hover': 'close-prelight.svg', 'close-active': 'close-prelight.svg',
      minimize: 'min.svg', 'minimize-hover': 'min-prelight.svg', 'minimize-active': 'min-prelight.svg',
      'maximize-hover': 'maximize-prelight.svg', 'maximize-active': 'maximize-prelight.svg'
    },
    windwood: { 'close-active': 'close-hover.svg', 'minimize-active': 'minimize-hover.svg', 'maximize-active': 'maximize-hover.svg' }
  }
  for (const theme of themes.available) {
    for (const dark of [true, false]) {
      const icons = theme.getActionIcons(dark)
      for (const action of ['close', 'minimize', 'maximize']) {
        for (const state of ['default', 'hover', 'active']) {
          const key = state === 'default' ? action : `${action}-${state}`
          const file = icons[action][state].get_file()
          equal(file.get_basename(), special[theme.uuid]?.[key] || `${key}.svg`, `Intended ${theme.uuid}/${dark}/${key}`)
          check(file.query_exists(null), `Existing ${theme.uuid}/${dark}/${key}`)
        }
      }
      check(icons === theme.getActionIcons(dark), 'Same variant reuses its cache')
    }
  }
  const darkIcons = themes.default.getActionIcons(true)
  const lightIcons = themes.default.getActionIcons(false)
  check(darkIcons !== lightIcons, 'Variant caches are distinct')
  check(darkIcons.close.default.get_file().get_path().endsWith('/dark/close.svg'), 'Dark variant path')
  check(lightIcons.close.default.get_file().get_path().endsWith('/light/close.svg'), 'Light variant path')
  check(themes.default.getActionIcons(true) === darkIcons, 'Repeated dark-light-dark transition')
  check(themes.locate('another-missing-theme', 'Adwaita') === themes.default, 'Bounded default substitution')
  equal(warnings.length, 1, 'Unavailable theme substitution reports a diagnostic')
  check(warnings[0].includes('another-missing-theme'), 'Diagnostic identifies selected ID')
  equal(settings.get_string('window-buttons-theme'), 'another-missing-theme', 'Runtime fallback preserves selected ID')
  themes.locate('another-missing-theme', 'Adwaita')
  equal(warnings.length, 1, 'Unchanged missing selection does not flood diagnostics')

  const invalid = `${temp}/user-themes/broken`
  write(`${invalid}/unite.theme`, '[Theme]\nName=Broken\n[Dark]\nStyle=missing.css\n[Light]\nStyle=missing.css\n')
  const invalidTheme = new WindowControlsTheme('broken', invalid)
  equal(invalidTheme.valid, false, 'Missing assets invalidate a theme')
  check(invalidTheme.error.includes('Missing stylesheet'), 'Missing asset error remains observable')
  throws(() => invalidTheme.getActionIcons(), 'Invalid icon lookup fails visibly')
  throws(() => new WindowControlsThemes({ directories: [] }), 'Missing bundled default fails visibly')
  const userWarnings = []
  const withUser = new WindowControlsThemes({ directories: [bundled, `${temp}/user-themes`], warn: message => userWarnings.push(message) })
  check(userWarnings.some(message => message.includes('broken')), 'Invalid user theme reports its error')
  check(withUser.locate('broken', 'Adwaita') === withUser.default, 'Invalid selected user theme has bounded fallback')
  check(userWarnings.some(message => message.includes('using bundled default')), 'Invalid selected theme fallback is observable')

  print(`Preference/settings/theme scenarios passed (${assertions} independent assertions)`)
} finally {
  removeTree(temp)
}
