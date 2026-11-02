export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function throws(callback, message) {
  try { callback() } catch (error) { return error }
  throw new Error(message)
}
