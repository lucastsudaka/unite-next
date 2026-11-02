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
}

export class ServerDecorations {
  constructor({ xid, win }, { request, border }) {
    this.request = request
    this.border = border
    this.xid = xid
    this.win = win
    this.owned = null
    this.conflicted = false
  }

  get decorated() {
    return this.win.get_frame_type() !== this.border
  }

  get handle() {
    return this.win.decorated
  }

  show() {
    this.reset()
  }

  hide() {
    if (!this.handle || !this.decorated || this.owned || this.conflicted) return
    const result = this.request({ operation: 'read', xid: this.xid })
    const original = result.value
    // Type atoms are server-local and remain valid for this window's lifetime.
    const value = original ? { ...original, data: [...original.data] } :
      { type: result.type, format: 32, data: [2, 0, 2, 0, 0] }
    this.owned = { original, value }
    if (original) {
      value.data[0] = (value.data[0] | 2) >>> 0
      value.data[2] = 2
    }
    try {
      const applied = this.request({ operation: 'replace', xid: this.xid,
        expected: original, value: this.owned.value })
      if (!applied.changed) this.owned = null
    } catch (error) {
      if (error.message.includes('Ownership conflict:')) {
        this.owned = null
        this.conflicted = true
      }
      throw error
    }
  }

  reset() {
    if (!this.owned) return
    const { original, value } = this.owned
    try {
      this.request({ operation: 'replace', xid: this.xid, expected: value, value: original })
      this.owned = null
    } catch (error) {
      if (error.message.includes('Ownership conflict:')) {
        this.owned = null
        this.conflicted = true
      }
      throw error
    }
  }
}
