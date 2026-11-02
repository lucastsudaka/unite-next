import GLib from 'gi://GLib'

// This owner can load without Shell services; resources are acquired only by calls.
// Cleanup is a best-effort traversal, but failure is never a successful result.
export function runCleanup(callbacks) {
  const errors = []
  for (const callback of callbacks) {
    try {
      callback()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors,
    `Unite cleanup failed: ${errors.map(error => error.message).join('; ')}`, { cause: errors[0] })
}

export class Signals {
  constructor() {
    this.signals = new Map()
  }

  registerHandler(object, name, callback) {
    const uid = GLib.uuid_string_random()
    const key = `[signal ${name} uuid@${uid}]`

    this.signals.set(key, {
      object:   object,
      signalId: object.connect(name, callback)
    })

    return key
  }

  hasSignal(key) {
    return this.signals.has(key)
  }

  connect(object, name, callback) {
    return this.registerHandler(object, name, callback)
  }

  disconnect(key) {
    if (this.hasSignal(key)) {
      const data = this.signals.get(key)

      this.signals.delete(key)
      if (data.object != null) data.object.disconnect(data.signalId)
    }
  }

  disconnectMany(keys) {
    runCleanup(keys.map(key => () => this.disconnect(key)))
  }

  disconnectAll() {
    this.disconnectMany([...this.signals.keys()])
  }
}

export class Timeouts {
  constructor() {
    this.store = new Map()
  }

  register(addSource, callback) {
    const uid = GLib.uuid_string_random()
    const key = `[timeout uuid@${uid}]`

    const sourceId = addSource(() => {
      try {
        callback()
        return GLib.SOURCE_REMOVE
      } finally {
        this.store.delete(key)
      }
    })
    this.store.set(key, sourceId)

    return key
  }

  idle(callback) {
    return this.register(
      handler => GLib.idle_add(GLib.PRIORITY_DEFAULT, handler), callback
    )
  }

  timeout(time, callback) {
    return this.register(
      handler => GLib.timeout_add(GLib.PRIORITY_DEFAULT, time, handler), callback
    )
  }

  remove(key) {
    if (this.store.has(key)) {
      const sourceId = this.store.get(key)
      this.store.delete(key)
      GLib.source_remove(sourceId)
    }
  }

  removeAll() {
    runCleanup([...this.store.keys()].map(key => () => this.remove(key)))
  }
}
