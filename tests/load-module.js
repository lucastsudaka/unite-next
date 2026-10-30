import Gio from 'gi://Gio'

// Shell-only imports are injected at their boundary; GLib/Gio remain real.
export function loadModule(path, dependencies, names) {
  const [, bytes] = Gio.File.new_for_path(path).load_contents(null)
  const source = new TextDecoder().decode(bytes)
    .replace(/^import .+$/gm, '')
    .replace(/export default class /g, 'class ')
    .replace(/export /g, '')
  return new Function(...Object.keys(dependencies), `${source}\nreturn {${names.map(name => `${name}: typeof ${name} === 'undefined' ? undefined : ${name}`).join(',')}}`)(
    ...Object.values(dependencies))
}

export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function throws(callback, message) {
  try { callback() } catch (error) { return error }
  throw new Error(message)
}
