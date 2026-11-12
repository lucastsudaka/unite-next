import Gio from 'gi://Gio'

// The native callback retains only this read. cancel() detaches the delivery
// before GIO queues its terminal completion, including an already-ready result.
function complete(read, file, result) {
  let bytes = null
  let error = null
  try { [, bytes] = file.load_contents_finish(result) } catch (failure) { error = failure }
  const receive = read.receive
  read.receive = read.cancellable = null
  receive?.(error, bytes)
}

export class FileRead {
  constructor(file, receive) {
    this.receive = receive
    this.cancellable = new Gio.Cancellable()
    try {
      file.load_contents_async(this.cancellable, complete.bind(null, this))
    } catch (error) {
      this.cancel()
      throw error
    }
  }

  cancel() {
    const cancellable = this.cancellable
    this.receive = this.cancellable = null
    cancellable?.cancel()
  }
}
