/** Evaluate a retained native window policy without acquiring desktop services.
 * @param {string} policy Native schema enum nick.
 * @param {object} window Current window/monitor state, read for this decision.
 * @returns {boolean} Whether this window receives the selected effect.
 */
export function windowPolicyApplies(policy, window) {
  if (policy === 'never') return false
  const eligible = window.primaryScreen || !window.restrictToPrimary
  switch (policy) {
    case 'always': return eligible
    case 'tiled': return eligible && window.tiled
    case 'maximized': return eligible && window.maximized
    case 'both': return eligible && window.anyMaximized
  }
  throw new Error(`Unknown window policy: ${policy}`)
}

/** One presentation decision shared by every panel invalidation path. */
export function isWindowControlsVisible({ overviewVisible, appRunning, window }) {
  return Boolean(!overviewVisible && appRunning && window?.hasFocus &&
    !window.skipTaskbar && window.showButtons)
}
