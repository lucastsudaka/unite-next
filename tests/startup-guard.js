// Test-tool precondition; native startup state is observed, never changed.
export function assertStartupPending(layoutManager) {
  if (layoutManager?._startingUp !== true) {
    throw new Error('Desktop acceptance requires native startup in progress before the startup-complete listener is installed')
  }
}
