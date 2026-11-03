// REQ-STATE-001 / REQ-LIFE-001: real private files and native exclusive publication.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Gtk from 'gi://Gtk?version=4.0'
import { assert, throws } from './assert.js'
import { GtkStyles, resetGtkStyles } from '../unite-next@lucastsudaka.github.io/gtk-styles.js'

assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'GTK file tests require the private Python runner')
const config = GLib.get_user_config_dir()
const nativeNewForPath = Gio.File.new_for_path
const nativeSpawn = Gio.SubprocessLauncher.prototype.spawnv
const nativeUuid = GLib.uuid_string_random
const ownedStyles = () => new class extends GtkStyles {
  load() { super.load(); this.flush() }
}('fixture', 'window { padding: 0; }', [3])
let passed = 0
function test(name, callback) {
  callback()
  passed++
  print(`PASS ${name}`)
}
const read = path => new TextDecoder().decode(GLib.file_get_contents(path)[1])
function stages(directory) {
  const file = Gio.File.new_for_path(directory)
  if (!file.query_exists(null)) return []
  const data = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)
  const found = []
  try {
    for (let info = data.next_file(null); info; info = data.next_file(null)) {
      if (info.get_name().startsWith('.unite-next-gtk-')) found.push(info.get_name())
    }
  } finally {
    data.close(null)
  }
  return found
}
function withFileBoundary({ target, failWrite = false, failMetadata = false, intervene = false, changeAfterCheck = false,
  collideEtag = false, stallPublication = false, stallReplacement = false, stageToken = null }, callback) {
  const observations = {}
  let intercepted = false
  const wrap = file => new Proxy(file, { get(_target, name) {
    const overrides = {
    get_path: () => file.get_path(),
    get_uri: () => file.get_uri(),
    get_parent: () => wrap(file.get_parent()),
    get_child: name => wrap(file.get_child(name)),
    make_directory_with_parents: (...args) => file.make_directory_with_parents(...args),
    load_contents(...args) {
      return file.load_contents(...args)
    },
    create(...args) {
      const stream = file.create(...args)
      if (!failWrite || !file.get_basename().startsWith('.unite-next-gtk-')) return stream
      return {
        write_all(bytes) {
          stream.write_all(bytes.slice(0, 12), null)
          throw new Error('Injected disk-full failure')
        },
        close: (...closeArgs) => stream.close(...closeArgs)
      }
    },
    set_attributes_from_info(...args) {
      if (failMetadata && file.get_basename().startsWith('gtk.css-')) throw new Error('Injected metadata failure')
      return file.set_attributes_from_info(...args)
    },
    delete: (...args) => file.delete(...args)
    }
    if (name in overrides) return overrides[name]
    const value = file[name]
    return typeof value === 'function' ? value.bind(file) : value
  } })
  try {
    Gio.File.new_for_path = path => wrap(nativeNewForPath(path === `${config}/gtk-3.0/gtk.css` ? target : path))
    if (stageToken) GLib.uuid_string_random = () => stageToken
    Gio.SubprocessLauncher.prototype.spawnv = function (argv) {
      argv = argv.map(value => value === `${config}/gtk-3.0/gtk.css` ? target : value)
      if (intervene && argv.includes('/usr/bin/ln')) GLib.file_set_contents(target, 'Concurrent user file')
      if (changeAfterCheck && argv.includes('/usr/bin/mv')) {
        GLib.file_set_contents(target, 'Concurrent user edit')
      }
      if (stallPublication && argv.includes('/usr/bin/ln')) {
        const index = argv.indexOf('/usr/bin/ln')
        assert(index >= 0, 'Fixture requires the actual publication child')
        argv = [...argv.slice(0, index), '/usr/bin/python3', '-c',
          'import os, signal; open(__import__("sys").argv[1], "w").write(str(os.getpid())); os.kill(os.getpid(), signal.SIGSTOP)',
          `${target}.pid`]
      }
      if (stallReplacement && argv.includes('/usr/bin/mv')) {
        const index = argv.indexOf('/usr/bin/mv')
        argv = [...argv.slice(0, index), '/usr/bin/python3', '-c',
          'import os, signal, sys; open(sys.argv[1], "w").write(str(os.getpid())); os.kill(os.getpid(), signal.SIGSTOP)',
          `${target}.pid`]
      }
      const process = nativeSpawn.call(this, argv)
      if (collideEtag && !intercepted && argv.includes('/usr/bin/dd') && argv.includes(`if=${target}`)) {
        intercepted = true
        const file = nativeNewForPath(target)
        const original = file.load_contents(null)
        const timestamp = file.query_info('time::modified,time::modified-usec,time::modified-nsec', 0, null)
        process.wait_check(null)
        const stream = file.open_readwrite(null)
        stream.get_output_stream().write_all(new TextEncoder().encode('Concurrent change!'), null)
        stream.close(null)
        file.set_attributes_from_info(timestamp, 0, null)
        const current = file.load_contents(null)
        observations.collisionConfirmed = current[2] === original[2]
        observations.sameLengthConfirmed = current[1].length === original[1].length
        assert(observations.collisionConfirmed, 'Fixture failed to retain the actual native etag')
      }
      return process
    }
    return callback(observations)
  } finally {
    Gio.File.new_for_path = nativeNewForPath
    Gio.SubprocessLauncher.prototype.spawnv = nativeSpawn
    GLib.uuid_string_random = nativeUuid
  }
}

const content = '/* UNITE_NEXT fixture */\nwindow { padding: 0; }\n/* fixture UNITE_NEXT */\n'
test('No-op reset creates neither GTK files nor parent directories', () => {
  resetGtkStyles()
  for (const version of [3, 4]) {
    assert(!Gio.File.new_for_path(`${config}/gtk-${version}.0`).query_exists(null), 'No-op reset created state')
  }
})
test('Partial staging write leaves no target or temporary file', () => {
  const directory = `${config}/write-failure`
  const target = `${directory}/gtk.css`
  withFileBoundary({ target, failWrite: true }, () => {
    const error = throws(() => ownedStyles().load(), 'Partial write falsely succeeded')
    assert(error.message.includes('disk-full'), 'Original write error disappeared')
  })
  assert(!Gio.File.new_for_path(target).query_exists(null), 'Partial target was published')
  assert(stages(directory).length === 0, 'Partial staging file survived failure')
})
test('Atomic exclusive publication preserves an intervening foreign file', () => {
  const directory = `${config}/create-race`
  const target = `${directory}/gtk.css`
  withFileBoundary({ target, intervene: true }, () => {
    const error = throws(() => ownedStyles().load(), 'Concurrent target was overwritten')
    assert(error.message.includes('publication failed'), 'Publication error was hidden')
  })
  assert(read(target) === 'Concurrent user file', 'Concurrent user bytes changed')
  assert(stages(directory).length === 0, 'Staging survived rejected publication')
})
test('Successful publication exposes complete private content and removes stage', () => {
  const directory = `${config}/success`
  const target = `${directory}/gtk.css`
  withFileBoundary({ target }, () => ownedStyles().load())
  assert(read(target) === content, 'Published content is incomplete')
  const info = Gio.File.new_for_path(target).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
  assert((info.get_attribute_uint32('unix::mode') & 0o777) === 0o600, 'Published file is not private')
  assert(stages(directory).length === 0, 'Staging survived successful publication')
})
test('A preexisting staging-name collision remains owned by its creator', () => {
  const directory = `${config}/stage-collision`
  GLib.mkdir_with_parents(directory, 0o700)
  const target = `${directory}/gtk.css`
  const collision = `${directory}/.unite-next-gtk-fixed.css`
  GLib.file_set_contents(collision, 'Foreign stage-name owner')
  withFileBoundary({ target, stageToken: 'fixed' }, () => {
    throws(() => ownedStyles().load(), 'Stage collision falsely succeeded')
  })
  assert(read(collision) === 'Foreign stage-name owner', 'Unowned staging path was removed')
  assert(!Gio.File.new_for_path(target).query_exists(null), 'Stage collision published a target')
})
test('Recoverable replacement rejects an edit occurring after the GJS precondition', () => {
  const directory = `${config}/etag`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  GLib.file_set_contents(target, 'Original user file')
  withFileBoundary({ target, changeAfterCheck: true }, () => {
    const error = throws(() => ownedStyles().load(), 'Stale snapshot falsely succeeded')
    assert(error.message.includes('ownership conflict'), `Expected visible content conflict: ${error.message}`)
  })
  assert(read(target) === 'Concurrent user edit', 'Concurrent existing-file bytes changed')
})
test('Same-etag content conflict is rejected without losing user bytes', () => {
  const directory = `${config}/same-etag`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  GLib.file_set_contents(target, 'Original user file')
  withFileBoundary({ target, collideEtag: true }, observations => {
    const error = throws(() => ownedStyles().load(), 'Same-etag edit falsely succeeded')
    assert(observations.collisionConfirmed, 'The conflict fixture did not establish a native etag collision')
    assert(observations.sameLengthConfirmed, 'The fixture must exercise byte comparison, not only length comparison')
    assert(error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.WRONG_ETAG), 'Expected visible content-precondition conflict')
  })
  assert(read(target) === 'Concurrent change!', 'Same-etag user edit was overwritten')
})
test('metadata failure aborts before exchange and cleans only its own complete stage', () => {
  const directory = `${config}/metadata-failure`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  GLib.file_set_contents(target, 'Foreign CSS')
  nativeNewForPath(target).set_attribute_uint32('unix::mode', 0o640, 0, null)
  withFileBoundary({ target, failMetadata: true }, () => {
    const error = throws(() => ownedStyles().load(), 'Metadata failure was ignored')
    assert(error.message.includes('metadata failure'), 'Original metadata failure was hidden')
  })
  assert(read(target) === 'Foreign CSS', 'Metadata failure published owned content')
  const iterator = nativeNewForPath(`${directory}/.unite-next-gtk-recovery`).enumerate_children('standard::name', 0, null)
  try { assert(iterator.next_file(null) === null, 'Metadata failure retained an unneeded stage') }
  finally { iterator.close(null) }
})
test('UTF-8 BOM, Unicode and original line endings survive owned apply/remove', () => {
  const directory = `${config}/utf8-roundtrip`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  const original = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('/* User ação α */\r\nbutton { color: red; }\r\n')])
  GLib.file_set_contents(target, original)
  withFileBoundary({ target }, () => {
    const owner = ownedStyles()
    owner.load()
    const recovery = nativeNewForPath(`${directory}/.unite-next-gtk-recovery`)
    const countRecoveries = () => {
      const iterator = recovery.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)
      let count = 0
      try { while (iterator.next_file(null)) count++ }
      finally { iterator.close(null) }
      return count
    }
    const snapshots = countRecoveries()
    owner.load()
    assert(countRecoveries() === snapshots, 'No-op apply created another recovery')
    const applied = GLib.file_get_contents(target)[1]
    assert(Array.from(applied.slice(new TextEncoder().encode(content).length)).join(',') === Array.from(original).join(','),
      'Apply changed unrelated UTF-8 bytes')
    owner.unload()
  })
  const restored = GLib.file_get_contents(target)[1]
  assert(Array.from(restored).join(',') === Array.from(original).join(','), 'Apply/remove lost BOM, Unicode or line endings')
})
test('Stalled publication is killed and reaped without a Shell-loop callback or partial output', () => {
  const directory = `${config}/stalled-publication`
  const target = `${directory}/gtk.css`
  const start = GLib.get_monotonic_time()
  withFileBoundary({ target, stallPublication: true }, () => {
    const error = throws(() => ownedStyles().load(), 'Stalled publication falsely succeeded')
    assert(GLib.get_monotonic_time() - start < 3000000, 'Publication exceeded its independent deadline')
    assert(error.message.includes('status 137'), 'Timeout status was masked')
  })
  const pid = read(`${target}.pid`).trim()
  assert(!Gio.File.new_for_path(`/proc/${pid}`).query_exists(null), 'Publication child was not reaped')
  assert(!Gio.File.new_for_path(target).query_exists(null), 'Stalled publication exposed a target')
  assert(stages(directory).length === 0, 'Staging survived timed-out publication')
})
test('Stalled replacement is killed and reaped and leaves user content intact', () => {
  const directory = `${config}/stalled-replacement`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  GLib.file_set_contents(target, 'User CSS before timeout')
  const start = GLib.get_monotonic_time()
  withFileBoundary({ target, stallReplacement: true }, () => {
    const error = throws(() => ownedStyles().load(), 'Stalled replacement falsely succeeded')
    assert(GLib.get_monotonic_time() - start < 3000000, 'Replacement exceeded its independent deadline')
    assert(error.message.includes('status 137'), 'Replacement timeout was masked')
  })
  const pid = read(`${target}.pid`).trim()
  assert(!Gio.File.new_for_path(`/proc/${pid}`).query_exists(null), 'Replacement child was not reaped')
  assert(read(target) === 'User CSS before timeout', 'Replacement timeout changed user bytes')
})
test('normal GTK updates keep one owner, coalesce the final selection and leave the loop free', () => {
  const directory = `${config}/async-updates`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  GLib.file_set_contents(target, 'Foreign CSS\r\n')
  withFileBoundary({ target }, () => {
    const owner = new GtkStyles('async', 'window { padding: 1px; }', [3])
    let ticks = 0
    const ticker = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => { ticks++; return GLib.SOURCE_CONTINUE })
    try {
      owner.load()
      const style = owner.styles[0]
      owner.update('window { padding: 2px; }', [3])
      owner.update('window { padding: 3px; }', [3])
      assert(owner.styles[0] === style && style.pending, 'Normal changes replaced or abandoned their transaction owner')
      const deadline = GLib.get_monotonic_time() + 5000000
      while (style.pending) {
        assert(GLib.get_monotonic_time() < deadline, 'Async GTK update did not complete')
        GLib.MainContext.default().iteration(true)
      }
      const actual = read(target)
      assert(ticks > 2 && actual.includes('padding: 3px') && !actual.includes('padding: 1px') &&
        !actual.includes('padding: 2px') && actual.endsWith('Foreign CSS\r\n'),
      'Ordinary update blocked the loop, applied a stale choice or changed foreign bytes')
      assert(actual.split('/* UNITE_NEXT async */').length === 2, 'Coalesced update duplicated its owned block')
      owner.unload()
      assert(read(target) === 'Foreign CSS\r\n', 'Coalesced owner did not restore foreign bytes')
    } finally {
      GLib.source_remove(ticker)
      owner.unload()
    }
  })
})
test('disable during a pending GTK command drains all phases without a late callback', () => {
  const directory = `${config}/async-disable`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  GLib.file_set_contents(target, 'Original user CSS')
  withFileBoundary({ target }, () => {
    const owner = new GtkStyles('pending', 'window { padding: 0; }', [3])
    owner.load()
    const pending = owner.styles[0].pending
    const source = pending.job.source
    owner.unload()
    assert(read(target) === 'Original user CSS' && !owner.styles[0].pending && !pending.job,
      'Disable returned with pending mutation or retained CSS')
    assert(GLib.MainContext.default().find_source_by_id(source) === null, 'Disable left a completion callback')
    while (GLib.MainContext.default().pending()) GLib.MainContext.default().iteration(false)
    assert(read(target) === 'Original user CSS', 'A disabled callback changed user content')
  })
})
const quotedRoot = `${config}/owner's "theme" \\ extension`
GLib.mkdir_with_parents(`${quotedRoot}/styles/gtk4/buttons-left`, 0o700)
const sources = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
  .get_child('unite-next@lucastsudaka.github.io')
for (const name of ['gtk-styles.js', 'convenience.js', 'resources.js', 'gtk-files.js', 'process-jobs.js']) {
  sources.get_child(name).copy(Gio.File.new_for_path(`${quotedRoot}/${name}`), Gio.FileCopyFlags.NONE, null, null)
}
GLib.file_set_contents(`${quotedRoot}/styles/gtk4/buttons-left/maximized.css`, 'button { color: rgb(1, 2, 3); }')
const { GtkStyles: QuotedGtkStyles } = await import(Gio.File.new_for_path(`${quotedRoot}/gtk-styles.js`).get_uri())
test('GTK imports escape apostrophes and resolve paths with spaces, quotes and backslashes', () => {
  const owner = new QuotedGtkStyles('quoted', '@/buttons-left/maximized.css', [4])
  owner.load()
  owner.flush()
  const stylesheet = `${config}/gtk-4.0/gtk.css`
  const provider = new Gtk.CssProvider()
  const errors = []
  provider.connect('parsing-error', (_provider, _section, error) => errors.push(error.message))
  provider.load_from_path(stylesheet)
  assert(errors.length === 0, `Escaped import failed: ${errors.join('; ')}`)
  assert(provider.to_string().includes('button'), 'Imported declarations were not parsed')
})
print(`GTK_FILE_TESTS_PASS scenarios=${passed}`)
