import { addAbortListener } from 'node:events'
import type { Bytes, ByteStream } from './types.js'
import { HEADER_SIZE } from './wire.js'

const END: IteratorReturnResult<undefined> = Object.freeze({ done: true, value: undefined })

interface Item {
  bytes: Bytes
  release: () => void
}

interface Consumer {
  resolve: (result: IteratorResult<Bytes>) => void
  reject: (error: unknown) => void
}

export class IncomingStream implements AsyncIterableIterator<Bytes> {
  #queue: Array<Item | undefined> = []
  #head = 0
  #consumer: Consumer | undefined
  #terminal: typeof END | Error | undefined

  constructor(private readonly onStop: () => void) {}

  [Symbol.asyncIterator](): this {
    return this
  }

  next(): Promise<IteratorResult<Bytes>> {
    const item = this.#queue[this.#head]
    if (item) {
      this.#queue[this.#head++] = undefined
      if (this.#head === this.#queue.length) {
        this.#queue.length = 0
        this.#head = 0
      } else if (this.#head >= 32 && this.#head * 2 >= this.#queue.length) {
        this.#queue = this.#queue.slice(this.#head)
        this.#head = 0
      }
      item.release()
      return Promise.resolve({ done: false, value: item.bytes })
    }

    const terminal = this.#terminal
    if (terminal) return terminal === END ? Promise.resolve(END) : Promise.reject(terminal)
    if (this.#consumer) return Promise.reject(new Error('Only one RPC stream read may be pending'))
    return new Promise((resolve, reject) => {
      this.#consumer = { resolve, reject }
    })
  }

  return(): Promise<IteratorResult<Bytes>> {
    this.stop()
    return Promise.resolve(END)
  }

  stop(): void {
    const notify = !this.#terminal
    this.#finish(END)
    this.#discard()
    if (notify) this.onStop()
  }

  push(bytes: Bytes, release: () => void): void {
    if (this.#terminal) {
      release()
      return
    }
    const consumer = this.#consumer
    if (!consumer) {
      // Bound the backing storage of a queued view relative to its flow-control charge.
      if (bytes.buffer.byteLength > 4 * (bytes.byteLength + HEADER_SIZE)) {
        const compact = Buffer.allocUnsafeSlow(bytes.byteLength)
        compact.set(bytes)
        bytes = compact
      }
      this.#queue.push({ bytes, release })
      return
    }
    this.#consumer = undefined
    consumer.resolve({ done: false, value: bytes })
    release()
  }

  end(): void {
    if (!this.#terminal) this.#finish(END)
  }

  fail(error: Error, discard = false): void {
    if (!this.#terminal) this.#finish(error)
    if (discard) this.#discard()
  }

  #discard(): void {
    const queue = this.#queue
    this.#queue = []
    this.#head = 0
    for (const item of queue) item?.release()
  }

  #finish(terminal: typeof END | Error): void {
    this.#terminal = terminal
    const consumer = this.#consumer
    this.#consumer = undefined
    if (terminal === END) consumer?.resolve(END)
    else consumer?.reject(terminal)
  }
}

export async function pump(
  source: ByteStream,
  signal: AbortSignal,
  send: (bytes: Bytes) => void | Promise<void>,
  onCleanup?: (cleanup: Promise<unknown>) => void,
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]()
  let completed = false
  let wakeOnAbort: (() => void) | undefined
  const abort = () => wakeOnAbort?.()

  function untilAbort<T>(operation: Promise<T>): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      wakeOnAbort = () => resolve(undefined)
      // Each operation gets its own abort hook so settled reads release their callbacks.
      Promise.resolve(operation).then(resolve, reject)
      if (signal.aborted) abort()
    })
  }

  const abortListener = addAbortListener(signal, abort)
  try {
    while (!signal.aborted) {
      const result = await untilAbort(iterator.next())
      if (!result || signal.aborted) break
      if (result.done) {
        completed = true
        return
      }
      const sent = send(result.value)
      if (sent) await untilAbort(sent)
    }
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    abortListener[Symbol.dispose]()
    if (!completed) {
      try {
        const cleanup = Promise.resolve(iterator.return?.()).catch(() => {})
        onCleanup?.(cleanup)
      } catch {
        // An abandoned producer cannot delay the call's cleanup.
      }
    }
  }
}
