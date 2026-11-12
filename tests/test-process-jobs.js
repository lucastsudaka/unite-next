import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { assert, throws } from './assert.js'
import { ProcessJob } from '../unite-next@lucastsudaka.github.io/process-jobs.js'
import { ServerDecorations } from '../unite-next@lucastsudaka.github.io/decorations.js'

assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Run with disposable HOME/XDG/settings state')
let passed = 0
function test(name, callback) {
  callback()
  passed++
  print(`PASS ${name}`)
}
function turnUntil(predicate) {
  const end = GLib.get_monotonic_time() + 5000000
  while (!predicate()) {
    assert(GLib.get_monotonic_time() < end, 'Private command failed to complete')
    GLib.MainContext.default().iteration(true)
  }
}

test('ordinary command completion leaves the main loop free and removes private IPC', () => {
  let ticks = 0
  let completed = false
  let observed = null
  const ticker = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => { ticks++; return GLib.SOURCE_CONTINUE })
  const job = new ProcessJob(['/usr/bin/timeout', '--foreground', '--signal=KILL', '1s',
    '/usr/bin/python3', '-I', '-c', 'import sys,time; time.sleep(.08); print(sys.stdin.read())'], 'fixture')
  const directory = job.directory.get_path()
  assert((job.directory.query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o777) === 0o700,
    'IPC directory must be private')
  for (const file of job.files) {
    assert((file.query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o777) === 0o600,
      'IPC file must be private')
  }
  job.watch((error, output) => { observed = { error, output }; completed = true })
  try { turnUntil(() => completed) } finally { GLib.source_remove(ticker) }
  assert(ticks > 3 && observed.error === null && observed.output.trim() === 'fixture',
    'Normal subprocess completion blocked Shell-style event processing')
  assert(job.source === 0 && job.process === null && !Gio.File.new_for_path(directory).query_exists(null),
    'Completed command retained source, process or IPC')
})

test('synchronous drain cancels the only callback and reaps the externally limited command', () => {
  const pidfile = `${GLib.get_user_config_dir()}/stopped-command.pid`
  const job = new ProcessJob(['/usr/bin/timeout', '--foreground', '--signal=KILL', '.15s',
    '/usr/bin/python3', '-I', '-c',
    'import os,signal,sys; open(sys.argv[1],"w").write(str(os.getpid())); os.kill(os.getpid(),signal.SIGSTOP)', pidfile])
  let callbacks = 0
  job.watch(() => callbacks++)
  const source = job.source
  const directory = job.directory.get_path()
  const start = GLib.get_monotonic_time()
  const error = throws(() => job.finish(), 'Stopped command reported success')
  assert(error.message.includes('status 137') && GLib.get_monotonic_time() - start < 2000000,
    'Command was not bounded independently of this main loop')
  const pid = new TextDecoder().decode(GLib.file_get_contents(pidfile)[1]).trim()
  assert(!Gio.File.new_for_path(`/proc/${pid}`).query_exists(null), 'Limited child was not reaped')
  assert(GLib.MainContext.default().find_source_by_id(source) === null, 'Drained completion source remains installed')
  while (GLib.MainContext.default().pending()) GLib.MainContext.default().iteration(false)
  assert(callbacks === 0 && !Gio.File.new_for_path(directory).query_exists(null),
    'Drained owner received a late callback or retained IPC')
})

test('regular files avoid subprocess output backpressure and decode failures still clean up', () => {
  const job = new ProcessJob(['/usr/bin/timeout', '--foreground', '--signal=KILL', '1s',
    '/usr/bin/python3', '-I', '-c', 'print("a" * 1048576)'])
  assert(job.finish().length === 1048577, 'Large child output was incomplete')
  const invalid = new ProcessJob(['/usr/bin/printf', 'invalid JSON'], '', JSON.parse)
  const directory = invalid.directory.get_path()
  throws(() => invalid.finish(), 'Invalid response was accepted')
  assert(!Gio.File.new_for_path(directory).query_exists(null), 'Response failure retained IPC')
  const bytes = new ProcessJob(['/usr/bin/python3', '-I', '-c',
    'import sys; sys.stdout.buffer.write(bytes([0,255,254,13,10]))'], '', output => output, true).finish()
  assert(bytes instanceof Uint8Array && bytes.join(',') === '0,255,254,13,10', 'Binary command output was decoded or normalized')
})

function decorationFixture() {
  let property = null
  let response
  let failure = null
  const requests = []
  const jobs = []
  const reports = []
  const request = input => {
    requests.push(input.operation)
    if (failure) throw failure
    if (response !== undefined) return response
    if (input.operation === 'read') return { value: property, type: 71 }
    if (JSON.stringify(input.expected) !== JSON.stringify(property)) throw new Error('Ownership conflict: foreign change')
    const changed = JSON.stringify(input.value) !== JSON.stringify(property)
    property = input.value
    return { changed }
  }
  const owner = new ServerDecorations({ xid: '0x7', win: { decorated: true, get_frame_type: () => 0 } }, {
    border: 1, request, report: error => reports.push(error),
    start(input, callback) {
      let consumed = false
      const finish = () => { assert(!consumed, 'Command was consumed twice'); consumed = true; return request(input) }
      const entry = { finish, deliver() {
        let result = null
        let error = null
        try { result = finish() } catch (failure) { error = failure }
        callback(error, result)
      } }
      jobs.push(entry)
      return entry
    }
  })
  return { owner, requests, jobs, reports, get property() { return property }, set property(value) { property = value },
    set response(value) { response = value }, set failure(value) { failure = value } }
}

test('rapid window changes coalesce before a pending read can mutate the property', () => {
  const state = decorationFixture()
  state.owner.hide()
  state.owner.show()
  state.owner.hide()
  state.owner.show()
  assert(state.jobs.length === 1 && state.requests.length === 0, 'Window changes spawned competing commands')
  state.jobs[0].deliver()
  assert(state.property === null && state.jobs.length === 1 && !state.owner.pending && !state.owner.owned,
    'Superseded read was followed by a stale property write')
})

test('read snapshot precedes mutation and disable drains apply before exact restoration', () => {
  const state = decorationFixture()
  state.owner.hide()
  state.jobs[0].deliver()
  assert(state.property === null && state.owner.owned.original === null && state.jobs.length === 2,
    'Original property was not recorded before starting the write')
  state.owner.stop()
  assert(state.property === null && state.requests.join(',') === 'read,replace,replace' && !state.owner.pending,
    'Disable did not drain apply and restore exact original absence')
  state.owner.hide()
  assert(state.jobs.length === 2, 'Stopped decoration restarted work')
})

test('disable during read does not start mutation and unmanaged drains an in-flight write', () => {
  const read = decorationFixture()
  read.owner.hide()
  read.owner.stop()
  assert(read.requests.join(',') === 'read' && !read.owner.owned && !read.owner.pending,
    'Disable acquired effects after a pending read')
  const apply = decorationFixture()
  apply.owner.hide()
  apply.jobs[0].deliver()
  apply.owner.stop(false)
  assert(apply.requests.join(',') === 'read,replace' && !apply.owner.pending,
    'Unmanaged owner abandoned an active command or tried to restore a gone window')
})

test('async foreign conflicts remain visible without another write or disabled callback', () => {
  const state = decorationFixture()
  state.owner.hide()
  state.jobs[0].deliver()
  state.property = { foreign: true }
  state.jobs[1].deliver()
  assert(state.reports.length === 1 && state.owner.conflicted && !state.owner.owned,
    'Async ownership conflict was hidden or retained false ownership')
  state.owner.stop()
  assert(state.property.foreign === true && state.requests.join(',') === 'read,replace', 'Teardown overwrote foreign state')
})

test('unmanaged drains a destroyed target during read or apply without restoring or retaining ownership', () => {
  for (const phase of ['read', 'apply']) {
    const state = decorationFixture()
    const original = { type: 71, format: 32, data: [3, 4, 1, 17, 42] }
    state.property = original
    state.owner.hide()
    if (phase === 'apply') state.jobs[0].deliver()
    state.response = { windowGone: true, xid: '0x7' }
    state.owner.stop(false)
    assert(!state.owner.pending && !state.owner.owned && state.reports.length === 0,
      'Gone unmanaged target retained a job/ownership or reported a spurious failure')
    assert(state.property === original && state.requests.join(',') === (phase === 'read' ? 'read' : 'read,replace'),
      'Gone unmanaged target triggered restoration or changed the original property')
    const jobs = state.jobs.length
    state.owner.hide()
    assert(state.jobs.length === jobs, 'Gone unmanaged target started another command')
  }
})

test('gone targets remain errors during normal completion and disable restoration', () => {
  const active = decorationFixture()
  active.owner.hide()
  active.response = { windowGone: true, xid: '0x7' }
  active.jobs[0].deliver()
  assert(active.reports.length === 1 && active.reports[0].message.includes('still managed'),
    'Normal completion hid a disappearing managed window')
  active.owner.stop(false)
  for (const phase of ['read', 'apply', 'restore']) {
    const state = decorationFixture()
    state.owner.hide()
    if (phase !== 'read') state.jobs[0].deliver()
    if (phase === 'restore') state.jobs[1].deliver()
    state.response = { windowGone: true, xid: '0x7' }
    const error = throws(() => state.owner.stop(), 'Disable hid a gone target without unmanaged proof')
    assert(error.message.includes('still managed') && !state.owner.pending,
      'Disable failed to expose the gone target or retained the in-flight command')
  }
})

test('unmanaged rejects malformed gone results, unrelated errors and ownership conflicts', () => {
  for (const response of [{ windowGone: true, xid: '0x8' }, { windowGone: false, xid: '0x7' },
    { windowGone: true, xid: '0x7', changed: false }, { windowGone: true, xid: '0x7', value: null },
    { windowGone: true, xid: '0x7', type: 71 }]) {
    const state = decorationFixture()
    state.owner.hide()
    state.jobs[0].deliver()
    state.response = response
    assert(throws(() => state.owner.stop(false), 'Unmanaged accepted an invalid gone response').message.includes('Invalid gone-window'),
      'Malformed or wrong-target response was not diagnosed')
    assert(state.owner.owned && !state.owner.pending, 'Invalid gone response discarded uncertain ownership or retained a job')
  }
  for (const message of ['X11 error 5', 'Ownership conflict: foreign change']) {
    const state = decorationFixture()
    state.owner.hide()
    state.jobs[0].deliver()
    state.failure = new Error(message)
    assert(throws(() => state.owner.stop(false), 'Unmanaged hid an unrelated error').message === message,
      'Unmanaged changed an unrelated diagnostic')
    assert(!state.owner.pending && state.property === null, 'Unmanaged retained work or overwrote foreign state')
    assert(state.owner.conflicted === message.startsWith('Ownership conflict:'), 'Ownership conflict classification changed')
  }
})

test('normal output collection is asynchronous for large binary stdout and failed stderr', () => {
  const cases = [
    { code: 'import sys; sys.stdout.buffer.write(bytes([0,255,254,13,10])*200000)', binary: true,
      verify(error, output) { assert(!error && output.length === 1000000 && output[1] === 255 && output[2] === 254, 'Binary stdout changed') } },
    { code: 'import sys; sys.stderr.write("diagnostic"*100000); sys.exit(7)', index: 2,
      verify(error) { assert(error?.message.includes('status 7') && error.message.endsWith('diagnostic'), 'Failed stderr/status changed') } },
    { code: 'print("not-json")', decode: JSON.parse,
      verify(error) { assert(error instanceof SyntaxError, 'Asynchronous decode failure disappeared') } }
  ]
  for (const entry of cases) {
    const job = new ProcessJob(['/usr/bin/timeout', '--foreground', '--signal=KILL', '1s',
      '/usr/bin/python3', '-I', '-c', entry.code], '', entry.decode, entry.binary)
    const directory = job.directory
    job.files[entry.index || 1].load_contents = () => { throw new Error('Normal completion used a synchronous read') }
    let done = false
    let observed
    job.watch((error, output) => { observed = { error, output }; done = true })
    turnUntil(() => done)
    entry.verify(observed.error, observed.output)
    assert(!directory.query_exists(null) && !job.read && !job.callback && !job.process, 'Normal completion retained IPC or delivery')
    throws(() => job.finish(), 'Completed command was consumed twice')
  }
})

test('synchronous drain during an output read detaches delivery and preserves exact bytes', () => {
  const job = new ProcessJob(['/usr/bin/printf', 'pending-output'])
  const directory = job.directory
  const file = job.files[1]
  let finished = false
  const finish = file.load_contents_finish.bind(file)
  file.load_contents_finish = result => { try { return finish(result) } finally { finished = true } }
  let callbacks = 0
  job.watch(() => callbacks++)
  turnUntil(() => job.read !== null)
  const read = job.read
  const cancellable = read.cancellable
  assert(job.finish() === 'pending-output', 'Draining lost the pending output')
  assert(cancellable.is_cancelled() && read.receive === null && !directory.query_exists(null), 'Drain did not detach and clean')
  turnUntil(() => finished)
  assert(callbacks === 0 && !job.process && !job.callback && !job.read, 'A late result reached the drained command')
})

print(`PROCESS_JOBS_PASS scenarios=${passed}`)
