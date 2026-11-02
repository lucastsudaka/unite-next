// REQ-LIFE-001/002: actual ESM lifecycle state and real owned setting signals.
import GLib from 'gi://GLib'
import { Feature, Features } from '../unite-next@lucastsudaka.github.io/features.js'
import { Settings } from '../unite-next@lucastsudaka.github.io/settings.js'
import { assert, throws } from './assert.js'

assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Run with disposable HOME/XDG/settings state')
let passed = 0
function test(name, callback) { callback(); passed++; print(`PASS ${name}`) }
function fixture(values = { first: true, second: true }) {
  let serial = 0
  const listeners = new Map()
  const source = {
    exists: key => key in values,
    getSetting: key => values[key],
    connect(name, callback) { const id = ++serial; listeners.set(id, { name, callback }); return id },
    disconnect(id) { assert(listeners.delete(id), 'Disconnected an unowned native handler') }
  }
  const context = { settings: { extension: source } }
  const owner = new Features(context)
  const calls = []
  const instances = []
  const initialKeys = []
  const failures = {}
  function add(key) {
    class TestFeature extends Feature {
      constructor(ctx) {
        super(ctx, key, value => value)
        instances.push(this)
        initialKeys.push(Object.keys(this).join(','))
      }
      activate() { calls.push(`${key}:activate`); if (failures[`${key}:activate`]) throw failures[`${key}:activate`] }
      destroy() { calls.push(`${key}:destroy`); if (failures[`${key}:destroy`]) throw failures[`${key}:destroy`] }
    }
    owner.add(TestFeature)
  }
  function set(key, value) {
    values[key] = value
    for (const entry of [...listeners.values()]) if (entry.name === `changed::${key}`) entry.callback(source)
  }
  return { owner, add, set, calls, instances, initialKeys, listeners, failures, source, context }
}

test('ordered lifecycle keeps transition state off feature instances', () => {
  const state = fixture()
  state.add('first'); state.add('second')
  state.owner.activate()
  assert(state.calls.join(',') === 'first:activate,second:activate', 'Activation order changed')
  state.set('first', true)
  assert(state.calls.length === 2, 'Unchanged setting reacquired resources')
  state.set('first', false); state.set('first', false); state.set('first', true)
  state.owner.destroy(); state.owner.destroy()
  assert(state.calls.join(',') === 'first:activate,second:activate,first:destroy,first:activate,first:destroy,second:destroy',
    'Toggle, cleanup order or exactly-once release changed')
  assert(state.instances.every((instance, index) => Object.keys(instance).join(',') === state.initialKeys[index]),
    'Manager injected lifecycle methods/state onto features')
  assert(state.listeners.size === 0, 'Disabled manager retains settings observers')
})

test('settings-driven partial acquisition unwinds immediately and permits later recovery', () => {
  const state = fixture({ first: false })
  const original = new Error('partial activation failed')
  state.add('first'); state.owner.activate()
  state.failures['first:activate'] = original
  assert(throws(() => state.set('first', true), 'Partial failure disappeared') === original, 'Original activation error changed')
  assert(state.calls.join(',') === 'first:activate,first:destroy', 'Partial resource rollback was skipped')
  delete state.failures['first:activate']
  state.set('first', true)
  state.owner.destroy()
  assert(state.calls.join(',') === 'first:activate,first:destroy,first:activate,first:destroy' && state.listeners.size === 0,
    'Recovery leaked or duplicated lifecycle resources')
})

test('failed initial activation leaves earlier owners releasable in registration order', () => {
  const state = fixture()
  const original = new Error('second activation failed')
  state.add('first'); state.add('second')
  state.failures['second:activate'] = original
  assert(throws(() => state.owner.activate(), 'Initial failure disappeared') === original, 'Initial error changed')
  assert(state.calls.join(',') === 'first:activate,second:activate,second:destroy', 'Failed acquisition was not rolled back')
  state.owner.destroy()
  assert(state.calls.join(',') === 'first:activate,second:activate,second:destroy,first:destroy' && state.listeners.size === 0,
    'Earlier ownership survived enclosing activation cleanup')
})

test('activation plus rollback failure preserves both errors and never releases twice', () => {
  const state = fixture({ first: true })
  const original = new Error('activation failed')
  const cleanup = new Error('rollback failed')
  state.add('first')
  state.failures['first:activate'] = original
  state.failures['first:destroy'] = cleanup
  const error = throws(() => state.owner.activate(), 'Both failures disappeared')
  assert(error.errors?.[0] === original && error.errors[1] === cleanup && error.cause === original,
    'Rollback replaced the original error/aggregate order')
  state.owner.destroy()
  assert(state.calls.join(',') === 'first:activate,first:destroy' && state.listeners.size === 0,
    'Failed cleanup was repeated or observers survived')
})

test('disconnect and feature cleanup failures do not skip independent owners', () => {
  const state = fixture()
  const disconnect = new Error('disconnect failed')
  const first = new Error('first cleanup failed')
  const second = new Error('second cleanup failed')
  state.add('first'); state.add('second'); state.owner.activate()
  state.source.disconnect = id => { assert(state.listeners.delete(id), 'Invalid disconnect'); if (id === 1) throw disconnect }
  state.failures['first:destroy'] = first
  state.failures['second:destroy'] = second
  const error = throws(() => state.owner.destroy(), 'Cleanup failures disappeared')
  assert(error.errors?.[0] === disconnect && error.errors[1] === first && error.errors[2] === second &&
    state.calls.join(',') === 'first:activate,second:activate,first:destroy,second:destroy' && state.listeners.size === 0,
  'Independent cleanup, aggregate order or original errors changed')
  state.owner.destroy()
  assert(state.calls.length === 4, 'Already released features were destroyed again')
})

test('unknown setting reads and subscriptions fail before acquiring a handler', () => {
  const state = fixture({})
  const settings = new Settings(state.context)
  assert(throws(() => settings.get('missing'), 'Unknown read succeeded').message.includes('missing'), 'Unknown read lost its key')
  assert(throws(() => settings.connect('missing', () => {}), 'Unknown subscription succeeded').message.includes('missing'),
    'Unknown subscription lost its key')
  settings.disconnectAll()
  assert(state.listeners.size === 0, 'Unknown subscription acquired a handler')
})

print(`FEATURE_TESTS_PASS scenarios=${passed}`)
