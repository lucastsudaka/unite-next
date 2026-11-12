// REQ-LIFE-001/002: native ESM with real GLib and owned boundary failures.
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import { FileRead } from '../unite-next@lucastsudaka.github.io/file-reads.js'
import { Signals, Timeouts, runCleanup } from '../unite-next@lucastsudaka.github.io/resources.js'
import { assert, throws } from './assert.js'

assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Run with disposable HOME/XDG/settings state')
let passed = 0
function test(name, callback) { callback(); passed++; print(`PASS ${name}`) }

test('signal ownership disconnects each handler once despite independent failures', () => {
  const owner = new Signals()
  const calls = []
  const original = new Error('native disconnect failure')
  let id = 0
  const emitter = {
    connect: () => ++id,
    disconnect(value) { calls.push(value); if (value === 1) throw original }
  }
  const first = owner.connect(emitter, 'first', () => {})
  owner.connect(emitter, 'second', () => {})
  assert(throws(() => owner.disconnectAll(), 'Disconnect failure disappeared') === original, 'Original error changed')
  assert(calls.join(',') === '1,2' && owner.signals.size === 0, 'Independent cleanup was skipped')
  owner.disconnect(first)
  owner.disconnectAll()
  assert(calls.length === 2, 'Released handlers were disconnected again')
})

test('failed signal acquisition leaves no owned disconnect', () => {
  const owner = new Signals()
  const original = new Error('native connect failure')
  const emitter = { connect() { throw original }, disconnect() { throw new Error('Unacquired handler disconnected') } }
  assert(throws(() => owner.connect(emitter, 'event', () => {}), 'Acquisition failure disappeared') === original,
    'Original acquisition error changed')
  assert(owner.signals.size === 0, 'Unacquired handler entered ownership')
  owner.disconnectAll()
})

test('completed native one-shot sources expire even when callbacks return continue', () => {
  const owner = new Timeouts()
  const loop = new GLib.MainLoop(null, false)
  let completed = 0
  let timedOut = false
  const finish = () => { if (++completed === 2) loop.quit(); return GLib.SOURCE_CONTINUE }
  owner.idle(finish)
  owner.timeout(1, finish)
  const ids = [...owner.store.values()]
  const watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    timedOut = true
    loop.quit()
    return GLib.SOURCE_REMOVE
  })
  try {
    loop.run()
    assert(!timedOut && completed === 2 && owner.store.size === 0, 'One-shot ownership did not complete')
    for (const id of ids) assert(GLib.main_context_default().find_source_by_id(id) === null, 'Native source remains active')
  } finally {
    if (!timedOut) GLib.source_remove(watchdog)
    owner.removeAll()
  }
})

test('cancellation releases a live native source without removing it twice', () => {
  const owner = new Timeouts()
  const key = owner.timeout(1000, () => { throw new Error('Cancelled callback executed') })
  const id = owner.store.get(key)
  owner.remove(key)
  owner.remove(key)
  owner.removeAll()
  assert(owner.store.size === 0 && GLib.main_context_default().find_source_by_id(id) === null,
    'Cancelled native source remains owned or active')
})

test('throwing callback expires ownership and preserves its original error', () => {
  const nativeAdd = GLib.idle_add
  let callback
  const original = new Error('original callback failure')
  const owner = new Timeouts()
  try {
    GLib.idle_add = (_priority, handler) => { callback = handler; return 123 }
    owner.idle(() => { throw original })
    assert(throws(callback, 'Callback failure disappeared') === original, 'Callback error identity changed')
    assert(owner.store.size === 0, 'Throwing callback retained source ownership')
    owner.removeAll()
  } finally {
    GLib.idle_add = nativeAdd
  }
})

test('cleanup preserves original and ordered aggregate failures while attempting every owner', () => {
  const first = new Error('first boundary failure')
  const second = new Error('second boundary failure')
  assert(throws(() => runCleanup([() => { throw first }]), 'Error disappeared') === first,
    'Single failure identity changed')
  const calls = []
  const aggregate = throws(() => runCleanup([
    () => { calls.push(1); throw first }, () => { calls.push(2); throw second }, () => calls.push(3)
  ]), 'Aggregate disappeared')
  assert(calls.join(',') === '1,2,3' && aggregate.errors[0] === first && aggregate.errors[1] === second &&
    aggregate.cause === first && aggregate.message.includes(first.message) && aggregate.message.includes(second.message),
  'Independent traversal or original aggregate diagnostics changed')
})

test('read completion consumes native success once and releases delivery references', () => {
  let complete
  let finished = 0
  const expected = new Uint8Array([0, 255, 13, 10])
  const file = {
    load_contents_async(cancellable, callback) { complete = callback },
    load_contents_finish() { finished++; return [true, expected] }
  }
  let delivered = 0
  const read = new FileRead(file, (error, bytes) => {
    assert(!error && bytes === expected, 'Read result changed')
    delivered++
  })
  complete(file, {})
  read.cancel()
  assert(finished === 1 && delivered === 1 && read.receive === null && read.cancellable === null,
    'Completed read retained delivery or cancellation ownership')
})

test('cancelled reads consume queued success and failure without reaching a disposed owner', () => {
  for (const failure of [null, new Error('Queued read failure')]) {
    let complete
    let finished = 0
    const file = {
      load_contents_async(cancellable, callback) { complete = callback },
      load_contents_finish() { finished++; if (failure) throw failure; return [true, new Uint8Array([1])] }
    }
    const read = new FileRead(file, () => { throw new Error('Disposed owner received a result') })
    const cancellable = read.cancellable
    read.cancel()
    read.cancel()
    assert(cancellable.is_cancelled() && read.receive === null, 'Cancellation did not detach delivery')
    complete(file, {})
    assert(finished === 1 && read.cancellable === null, 'Terminal result was not consumed')
  }
})

test('real GIO cancellation completes later without an owner callback', () => {
  const file = Gio.File.new_for_path(`${GLib.get_home_dir()}/cancelled-read`)
  file.replace_contents('private fixture', null, false, Gio.FileCreateFlags.PRIVATE, null)
  let finished = false
  const finish = file.load_contents_finish.bind(file)
  file.load_contents_finish = result => { try { return finish(result) } finally { finished = true } }
  const read = new FileRead(file, () => { throw new Error('Cancelled native read delivered to its owner') })
  read.cancel()
  assert(!finished, 'Native cancellation completed synchronously')
  const end = GLib.get_monotonic_time() + 2000000
  while (!finished && GLib.get_monotonic_time() < end) {
    GLib.MainContext.default().iteration(false)
    GLib.usleep(1000)
  }
  file.delete(null)
  assert(finished && read.receive === null, 'Native completion was not consumed')
})

print(`RESOURCE_TESTS_PASS scenarios=${passed}`)
