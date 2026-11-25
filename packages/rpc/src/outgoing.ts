import { isAnyArrayBuffer, isUint8Array } from 'node:util/types'
import { observeAbort } from './abort.js'
import { deferred } from './deferred.js'
import type { Deferred } from './deferred.js'
import { byteBody, frame, invalidProtocol, openFrame, readError } from './messages.js'
import type { MessageModem } from './modem.js'
import { IncomingStream, pump } from './stream.js'
import { RpcError, RpcMode } from './types.js'
import type { Bytes, RpcCallOptions } from './types.js'
import { EMPTY, FrameType } from './wire.js'
import type { Frame } from './wire.js'

interface Call {
  id: number
  result?: Deferred<Bytes>
  output?: IncomingStream
  upload?: AbortController
  uploadEnded: boolean
  opened: boolean
  timeout?: NodeJS.Timeout
  abort?: () => void
}

function cancelled(): RpcError {
  return new RpcError('CANCELLED', 'RPC call cancelled')
}

function isError<T extends Error>(value: unknown, type: new (...args: never[]) => T): value is T {
  try {
    return value instanceof type
  } catch {
    return false
  }
}

function responseIterator(
  open: (output: IncomingStream) => (() => void) | undefined,
): AsyncIterableIterator<Bytes> {
  const output = new IncomingStream()
  let start: typeof open | undefined = open
  return {
    [Symbol.asyncIterator]() { return this },
    next() {
      if (start) {
        const opening = start
        start = undefined
        const cancel = opening(output)
        if (cancel) output.setOnStop(cancel)
      }
      return output.next()
    },
    return() {
      start = undefined
      return output.return()
    },
  }
}

export class OutgoingCalls {
  #calls = new Map<number, Call>()

  constructor(private readonly modem: MessageModem) {}

  request(name: string, dataOrOptions?: Bytes | RpcCallOptions, options?: RpcCallOptions): Promise<Bytes> {
    const result = deferred<Bytes>()
    try {
      this.#start(name, dataOrOptions, options, { result })
    } catch (error) {
      return Promise.reject(error)
    }
    return result.promise
  }

  stream(name: string, dataOrOptions?: Bytes | RpcCallOptions, options?: RpcCallOptions): AsyncIterableIterator<Bytes> {
    return responseIterator(output => {
      try {
        const call = this.#start(name, dataOrOptions, options, { output })
        return () => this.#cancel(call, cancelled())
      } catch (error) {
        output.fail(isError(error, Error) ? error : new RpcError('INTERNAL', 'RPC startup failed'))
      }
    })
  }

  closed(error: RpcError): void {
    for (const call of this.#calls.values()) this.#fail(call, error, true)
  }

  #start(name: string, dataOrOptions: Bytes | RpcCallOptions | undefined, options: RpcCallOptions | undefined, target: {
    result?: Deferred<Bytes>
    output?: IncomingStream
  }): Call {
    if (this.modem.failure) throw this.modem.failure
    let data: Bytes = EMPTY
    if (isUint8Array(dataOrOptions)) {
      data = dataOrOptions
    } else if (dataOrOptions !== undefined) {
      if (options !== undefined || dataOrOptions === null || typeof dataOrOptions !== 'object'
        || ArrayBuffer.isView(dataOrOptions) || isAnyArrayBuffer(dataOrOptions)) {
        throw new RpcError('INVALID_ARGUMENT', 'Expected RPC request bytes or call options')
      }
      options = dataOrOptions
    }
    const signal = options?.signal
    if (signal?.aborted) throw cancelled()
    const input = options?.input
    if (input !== undefined && typeof input !== 'function') {
      throw new RpcError('INVALID_ARGUMENT', 'RPC input must be a stream factory')
    }
    const timeoutMs = options?.timeoutMs
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)) {
      throw new RpcError('INVALID_ARGUMENT', 'Invalid RPC call timeout')
    }
    if (signal?.aborted) throw cancelled()
    if (this.modem.failure) throw this.modem.failure
    const limit = this.modem.maxCalls
    this.#checkCapacity(limit)
    const mode = (input ? RpcMode.ClientStream : 0) | (target.output ? RpcMode.ServerStream : 0)
    const open = openFrame(0, name, data, mode)
    let call: Call | undefined
    let aborted = false
    const stopObserving = signal && observeAbort(signal, () => {
      if (call) this.#cancel(call, cancelled())
      else aborted = true
    })
    try {
      if (signal?.aborted || aborted) throw cancelled()
      if (this.modem.failure) throw this.modem.failure
      this.#checkCapacity(limit)
      const id = this.modem.nextCallId
      if (id > 0xffffffff) throw new RpcError('RESOURCE_EXHAUSTED', 'RPC connection exhausted its call IDs')
      open.id = id
      this.modem.open(id, mode !== RpcMode.Unary)
      call = {
        ...target,
        id,
        upload: input ? new AbortController() : undefined,
        uploadEnded: false,
        opened: false,
        abort: stopObserving,
      }
      this.#calls.set(id, call)
    } catch (error) {
      stopObserving?.()
      throw error
    }
    const started = call
    if (timeoutMs !== undefined) {
      started.timeout = setTimeout(() => {
        this.#cancel(started, new RpcError('DEADLINE_EXCEEDED', 'RPC call timed out'))
      }, timeoutMs).unref()
    }
    if (this.modem.trySend(open, this.#calls.size > 1)) {
      started.opened = true
      if (input) void Promise.resolve().then(() => this.#upload(started, input)).catch(error => this.#cancel(started, error))
    } else {
      const queued = this.modem.send(open, () => { started.opened = true })
      void (input ? queued.then(() => this.#upload(started, input)) : queued).catch(error => this.#cancel(started, error))
    }
    return started
  }

  #checkCapacity(limit: number): void {
    if (this.#calls.size >= limit) {
      throw new RpcError('RESOURCE_EXHAUSTED', 'RPC connection reached its active call limit')
    }
  }

  async #upload(call: Call, input: NonNullable<RpcCallOptions['input']>): Promise<void> {
    const signal = call.upload!.signal
    if (signal.aborted) return
    await pump(input(signal), signal, data => this.modem.sendData(call.id, byteBody(data)))
    if (!signal.aborted) this.#endInput(call)
  }

  #endInput(call: Call): void {
    if (call.uploadEnded) return
    call.uploadEnded = true
    void this.modem.send(frame(FrameType.EndInput, call.id)).catch(error => this.#cancel(call, error))
  }

  receive(value: Frame, release: () => void): void {
    const { id, type, body } = value
    if (type !== FrameType.StopInput && type !== FrameType.Data && type !== FrameType.End && type !== FrameType.Error) {
      invalidProtocol('Unexpected frame for an outgoing RPC call')
    }

    const call = this.#calls.get(id)
    if (!call) {
      if (id > this.modem.lastOpened(id)) invalidProtocol('Response for an unopened RPC call')
      release()
      return
    }
    if (!call.opened) invalidProtocol('Response for an unsent RPC call')
    if (type === FrameType.StopInput) {
      if (!call.upload) invalidProtocol('STOP_INPUT for a call without an upload')
      if (call.uploadEnded) return
      call.upload.abort()
      this.modem.dropData(id, cancelled())
      this.#endInput(call)
      return
    }
    if (type === FrameType.Data) {
      if (!call.output) invalidProtocol('Streaming response for a unary result')
      call.output.push(body, release)
      return
    }
    if (type === FrameType.Error) {
      this.#fail(call, readError(body), false)
      return
    }
    if (call.output && body.length !== 0) invalidProtocol('Streaming END contains a response body')
    release()
    this.#retire(call)
    call.output?.end()
    call.result?.resolve(body === EMPTY ? Buffer.alloc(0) : body)
    call.abort?.()
    if (!call.uploadEnded) call.upload?.abort()
  }

  #cancel(call: Call, error: unknown): void {
    const failure = isError(error, RpcError) ? error : new RpcError('INTERNAL', 'RPC input failed', { cause: error })
    this.#fail(call, failure, true, true)
  }

  #fail(call: Call, error: RpcError, discard: boolean, notifyPeer = false): void {
    if (!this.#retire(call, error)) return
    // An upload abort listener can immediately open another call.
    if (notifyPeer && call.opened && !this.modem.failure) {
      void this.modem.send(frame(FrameType.Cancel, call.id)).catch(() => {})
    }
    call.output?.fail(error, discard)
    call.result?.reject(error)
    call.abort?.()
    if (!call.uploadEnded) call.upload?.abort()
  }

  #retire(call: Call, error?: RpcError): boolean {
    if (!this.#calls.delete(call.id)) return false
    clearTimeout(call.timeout)
    if (error || call.upload || call.output) this.modem.retire(call.id, error)
    return true
  }
}
