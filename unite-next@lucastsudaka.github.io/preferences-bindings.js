export function enumChoices(_) {
  const states = [
    ['never', _('Never')], ['tiled', _('Tiled')], ['maximized', _('Maximized')],
    ['both', _('Both')], ['always', _('Always')]
  ]

  return {
    'show-window-title': states,
    'show-window-buttons': states,
    'hide-window-titlebars': states,
    'notifications-position': [['center', _('Center')], ['left', _('Left')], ['right', _('Right')]],
    'hide-activities-button': [['never', _('Never')], ['auto', _('Auto')], ['always', _('Always')]],
    'window-buttons-placement': [
      ['auto', _('Auto')], ['left', _('Left')], ['right', _('Right')],
      ['first', _('First')], ['last', _('Last')]
    ],
    'app-menu-ellipsize-mode': [['start', _('Start')], ['middle', _('Middle')], ['end', _('End')]]
  }
}

// REQ-PREF-001: keep choice IDs independent of model indices and translated labels.
// This module deliberately has no Shell or widget-library dependencies.
export function bindChoice(settings, key, row, values, onUnknown = null,
  { refresh: refreshChoices = null, watch: watchChoices = null } = {}) {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`Setting ${key} requires unique, nonempty choices`)
  }

  let updating = false
  let disposed = false
  let stopWatching = null
  const connections = []

  const syncValue = () => {
    if (disposed) return

    const value = settings.get_string(key)
    updating = true
    try {
      // Updating a native model can itself notify selection changes. Keep the
      // stored ID authoritative throughout discovery and model replacement.
      if (refreshChoices) refreshChoices()
      if (disposed) return
      let index = values.indexOf(value)
      if (index < 0 && onUnknown) index = onUnknown(value)
      if (!Number.isInteger(index) || index < 0 || values[index] !== value) {
        throw new Error(`No preference choice for ${key}: ${JSON.stringify(value)}`)
      }
      row.selected = index
    } finally {
      updating = false
    }
  }

  const syncWritable = () => {
    if (!disposed) row.sensitive = settings.is_writable(key)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (stopWatching) stopWatching()
    stopWatching = null
    for (const [object, id] of connections) object.disconnect(id)
    connections.length = 0
  }

  try {
    connections.push([settings, settings.connect(`changed::${key}`, syncValue)])
    connections.push([settings, settings.connect(`writable-changed::${key}`, syncWritable)])
    connections.push([row, row.connect('notify::selected', () => {
      if (disposed || updating) return

      const value = values[row.selected]
      if (value === undefined || !settings.is_writable(key)) {
        syncValue()
        return
      }

      if (value !== settings.get_string(key) && !settings.set_string(key, value)) {
        syncValue()
        throw new Error(`Failed to update setting ${key}`)
      }
      // A model choice may have become unavailable even when the stored ID did
      // not change. Refresh without treating the model's index as a new value.
      if (refreshChoices) syncValue()
    })])
    connections.push([row, row.connect('destroy', dispose)])
    syncValue()
    syncWritable()
    if (watchChoices) stopWatching = watchChoices(syncValue)
  } catch (error) {
    dispose()
    throw error
  }

  return dispose
}
