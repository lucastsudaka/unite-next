import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { runCleanup } from './resources.js'

// Callers provide an independently bounded command. GIO reaps it on its worker
// thread; the only JavaScript completion callback belongs to this removable source.
export class ProcessJob {
  constructor(argv, input = '', decode = output => output, binary = false) {
    this.decode = decode
    this.binary = binary
    this.directory = Gio.File.new_for_path(GLib.dir_make_tmp('unite-next-command-XXXXXX'))
    this.files = []
    this.source = 0
    this.process = null
    try {
      const paths = ['stdin', 'stdout', 'stderr'].map(name => {
        const file = this.directory.get_child(name)
        const stream = file.create(Gio.FileCreateFlags.PRIVATE, null)
        this.files.push(file)
        runCleanup([
          () => { if (name === 'stdin') stream.write_all(new TextEncoder().encode(input), null) },
          () => stream.close(null)
        ])
        return file.get_path()
      })
      const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE })
      launcher.set_stdin_file_path(paths[0])
      launcher.set_stdout_file_path(paths[1])
      launcher.set_stderr_file_path(paths[2])
      this.process = launcher.spawnv(argv)
    } catch (error) {
      runCleanup([() => { throw error }, () => this._clear()])
    }
  }

  watch(callback) {
    if (this.source || !this.process) throw new Error('Command completion already consumed or observed')
    try {
      this.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        if (this.process.get_identifier() !== null) return GLib.SOURCE_CONTINUE
        this.source = 0
        let output = null
        let error = null
        try { output = this.finish() } catch (failure) { error = failure }
        callback(error, output)
        return GLib.SOURCE_REMOVE
      })
    } catch (error) {
      runCleanup([() => { throw error }, () => this.finish()])
    }
    return this
  }

  finish() {
    if (this.source) GLib.source_remove(this.source)
    this.source = 0
    const process = this.process
    if (!process) throw new Error('Command completion already consumed')
    this.process = null
    let output = null
    runCleanup([
      () => {
        process.wait(null)
        const read = (index, fatal = false) => new TextDecoder('utf-8', { fatal }).decode(this.files[index].load_contents(null)[1])
        if (!process.get_successful()) {
          const status = process.get_if_exited() ? process.get_exit_status() : `signal ${process.get_term_sig()}`
          throw new Error(`Command failed (status ${status}): ${read(2).trim() || 'no diagnostic'}`)
        }
        output = this.binary ? this.files[1].load_contents(null)[1] : read(1, true)
      },
      () => this._clear()
    ])
    return this.decode(output)
  }

  _clear() {
    const files = this.files.splice(0)
    const directory = this.directory
    this.directory = null
    runCleanup([
      ...files.map(file => () => file.delete(null)),
      () => directory?.delete(null)
    ])
  }
}

// A transaction may yield bounded commands between local state transitions.
// Draining resumes those same transitions, including rollback/finally blocks.
export class ProcessSequence {
  constructor(iterator) {
    this.iterator = iterator
    this.job = null
    this.callback = null
    this.done = false
    this.result = null
  }

  _resume(value, error) {
    while (!this.done) {
      let step
      try {
        step = error ? this.iterator.throw(error) : this.iterator.next(value)
      } catch (failure) {
        this.done = true
        this.iterator = null
        throw failure
      }
      if (step.done) {
        this.done = true
        this.result = step.value
        this.iterator = null
        return
      }
      try {
        this.job = new ProcessJob(step.value.argv, step.value.input, step.value.decode, step.value.binary)
        return
      } catch (failure) {
        value = undefined
        error = failure
      }
    }
  }

  _watch() {
    if (!this.job) return
    const complete = (error, value) => {
      this.job = null
      let failure = null
      try { this._resume(value, error) } catch (caught) { failure = caught }
      if (failure || this.done) {
        const callback = this.callback
        this.callback = null
        callback(failure, this.result)
      } else {
        this._watch()
      }
    }
    try { this.job.watch(complete) } catch (error) { complete(error, undefined) }
  }

  watch(callback) {
    this.callback = callback
    try {
      this._resume()
      if (this.done) {
        this.callback = null
        callback(null, this.result)
      } else {
        this._watch()
      }
    } catch (error) {
      this.callback = null
      throw error
    }
    return this
  }

  finish() {
    this.callback = null
    while (!this.done) {
      let value
      let error = null
      if (this.job) {
        const job = this.job
        this.job = null
        try { value = job.finish() } catch (failure) { error = failure }
      }
      this._resume(value, error)
    }
    return this.result
  }
}
