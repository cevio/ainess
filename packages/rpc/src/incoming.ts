import { isUint8Array } from 'node:util/types'
import { byteBody, errorFrame, frame, invalidProtocol, readOpenBody } from './messages.js'
import type { MethodRegistry, RegisteredMethod } from './methods.js'
import type { MessageModem } from './modem.js'
import type { RpcPeer } from './peer.js'
import { IncomingStream, pump } from './stream.js'
import { RpcError, RpcMode } from './types.js'
import type { Bytes } from './types.js'
import { FrameType } from './wire.js'
import type { Frame } from './wire.js'

interface Call {
  id: number
  controller: AbortController
  input?: IncomingStream
  inputEnded: boolean
}

export class IncomingCalls {
  #calls = new Map<number, Call>()

  constructor(
    private readonly modem: MessageModem,
    private readonly peer: RpcPeer,
    private readonly methods: MethodRegistry,
    private readonly sharedMethods?: MethodRegistry,
  ) {}

  closed(error: RpcError): void {
    for (const call of this.#calls.values()) this.#retire(call, error)
  }

  receive(value: Frame, release: () => void): void {
    const { id, type, body } = value
    if (type === FrameType.Open) {
      release()
      this.#open(value)
      return
    }
    if (type !== FrameType.Cancel && type !== FrameType.EndInput && type !== FrameType.Data) {
      invalidProtocol('Unexpected frame for an incoming RPC call')
    }

    const call = this.#calls.get(id)
    if (!call) {
      if (id > this.modem.lastOpened(id)) invalidProtocol('Frame for an unopened RPC call')
      release()
      return
    }
    if (type === FrameType.Cancel) {
      this.#retire(call, new RpcError('CANCELLED', 'RPC caller cancelled'))
      return
    }
    if (!call.input || call.inputEnded) invalidProtocol('Unexpected RPC input')
    if (type === FrameType.EndInput) {
      call.inputEnded = true
      this.modem.stopReceiving(id)
      call.input.end()
    } else {
      call.input.push(body, release)
    }
  }

  #open({ id, flags, body }: Frame): void {
    const { name, data } = readOpenBody(body)
    const method = this.methods.get(name) ?? this.sharedMethods?.get(name)
    const available = this.#calls.size < this.modem.maxIncomingCalls
    this.modem.open(id, method?.mode === flags && available && flags !== RpcMode.Unary)

    if (!method || method.mode !== flags || !available) {
      const error = !method
        ? new RpcError('NOT_FOUND', `Unknown RPC method ${name}`)
        : method.mode !== flags
          ? new RpcError('INVALID_ARGUMENT', 'RPC call mode does not match its method')
          : new RpcError('RESOURCE_EXHAUSTED', 'RPC connection reached its active call limit')
      void this.modem.send(errorFrame(id, error)).catch(() => {})
      return
    }
    const call: Call = { id, controller: new AbortController(), inputEnded: false }
    if ((method.mode & RpcMode.ClientStream) !== 0) {
      call.input = new IncomingStream(() => {
        if (!this.#calls.has(id)) return
        this.modem.stopReceiving(id)
        void this.modem.send(frame(FrameType.StopInput, id)).catch(() => {})
      })
    }
    this.#calls.set(id, call)
    method.active++
    void this.#execute(call, method, data)
  }

  async #execute(call: Call, method: RegisteredMethod, data: Bytes): Promise<void> {
    const { controller: { signal }, id } = call
    let responseCleanup: Promise<unknown> | undefined
    try {
      const context = { data, signal, peer: this.peer }
      const response = method.mode === RpcMode.ClientStream || method.mode === RpcMode.Bidi
        ? method.handle({ ...context, input: call.input! })
        : method.handle(context)
      const result = isUint8Array(response) ? response : await response
      if (method.mode === RpcMode.ServerStream || method.mode === RpcMode.Bidi) {
        if (!result || !(Symbol.asyncIterator in result)) {
          throw new RpcError('INTERNAL', 'RPC method must return an async iterable of bytes')
        }
        await pump(result, signal, bytes => this.modem.sendData(id, byteBody(bytes)), cleanup => {
          responseCleanup = cleanup
        })
        if (!signal.aborted) await this.modem.send(frame(FrameType.End, id))
      } else if (!signal.aborted) {
        if (!isUint8Array(result)) throw new RpcError('INTERNAL', 'RPC method must return bytes')
        const reply = frame(FrameType.End, id, byteBody(result))
        if (!this.modem.trySend(reply)) await this.modem.send(reply)
      }
    } catch (error) {
      if (!signal.aborted && !this.modem.failure) {
        await this.modem.send(errorFrame(id, error)).catch(() => {})
      }
    } finally {
      this.#retire(call, undefined, method.mode !== RpcMode.Unary)
      if (responseCleanup) await responseCleanup
      if (--method.active === 0) {
        method.drained?.resolve()
        method.drained = undefined
      }
    }
  }

  #retire(call: Call, error?: RpcError, streaming = true): void {
    if (!this.#calls.delete(call.id)) return
    if (streaming) this.modem.retire(call.id, error)
    if (error) call.controller.abort(error)
    call.input?.stop()
  }
}
