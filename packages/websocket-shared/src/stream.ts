interface QueueNode<Value> {
  readonly value: Value
  next?: QueueNode<Value>
}

interface Reader<Value> {
  resolve(result: IteratorResult<Value>): void
  reject(error: unknown): void
  next?: Reader<Value>
}

class Fifo<Node extends { next?: Node }> {
  private first?: Node
  private last?: Node

  push(node: Node): void {
    if (this.last) this.last.next = node
    else this.first = node
    this.last = node
  }

  shift(): Node | undefined {
    const node = this.first
    if (!node) return
    this.first = node.next
    if (!this.first) this.last = undefined
    return node
  }

  clear(): void {
    this.first = this.last = undefined
  }
}

export class WebSocketStreamQueue<Value> implements AsyncIterable<Value> {
  private readonly values = new Fifo<QueueNode<Value>>()
  private readonly readers = new Fifo<Reader<Value>>()
  private terminal?: { error?: { reason: unknown } }

  push(value: Value): void {
    if (this.terminal) return
    const reader = this.readers.shift()
    if (reader) return reader.resolve({ value, done: false })
    this.values.push({ value })
  }

  next(): Promise<IteratorResult<Value>> {
    const node = this.values.shift()
    if (node) return Promise.resolve({ value: node.value, done: false })
    if (this.terminal?.error) return Promise.reject(this.terminal.error.reason)
    if (this.terminal) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => { this.readers.push({ resolve, reject }) })
  }

  end(): void {
    if (this.terminal) return
    this.terminal = {}
    for (let reader = this.readers.shift(); reader; reader = this.readers.shift()) {
      reader.resolve({ value: undefined, done: true })
    }
  }

  discard(): void {
    this.values.clear()
    this.terminal = undefined
    this.end()
  }

  fail(reason: unknown, { drain = false }: { drain?: boolean } = {}): void {
    this.terminal = { error: { reason } }
    if (!drain) this.values.clear()
    for (let reader = this.readers.shift(); reader; reader = this.readers.shift()) {
      reader.reject(reason)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return { next: () => this.next() }
  }
}

export function waitWithAbort<Value>(work: PromiseLike<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    const cleanup = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve(work).then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

export async function pumpWebSocketStream<Value>(
  source: AsyncIterable<Value>,
  signal: AbortSignal,
  write: (value: Value) => void | Promise<void>,
): Promise<void> {
  signal.throwIfAborted()
  const iterator = source[Symbol.asyncIterator]()
  let ended = false
  let chunksThisTurn = 0
  let yieldTimer: ReturnType<typeof setTimeout> | undefined
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await waitWithAbort(iterator.next(), signal)
      signal.throwIfAborted()
      if (result.done) {
        ended = true
        return
      }
      const writing = write(result.value)
      if (writing) await waitWithAbort(writing, signal)
      if (++chunksThisTurn === 64) {
        chunksThisTurn = 0
        // An immediately ready producer must give the transport a turn to deliver replies and cancellation.
        const yielding = new Promise<void>((resolve) => {
          yieldTimer = setTimeout(resolve, 0)
        })
        await waitWithAbort(yielding, signal)
      }
    }
  } finally {
    clearTimeout(yieldTimer)
    if (!ended) void Promise.resolve().then(() => iterator.return?.()).catch(() => {})
  }
}
