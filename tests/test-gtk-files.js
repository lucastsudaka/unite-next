// REQ-STATE-001 / REQ-LIFE-001: real private files and native exclusive publication.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { loadModule, assert, throws } from './load-module.js'

assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'GTK file tests require the private Python runner')
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path()
const config = GLib.get_user_config_dir()
const dependencies = { GLib, St: {}, Main: {}, Convenience: { getPath: () => `${root}/unite-next@lucastsudaka.github.io` }, InjectionManager: class {} }
const modulePath = `${root}/unite-next@lucastsudaka.github.io/handlers.js`
const native = loadModule(modulePath, { ...dependencies, Gio }, ['updateFile', 'resetGtkStyles'])
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
function fixtureGio({ target, failWrite = false, intervene = false, changeAfterCheck = false, collideEtag = false, stallPublication = false }) {
  const facade = Object.create(Gio)
  let intercepted = false
  const wrap = file => ({
    get_path: () => file.get_path(),
    get_parent: () => wrap(file.get_parent()),
    get_child: name => wrap(file.get_child(name)),
    make_directory_with_parents: (...args) => file.make_directory_with_parents(...args),
    load_contents(...args) {
      const result = file.load_contents(...args)
      if (collideEtag && !intercepted && file.get_path() === target) {
        intercepted = true
        const timestamp = file.query_info('time::modified,time::modified-usec,time::modified-nsec', Gio.FileQueryInfoFlags.NONE, null)
        GLib.file_set_contents(target, 'Concurrent change!')
        // Reproduce the observed native collision deterministically, without a delay/retry.
        file.set_attributes_from_info(timestamp, Gio.FileQueryInfoFlags.NONE, null)
        const current = file.load_contents(null)
        facade.collisionConfirmed = current[2] === result[2]
        facade.sameLengthConfirmed = current[1].length === result[1].length
        assert(facade.collisionConfirmed, 'Fixture failed to retain the actual native etag')
      }
      return result
    },
    replace_contents(...args) {
      if (changeAfterCheck && file.get_path() === target) {
        GLib.file_set_contents(target, 'Concurrent user edit')
        file.set_attribute_uint64('time::modified', Math.floor(GLib.get_real_time() / 1000000) + 10, Gio.FileQueryInfoFlags.NONE, null)
      }
      return file.replace_contents(...args)
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
    delete: (...args) => file.delete(...args)
  })
  facade.File = { new_for_path: path => wrap(Gio.File.new_for_path(path)) }
  facade.Subprocess = {
    new(argv, flags) {
      if (intervene) GLib.file_set_contents(target, 'Concurrent user file')
      if (stallPublication) {
        const index = argv.indexOf('/usr/bin/ln')
        assert(index >= 0, 'Fixture requires the actual publication child')
        argv = [...argv.slice(0, index), '/usr/bin/python3', '-c',
          'import os, signal; open(__import__("sys").argv[1], "w").write(str(os.getpid())); os.kill(os.getpid(), signal.SIGSTOP)',
          `${target}.pid`]
      }
      return Gio.Subprocess.new(argv, flags)
    }
  }
  return facade
}

const content = '/* UNITE fixture */\nwindow { padding: 0; }\n/* fixture UNITE */\n'
test('No-op reset creates neither GTK files nor parent directories', () => {
  native.resetGtkStyles()
  for (const version of [3, 4]) {
    assert(!Gio.File.new_for_path(`${config}/gtk-${version}.0`).query_exists(null), 'No-op reset created state')
  }
})
test('Partial staging write leaves no target or temporary file', () => {
  const directory = `${config}/write-failure`
  const target = `${directory}/gtk.css`
  const { updateFile } = loadModule(modulePath, { ...dependencies, Gio: fixtureGio({ target, failWrite: true }) }, ['updateFile'])
  const error = throws(() => updateFile(target, () => content), 'Partial write falsely succeeded')
  assert(error.message.includes('disk-full'), 'Original write error disappeared')
  assert(!Gio.File.new_for_path(target).query_exists(null), 'Partial target was published')
  assert(stages(directory).length === 0, 'Partial staging file survived failure')
})
test('Atomic exclusive publication preserves an intervening foreign file', () => {
  const directory = `${config}/create-race`
  const target = `${directory}/gtk.css`
  const { updateFile } = loadModule(modulePath, { ...dependencies, Gio: fixtureGio({ target, intervene: true }) }, ['updateFile'])
  const error = throws(() => updateFile(target, () => content), 'Concurrent target was overwritten')
  assert(error.message.includes('publication failed'), 'Publication error was hidden')
  assert(read(target) === 'Concurrent user file', 'Concurrent user bytes changed')
  assert(stages(directory).length === 0, 'Staging survived rejected publication')
})
test('Successful publication exposes complete private content and removes stage', () => {
  const directory = `${config}/success`
  const target = `${directory}/gtk.css`
  native.updateFile(target, () => content)
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
  const fakeGLib = Object.create(GLib)
  fakeGLib.uuid_string_random = () => 'fixed'
  const { updateFile } = loadModule(modulePath, { ...dependencies, GLib: fakeGLib, Gio }, ['updateFile'])
  throws(() => updateFile(target, () => content), 'Stage collision falsely succeeded')
  assert(read(collision) === 'Foreign stage-name owner', 'Unowned staging path was removed')
  assert(!Gio.File.new_for_path(target).query_exists(null), 'Stage collision published a target')
})
test('Native etag guard rejects an edit occurring after the full-byte precondition', () => {
  const directory = `${config}/etag`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  GLib.file_set_contents(target, 'Original user file')
  const { updateFile } = loadModule(modulePath, { ...dependencies, Gio: fixtureGio({ target, changeAfterCheck: true }) }, ['updateFile'])
  const error = throws(() => updateFile(target, previous => content + previous), 'Stale etag falsely succeeded')
  assert(error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.WRONG_ETAG), 'Expected native etag conflict')
  assert(read(target) === 'Concurrent user edit', 'Concurrent existing-file bytes changed')
})
test('Same-etag content conflict is rejected without losing user bytes', () => {
  const directory = `${config}/same-etag`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  GLib.file_set_contents(target, 'Original user file')
  const facade = fixtureGio({ target, collideEtag: true })
  const { updateFile } = loadModule(modulePath, { ...dependencies, Gio: facade }, ['updateFile'])
  const error = throws(() => updateFile(target, previous => content + previous), 'Same-etag edit falsely succeeded')
  assert(facade.collisionConfirmed, 'The conflict fixture did not establish a native etag collision')
  assert(facade.sameLengthConfirmed, 'The fixture must exercise byte comparison, not only length comparison')
  assert(error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.WRONG_ETAG), 'Expected visible content-precondition conflict')
  assert(read(target) === 'Concurrent change!', 'Same-etag user edit was overwritten')
})
test('UTF-8 BOM, Unicode and original line endings survive owned apply/remove', () => {
  const directory = `${config}/utf8-roundtrip`
  const target = `${directory}/gtk.css`
  GLib.mkdir_with_parents(directory, 0o700)
  const original = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('/* User ação α */\r\nbutton { color: red; }\r\n')])
  GLib.file_set_contents(target, original)
  native.updateFile(target, previous => content + previous)
  const applied = GLib.file_get_contents(target)[1]
  assert(Array.from(applied.slice(new TextEncoder().encode(content).length)).join(',') === Array.from(original).join(','), 'Apply changed unrelated UTF-8 bytes')
  native.updateFile(target, previous => previous.replace(content, ''))
  const restored = GLib.file_get_contents(target)[1]
  assert(Array.from(restored).join(',') === Array.from(original).join(','), 'Apply/remove lost BOM, Unicode or line endings')
})
test('Stalled publication is killed and reaped without a Shell-loop callback or partial output', () => {
  const directory = `${config}/stalled-publication`
  const target = `${directory}/gtk.css`
  const { updateFile } = loadModule(modulePath,
    { ...dependencies, Gio: fixtureGio({ target, stallPublication: true }) }, ['updateFile'])
  const start = GLib.get_monotonic_time()
  const error = throws(() => updateFile(target, () => content), 'Stalled publication falsely succeeded')
  assert(GLib.get_monotonic_time() - start < 3000000, 'Publication exceeded its independent deadline')
  assert(error.message.includes('status 137'), 'Timeout status was masked')
  const pid = read(`${target}.pid`).trim()
  assert(!Gio.File.new_for_path(`/proc/${pid}`).query_exists(null), 'Publication child was not reaped')
  assert(!Gio.File.new_for_path(target).query_exists(null), 'Stalled publication exposed a target')
  assert(stages(directory).length === 0, 'Staging survived timed-out publication')
})
print(`GTK_FILE_TESTS_PASS scenarios=${passed}`)
