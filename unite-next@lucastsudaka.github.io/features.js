import { runCleanup } from './resources.js'
import { Settings } from './settings.js'

export class Feature {
  constructor(context, setting, predicate) {
    this.context = context
    this._settingsKey = setting
    this._checkActive = predicate
  }
}

// Entries own the synchronous inactive/active transition and rollback state;
// feature instances own only their activation resources and activate/destroy.
export class Features {
  constructor(context) {
    this.context = context
    this._entries = []
    this.settings = new Settings(context)
  }

  add(klass) {
    const feature = new klass(this.context)
    this._entries.push({
      feature,
      key: feature._settingsKey,
      predicate: feature._checkActive,
      active: false
    })
    return feature
  }

  _sync(entry) {
    const active = entry.predicate.call(null, this.settings.get(entry.key))
    if (active && !entry.active) {
      // Record ownership before acquisition so partial activation can unwind.
      entry.active = true
      try {
        entry.feature.activate()
      } catch (error) {
        runCleanup([() => { throw error }, () => this._destroy(entry)])
      }
    } else if (!active && entry.active) {
      this._destroy(entry)
    }
  }

  _destroy(entry) {
    if (entry.active) {
      // A release failure must not schedule a second release of the same owner.
      entry.active = false
      entry.feature.destroy()
    }
  }

  activate() {
    for (const entry of this._entries) {
      this.settings.connect(entry.key, () => this._sync(entry))
      this._sync(entry)
    }
  }

  destroy() {
    runCleanup([
      () => this.settings.disconnectAll(),
      ...this._entries.map(entry => () => this._destroy(entry))
    ])
  }
}
