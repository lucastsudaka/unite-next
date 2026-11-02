// REQ-FEATURE-003 / REQ-PREF-002: independent policy and eligibility tables.
import {
  windowPolicyApplies,
  isWindowControlsVisible
} from '../unite-next@lucastsudaka.github.io/window-policy.js'
import { assert, throws } from './assert.js'

const rows = [
  { state: { tiled: false, maximized: false, anyMaximized: false }, expected: [false, false, false, false, true] },
  { state: { tiled: true, maximized: false, anyMaximized: true }, expected: [false, true, false, true, true] },
  { state: { tiled: false, maximized: true, anyMaximized: true }, expected: [false, false, true, true, true] }
]
const policies = ['never', 'tiled', 'maximized', 'both', 'always']
let cases = 0
for (const row of rows) {
  for (const [restrictToPrimary, primaryScreen] of [[false, false], [false, true], [true, true], [true, false]]) {
    policies.forEach((policy, index) => {
      const expected = restrictToPrimary && !primaryScreen ? false : row.expected[index]
      assert(windowPolicyApplies(policy, { ...row.state, restrictToPrimary, primaryScreen }) === expected,
        `Policy table mismatch: ${policy}/${restrictToPrimary}/${primaryScreen}/${JSON.stringify(row.state)}`)
      cases++
    })
  }
}
throws(() => windowPolicyApplies('invalid', rows[0].state), 'Unknown policy was silently accepted')
const eligible = { hasFocus: true, skipTaskbar: false, showButtons: true }
for (const [overviewVisible, appRunning, window, expected] of [
  [false, true, eligible, true], [true, true, eligible, false],
  [false, false, eligible, false], [false, true, undefined, false],
  [false, true, null, false], [false, true, { ...eligible, hasFocus: false }, false],
  [false, true, { ...eligible, skipTaskbar: true }, false],
  [false, true, { ...eligible, showButtons: false }, false]
]) {
  assert(isWindowControlsVisible({ overviewVisible, appRunning, window }) === expected,
    `Visibility table mismatch: ${overviewVisible}/${appRunning}/${JSON.stringify(window)}`)
  cases++
}
print(`WINDOW_POLICY_PASS cases=${cases + 1}`)
