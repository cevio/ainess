import type { Socket } from 'node:net'
import { deferred } from './deferred.js'
import type { Deferred } from './deferred.js'
import { frame, invalidProtocol } from './messages.js'
import { RpcError } from './types.js'
import type { RpcCloseReason } from './types.js'
import {
  decodeHello, encodeHeader, encodeHello, FrameDecoder, FrameType, HEADER_SIZE, LIMITS, MAX_BODY, writeUint32,
} from './wire.js'
import type { Frame, Limits } from './wire.js'

type Release = () => void
type Receive = (frame: Frame, release: Release) => void
type Lane = 'control' | 'short' | 'data'

interface Pending {
  frame: Frame
  written?: () => void
  beforeOpen?: () => RpcError | undefined
  done: Deferred<void>
}

interface ReceiveWindow {
  id: number
  flags: number
  available: number
  owed: number
  batchThreshold: number
}

interface CallWindow {
  incoming: ReceiveWindow
  outgoing: number
  stopped: boolean
}

const NO_RELEASE = () => {}
const CALL_FINISHED = new RpcError('CANCELLED', 'RPC call finished')
const CREDIT_INTERVAL_MS = 1
const MAX_INLINE_BODY = 4 * 1024
const DEFAULT_KEEP_ALIVE_INITIAL_DELAY_MS = 30_000
const MAX_KEEP_ALIVE_INITIAL_DELAY_MS = 32_767_000
const MAX_FRAME_SIZE = HEADER_SIZE + MAX_BODY

/** @internal */
export const HANDSHAKE_TIMEOUT_MS = 10_000

/** @internal */
export function handshakeTimedOut(): RpcError {
  return new RpcError('UNAVAILABLE', 'RPC handshake timed out')
}

export function resolveKeepAliveInitialDelay(delay = DEFAULT_KEEP_ALIVE_INITIAL_DELAY_MS): number {
  if (!Number.isInteger(delay) || delay < 1_000 || delay > MAX_KEEP_ALIVE_INITIAL_DELAY_MS) {
    throw new RpcError(
      'INVALID_ARGUMENT',
      `RPC keepAliveInitialDelayMs must be an integer from 1000 to ${MAX_KEEP_ALIVE_INITIAL_DELAY_MS}`,
    )
  }
  return delay
}

function window(id: number, flags: number, available: number): ReceiveWindow {
  return { id, flags, available, owed: 0, batchThreshold: Math.floor(available / 2) }
}

function lane({ type, body }: Frame): Lane {
  if (type === FrameType.Data) return 'data'
  if (type === FrameType.Open || (type === FrameType.End && body.length > 0)) return 'short'
  return 'control'
}

function validateFrame({ type, id, flags, body }: Frame): void {
  if (type === FrameType.WindowUpdate) {
    if (body.length !== 4 || flags > (id === 0 ? 1 : 0) || body.readUInt32BE() === 0) {
      invalidProtocol('Invalid RPC window update')
    }
    return
  }
  if (id === 0) invalidProtocol('RPC call frame has no call ID')
  if (type === FrameType.Open) {
    if (flags > 3) invalidProtocol('Invalid RPC OPEN flags')
    return
  }
  if (flags !== 0) invalidProtocol('Invalid RPC frame flags')
  if (type === FrameType.Error) {
    if (body.length < 2 || body.length > 1026) invalidProtocol('Invalid RPC ERROR')
  } else if (type !== FrameType.Data && type !== FrameType.End && body.length !== 0) {
    invalidProtocol('RPC control frame has an unexpected body')
  }
}

export class MessageModem {
  #decoder = new FrameDecoder()
  #ready = deferred<void>()
  #closed = deferred<void>()
  #handshake: NodeJS.Timeout | undefined
  #reason: RpcError | undefined
  #peer: Limits | undefined
  #localParity: 0 | 1
  #lastOpened: [number, number] = [0, 0]
  #calls = new Map<number, CallWindow>()
  #receiveShort = window(0, 0, LIMITS.messageWindow)
  #receiveData = window(0, 1, LIMITS.streamWindow)
  #sendShort = 0
  #sendData = 0
  #replyReserve = 0
  #credits = new Set<ReceiveWindow>()
  #creditTimer: NodeJS.Timeout | undefined
  #control = new Set<Pending>()
  #controlByCall = new Map<number, Set<Pending>>()
  #short = new Map<number, Pending>()
  #data = new Map<number, Pending>()
  #blockedUpload: number | undefined
  #writable = true
  #flushing = false
  #readingBatch = false
  #uncork = () => { this.socket.uncork() }
  #flushDeferred = () => this.#flush()

  constructor(
    private readonly socket: Socket,
    role: 'dialer' | 'acceptor',
    private readonly receive: Receive,
    private readonly onClose: (error: RpcError, reason: RpcCloseReason) => void,
    private readonly onReady?: () => void,
    keepAliveInitialDelayMs = DEFAULT_KEEP_ALIVE_INITIAL_DELAY_MS,
    private readonly helloDeadline?: number,
  ) {
    this.#localParity = role === 'dialer' ? 1 : 0
    if (role === 'acceptor') {
      this.#handshake = setTimeout(
        () => this.close(handshakeTimedOut()),
        HANDSHAKE_TIMEOUT_MS,
      ).unref()
    }
    void this.#ready.promise.catch(NO_RELEASE)
    socket.setKeepAlive(true, keepAliveInitialDelayMs)
    socket.setNoDelay(true)
    socket.on('data', bytes => {
      try {
        if (typeof bytes === 'string') invalidProtocol('RPC sockets must receive bytes')
        this.#decoder.push(bytes, (value, more) => {
          if (this.#reason) return
          this.#readingBatch = more
          this.#receive(value)
        })
        this.#flush()
      } catch (cause) {
        this.close(new RpcError('UNAVAILABLE', 'Invalid RPC connection data', { cause }))
      } finally {
        this.#readingBatch = false
      }
    })
    socket.on('drain', () => {
      this.#writable = true
      this.#flush()
    })
    socket.on('error', cause => this.close(new RpcError('UNAVAILABLE', cause.message, { cause })))
    socket.on('end', () => {
      if (this.#decoder.incomplete) this.close(new RpcError('UNAVAILABLE', 'Truncated RPC frame'))
      else this.close(new RpcError('UNAVAILABLE', 'RPC peer disconnected'), 'remote')
    })
    socket.once('close', () => {
      if (!this.#reason) this.close(new RpcError('UNAVAILABLE', 'RPC peer disconnected'), 'remote')
      this.#closed.resolve()
    })
    this.#write(frame(FrameType.Hello, 0, encodeHello()))
  }

  get ready(): Promise<void> {
    return this.#ready.promise
  }

  get failure(): RpcError | undefined {
    return this.#reason
  }

  get nextCallId(): number {
    const last = this.#lastOpened[this.#localParity]
    return last === 0 ? (this.#localParity === 1 ? 1 : 2) : last + 2
  }

  isLocal(id: number): boolean {
    return id !== 0 && (id & 1) === this.#localParity
  }

  lastOpened(id: number): number {
    return this.#lastOpened[id & 1]
  }

  open(id: number, streaming: boolean): void {
    if (id === 0 || id <= this.lastOpened(id)) invalidProtocol('RPC call IDs must increase within their parity')
    this.#lastOpened[id & 1] = id
    if (streaming) {
      this.#calls.set(id, {
        incoming: window(id, 0, LIMITS.callWindow),
        outgoing: this.#peer!.callWindow,
        stopped: false,
      })
    }
  }

  stopReceiving(id: number): void {
    const call = this.#calls.get(id)
    if (!call) return
    call.stopped = true
    this.#credits.delete(call.incoming)
  }

  dropData(id: number, error: Error): void {
    this.#drop(this.#data, id, error)
  }

  retire(id: number, error = CALL_FINISHED): void {
    this.stopReceiving(id)
    this.#calls.delete(id)
    const removedMessage = this.#drop(this.#short, id, error)
    const removedData = this.#drop(this.#data, id, error)
    const controls = this.#controlByCall.get(id)
    if (controls) {
      this.#controlByCall.delete(id)
      for (const pending of controls) {
        this.#control.delete(pending)
        pending.done.reject(error)
      }
    }
    // A caller can enqueue CANCEL before resuming writes unblocked by retirement.
    if (removedMessage || removedData) queueMicrotask(() => this.#flush())
  }

  trySend(value: Frame, batch = false): boolean {
    if ((!value.packet && value.body.length > MAX_INLINE_BODY) || !this.#writable || this.#reason || !this.#peer || this.#flushing
      || this.#control.size || (this.#credits.size && !this.#creditTimer)) {
      return false
    }
    const bytes = HEADER_SIZE + value.body.length
    const channel = lane(value)
    if (channel === 'short') {
      if (this.#short.size || bytes > this.#sendShort) return false
      this.#sendShort -= bytes
    } else if (channel === 'data') {
      const call = this.#calls.get(value.id)
      if (!call || this.#short.size || this.#data.size || !this.#hasDataCredit(value.id, bytes, call)) return false
      this.#sendData -= bytes
      call.outgoing -= bytes
    }
    try {
      this.#write(value, batch || this.#readingBatch)
      return true
    } catch (cause) {
      this.close(new RpcError('UNAVAILABLE', 'RPC write failed', { cause }))
      return false
    }
  }

  send(value: Frame, written?: () => void, beforeOpen?: Pending['beforeOpen']): Promise<void> {
    if (this.#reason) return Promise.reject(this.#reason)
    const channel = lane(value)
    const call = channel === 'data' ? this.#calls.get(value.id) : undefined
    if (channel === 'data' && !call) return Promise.reject(CALL_FINISHED)
    const pending = { frame: value, written, beforeOpen, done: deferred<void>() }
    if (channel === 'control') {
      this.#control.add(pending)
      let controls = this.#controlByCall.get(value.id)
      if (!controls) this.#controlByCall.set(value.id, controls = new Set())
      controls.add(pending)
    } else {
      const queue = channel === 'short' ? this.#short : this.#data
      if (queue.has(value.id)) return Promise.reject(new RpcError('INTERNAL', 'RPC writes were queued out of order'))
      queue.set(value.id, pending)
    }
    if (call) {
      // A later upload waits behind the first one blocked by shared credit. A reply may pass it.
      if (this.#blockedUpload !== undefined && this.isLocal(value.id)) return pending.done.promise
      if (!this.#hasDataCredit(value.id, HEADER_SIZE + value.body.length, call)) return pending.done.promise
    }
    this.#flush()
    return pending.done.promise
  }

  sendData(id: number, body: Buffer): void | Promise<void> {
    const value = frame(FrameType.Data, id, body)
    if (!this.trySend(value, true)) return this.send(value)
  }

  close(error?: RpcError, reason: RpcCloseReason = error ? 'error' : 'local'): Promise<void> {
    if (this.#reason) return this.#closed.promise
    error ??= new RpcError('UNAVAILABLE', 'RPC connection closed')
    this.#reason = error
    clearTimeout(this.#handshake)
    clearTimeout(this.#creditTimer)
    this.#ready.reject(error)
    this.socket.destroy()
    for (const pending of this.#control) pending.done.reject(error)
    for (const pending of this.#short.values()) pending.done.reject(error)
    for (const pending of this.#data.values()) pending.done.reject(error)
    this.#control.clear()
    this.#controlByCall.clear()
    this.#short.clear()
    this.#data.clear()
    this.#blockedUpload = undefined
    this.#credits.clear()
    this.#calls.clear()
    this.onClose(error, reason)
    return this.#closed.promise
  }

  #receive(value: Frame): void {
    if (value.type === FrameType.Hello) {
      if (this.#peer || value.id !== 0 || value.flags !== 0) invalidProtocol('Unexpected RPC HELLO')
      const peer = decodeHello(value.body)
      if (this.helloDeadline !== undefined && performance.now() >= this.helloDeadline) {
        void this.close(handshakeTimedOut())
        return
      }
      this.#peer = peer
      this.#sendShort = this.#peer.messageWindow
      this.#sendData = this.#peer.streamWindow
      this.#replyReserve = Math.min(MAX_FRAME_SIZE, this.#sendData - MAX_FRAME_SIZE)
      clearTimeout(this.#handshake)
      this.onReady?.()
      this.#ready.resolve()
      return
    }
    if (!this.#peer) invalidProtocol('RPC HELLO must precede calls')
    validateFrame(value)
    if (value.type === FrameType.WindowUpdate) {
      this.#receiveCredit(value)
      return
    }
    const channel = lane(value)
    if (channel === 'control') {
      this.receive(value, NO_RELEASE)
      return
    }
    const bytes = HEADER_SIZE + value.body.length
    const incoming = channel === 'short' ? this.#receiveShort : this.#receiveData
    const call = channel === 'data' ? this.#calls.get(value.id) : undefined
    if (incoming.available < bytes || (call && call.incoming.available < bytes)) {
      invalidProtocol('Peer exceeded RPC receive credit')
    }
    incoming.available -= bytes
    if (channel === 'short') {
      this.#returnCredit(incoming, bytes)
      this.receive(value, NO_RELEASE)
      return
    }
    if (call) call.incoming.available -= bytes
    this.receive(value, () => {
      this.#returnCredit(incoming, bytes)
      if (call && !call.stopped) this.#returnCredit(call.incoming, bytes)
    })
  }

  #receiveCredit({ id, flags, body }: Frame): void {
    const bytes = body.readUInt32BE()
    const peer = this.#peer!
    if (id !== 0) {
      const call = this.#calls.get(id)
      if (!call) {
        if (id > this.lastOpened(id)) invalidProtocol('RPC credit for an unopened call')
        return
      }
      call.outgoing += bytes
      if (call.outgoing > peer.callWindow) invalidProtocol('Invalid RPC call credit')
    } else if (flags === 1) {
      this.#sendData += bytes
      if (this.#sendData > peer.streamWindow) invalidProtocol('Invalid RPC data credit')
    } else {
      this.#sendShort += bytes
      if (this.#sendShort > peer.messageWindow) invalidProtocol('Invalid RPC message credit')
    }
  }

  #returnCredit(incoming: ReceiveWindow, bytes: number): void {
    if (this.#reason) return
    incoming.owed += bytes
    const short = incoming === this.#receiveShort
    if (short && incoming.available >= LIMITS.messageWindow * 3 / 4) return
    const pending = this.#credits.size > 0
    this.#credits.add(incoming)
    if (short || incoming.owed >= incoming.batchThreshold || incoming.available < MAX_FRAME_SIZE) {
      if (!pending || this.#creditTimer) {
        clearTimeout(this.#creditTimer)
        this.#creditTimer = undefined
        queueMicrotask(this.#flushDeferred)
      }
    } else if (!pending && !this.#creditTimer) {
      this.#creditTimer = setTimeout(() => {
        this.#creditTimer = undefined
        this.#flush()
      }, CREDIT_INTERVAL_MS).unref()
    }
  }

  #drop(queue: Map<number, Pending>, id: number, error: Error): boolean {
    const pending = queue.get(id)
    if (!pending) return false
    queue.delete(id)
    if (queue === this.#data && this.#blockedUpload === id) this.#blockedUpload = undefined
    pending.done.reject(error)
    return true
  }

  #hasDataCredit(id: number, bytes: number, call: CallWindow): boolean {
    return bytes <= call.outgoing && bytes <= this.#sendData - (this.isLocal(id) ? this.#replyReserve : 0)
  }

  #flush(): void {
    if (!this.#writable || this.#reason || !this.#peer || this.#flushing) return
    if (!this.#short.size && !this.#data.size && !this.#control.size && (!this.#credits.size || this.#creditTimer)) return
    this.#flushing = true
    this.socket.cork()
    try {
      this.#flushControls()
      this.#flushCredits()
      this.#flushMessages()
      this.#flushData()
    } catch (cause) {
      this.close(new RpcError('UNAVAILABLE', 'RPC write failed', { cause }))
    } finally {
      this.#flushing = false
      this.socket.uncork()
    }
  }

  #flushControls(): void {
    for (const pending of this.#control) {
      if (!this.#writable) break
      this.#control.delete(pending)
      const { id } = pending.frame
      const controls = this.#controlByCall.get(id)!
      controls.delete(pending)
      if (!controls.size) this.#controlByCall.delete(id)
      this.#writePending(pending)
    }
  }

  #flushCredits(): void {
    if (this.#creditTimer) return
    for (const incoming of this.#credits) {
      if (!this.#writable) break
      this.#credits.delete(incoming)
      const bytes = incoming.owed
      incoming.owed = 0
      incoming.available += bytes
      this.#write(frame(FrameType.WindowUpdate, incoming.id, writeUint32(bytes), incoming.flags))
    }
  }

  #flushMessages(): void {
    for (const [id, pending] of this.#short) {
      if (!this.#writable) break
      const expired = pending.beforeOpen?.()
      if (expired) {
        this.#short.delete(id)
        pending.done.reject(expired)
        continue
      }
      const bytes = HEADER_SIZE + pending.frame.body.length
      if (bytes > this.#sendShort) break
      this.#short.delete(id)
      this.#sendShort -= bytes
      this.#writePending(pending)
    }
  }

  #flushData(): void {
    this.#blockedUpload = undefined
    for (const [id, pending] of this.#data) {
      if (!this.#writable) break
      const call = this.#calls.get(id)!
      const bytes = HEADER_SIZE + pending.frame.body.length
      if (bytes > call.outgoing) continue
      if (this.isLocal(id)) {
        // Keep enough credit for a reply even when uploads on both peers fill their windows.
        if (this.#blockedUpload !== undefined) continue
        if (bytes > this.#sendData - this.#replyReserve) {
          this.#blockedUpload = id
          continue
        }
      } else if (bytes > this.#sendData) {
        break
      }
      this.#data.delete(id)
      this.#sendData -= bytes
      call.outgoing -= bytes
      this.#writePending(pending)
    }
  }

  #writePending(pending: Pending): void {
    try {
      this.#write(pending.frame)
      pending.written?.()
      pending.done.resolve()
    } catch (error) {
      pending.done.reject(error)
      throw error
    }
  }

  #write(value: Frame, batch = false): void {
    const packet = value.packet
    if (packet || value.body.length <= MAX_INLINE_BODY) {
      const bytes = encodeHeader(value, packet ?? Buffer.allocUnsafe(HEADER_SIZE + value.body.length))
      if (!packet) bytes.set(value.body, HEADER_SIZE)
      if (batch && !this.socket.writableCorked) {
        this.socket.cork()
        process.nextTick(this.#uncork)
      }
      this.#writable = this.socket.write(bytes)
      return
    }
    const headWritten = this.socket.write(encodeHeader(value))
    const bodyWritten = value.body.length === 0 || this.socket.write(value.body)
    this.#writable = headWritten && bodyWritten
  }
}
