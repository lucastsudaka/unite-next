import { runCleanup } from './resources.js'

// Exact Motif ownership; the native transport and border type are explicit dependencies.
export class ClientDecorations {
  show() {
    return false
  }

  hide() {
    return false
  }

  reset() {
    return false
  }

  stop(reset = true) {
    if (reset) this.reset()
  }
}

export class ServerDecorations {
  constructor({ xid, win }, { request, start, border, report = error => console.error(error) }) {
    this.request = request
    this.start = start
    this.report = report
    this.border = border
    this.xid = xid
    this.win = win
    this.owned = null
    this.conflicted = false
    this.pending = null
    this.hidden = false
    this.stopping = false
    this.stopped = false
    this.unmanaged = false
  }

  get decorated() {
    return this.win.get_frame_type() !== this.border
  }

  get handle() {
    return this.win.decorated
  }

  show() {
    this.hidden = false
    this._sync()
  }

  hide() {
    this.hidden = true
    this._sync()
  }

  _snapshot(result) {
    const original = result.value
    // Type atoms are server-local and remain valid for this window's lifetime.
    const value = original ? { ...original, data: [...original.data] } :
      { type: result.type, format: 32, data: [2, 0, 2, 0, 0] }
    this.owned = { original, value }
    if (original) {
      value.data[0] = (value.data[0] | 2) >>> 0
      value.data[2] = 2
    }
  }

  _failure(error) {
    if (error.message.includes('Ownership conflict:')) {
      this.owned = null
      this.conflicted = true
    }
    throw error
  }

  _accept(result, accept) {
    if (result?.windowGone !== undefined) {
      if (result.windowGone !== true || result.xid !== this.xid || Object.keys(result).length !== 2) {
        throw new Error('Invalid gone-window Motif response')
      }
      // Only the native unmanaged signal proves this owner no longer has a
      // window to restore. A disappearing target during normal work is an error.
      if (!this.unmanaged) throw new Error(`Motif window ${this.xid} disappeared while still managed`)
      this.owned = null
      return false
    }
    return accept(result)
  }

  _begin(request, accept) {
    const pending = { job: null, accept }
    this.pending = pending
    try {
      pending.job = this.start(request, (error, result) => {
        this.pending = null
        try {
          if (error) this._failure(error)
          if (this._accept(result, accept) !== false) this._sync()
        } catch (failure) {
          this.report(failure)
        }
      })
    } catch (error) {
      this.pending = null
      this._failure(error)
    }
  }

  _sync() {
    if (this.pending || this.stopping || this.stopped || this.conflicted) return
    if (this.hidden && !this.owned && this.handle && this.decorated) {
      this._begin({ operation: 'read', xid: this.xid }, result => {
        if (this.hidden && !this.stopping && !this.stopped) this._snapshot(result)
      })
    } else if (!this.hidden && this.owned) {
      const { original, value } = this.owned
      this._begin({ operation: 'replace', xid: this.xid, expected: value, value: original }, () => { this.owned = null })
    } else if (this.hidden && this.owned && !this.owned.attempted) {
      const { original, value } = this.owned
      // A failed response cannot prove that the child did not mutate X11.
      this.owned.attempted = true
      this._begin({ operation: 'replace', xid: this.xid, expected: original, value }, result => {
        if (result.changed) this.owned.applied = true
        else this.owned = null
        return !this.hidden
      })
    }
  }

  flush() {
    while (this.pending) {
      const pending = this.pending
      this.pending = null
      try {
        if (this._accept(pending.job.finish(), pending.accept) !== false) this._sync()
      } catch (error) { this._failure(error) }
    }
  }

  reset() {
    this.hidden = false
    this.stopping = true
    try {
      runCleanup([
        () => this.flush(),
        () => {
          if (!this.owned) return
          const { original, value } = this.owned
          try {
            const result = this.request({ operation: 'replace', xid: this.xid, expected: value, value: original })
            this._accept(result, () => { this.owned = null })
          } catch (error) { this._failure(error) }
        }
      ])
    } finally {
      this.stopping = false
    }
  }

  stop(reset = true) {
    this.stopped = true
    if (reset) this.reset()
    else {
      this.unmanaged = true
      this.flush()
    }
  }
}
