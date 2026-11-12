import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import St from 'gi://St'
import { runCleanup } from './resources.js'
import { FileRead } from './file-reads.js'

// St 50/51 inherits the stage theme: there is no per-widget theme override.
// Constrain each matched target without changing its ancestor/combinator chain.
const whitespace = character => /[\t\n\f\r ]/.test(character)
const nameCharacter = character => /[\w\-\u0080-\uffff]/.test(character)
function invalid(message) { throw new Error(`Invalid control stylesheet: ${message}`) }

function escapeEnd(text, start, continuation = false) {
  let index = start + 1
  if (index === text.length) invalid('unfinished escape')
  if (!continuation && /[\r\n\f]/.test(text[index])) invalid('escaped newline outside a string')
  if (/[\da-f]/i.test(text[index])) {
    const first = index
    while (index < text.length && index - first < 6 && /[\da-f]/i.test(text[index])) index++
    if (index < text.length && whitespace(text[index])) {
      if (text[index++] === '\r' && text[index] === '\n') index++
    }
    return index
  }
  return text[index] === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1
}

function unescape(text) {
  let result = ''
  for (let index = 0; index < text.length;) {
    if (text[index] !== '\\') { result += text[index++]; continue }
    const end = escapeEnd(text, index, true)
    const value = text.slice(index + 1, end)
    if (/^[\da-f]/i.test(value)) {
      const code = parseInt(value.trim(), 16)
      if (!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) invalid('invalid escaped code point')
      result += String.fromCodePoint(code)
    } else if (!/^[\r\n\f]/.test(value)) result += value
    index = end
  }
  return result
}

function commentEnd(text, start) {
  const end = text.indexOf('*/', start + 2)
  if (end < 0) invalid('unterminated comment')
  return end + 2
}

function stringEnd(text, start) {
  const quote = text[start]
  for (let index = start + 1; index < text.length;) {
    if (text[index] === quote) return index + 1
    if (/[\r\n\f]/.test(text[index])) invalid('newline in quoted string')
    index = text[index] === '\\' ? escapeEnd(text, index, true) : index + 1
  }
  invalid('unterminated string')
}

function triviaEnd(text, start) {
  let index = start
  while (index < text.length) {
    if (whitespace(text[index])) index++
    else if (text.startsWith('/*', index)) index = commentEnd(text, index)
    else break
  }
  return index
}

function nameEnd(text, start) {
  let index = start
  while (index < text.length) {
    if (text[index] === '\\') index = escapeEnd(text, index)
    else if (nameCharacter(text[index])) index++
    else break
  }
  return index
}

function identifierEnd(text, start) {
  let first = start
  if (text[first] === '-') first++
  if (first >= text.length || !/[_a-zA-Z\u0080-\uffff\\-]/.test(text[first])) invalid('expected CSS identifier')
  return nameEnd(text, start)
}

// Return a top-level delimiter, respecting all quoted/escaped delimiters.
function boundary(text, start, delimiters) {
  const stack = []
  for (let index = start; index < text.length;) {
    const character = text[index]
    if (text.startsWith('/*', index)) { index = commentEnd(text, index); continue }
    if (character === '"' || character === "'") { index = stringEnd(text, index); continue }
    if (character === '\\') { index = escapeEnd(text, index); continue }
    if (!stack.length && delimiters.includes(character)) return index
    if (character === '(' || character === '[') stack.push(character)
    else if (character === ')' || character === ']') {
      if (stack.pop() !== (character === ')' ? '(' : '[')) invalid('unbalanced grouping')
    } else if (character === '{' || character === '}') invalid('unexpected nested block')
    index++
  }
  if (stack.length) invalid('unclosed grouping')
  return text.length
}

// libcroco recovers from malformed selectors and can still report success.
// Validate compound/token grammar before trusting the native stylesheet parser.
function validateSelector(text) {
  let index = triviaEnd(text, 0)
  while (index < text.length) {
    let compound = false
    if (text[index] === '*') { index++; compound = true }
    else if (/[_a-zA-Z\u0080-\uffff\\-]/.test(text[index])) {
      index = identifierEnd(text, index); compound = true
    }
    while (index < text.length) {
      if (text.startsWith('/*', index)) { index = commentEnd(text, index); continue }
      if (text[index] === '.' || text[index] === '#') {
        index = identifierEnd(text, index + 1)
      } else if (text[index] === ':') {
        index++
        if (text[index] === ':') index++
        index = identifierEnd(text, index)
        if (text[index] === '(') {
          const end = boundary(text, index + 1, ');')
          if (text[end] !== ')' || triviaEnd(text, index + 1) === end) invalid('invalid pseudo-class function')
          index = end + 1
        }
      } else if (text[index] === '[') {
        index = triviaEnd(text, identifierEnd(text, triviaEnd(text, index + 1)))
        if (text[index] !== ']') {
          if ('~|^$*'.includes(text[index]) && text[index + 1] === '=') index += 2
          else if (text[index] === '=') index++
          else invalid('invalid attribute operator')
          index = triviaEnd(text, index)
          index = text[index] === '"' || text[index] === "'" ? stringEnd(text, index) : identifierEnd(text, index)
          index = triviaEnd(text, index)
        }
        if (text[index] !== ']') invalid('invalid attribute selector')
        index++
      } else break
      compound = true
    }
    if (!compound) invalid('empty selector compound')
    const previous = index
    index = triviaEnd(text, index)
    if (index === text.length) return
    if ('>+~'.includes(text[index])) {
      index = triviaEnd(text, index + 1)
      if (index === text.length) invalid('trailing combinator')
    } else if (index === previous) invalid('invalid selector token')
  }
  invalid('empty selector')
}

function scopedSelector(selector, scope) {
  validateSelector(selector)
  let end = 0
  let pseudoElement = null
  let combinator = true
  let separated = false
  const stack = []
  for (let index = 0; index < selector.length;) {
    const character = selector[index]
    if (selector.startsWith('/*', index)) { index = commentEnd(selector, index); continue }
    if (whitespace(character)) { if (!stack.length) separated = true; index++; continue }
    if (separated && !stack.length) { pseudoElement = null; separated = false }
    if (character === '"' || character === "'") index = stringEnd(selector, index)
    else if (character === '\\') index = escapeEnd(selector, index)
    else {
      if (!stack.length && '>+~'.includes(character)) {
        if (combinator) invalid('leading or repeated combinator')
        combinator = true; pseudoElement = null; end = ++index; continue
      }
      if (!stack.length && selector.startsWith('::', index) && pseudoElement === null) pseudoElement = index
      if (character === '(' || character === '[') stack.push(character)
      else if (character === ')' || character === ']') {
        if (stack.pop() !== (character === ')' ? '(' : '[')) invalid('unbalanced selector')
      }
      index++
    }
    end = index
    combinator = false
  }
  if (stack.length || !end || combinator) invalid('empty selector or trailing combinator')
  const insertion = pseudoElement ?? end
  return selector.slice(0, insertion) + `.${scope}` + selector.slice(insertion)
}

function selectorList(text, scope) {
  const selectors = []
  for (let start = 0;;) {
    const end = boundary(text, start, ',')
    selectors.push(scopedSelector(text.slice(start, end), scope))
    if (end === text.length) return selectors.join(',')
    start = end + 1
  }
}

function urlToken(text, start) {
  let index = triviaEnd(text, start + 1)
  let value
  if (text[index] === '"' || text[index] === "'") {
    const end = stringEnd(text, index)
    value = unescape(text.slice(index + 1, end - 1))
    index = triviaEnd(text, end)
  } else {
    const first = index
    while (index < text.length && text[index] !== ')' && !whitespace(text[index])) {
      if (text.startsWith('/*', index) || /["'(]/.test(text[index])) invalid('invalid unquoted URL')
      index = text[index] === '\\' ? escapeEnd(text, index) : index + 1
    }
    value = unescape(text.slice(first, index))
    index = triviaEnd(text, index)
  }
  if (text[index] !== ')') invalid('unterminated URL')
  return { value, end: index + 1 }
}

const quoted = value => `"${value.replace(/[\\"]/g, '\\$&')}"`
function resolve(base, value) {
  return GLib.uri_parse_scheme(value) ? Gio.File.new_for_uri(value)
    : base.get_parent().resolve_relative_path(value)
}

function rewriteUrls(text, base) {
  let result = ''
  for (let index = 0; index < text.length;) {
    let end
    if (text.startsWith('/*', index)) end = commentEnd(text, index)
    else if (text[index] === '"' || text[index] === "'") end = stringEnd(text, index)
    else if (nameCharacter(text[index]) || text[index] === '\\') {
      end = nameEnd(text, index)
      if (unescape(text.slice(index, end)).toLowerCase() === 'url' && text[end] === '(') {
        const token = urlToken(text, end)
        result += `url(${quoted(resolve(base, token.value).get_uri())})`
        index = token.end
        continue
      }
    } else end = index + 1
    result += text.slice(index, end)
    index = end
  }
  return result
}

function declarations(text) {
  for (let index = triviaEnd(text, 0); index < text.length;) {
    if (text[index] === ';') { index = triviaEnd(text, index + 1); continue }
    const name = identifierEnd(text, index)
    const colon = triviaEnd(text, name)
    if (name === index || text[colon] !== ':') invalid('declaration requires a property and colon')
    const end = boundary(text, colon + 1, ';')
    if (triviaEnd(text, colon + 1) >= end) invalid('empty declaration value')
    index = triviaEnd(text, end + 1)
  }
}

function mediaList(text) {
  let index = triviaEnd(text, 0)
  if (index === text.length) return
  while (index < text.length) {
    index = triviaEnd(text, identifierEnd(text, index))
    if (index === text.length) return
    if (text[index] !== ',') invalid('invalid import media list')
    index = triviaEnd(text, index + 1)
  }
  invalid('trailing import media comma')
}

export function scopeStylesheet(text, scope, base, imported) {
  if (!/^[a-zA-Z_][\w-]*$/.test(scope)) invalid('unsafe ownership class')
  if (text.includes('\0')) invalid('NUL character')
  let result = text.startsWith('\ufeff') ? '\ufeff' : ''
  let index = result.length
  while (index < text.length) {
    const first = triviaEnd(text, index)
    result += text.slice(index, first)
    if (first === text.length) break
    const end = boundary(text, first, '{;}')
    if (text[first] === '@') {
      const keywordEnd = nameEnd(text, first + 1)
      const keyword = unescape(text.slice(first + 1, keywordEnd)).toLowerCase()
      if (text[end] !== ';' || !['import', 'charset'].includes(keyword)) invalid(`unsupported @${keyword} rule`)
      if (keyword === 'charset') {
        const start = triviaEnd(text, keywordEnd)
        if (!['"', "'"].includes(text[start]) || triviaEnd(text, stringEnd(text, start)) !== end) invalid('invalid charset rule')
        result += text.slice(first, end + 1)
      }
      else {
        let start = triviaEnd(text, keywordEnd)
        let token
        if (text[start] === '"' || text[start] === "'") {
          const finish = stringEnd(text, start)
          token = { value: unescape(text.slice(start + 1, finish - 1)), end: finish }
        } else {
          const finish = nameEnd(text, start)
          if (unescape(text.slice(start, finish)).toLowerCase() !== 'url' || text[finish] !== '(') invalid('import requires a URL')
          token = urlToken(text, finish)
        }
        // St 50/51 resolves import rules in place, regardless of a media suffix.
        const media = text.slice(token.end, end)
        mediaList(media)
        result += `@import url(${quoted(imported(resolve(base, token.value)).get_uri())})${media};`
      }
      index = end + 1
    } else {
      if (text[end] !== '{') invalid('ruleset requires a declaration block')
      const close = boundary(text, end + 1, '}')
      if (close === text.length) invalid('unclosed declaration block')
      const body = text.slice(end + 1, close)
      declarations(body)
      result += selectorList(text.slice(first, end), scope) + '{' + rewriteUrls(body, base) + '}'
      index = close + 1
    }
  }
  return result
}

// Preparation owns only input bytes and parsing state, never a stylesheet store.
// Each native read is detached before cancellation; no later completion can
// resume this traversal or reach its disposed presentation owner.
export class StylesheetPreparation {
  constructor(path, scope, receive) {
    const file = Gio.File.new_for_path(path)
    this.scope = scope
    this.receive = receive
    this.records = new Map()
    this.active = new Set([file.get_uri()])
    this.frames = [{ file, imports: null, index: 0 }]
    this.read = null
    try { this._advance() } catch (error) { this.cancel(); throw error }
  }

  _advance() {
    while (this.frames.length) {
      const frame = this.frames[this.frames.length - 1]
      if (frame.imports === null) {
        this.read = new FileRead(frame.file, this._loaded.bind(this, frame))
        return
      }
      if (frame.index < frame.imports.length) {
        const file = frame.imports[frame.index++]
        const uri = file.get_uri()
        if (this.active.has(uri)) throw new Error(`Cyclic control stylesheet import: ${uri}`)
        if (this.records.has(uri)) continue
        this.active.add(uri)
        this.frames.push({ file, imports: null, index: 0 })
      } else {
        this.active.delete(frame.file.get_uri())
        this.frames.pop()
      }
    }
    return true
  }

  _loaded(frame, error, bytes) {
    this.read = null
    if (error) { this._finish(error); return }
    let complete = false
    try {
      frame.imports = []
      // Use the same token-aware parser as compilation, preserving lexical bases.
      scopeStylesheet(new TextDecoder('utf-8', { fatal: true }).decode(bytes), this.scope, frame.file, file => {
        frame.imports.push(file)
        return file
      })
      this.records.set(frame.file.get_uri(), bytes)
      complete = this._advance()
    } catch (failure) { this._finish(failure); return }
    if (complete) this._finish(null)
  }

  _finish(error) {
    const receive = this.receive
    const records = this.records
    this.cancel()
    receive?.(error, error ? null : records)
  }

  cancel() {
    this.receive = null
    this.read?.cancel()
    this.read = this.records = null
    this.frames = []
    this.active.clear()
  }
}

// One store spans a feature activation. Content-addressed paths let native
// St.Theme reuse its opaque import cache across unchanged theme selections.
export class ScopedStylesheetStore {
  constructor() {
    this.directory = null
    this.files = new Map()
  }

  compile(path, scope, prepared = null) {
    const created = []
    try {
      if (!this.directory) this.directory = Gio.File.new_for_path(GLib.dir_make_tmp('unite-next-style-XXXXXX'))
      const records = new Map()
      const active = new Set()
      const validator = new St.Theme()
      const visit = file => {
        const uri = file.get_uri()
        // Native GFile URIs own lexical '..' resolution, even for aliases of the
        // same physical file/parent. Expanding symlink paths fail natively at ELOOP.
        if (active.has(uri)) throw new Error(`Cyclic control stylesheet import: ${uri}`)
        if (records.has(uri)) return records.get(uri)
        active.add(uri)
        const bytes = prepared ? prepared.get(uri) : file.load_contents(null)[1]
        if (!bytes) throw new Error(`Missing prepared control stylesheet: ${uri}`)
        const text = scopeStylesheet(new TextDecoder('utf-8', { fatal: true }).decode(bytes), scope, file, visit)
        active.delete(uri)
        // Distinct original sheets also retain distinct native cascade identities.
        const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, JSON.stringify([scope, uri, text]), -1)
        let staged = this.files.get(digest)
        if (!staged) {
          staged = this.directory.get_child(`${digest}.css`)
          const stream = staged.create(Gio.FileCreateFlags.PRIVATE, null)
          created.push([digest, staged])
          runCleanup([
            () => stream.write_all(new TextEncoder().encode(text), null),
            () => stream.close(null)
          ])
          // Validate every import before exposing any stylesheet to Shell.
          if (!validator.load_stylesheet(staged)) throw new Error('Native stylesheet validation failed')
          validator.unload_stylesheet(staged)
          this.files.set(digest, staged)
        }
        records.set(uri, staged)
        return staged
      }
      return visit(Gio.File.new_for_path(path))
    } catch (error) {
      runCleanup([
        () => { throw error },
        ...created.map(([digest, file]) => () => { this.files.delete(digest); file.delete(null) }),
        () => { if (!this.files.size) this.clear() }
      ])
    }
  }

  clear() {
    this.rollback(new Set())
  }

  rollback(retained) {
    const files = [...this.files].filter(([digest]) => !retained.has(digest))
    for (const [digest] of files) this.files.delete(digest)
    const directory = this.files.size ? null : this.directory
    if (directory) this.directory = null
    runCleanup([
      ...files.map(([, file]) => () => file.delete(null)),
      () => { if (directory) directory.delete(null) }
    ])
  }
}

export class ScopedStylesheet {
  constructor(path, scope, store = null) {
    this.path = path
    this.scope = scope
    this.ownsStore = store === null
    this.store = store || new ScopedStylesheetStore()
    this.file = this.loadedTheme = null
    this.transition = null
    this.roots = new Set()
  }

  load(theme, prepared = null) {
    if (this.file) throw new Error('Scoped stylesheet is already loaded')
    const retained = new Set(this.store.files.keys())
    try {
      this.file = this.store.compile(this.path, this.scope, prepared)
      this.roots.add(this.file)
      this.loadedTheme = theme
      if (!theme.load_stylesheet(this.file)) throw new Error('Native scoped stylesheet loading failed')
    } catch (error) {
      runCleanup([() => { throw error }, () => this.unload(theme), () => this.store.rollback(retained)])
    }
  }

  replace(theme, path, scope, prepared, presentation) {
    if (!this.file) throw new Error('Scoped stylesheet is not loaded')
    if (this.transition) throw new Error('Scoped stylesheet transition is already in progress')
    const retained = new Set(this.store.files.keys())
    const previous = this.file
    const owners = [...new Set([theme, this.loadedTheme])]
    const contains = (owner, file) => owner.get_custom_stylesheets().some(entry => entry.equal(file))
    const originalOwners = owners.filter(owner => contains(owner, previous))
    let next = null
    let acquired = false
    let applying = false
    const checkTheme = () => {
      if (presentation.currentTheme && presentation.currentTheme() !== theme)
        throw new Error('Native theme changed during scoped stylesheet transition')
    }
    try {
      next = this.store.compile(path, scope, prepared)
      this.roots.add(next)
      this.transition = { theme, file: next }
      if (!contains(theme, next)) {
        acquired = true
        if (!theme.load_stylesheet(next)) throw new Error('Native scoped stylesheet loading failed')
      }
      if (this.file !== previous) throw new Error('Scoped stylesheet owner was disposed during loading')
      checkTheme()
      applying = true
      presentation.apply()
      checkTheme()
      runCleanup(owners.filter(owner => owner !== theme || !next.equal(previous))
        .map(owner => () => owner.unload_stylesheet(previous)))
      if (this.file !== previous) throw new Error('Scoped stylesheet owner was disposed during transition')
      checkTheme()
      presentation.check?.()
      this.path = path
      this.scope = scope
      this.file = next
      this.loadedTheme = theme
    } catch (error) {
      let current = null
      let recoveryError = null
      try { current = presentation.currentTheme?.() } catch (failure) { recoveryError = failure }
      const recover = new Set([...originalOwners, ...(current ? [current] : [])])
      runCleanup([
        () => { throw error },
        () => { if (recoveryError) throw recoveryError },
        () => { if (applying) presentation.rollback() },
        ...[...new Set([theme, current])].filter(Boolean).map(owner => () => {
          if (next && (acquired || !next.equal(previous))) owner.unload_stylesheet(next)
        }),
        ...[...recover].map(owner => () => {
          if (this.file && !contains(owner, previous) && !owner.load_stylesheet(previous))
            throw new Error('Native scoped stylesheet restoration failed')
        }),
        () => this.store.rollback(retained)
      ])
    } finally { this.transition = null }
  }

  unload(theme) {
    const roots = [...this.roots]
    this.roots.clear()
    const transition = this.transition
    const themes = new Set([theme, this.loadedTheme, transition?.theme])
    this.transition = null
    this.file = this.loadedTheme = null
    runCleanup([
      ...[...themes].filter(Boolean).flatMap(owner => roots.map(file => () => owner.unload_stylesheet(file))),
      () => { if (this.ownsStore) this.store.clear() }
    ])
  }
}
