// REQ-FORK-OWN-001 / REQ-LIFE-001: native CSS parsing and private ownership.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import St from 'gi://St'
import { scopeStylesheet, ScopedStylesheet, ScopedStylesheetStore, StylesheetPreparation } from '../unite-next@lucastsudaka.github.io/scoped-styles.js'
import { assert, throws } from './assert.js'
import { Styles } from '../unite-next@lucastsudaka.github.io/styles.js'
import { ScopedShellStyle } from '../unite-next@lucastsudaka.github.io/shell-styles.js'

assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Scoped CSS tests require private state')
const scope = 'unite-next-window-controls'
const source = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
const base = Gio.File.new_for_path(`${GLib.get_home_dir()}/theme files`)
base.make_directory_with_parents(null)
const style = base.get_child('stylesheet.css')
const read = file => new TextDecoder().decode(file.load_contents(null)[1])
const write = (file, content) => file.replace_contents(content, null, false, Gio.FileCreateFlags.PRIVATE, null)
let passed = 0
function test(name, callback) { callback(); passed++; print(`PASS ${name}`) }
const transform = text => scopeStylesheet(text, scope, style, () => { throw new Error('Unexpected import') })

test('every selector target is scoped while ancestors, UUIDs and combinators remain unchanged', () => {
  const actual = transform('#panel .window-controls.selected > .close:hover, .window-controls.selected { width: 17px; }')
  assert(actual === '#panel .window-controls.selected > .close:hover.unite-next-window-controls, .window-controls.selected.unite-next-window-controls { width: 17px; }', actual)
})
test('quoted and escaped delimiters do not split selectors or declaration blocks', () => {
  const actual = transform('/* ,{} */ [name="a,b}="]:hover, .clo\\73 e /* tail */ { content: ";}url(fake)"; /* } */ width: 17px; }')
  assert(actual.includes('[name="a,b}="]:hover.unite-next-window-controls,'), actual)
  assert(actual.includes('.clo\\73 e.unite-next-window-controls /* tail */'), actual)
  assert(actual.includes('content: ";}url(fake)"; /* } */'), 'Quoted/comment content changed')
})
test('pseudo-elements retain terminal position and escaped combinators stay in their identifier', () => {
  const actual = transform('.close::before  , .clo\\+se:hover { width: 17px; }')
  assert(actual === '.close.unite-next-window-controls::before  , .clo\\+se:hover.unite-next-window-controls { width: 17px; }', actual)
})
test('relative URLs use each original stylesheet base, including escaped strings and URL identifiers', () => {
  const actual = transform('.close { background-image: u\\72l("icons/close\\20 hover.svg"); content: "url(unchanged)"; }')
  const expected = base.resolve_relative_path('icons/close hover.svg').get_uri()
  assert(actual.includes(`url("${expected}")`), actual)
  assert(actual.includes('content: "url(unchanged)"'), actual)
})
test('structural malformed and unsupported syntax never produces partial unscoped output', () => {
  for (const text of ['.close { width: 17px;', '.close, { width: 17px; }', '.close > { width: 17px; }',
    '> .close {}', '.close + > .icon {}', '.close { color red; }', '.close { color: ; }',
    '.close { content: "unfinished; }', '/* unfinished', '.close { width: calc(2px; }', '.clo\\\nse {}',
    '.close { background: url(unclosed; }', '@media screen { .foreign { width: 3px; } }',
    '.close..bad { width: 17px; } .close { height: 8px; }', '[class=] { width: 17px; }',
    '.close!!! { width: 17px; }', '.close: { width: 17px; }', '.close { 123: 4px; }', '@charset nope;']) {
    throws(() => transform(text), `Malformed stylesheet was accepted: ${text}`)
  }
})
test('real import closure is privately scoped without modifying sources or their URL bases', () => {
  const directory = base.get_child('nested')
  directory.make_directory(null)
  const child = directory.get_child('imported.css')
  const original = '.close .icon { background-image: url("close.svg"); width: 19px; }'
  write(child, original)
  const root = '@import "nested/imported.css" screen;\n#panel .selected .close:hover { width: 22px; }'
  write(style, root)
  const owner = new ScopedStylesheet(style.get_path(), scope)
  const theme = new St.Theme()
  owner.load(theme, prepare(Gio.File.new_for_path(owner.path)))
  const directoryPath = owner.store.directory.get_path()
  const files = [...owner.store.files.values()]
  try {
    assert(files.length === 2, 'Import closure must contain exactly two native files')
    assert(theme.get_custom_stylesheets().length === 1, 'Only the root may be custom-loaded')
    assert(read(owner.file).includes(' screen;'), 'Native import media suffix changed')
    const contents = files.map(read).join('\n')
    assert(contents.includes('.icon.unite-next-window-controls'), 'Imported selector escaped confinement')
    assert(contents.includes(child.get_parent().get_child('close.svg').get_uri()), 'Imported URL used the wrong original base')
    assert(read(style) === root && read(child) === original, 'User sources changed')
    for (const file of files) {
      const mode = file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode')
      assert((mode & 0o777) === 0o600, 'Generated CSS is not private')
    }
  } finally { owner.unload(theme) }
  assert(theme.get_custom_stylesheets().length === 0, 'Root remained loaded')
  assert(!Gio.File.new_for_path(directoryPath).query_exists(null), 'Private stage directory survived unload')
})
test('import suffixes preserve native media lists and reject recovered malformed lists', () => {
  const root = base.get_child('media.css')
  for (const suffix of ['??', 'screen and (width: 3px)', 'screen,', ',print']) {
    write(root, `@import "nested/imported.css" ${suffix}; .close { width: 5px; }`)
    const owner = new ScopedStylesheet(root.get_path(), scope)
    const theme = new St.Theme()
    throws(() => owner.load(theme, prepare(Gio.File.new_for_path(owner.path))), `Malformed media suffix was accepted: ${suffix}`)
    assert(theme.get_custom_stylesheets().length === 0 && owner.store.directory === null,
      'Malformed import retained staging or native ownership')
  }
  write(root, '@import "nested/imported.css" screen /* comma */ , print;')
  const owner = new ScopedStylesheet(root.get_path(), scope)
  const theme = new St.Theme()
  try {
    owner.load(theme, prepare(Gio.File.new_for_path(owner.path)))
    assert(read(owner.file).includes('screen /* comma */ , print;'), 'Valid native media list changed')
  } finally { owner.unload(theme) }
})
test('unchanged selections reuse generated import paths across a feature activation', () => {
  const theme = new St.Theme()
  const store = new ScopedStylesheetStore()
  const first = new ScopedStylesheet(style.get_path(), scope, store)
  first.load(theme, prepare(Gio.File.new_for_path(first.path)))
  const paths = [...store.files.values()].map(file => file.get_path())
  first.unload(theme)
  const second = new ScopedStylesheet(style.get_path(), scope, store)
  second.load(theme, prepare(Gio.File.new_for_path(second.path)))
  try {
    assert(JSON.stringify([...store.files.values()].map(file => file.get_path())) === JSON.stringify(paths),
      'Unchanged import closure created new native cache paths')
  } finally { second.unload(theme); store.clear() }
  assert(store.directory === null && store.files.size === 0, 'Activation store retained resources')
})
test('source aliases retain their own relative asset bases and distinct sheet identities', () => {
  const shared = base.get_child('shared.css')
  write(shared, '.icon { background-image: url("local.svg"); }')
  for (const name of ['one', 'two']) {
    const directory = base.get_child(name)
    directory.make_directory(null)
    directory.get_child('alias.css').make_symbolic_link(shared.get_path(), null)
  }
  const root = base.get_child('aliases.css')
  write(root, '@import "one/alias.css"; @import "two/alias.css";')
  const store = new ScopedStylesheetStore()
  try {
    store.compile(root.get_path(), scope, prepare(root))
    const contents = [...store.files.values()].map(read).join('\n')
    assert(store.files.size === 3, 'Distinct source aliases were merged')
    for (const name of ['one', 'two'])
      assert(contents.includes(base.get_child(name).get_child('local.svg').get_uri()), 'Alias lost its original URL base')
  } finally { store.clear() }
})
test('changed content at the same source receives a fresh native cache identity', () => {
  const changing = base.get_child('changing.css')
  const store = new ScopedStylesheetStore()
  try {
    write(changing, '.close { width: 17px; }')
    const first = store.compile(changing.get_path(), scope, prepare(changing))
    write(changing, '.close { width: 31px; }')
    const second = store.compile(changing.get_path(), scope, prepare(changing))
    assert(!first.equal(second), 'Changed content reused stale native CSS identity')
    assert(read(first).includes('width: 17px') && read(second).includes('width: 31px'), 'Staged snapshots were overwritten')
    assert(store.compile(changing.get_path(), scope, prepare(changing)).equal(second), 'Unchanged content did not reuse its native cache identity')
  } finally { store.clear() }
})
test('finite nested hardlink imports with distinct real parents remain valid', () => {
  const first = base.get_child('finite.css')
  write(first, '@import "next/finite.css"; .close { width: 19px; }')
  const next = base.get_child('next')
  next.make_directory(null)
  // A real native hardlink shares the file identity, while its URL base differs.
  const link = Gio.Subprocess.new(['/usr/bin/ln', '--', first.get_path(), next.get_child('finite.css').get_path()],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
  link.wait_check(null)
  const final = next.get_child('next')
  final.make_directory(null)
  write(final.get_child('finite.css'), '.close { height: 11px; }')
  const store = new ScopedStylesheetStore()
  try {
    store.compile(first.get_path(), scope, prepare(first))
    assert(store.files.size === 3, 'Finite nested hardlink graph was rejected or conflated')
  } finally { store.clear() }
})
test('finite alias imports preserve lexical parent resolution at different path depths', () => {
  const directory = base.get_child('lexical-depth')
  directory.make_directory(null)
  const real = directory.get_child('real')
  real.make_directory(null)
  write(real.get_child('theme.css'), '@import "../../next/theme.css"; .close { width: 13px; }')
  const inside = directory.get_child('inside')
  inside.make_directory(null)
  const aliases = inside.get_child('aliases')
  aliases.make_directory(null)
  aliases.get_child('deep').make_symbolic_link(real.get_path(), null)
  inside.get_child('next').make_symbolic_link(real.get_path(), null)
  const final = directory.get_child('next')
  final.make_directory(null)
  write(final.get_child('theme.css'), '.close { height: 7px; }')
  const store = new ScopedStylesheetStore()
  try {
    store.compile(aliases.get_child('deep').get_child('theme.css').get_path(), scope, prepare(aliases.get_child('deep').get_child('theme.css')))
    assert(store.files.size === 3, 'Physical alias identity replaced native lexical base semantics')
  } finally { store.clear() }
})
test('expanding directory-symlink imports fail visibly at the native filesystem resolver', () => {
  const cycle = base.get_child('directory-cycle.css')
  write(cycle, '@import "again/directory-cycle.css";')
  base.get_child('again').make_symbolic_link(base.get_path(), null)
  const owner = new ScopedStylesheet(cycle.get_path(), scope)
  const error = throws(() => owner.load(new St.Theme(), prepare(Gio.File.new_for_path(owner.path))), 'Directory alias cycle was accepted')
  assert(error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TOO_MANY_LINKS), 'Directory alias loop lost its native ELOOP diagnostic')
  assert(owner.store.directory === null && owner.store.files.size === 0, 'Alias cycle retained a partial stage')
})
test('native global theme copying is unloaded from both original and current owners', () => {
  const original = new St.Theme()
  const replacement = new St.Theme()
  const owner = new ScopedStylesheet(style.get_path(), scope)
  owner.load(original, prepare(Gio.File.new_for_path(owner.path)))
  for (const file of original.get_custom_stylesheets()) replacement.load_stylesheet(file)
  const directory = owner.store.directory
  owner.unload(replacement)
  assert(original.get_custom_stylesheets().length === 0 && replacement.get_custom_stylesheets().length === 0,
    'A native theme copy retained the scoped root')
  assert(!directory.query_exists(null), 'Theme replacement cleanup retained generated files')
})
test('cyclic, symlink-cyclic and unreadable imports fail visibly and remove stages', () => {
  const cycle = base.get_child('cycle.css')
  write(cycle, '@import "cycle.css";')
  const alias = base.get_child('cycle-alias.css')
  alias.make_symbolic_link(cycle.get_path(), null)
  for (const content of ['@import "cycle.css";', '@import "cycle-alias.css";', '@import "missing.css";']) {
    write(cycle, content)
    const owner = new ScopedStylesheet(cycle.get_path(), scope)
    throws(() => owner.load(new St.Theme(), prepare(Gio.File.new_for_path(owner.path))), 'Import acquisition failure disappeared')
    assert(owner.store.directory === null && owner.store.files.size === 0, 'Failed import retained private stage')
  }
})
test('failed final loading releases staged files and partially acquired stylesheet ownership', () => {
  const owner = new ScopedStylesheet(style.get_path(), scope)
  let unloaded = 0
  const failing = { load_stylesheet() { throw new Error('Injected native load failure') }, unload_stylesheet() { unloaded++ } }
  const error = throws(() => owner.load(failing, prepare(Gio.File.new_for_path(owner.path))), 'Native loading failure disappeared')
  assert(error.message.includes('Injected native load failure'), 'Original native loading error disappeared')
  assert(unloaded === 1 && owner.file === null && owner.store.directory === null && owner.store.files.size === 0,
    'Failed loading retained root or private files')
})
test('failed loading rolls back only its new files in a shared activation store', () => {
  const store = new ScopedStylesheetStore()
  store.compile(style.get_path(), scope, prepare(style))
  const retained = [...store.files.values()].map(file => file.get_path())
  const changed = base.get_child('rejected.css')
  write(changed, '.close { width: 37px; }')
  const owner = new ScopedStylesheet(changed.get_path(), scope, store)
  try {
    throws(() => owner.load({load_stylesheet() { throw new Error('Rejected update') }, unload_stylesheet() {}}, prepare(changed)),
      'Rejected update falsely succeeded')
    assert(JSON.stringify([...store.files.values()].map(file => file.get_path())) === JSON.stringify(retained),
      'Failed update retained new files or discarded existing activation ownership')
    for (const path of retained) assert(Gio.File.new_for_path(path).query_exists(null), 'Existing cache file was removed')
  } finally { store.clear() }
})
test('malformed roots unwind imported files already staged before the failure', () => {
  const malformed = base.get_child('malformed.css')
  write(malformed, '@import "nested/imported.css"; .close { color red; }')
  const owner = new ScopedStylesheet(malformed.get_path(), scope)
  const theme = new St.Theme()
  // Compilation also rejects an invalid snapshot instead of trusting its caller.
  const prepared = prepare(base.get_child('nested/imported.css'))
  prepared.set(malformed.get_uri(), malformed.load_contents(null)[1])
  throws(() => owner.load(theme, prepared), 'Malformed root was exposed after staging its import')
  assert(theme.get_custom_stylesheets().length === 0 && owner.store.directory === null && owner.store.files.size === 0,
    'Malformed root retained loaded ownership or partially staged imports')
})
test('partial native staging writes close and remove the owned file without publishing a root', () => {
  const prepared = prepare(style)
  const nativeNewForPath = Gio.File.new_for_path
  const wrap = file => ({
    get_path: () => file.get_path(), get_uri: () => file.get_uri(),
    get_parent: () => wrap(file.get_parent()), get_child: name => wrap(file.get_child(name)),
    resolve_relative_path: path => wrap(file.resolve_relative_path(path)),
    query_info: (...args) => file.query_info(...args),
    delete: (...args) => file.delete(...args),
    create(...args) {
      const stream = file.create(...args)
      return { write_all(bytes) { stream.write_all(bytes.slice(0, 7), null); throw new Error('Injected staging failure') },
        close: (...closeArgs) => stream.close(...closeArgs) }
    }
  })
  try {
    Gio.File.new_for_path = path => wrap(nativeNewForPath(path))
    const owner = new ScopedStylesheet(style.get_path(), scope)
    const error = throws(() => owner.load(new St.Theme(), prepared), 'Partial staging falsely succeeded')
    assert(error.message.includes('Injected staging failure'), 'Staging error disappeared')
    assert(owner.store.directory === null && owner.store.files.size === 0, 'Partial write retained generated files')
  } finally {
    Gio.File.new_for_path = nativeNewForPath
  }
})
test('every shipped theme variant scopes and passes the installed native CSS parser', () => {
  const store = new ScopedStylesheetStore()
  const themes = source.get_child('unite-next@lucastsudaka.github.io/themes')
  const entries = themes.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)
  let variants = 0
  try {
    for (let info = entries.next_file(null); info; info = entries.next_file(null)) {
      const directory = themes.get_child(info.get_name())
      const manifest = directory.get_child('unite.theme')
      if (!manifest.query_exists(null)) continue
      const keys = new GLib.KeyFile()
      keys.load_from_file(manifest.get_path(), GLib.KeyFileFlags.NONE)
      for (const variant of ['Dark', 'Light']) {
        const original = directory.resolve_relative_path(keys.get_string(variant, 'Style'))
        const bytes = read(original)
        store.compile(original.get_path(), scope, prepare(original))
        assert(read(original) === bytes, 'Shipped theme source changed')
        variants++
      }
    }
    assert(variants > 0, 'No shipped variants were checked')
    print(`SCOPED_SHIPPED_VARIANTS ${variants}`)
  } finally { entries.close(null); store.clear() }
})

function turnUntil(predicate) {
  const end = GLib.get_monotonic_time() + 5000000
  while (!predicate()) {
    assert(GLib.get_monotonic_time() < end, 'Stylesheet preparation did not complete')
    GLib.MainContext.default().iteration(false)
    GLib.usleep(1000)
  }
}

function prepare(file) {
  let done = false
  let observed
  const request = new StylesheetPreparation(file.get_path(), scope, (error, records) => {
    observed = { error, records }; done = true
  })
  turnUntil(() => done)
  assert(!request.receive && !request.read && !request.records && !request.frames.length, 'Preparation retained delivery or input state')
  if (observed.error) throw observed.error
  return observed.records
}

test('asynchronous import preparation is read-only and replacement uses its snapshot without synchronous input reads', () => {
  const initial = base.get_child('async-initial.css')
  const selected = base.get_child('async-selected.css')
  const child = base.get_child('async-import.css')
  write(initial, '.close { width: 11px; }')
  write(child, '.icon { background-image: url("icons/close.svg"); height: 19px; }')
  write(selected, '@import "async-import.css"; .close { width: 23px; }')
  const owner = new ScopedStylesheet(initial.get_path(), scope)
  const theme = new St.Theme()
  const load = Gio.File.prototype.load_contents
  let presentation = 'old'
  let records
  let previous
  try {
    Gio.File.prototype.load_contents = () => { throw new Error('Prepared selection used a synchronous input read') }
    const first = prepare(initial)
    assert(owner.store.directory === null, 'First preparation created staging')
    owner.load(theme, first)
    previous = owner.file
    const paths = [...owner.store.files.keys()]
    records = prepare(selected)
    assert(records.size === 2 && JSON.stringify([...owner.store.files.keys()]) === JSON.stringify(paths), 'Read-only preparation changed staging')
    write(selected, '.invalid { color broken; }')
    owner.replace(theme, selected.get_path(), scope, records, {
      apply() { presentation = 'new' }, rollback() { presentation = 'old' }
    })
    assert(presentation === 'new' && !owner.file.equal(previous), 'Prepared selection was not applied')
  } finally { Gio.File.prototype.load_contents = load }
  try {
    assert(read(owner.file).includes('width: 23px'), 'Compilation reread a changed input instead of its snapshot')
    const contents = [...owner.store.files.values()].map(read).join('\n')
    assert(contents.includes(child.get_parent().resolve_relative_path('icons/close.svg').get_uri()), 'Prepared import lost its original asset base')
    assert(theme.get_custom_stylesheets().length === 1, 'Replacement retained a previous or duplicate native root')
    owner.replace(theme, selected.get_path(), scope, records, {
      apply() {}, rollback() {}
    })
    assert(theme.get_custom_stylesheets().length === 1, 'Repeated identical graph duplicated the native root')
  } finally { owner.unload(theme) }
})

test('compilation requires a prepared snapshot and rejects an incomplete import closure without retained staging', () => {
  const store = new ScopedStylesheetStore()
  const error = throws(() => store.compile(style.get_path(), scope), 'Missing prepared snapshot was accepted')
  assert(error.message.includes('snapshot is required') && store.directory === null && store.files.size === 0,
    'Missing snapshot read inputs or allocated a stage')
  const incomplete = new Map([[style.get_uri(), style.load_contents(null)[1]]])
  const missing = throws(() => store.compile(style.get_path(), scope, incomplete), 'Incomplete import snapshot was accepted')
  assert(missing.message.includes('Missing prepared') && store.directory === null && store.files.size === 0,
    'Incomplete snapshot retained private files')
})

test('first Styles load or presentation failure removes candidate CSS and staging before a successful retry', () => {
  const theme = new St.Theme()
  const load = theme.load_stylesheet.bind(theme)
  Object.defineProperty(ScopedShellStyle.prototype, 'theme', { configurable: true, get: () => theme })
  try {
    for (const boundary of ['load', 'presentation', 'rollback']) {
      const owner = new Styles()
      const prepared = prepare(style)
      let directory
      const failure = new Error(`First ${boundary} failure`)
      theme.load_stylesheet = file => {
        directory = owner.scopedStore.directory
        const result = load(file)
        if (boundary === 'load') throw failure
        return result
      }
      try {
        const error = throws(() => owner.addScopedShellStyle('controls', style.get_path(), scope, prepared, {
          apply() { throw failure },
          rollback() { if (boundary === 'rollback') throw new Error('First rollback failure') }
        }), 'First acquisition failure disappeared')
        assert(error.message.includes(failure.message) && (boundary !== 'rollback' || error.message.includes('First rollback failure')),
          'Original or cleanup failure disappeared')
        assert(!owner.hasStyle('controls') && theme.get_custom_stylesheets().length === 0 &&
          owner.scopedStore.files.size === 0 && owner.scopedStore.directory === null && !directory.query_exists(null),
          'Local first failure retained native ownership or newly staged files')
        theme.load_stylesheet = load
        owner.addScopedShellStyle('controls', style.get_path(), scope, prepared)
        assert(owner.hasStyle('controls') && theme.get_custom_stylesheets().length === 1,
          'Same Styles owner could not recover after its first failure')
      } finally { theme.load_stylesheet = load; owner.removeAll() }
      assert(theme.get_custom_stylesheets().length === 0, 'Retry ownership survived cleanup')
    }
  } finally { delete ScopedShellStyle.prototype.theme }
})

test('failed native or presentation transitions restore the previous root and keep prior cache ownership', () => {
  const initial = base.get_child('rollback-initial.css')
  const selected = base.get_child('rollback-next.css')
  write(initial, '.close { width: 7px; }')
  write(selected, '.close { width: 29px; }')
  const owner = new ScopedStylesheet(initial.get_path(), scope)
  const theme = new St.Theme()
  owner.load(theme, prepare(Gio.File.new_for_path(owner.path)))
  const previous = owner.file
  const retained = [...owner.store.files.keys()]
  const prepared = prepare(selected)
  const load = theme.load_stylesheet.bind(theme)
  const unload = theme.unload_stylesheet.bind(theme)
  try {
    for (const boundary of ['load', 'presentation', 'unload']) {
      const failure = new Error(`Injected transition ${boundary} failure`)
      let presentation = 'old'
      let injected = false
      theme.load_stylesheet = file => {
        const result = load(file)
        if (boundary === 'load' && !file.equal(previous)) throw failure
        return result
      }
      theme.unload_stylesheet = file => {
        unload(file)
        if (boundary === 'unload' && file.equal(previous) && !injected) { injected = true; throw failure }
      }
      const error = throws(() => owner.replace(theme, selected.get_path(), scope, prepared, {
        apply() { presentation = 'new'; if (boundary === 'presentation') throw failure },
        rollback() { presentation = 'old' }
      }), 'Transition failure disappeared')
      assert(error === failure && presentation === 'old', 'Original failure or previous presentation was lost')
      assert(owner.file.equal(previous) && theme.get_custom_stylesheets().length === 1 &&
        theme.get_custom_stylesheets()[0].equal(previous), 'Previous native ownership was not restored')
      assert(JSON.stringify([...owner.store.files.keys()]) === JSON.stringify(retained), 'Failed transition retained new staging')
    }
  } finally { theme.load_stylesheet = load; theme.unload_stylesheet = unload; owner.unload(theme) }
})

test('prepared invalid, cyclic and unreadable imports fail without staging or owner delivery after cancellation', () => {
  const file = base.get_child('prepare-invalid.css')
  for (const text of ['.close { color broken; }', '@import "prepare-invalid.css";', '@import "absent-prepare.css";']) {
    write(file, text)
    throws(() => prepare(file), 'Invalid prepared closure succeeded')
  }
  write(file, '.close { width: 8px; }')
  let callbacks = 0
  const request = new StylesheetPreparation(file.get_path(), scope, () => callbacks++)
  const input = request.frames[0].file
  let finished = false
  const finish = input.load_contents_finish.bind(input)
  input.load_contents_finish = result => { try { return finish(result) } finally { finished = true } }
  const read = request.read
  request.cancel()
  turnUntil(() => finished)
  assert(callbacks === 0 && !read.receive && !request.receive && !request.records && !request.frames.length,
    'Cancelled preparation retained state or reached its disposed owner')
})

test('native theme copies replace cleanly and reentrant disposal unloads an in-progress candidate without restoring it', () => {
  const initial = base.get_child('copied-initial.css')
  const selected = base.get_child('copied-next.css')
  write(initial, '.close { width: 5px; }')
  write(selected, '.close { width: 31px; }')
  const owner = new ScopedStylesheet(initial.get_path(), scope)
  const original = new St.Theme()
  const current = new St.Theme()
  owner.load(original, prepare(Gio.File.new_for_path(owner.path)))
  current.load_stylesheet(owner.file)
  owner.replace(current, selected.get_path(), scope, prepare(selected), { apply() {}, rollback() {} })
  assert(original.get_custom_stylesheets().length === 0 && current.get_custom_stylesheets().length === 1,
    'Replacement retained a copied original root')
  const previous = owner.file
  const directory = owner.store.directory
  const prepared = prepare(initial)
  const load = current.load_stylesheet.bind(current)
  let disposed = false
  current.load_stylesheet = file => {
    const result = load(file)
    if (!file.equal(previous)) {
      owner.unload(current)
      disposed = true
      assert(current.get_custom_stylesheets().length === 0, 'Teardown returned with an in-progress candidate loaded')
    }
    return result
  }
  try {
    throws(() => owner.replace(current, initial.get_path(), scope, prepared, {
      apply() { throw new Error('Disposed owner reached presentation') }, rollback() {}
    }), 'Disposed transition succeeded')
    assert(disposed && owner.file === null && owner.transition === null && current.get_custom_stylesheets().length === 0 &&
      original.get_custom_stylesheets().length === 0 && !directory.query_exists(null), 'Disposed transition reacquired a root or staging')
  } finally { current.load_stylesheet = load; owner.unload(current) }
})

test('preparation startup failure preserves the original error and removes its pending Styles entry', () => {
  const owner = new Styles()
  const failure = new Error('Injected read acquisition failure')
  const load = Gio.File.prototype.load_contents_async
  try {
    Gio.File.prototype.load_contents_async = () => { throw failure }
    assert(throws(() => owner.prepareScopedShellStyle('controls', style.get_path(), scope, () => {
      throw new Error('Unacquired read delivered a result')
    }), 'Read acquisition failure disappeared') === failure, 'Cleanup replaced the original acquisition error')
    assert(owner.preparations.size === 0 && owner.scopedStore === null, 'Failed read acquisition retained ownership')
  } finally { Gio.File.prototype.load_contents_async = load; owner.removeAll() }
})

test('a real native theme copy during replacement is rolled back and all copied roots leave on teardown', () => {
  const initial = base.get_child('signal-initial.css')
  const selected = base.get_child('signal-next.css')
  write(initial, '.close { width: 13px; }')
  write(selected, '.close { width: 41px; }')
  for (const currentAware of [false, true]) {
    const owner = new ScopedStylesheet(initial.get_path(), scope)
    const original = new St.Theme()
    let current = original
    let copied = null
    let presentation = 'old'
    owner.load(original, prepare(Gio.File.new_for_path(owner.path)))
    const previous = owner.file
    const signal = original.connect('custom-stylesheets-changed', () => {
      if (copied || original.get_custom_stylesheets().length !== 2) return
      copied = new St.Theme()
      for (const file of original.get_custom_stylesheets()) copied.load_stylesheet(file)
      current = copied
    })
    try {
      const prepared = prepare(selected)
      const transition = {
        apply() { presentation = 'new' }, rollback() { presentation = 'old' },
        ...(currentAware ? { currentTheme: () => current } : {})
      }
      if (currentAware) {
        const error = throws(() => owner.replace(original, selected.get_path(), scope, prepared, transition),
          'Changed native context was silently accepted')
        assert(error.message.includes('Native theme changed') && presentation === 'old' &&
          current.get_custom_stylesheets().length === 1 && current.get_custom_stylesheets()[0].equal(previous),
        'Native context change did not preserve the previous presentation')
      } else owner.replace(original, selected.get_path(), scope, prepared, transition)
      owner.unload(current)
      assert(copied && original.get_custom_stylesheets().length === 0 && copied.get_custom_stylesheets().length === 0 &&
        owner.roots.size === 0 && owner.store.directory === null, 'A copied predecessor survived teardown')
    } finally { original.disconnect(signal); owner.unload(current) }
  }
})

print(`SCOPED_STYLES_PASS scenarios=${passed}`)
