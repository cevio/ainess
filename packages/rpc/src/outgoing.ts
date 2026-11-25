import { addAbortListener } from 'node:events'
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
  abort?: Disposable
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
    let call: Call | undefined
    let started = false
    const output = new IncomingStream(() => {
      if (call) this.#cancel(call, cancelled())
    })
    return {
      [Symbol.asyncIterator]() { return this },
      next: () => {
        if (!started) {
          started = true
          try {
            call = this.#start(name, dataOrOptions, options, { output })
          } catch (error) {
            output.fail(isError(error, Error) ? error : new RpcError('INTERNAL', 'RPC startup failed'))
          }
        }
        return output.next()
      },
      return: () => {
        started = true
        return output.return()
      },
    }
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
    if (dataOrOptions instanceof Uint8Array) {
      data = dataOrOptions
    } else if (dataOrOptions !== undefined) {
      if (options !== undefined || dataOrOptions === null || typeof dataOrOptions !== 'object'
        || ArrayBuffer.isView(dataOrOptions)) {
        throw new RpcError('INVALID_ARGUMENT', 'Expected RPC request bytes or call options')
      }
      options = dataOrOptions
    }
    if (options?.signal?.aborted) throw cancelled()
    const input = options?.input
    if (input !== undefined && typeof input !== 'function') {
      throw new RpcError('INVALID_ARGUMENT', 'RPC input must be a stream factory')
    }
    const timeoutMs = options?.timeoutMs
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)) {
      throw new RpcError('INVALID_ARGUMENT', 'Invalid RPC call timeout')
    }
    if (this.#calls.size >= this.modem.maxCalls) {
      throw new RpcError('RESOURCE_EXHAUSTED', 'RPC connection reached its active call limit')
    }
    const id = this.modem.nextCallId
    if (id > 0xffffffff) throw new RpcError('RESOURCE_EXHAUSTED', 'RPC connection exhausted its call IDs')

    const mode = (input ? RpcMode.ClientStream : 0) | (target.output ? RpcMode.ServerStream : 0)
    const open = openFrame(id, name, data, mode)
    const call: Call = {
      ...target,
      id,
      upload: input ? new AbortController() : undefined,
      uploadEnded: false,
      opened: false,
    }
    if (options?.signal) call.abort = addAbortListener(options.signal, () => this.#cancel(call, cancelled()))
    if (timeoutMs !== undefined) {
      call.timeout = setTimeout(() => {
        this.#cancel(call, new RpcError('DEADLINE_EXCEEDED', 'RPC call timed out'))
      }, timeoutMs).unref()
    }
    this.#calls.set(id, call)
    this.modem.open(id, mode !== RpcMode.Unary)
    if (this.modem.trySend(open, this.#calls.size > 1)) {
      call.opened = true
      if (input) void Promise.resolve().then(() => this.#upload(call, input)).catch(error => this.#cancel(call, error))
    } else {
      const queued = this.modem.send(open, () => { call.opened = true })
      void (input ? queued.then(() => this.#upload(call, input)) : queued).catch(error => this.#cancel(call, error))
    }
    return call
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
    call.result?.resolve(body)
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
    if (!call.uploadEnded) call.upload?.abort()
  }

  #retire(call: Call, error?: RpcError): boolean {
    if (!this.#calls.delete(call.id)) return false
    clearTimeout(call.timeout)
    call.abort?.[Symbol.dispose]()
    if (error || call.upload || call.output) this.modem.retire(call.id, error)
    return true
  }
}
