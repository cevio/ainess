import { setTimeout as delay } from 'node:timers/promises'
import { RpcError, RpcPeer } from '@ainess/rpc'
import {
  decodeRegistryMessage,
  encodeRegistryMessage,
  encodeRegistryRegistration,
  encodeRegistryRegistrationBatches,
  parsePickQuery,
  parseRegistration,
  parseRegisterResponse,
  parseRegistryListBatch,
  parseRegistryPickResponse,
  parseServiceQuery,
  parseUnregisterResponse,
  registryAddressKey,
  registryKeepAliveInitialDelayMs,
  registryMethods,
} from '@ainess/registry-shared'
import type { PickQuery, RegistrationRequest, RegisterResponse, RpcAddress, ServiceQuery } from '@ainess/registry-shared'

const INITIAL_RECONNECT_DELAY_MS = 200
const MAX_RECONNECT_DELAY_MS = 5_000
const STABLE_CONNECTION_MS = 5_000

export type RegistryClientState = 'ready' | 'reconnecting' | 'closed'

export interface RegistryClientOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface RegistryDiscovery {
  register(request: RegistrationRequest): Promise<RegisterResponse>
  unregister(request: RegistrationRequest): Promise<void>
  list(query: ServiceQuery): Promise<RpcAddress[]>
  pick(query: PickQuery, options?: { signal?: AbortSignal }): Promise<RpcAddress | null>
}

interface Registration {
  address: RpcAddress
  services: Set<string>
}

function unavailable(): RpcError {
  return new RpcError('UNAVAILABLE', 'Registry client is unavailable')
}

function decodeResponse<T>(data: Uint8Array, parse: (value: unknown) => T): T {
  try {
    return parse(decodeRegistryMessage(data))
  } catch (cause) {
    throw new RpcError('INTERNAL', 'Invalid response from Registry', { cause })
  }
}

function registrationAcknowledged(response: RegisterResponse, services: readonly string[]): boolean {
  const requested = new Set(services)
  return response.registered.length === requested.size && response.registered.every((id) => requested.delete(id))
}

function rejectedBeforeRegistration(error: unknown): boolean {
  return error instanceof RpcError &&
    (error.code === 'INVALID_ARGUMENT' || error.code === 'NOT_FOUND' || error.code === 'RESOURCE_EXHAUSTED')
}

export class RegistryClient {
  #state: RegistryClientState = 'ready'
  #readySince: number | undefined = performance.now()
  #peer: RpcPeer | undefined
  #peerClosed: Promise<void> | undefined
  #activeCalls = 0
  #lifetime = new AbortController()
  #registrations = new Map<string, Registration>()
  #writes: Promise<void> = Promise.resolve()
  #reconnecting: Promise<void> | undefined
  #reconnectDelay = INITIAL_RECONNECT_DELAY_MS
  #closing: Promise<void> | undefined

  readonly discovery: RegistryDiscovery = {
    register: (request) => this.#register(request),
    unregister: (request) => this.#unregister(request),
    list: (query) => this.#list(query),
    pick: (query, options) => this.#pick(query, options?.signal),
  }

  private constructor(private readonly address: RpcAddress, private readonly timeoutMs: number, peer: RpcPeer) {
    this.#own(peer)
  }

  static async connect(address: RpcAddress, options: RegistryClientOptions = {}): Promise<RegistryClient> {
    const timeoutMs = options.timeoutMs ?? 5000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) {
      throw new RangeError('Registry timeoutMs must be an integer from 1 to 2147483647')
    }
    const endpoint = { host: address.host, port: address.port }
    const peer = await RpcPeer.connect(endpoint, {
      signal: options.signal,
      keepAliveInitialDelayMs: registryKeepAliveInitialDelayMs,
    })
    return new RegistryClient(endpoint, timeoutMs, peer)
  }

  get state(): RegistryClientState {
    return this.#state
  }

  close(): Promise<void> {
    return this.#closing ??= this.#dispose()
  }

  async #dispose(): Promise<void> {
    this.#state = 'closed'
    this.#lifetime.abort()
    const peer = this.#peer
    this.#peer = undefined
    this.#registrations.clear()
    await Promise.all([peer?.close(), this.#peerClosed, this.#reconnecting, this.#writes])
  }

  #readyPeer(): RpcPeer {
    if (this.#state !== 'ready' || !this.#peer) throw unavailable()
    return this.#peer
  }

  async #runCall<T>(peer: RpcPeer, call: () => Promise<T>): Promise<T> {
    this.#activeCalls++
    try {
      return await call()
    } finally {
      if (this.#peer === peer && --this.#activeCalls === 0 && this.#state === 'ready' &&
        peer.remainingOutgoingCallIds === 0) {
        await this.#retire(peer)
      }
    }
  }

  #own(peer: RpcPeer): void {
    this.#peer = peer
    this.#peerClosed = undefined
    this.#activeCalls = 0
    peer.onClose(() => this.#disconnected(peer))
  }

  #disconnected(peer: RpcPeer): void {
    if (this.#peer !== peer) return
    this.#peer = undefined
    this.#peerClosed = peer.close()
    if (this.#state === 'closed') return
    if (this.#readySince !== undefined && performance.now() - this.#readySince >= STABLE_CONNECTION_MS) {
      this.#reconnectDelay = INITIAL_RECONNECT_DELAY_MS
    }
    this.#readySince = undefined
    this.#state = 'reconnecting'
    this.#startReconnect()
  }

  async #retire(peer: RpcPeer): Promise<void> {
    if (this.#peer !== peer) return
    this.#state = 'reconnecting'
    await peer.close()
    this.#disconnected(peer)
  }

  #write<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#writes.then(operation)
    this.#writes = result.then(() => {}, () => {})
    return result
  }

  #remember(request: RegistrationRequest, response: RegisterResponse): void {
    if (!response.registered.length) return
    const key = registryAddressKey(request)
    const current = this.#registrations.get(key)
    if (current) {
      for (const service of response.registered) current.services.add(service)
    } else {
      const address = { host: request.host, port: request.port }
      this.#registrations.set(key, { address, services: new Set(response.registered) })
    }
  }

  #withdraw(request: RegistrationRequest): string[] {
    const key = registryAddressKey(request)
    const current = this.#registrations.get(key)
    if (!current) return []
    const removed = request.services.filter((service) => current.services.delete(service))
    if (!current.services.size) this.#registrations.delete(key)
    return removed
  }

  async #register(value: RegistrationRequest): Promise<RegisterResponse> {
    const peer = this.#readyPeer()
    const request = parseRegistration(value)
    const data = encodeRegistryRegistration(request)
    return this.#runCall(peer, () => this.#write(async () => {
      if (this.#readyPeer() !== peer) throw unavailable()
      try {
        const response = await this.#sendRegister(peer, data, request.services)
        if (this.#readyPeer() !== peer) throw unavailable()
        this.#remember(request, response)
        return response
      } catch (error) {
        if (!rejectedBeforeRegistration(error)) await this.#retire(peer)
        throw error
      }
    }))
  }

  async #unregister(value: RegistrationRequest): Promise<void> {
    if (this.#state === 'closed') throw unavailable()
    const request = parseRegistration(value)
    await this.#write(async () => {
      if (this.#state === 'closed') throw unavailable()
      const removed = this.#withdraw(request)
      if (!removed.length) return
      if (this.#state === 'reconnecting') {
        if (this.#peer) await this.#retire(this.#peer)
        return
      }
      const peer = this.#readyPeer()
      return this.#runCall(peer, async () => {
        try {
          const batches = encodeRegistryRegistrationBatches({ ...request, services: removed })
          for (const { data, services } of batches) {
            const bytes = await peer.request(registryMethods.unregister, data, { timeoutMs: this.timeoutMs })
            const response = decodeResponse(bytes, parseUnregisterResponse)
            const requested = new Set(services)
            if (!response.removed.every((id) => requested.delete(id))) {
              throw new RpcError('INTERNAL', 'Registry acknowledged unexpected withdrawals')
            }
          }
        } catch (error) {
          const draining = error instanceof RpcError && error.code === 'RESOURCE_EXHAUSTED' &&
            peer.remainingOutgoingCallIds === 0
          if (!draining) await this.#retire(peer)
          throw error
        }
      })
    })
  }

  async #list(query: ServiceQuery): Promise<RpcAddress[]> {
    const peer = this.#readyPeer()
    return this.#runCall(peer, async () => {
      const data = encodeRegistryMessage(parseServiceQuery(query))
      const addresses: RpcAddress[] = []
      for await (const batch of peer.stream(registryMethods.list, data, { timeoutMs: this.timeoutMs })) {
        for (const address of decodeResponse(batch, parseRegistryListBatch)) addresses.push(address)
      }
      return addresses
    })
  }

  async #pick(query: PickQuery, signal?: AbortSignal): Promise<RpcAddress | null> {
    const peer = this.#readyPeer()
    return this.#runCall(peer, async () => {
      const data = encodeRegistryMessage(parsePickQuery(query))
      const response = await peer.request(registryMethods.pick, data, { timeoutMs: this.timeoutMs, signal })
      return decodeResponse(response, parseRegistryPickResponse)
    })
  }

  async #sendRegister(peer: RpcPeer, data: Uint8Array, services: readonly string[]): Promise<RegisterResponse> {
    const response = await peer.request(registryMethods.register, data, { timeoutMs: this.timeoutMs })
    const acknowledged = decodeResponse(response, parseRegisterResponse)
    if (!registrationAcknowledged(acknowledged, services)) {
      throw new RpcError('INTERNAL', 'Registry did not acknowledge the requested registrations')
    }
    return acknowledged
  }

  #startReconnect(): void {
    if (this.#reconnecting) return
    this.#reconnecting = this.#reconnect().finally(() => {
      this.#reconnecting = undefined
      if (this.#state === 'reconnecting') this.#startReconnect()
    })
  }

  async #reconnect(): Promise<void> {
    const signal = this.#lifetime.signal
    while (!signal.aborted) {
      let peer: RpcPeer | undefined
      try {
        const pause = this.#reconnectDelay
        const jittered = Math.round(pause / 2 + Math.random() * pause / 2)
        await Promise.all([delay(jittered, undefined, { signal }), this.#peerClosed])
        signal.throwIfAborted()
        this.#reconnectDelay = Math.min(pause * 2, MAX_RECONNECT_DELAY_MS)
        peer = await RpcPeer.connect(this.address, { signal, keepAliveInitialDelayMs: registryKeepAliveInitialDelayMs })
        if (signal.aborted) return
        this.#own(peer)
        if (await this.#restore(peer)) return
      } catch {
        // An incomplete connection will discard its registrations on close.
      } finally {
        if (peer && this.#state !== 'ready') await peer.close()
      }
    }
  }

  async #restore(peer: RpcPeer): Promise<boolean> {
    const requests = await this.#write(() => {
      if (this.#peer !== peer) return
      return Array.from(this.#registrations.values(), ({ address, services }) => ({
        ...address, services: [...services],
      }))
    })
    if (!requests) return false

    for (const request of requests) {
      for (const { data, services } of encodeRegistryRegistrationBatches(request)) {
        if (this.#peer !== peer) return false
        await this.#sendRegister(peer, data, services)
      }
    }
    return this.#write(() => {
      if (this.#peer !== peer) return false
      this.#readySince = performance.now()
      this.#state = 'ready'
      return true
    })
  }
}
