import { addAbortListener } from 'node:events'
import { RpcError, RpcPeer } from '@ainess/rpc'
import type { Bytes, RpcAddress, RpcCallFailure, RpcCallOptions } from '@ainess/rpc'
import { CircuitBreaker } from './circuit-breaker.js'
import type { CircuitBreakerSettings } from './circuit-breaker.js'

export interface MicroDiscovery {
  pick(
    query: { service: string; exclude?: readonly RpcAddress[] },
    options?: { signal?: AbortSignal },
  ): Promise<RpcAddress | null>
}

export interface MicroOptions {
  discovery: MicroDiscovery
  timeoutMs?: number
  resolveTimeoutMs?: number
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  circuitBreaker?: MicroCircuitBreakerOptions | false
  onTiming?: (event: MicroTimingEvent) => void
}

type MicroTimingPhase = { readonly service: string } & (
  | { readonly phase: 'discovery' | 'connect'; readonly attempt: 1 | 2 }
  | { readonly phase: 'rpc'; readonly method: string }
)

export type MicroTimingEvent = MicroTimingPhase & {
  readonly elapsedMs: number
  readonly outcome: 'success' | 'failure'
  readonly error?: unknown
}

export interface MicroCircuitBreakerOptions extends Partial<CircuitBreakerSettings> {
  minTimeoutSampleMs?: number
}

type MicroCallOptions = Omit<RpcCallOptions, 'openDeadline' | 'beforeResponse'>

export interface MicroStreamOptions extends Omit<MicroCallOptions, 'timeoutMs'> {
  timeoutMs?: number | false
  firstResponseTimeoutMs?: number
  readIdleTimeoutMs?: number
}

export interface MicroClient {
  request(service: string, method: string, data?: Bytes, options?: MicroCallOptions): Promise<Bytes>
  stream(service: string, method: string, data?: Bytes, options?: MicroStreamOptions): AsyncIterableIterator<Bytes>
  close(): Promise<void>
}

const FAILED_ADDRESS_MS = 5_000
const FAILED_DISCOVERY_MS = 200

interface Route {
  service: string
  endpoints: Map<Endpoint, CircuitBreaker | undefined>
  pending?: Promise<void>
  failure?: { error: unknown; retryAt: number }
}

interface Endpoint {
  address: RpcAddress
  routes: Set<Route>
  connections: Set<Connection>
  pending?: Promise<void>
  retryAt: number
}

interface Connection {
  peer: RpcPeer
  active: number
  // Reserve the ID until startup completes, including synchronous callbacks.
  reservedIds: number
  idleSince: number
}

interface Attempt {
  connection: Connection
  breaker: CircuitBreaker | undefined
  ticket: number | undefined
}

function addressKey({ host, port }: RpcAddress): string {
  return JSON.stringify([host, port])
}

function readEndpoint(value: RpcAddress): { key: string; address: RpcAddress } {
  const { host, port } = value ?? {}
  if (typeof host !== 'string' || !host.trim() || typeof port !== 'number' ||
    !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RpcError('INVALID_ARGUMENT', 'Micro discovery returned an invalid RPC address')
  }
  const address = { host, port }
  return { key: addressKey(address), address }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) {
    throw new RangeError(`Micro ${name} must be an integer from 1 to 2147483647`)
  }
  return value
}

function unavailable(service: string, cause?: unknown): RpcError {
  return new RpcError('UNAVAILABLE', `No reachable instance of ${service}`, { cause })
}

async function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let subscription: ReturnType<typeof addAbortListener> | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      work.then(resolve, reject)
      if (signal.aborted) reject(signal.reason)
      else subscription = addAbortListener(signal, () => reject(signal.reason))
    })
  } finally {
    subscription?.[Symbol.dispose]()
  }
}

function available(connection: Connection): boolean {
  return connection.reservedIds < connection.peer.remainingOutgoingCallIds
}

function availableConnection(route: Route, now = performance.now()): Attempt | undefined {
  let fallback: Attempt | undefined
  for (const [endpoint, breaker] of route.endpoints) {
    if (endpoint.retryAt > now || breaker?.allows(now) === false) continue
    for (const connection of endpoint.connections) {
      if (!available(connection)) continue
      if (!breaker || breaker.probeReady(now)) return { connection, breaker, ticket: undefined }
      fallback ??= { connection, breaker, ticket: undefined }
      break
    }
  }
  return fallback
}

function settle(attempt: Attempt | undefined, outcome: boolean | undefined): void {
  if (attempt?.ticket === undefined) return
  const ticket = attempt.ticket
  attempt.ticket = undefined
  attempt.breaker!.settle(ticket, outcome, performance.now())
}

function remoteAvailabilityFailure(failure: RpcCallFailure): boolean {
  return failure.source === 'remote' &&
    (failure.error.code === 'UNAVAILABLE' || failure.error.code === 'DEADLINE_EXCEEDED')
}

type StreamReadTimeoutPhase = 'first-response' | 'read-idle'

interface StreamReadDeadline {
  at: number
  phase: StreamReadTimeoutPhase
}

function streamTimedOut(phase: StreamReadTimeoutPhase): RpcError {
  return new RpcError('DEADLINE_EXCEEDED', `Micro stream ${phase} timed out`, { cause: { phase } })
}

function observeCall(
  attempt: Attempt, options: RpcCallOptions, observe: (failure: RpcCallFailure) => void,
): void {
  const { onFailure, onResponse } = options
  if ((onFailure !== undefined && typeof onFailure !== 'function') ||
    (onResponse !== undefined && typeof onResponse !== 'function')) return
  options.onResponse = () => {
    settle(attempt, true)
    return onResponse?.()
  }
  options.onFailure = onFailure ? failure => {
    observe(failure)
    return onFailure(failure)
  } : observe
}

class Client implements MicroClient {
  #discovery: MicroDiscovery
  #timeoutMs: number
  #resolveTimeoutMs: number
  #connectTimeoutMs: number
  #idleTimeoutMs: number
  #onTiming?: MicroOptions['onTiming']
  #circuitSettings?: CircuitBreakerSettings
  #minTimeoutSampleMs = 0
  #lifetime = new AbortController()
  #routes = new Map<string, Route>()
  #endpoints = new Map<string, Endpoint>()
  #peers = new Set<RpcPeer>()
  #dials = new Set<Promise<void>>()
  #lookups = new Set<Promise<void>>()
  #sweep: NodeJS.Timeout
  #closing?: Promise<void>

  constructor(options: MicroOptions) {
    if (typeof options.discovery?.pick !== 'function') throw new TypeError('Micro discovery requires pick()')
    this.#discovery = options.discovery
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 5_000, 'timeoutMs')
    this.#resolveTimeoutMs = positiveInteger(options.resolveTimeoutMs ?? this.#timeoutMs, 'resolveTimeoutMs')
    this.#connectTimeoutMs = positiveInteger(options.connectTimeoutMs ?? 5_000, 'connectTimeoutMs')
    this.#idleTimeoutMs = positiveInteger(options.idleTimeoutMs ?? 60_000, 'idleTimeoutMs')
    if (options.onTiming !== undefined && typeof options.onTiming !== 'function') {
      throw new TypeError('Micro onTiming must be a function')
    }
    this.#onTiming = options.onTiming
    const breaker = options.circuitBreaker
    if (breaker !== false) {
      if (breaker !== undefined && (breaker === null || typeof breaker !== 'object' || Array.isArray(breaker))) {
        throw new TypeError('Micro circuitBreaker must be an options object or false')
      }
      const failureRateThreshold = positiveInteger(
        breaker?.failureRateThreshold ?? 50, 'circuitBreaker.failureRateThreshold',
      )
      if (failureRateThreshold > 100) throw new RangeError('Micro circuitBreaker.failureRateThreshold must be at most 100')
      this.#circuitSettings = {
        windowMs: positiveInteger(breaker?.windowMs ?? 10_000, 'circuitBreaker.windowMs'),
        minimumCalls: positiveInteger(breaker?.minimumCalls ?? 10, 'circuitBreaker.minimumCalls'),
        failureRateThreshold,
        openMs: positiveInteger(breaker?.openMs ?? 5_000, 'circuitBreaker.openMs'),
      }
      this.#minTimeoutSampleMs = positiveInteger(breaker?.minTimeoutSampleMs ?? 1_000, 'circuitBreaker.minTimeoutSampleMs')
    }
    this.#sweep = setInterval(() => this.#prune(), Math.min(5_000, this.#idleTimeoutMs)).unref()
  }

  async request(service: string, method: string, data?: Bytes, options?: MicroCallOptions): Promise<Bytes> {
    const timeoutMs = positiveInteger(options?.timeoutMs ?? this.#timeoutMs, 'timeoutMs')
    const call = this.#callSignal(timeoutMs, options?.signal)
    let attempt: Attempt | undefined
    try {
      const effectiveOptions = call.optionsForRpc(options)
      effectiveOptions.beforeResponse = () => call.checkDeadline(performance.now())
      return await this.#dispatch(service, call, selected => {
        attempt = selected
        if (selected.ticket !== undefined) {
          observeCall(selected, effectiveOptions, failure => {
            const expiredAt = call.expiredAt()
            const timedOut = effectiveOptions.input === undefined && failure.source === 'local' &&
              failure.sentAt !== undefined && expiredAt !== undefined &&
              expiredAt - failure.sentAt >= this.#minTimeoutSampleMs
            settle(selected, remoteAvailabilityFailure(failure) || timedOut ? false : undefined)
          })
        }
        if (this.#onTiming) {
          return this.#measure({ phase: 'rpc', service, method },
            () => selected.connection.peer.request(method, data, effectiveOptions), call.recordFailure)
        }
        return selected.connection.peer.request(method, data, effectiveOptions)
      })
    } catch (error) {
      settle(attempt, undefined)
      throw call.failure(error)
    } finally {
      call.finish()
      if (attempt) this.#release(attempt.connection)
    }
  }

  stream(service: string, method: string, data?: Bytes, options?: MicroStreamOptions): AsyncIterableIterator<Bytes> {
    const stop = new AbortController()
    const response = this.#stream(service, method, data, options, stop.signal)
    return {
      [Symbol.asyncIterator]() { return this },
      next: () => response.next(),
      return: () => {
        stop.abort()
        return response.return(undefined)
      },
      throw: (error: unknown) => {
        stop.abort()
        return response.throw(error)
      },
    }
  }

  async *#stream(
    service: string,
    method: string,
    data: Bytes | undefined,
    options: MicroStreamOptions | undefined,
    stop: AbortSignal,
  ): AsyncGenerator<Bytes, void> {
    const { timeoutMs, firstResponseTimeoutMs, readIdleTimeoutMs, signal } = options ?? {}
    const totalMs = timeoutMs === false ? false : positiveInteger(timeoutMs ?? this.#timeoutMs, 'timeoutMs')
    if (firstResponseTimeoutMs !== undefined) positiveInteger(firstResponseTimeoutMs, 'firstResponseTimeoutMs')
    if (readIdleTimeoutMs !== undefined) positiveInteger(readIdleTimeoutMs, 'readIdleTimeoutMs')
    const call = this.#callSignal(totalMs, signal, stop)
    let attempt: Attempt | undefined
    let reader: AsyncIterableIterator<Bytes> | undefined
    let shutdown: Promise<unknown> | undefined
    let phaseTimer: NodeJS.Timeout | undefined
    let readDeadline: StreamReadDeadline | undefined
    const armPhase = (ms: number | undefined, phase: StreamReadTimeoutPhase) => {
      if (ms === undefined) return
      readDeadline = { at: performance.now() + ms, phase }
      phaseTimer = setTimeout(() => call.timeout.abort(streamTimedOut(phase)), ms).unref()
      return readDeadline
    }
    const clearPhase = () => {
      clearTimeout(phaseTimer)
      phaseTimer = undefined
      readDeadline = undefined
    }
    const finish = () => {
      if (shutdown) return shutdown
      clearPhase()
      call.finish()
      call.signal.removeEventListener('abort', abort)
      try {
        shutdown = reader?.return?.() ?? Promise.resolve()
      } catch (error) {
        shutdown = Promise.reject(error)
      } finally {
        reader = undefined
        const active = attempt
        attempt = undefined
        settle(active, undefined)
        if (active) this.#release(active.connection)
      }
      return shutdown
    }
    const abort = () => { void finish().catch(() => {}) }
    try {
      const firstDeadline = armPhase(firstResponseTimeoutMs, 'first-response')
      const effectiveOptions = call.optionsForRpc(options, firstDeadline)
      if (totalMs !== false || firstDeadline || readIdleTimeoutMs !== undefined) {
        effectiveOptions.beforeResponse = () => {
          call.checkDeadline(performance.now(), readDeadline)
          if (readDeadline) clearPhase()
        }
      }
      let item = await this.#dispatch(service, call, selected => {
        attempt = selected
        if (selected.ticket !== undefined) {
          observeCall(selected, effectiveOptions, failure => {
            settle(selected, remoteAvailabilityFailure(failure) ? false : undefined)
          })
        }
        reader = selected.connection.peer.stream(method, data, effectiveOptions)
        const reading = this.#onTiming
          ? this.#measure({ phase: 'rpc', service, method }, () => reader!.next(), call.recordFailure)
          : reader.next()
        // Return the reader on abort even if RPC already received END and left unread frames buffered.
        if (call.signal.aborted) abort()
        else call.signal.addEventListener('abort', abort, { once: true })
        return reading
      }, firstDeadline)
      clearPhase()
      call.throwIfAborted()
      for (;;) {
        if (item.done) return
        yield item.value
        call.checkDeadline(performance.now())
        armPhase(readIdleTimeoutMs, 'read-idle')
        item = await reader!.next()
        clearPhase()
        call.throwIfAborted()
      }
    } catch (error) {
      throw call.failure(error)
    } finally {
      await finish()
    }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = Promise.resolve().then(() => this.#dispose())
      this.#lifetime.abort(new RpcError('UNAVAILABLE', 'Micro client is closed'))
    }
    return this.#closing
  }

  #callSignal(timeoutMs: number | false, callerSignal?: AbortSignal, streamStop?: AbortSignal) {
    const timeout = new AbortController()
    const lifetime = this.#lifetime.signal
    const signals = [lifetime, timeout.signal]
    if (callerSignal) signals.push(callerSignal)
    if (streamStop) signals.push(streamStop)
    const signal = AbortSignal.any(signals)
    const deadline = timeoutMs === false ? Infinity : performance.now() + timeoutMs
    let expiredAt: number | undefined
    let settledFailure: { error: unknown } | undefined
    const recordFailure = (error: unknown) => {
      if (!signal.aborted) settledFailure = { error }
    }
    const throwIfAborted = () => {
      if (settledFailure && signal.aborted && signal.reason !== timeout.signal.reason) throw settledFailure.error
      signal.throwIfAborted()
    }
    const expireTotal = (now: number) => {
      // Event-loop delay cannot extend the response budget used by the circuit breaker.
      expiredAt = Math.min(now, deadline)
      const options = streamStop ? { cause: { phase: 'total' } } : undefined
      timeout.abort(new RpcError('DEADLINE_EXCEEDED', 'Micro call timed out', options))
    }
    const timer = timeoutMs === false ? undefined
      : setTimeout(() => expireTotal(performance.now()), timeoutMs).unref()
    return {
      signal,
      timeout,
      throwIfAborted,
      recordFailure,
      finish: () => clearTimeout(timer),
      expiredAt: () => signal.reason === timeout.signal.reason ? expiredAt : undefined,
      optionsForRpc(
        options?: Pick<MicroCallOptions, 'input' | 'onFailure' | 'onResponse'>,
        firstResponseDeadline?: StreamReadDeadline,
      ): RpcCallOptions {
        const { input, onFailure, onResponse } = options ?? {}
        let openDeadline: RpcCallOptions['openDeadline']
        if (firstResponseDeadline && firstResponseDeadline.at < deadline) {
          openDeadline = { at: firstResponseDeadline.at, cause: { phase: firstResponseDeadline.phase } }
        } else if (deadline !== Infinity) {
          openDeadline = { at: deadline, cause: streamStop ? { phase: 'total' } : undefined }
        }
        return {
          signal,
          input,
          onResponse,
          openDeadline,
          onFailure: typeof onFailure === 'function' ? failure => {
            // The transport settles before invoking onFailure, which can then abort the call signal.
            recordFailure(failure.error)
            return onFailure(failure)
          } : onFailure,
        }
      },
      checkDeadline(now: number, readDeadline?: StreamReadDeadline) {
        throwIfAborted()
        // Selection and response processing can run before an overdue timer callback.
        if (readDeadline && readDeadline.at < deadline && now >= readDeadline.at) {
          timeout.abort(streamTimedOut(readDeadline.phase))
        } else if (now >= deadline) {
          expireTotal(now)
        }
        throwIfAborted()
      },
      failure(error: unknown): unknown {
        if (!signal.aborted || (settledFailure && Object.is(error, settledFailure.error))) return error
        const reason = signal.reason
        let cancelledBySignal = Object.is(error, reason)
        if (!cancelledBySignal) {
          try {
            cancelledBySignal = error instanceof RpcError && error.code === 'CANCELLED' && Object.is(error.cause, reason)
          } catch {
            // A failure observer can abort while an application error is propagating.
            return error
          }
        }
        if (!cancelledBySignal) return error
        if (reason === lifetime.reason || reason === timeout.signal.reason) return reason
        return new RpcError('CANCELLED', 'Micro call cancelled', { cause: reason })
      },
    }
  }

  async #dispatch<T>(
    service: string,
    call: { signal: AbortSignal; checkDeadline(now: number, readDeadline?: StreamReadDeadline): void },
    start: (attempt: Attempt) => Promise<T>,
    firstResponseDeadline?: StreamReadDeadline,
  ): Promise<T> {
    if (typeof service !== 'string' || !service.trim()) {
      throw new RpcError('INVALID_ARGUMENT', 'Micro service must be a non-blank string')
    }
    const { signal } = call
    signal.throwIfAborted()
    let route = this.#routes.get(service)
    if (!route) this.#routes.set(service, route = { service, endpoints: new Map() })
    for (;;) {
      const now = performance.now()
      call.checkDeadline(now, firstResponseDeadline)
      const selection = availableConnection(route, now)
      if (selection) {
        const { connection, breaker } = selection
        selection.ticket = breaker?.admit(now)
        connection.reservedIds++
        connection.active++
        try {
          return start(selection)
        } finally {
          connection.reservedIds--
        }
      }
      if (route.failure && now < route.failure.retryAt) throw route.failure.error
      if (!route.pending) {
        const pending = Promise.resolve().then(() => this.#select(route)).then(() => {
          route.failure = undefined
        }, (error: unknown) => {
          route.failure = { error, retryAt: this.#lookupRetryAt(route) }
          throw error
        }).finally(() => {
          route.pending = undefined
          this.#lookups.delete(pending)
        })
        route.pending = pending
        this.#lookups.add(pending)
      }
      try {
        await waitFor(route.pending, signal)
      } catch (error) {
        call.checkDeadline(performance.now(), firstResponseDeadline)
        throw error
      }
    }
  }

  #lookupRetryAt(route: Route): number {
    const now = performance.now()
    let retryAt = now + FAILED_DISCOVERY_MS
    for (const [endpoint, breaker] of route.endpoints) {
      const eligibleAt = Math.max(endpoint.retryAt, breaker?.retryAt ?? 0)
      if (eligibleAt > now) retryAt = Math.min(retryAt, eligibleAt)
    }
    return retryAt
  }

  async #measure<T>(
    phase: MicroTimingPhase,
    run: () => Promise<T>,
    recordFailure?: (error: unknown) => void,
  ): Promise<T> {
    const started = performance.now()
    const report = (result: Pick<MicroTimingEvent, 'outcome' | 'error'>) => {
      const event = { ...phase, ...result, elapsedMs: performance.now() - started }
      try {
        void Promise.resolve(this.#onTiming?.(event)).catch(() => {})
      } catch {
        // Timing observers do not affect call outcomes.
      }
    }
    try {
      const result = await run()
      report({ outcome: 'success' })
      return result
    } catch (error) {
      recordFailure?.(error)
      report({ outcome: 'failure', error })
      throw error
    }
  }

  async #select(route: Route): Promise<void> {
    const { service } = route
    const lifetime = this.#lifetime.signal
    const deadlineAt = performance.now() + this.#resolveTimeoutMs
    const timeout = AbortSignal.timeout(this.#resolveTimeoutMs)
    const resolution = AbortSignal.any([lifetime, timeout])
    let selection = resolution
    const remaining = () => {
      lifetime.throwIfAborted()
      const ms = deadlineAt - performance.now()
      if (timeout.aborted || ms <= 0) {
        throw unavailable(service, timeout.reason ?? new RpcError('DEADLINE_EXCEEDED', 'Micro selection timed out'))
      }
      return ms
    }
    const failedAddresses = new Map<string, RpcAddress>()
    let failure: RpcError | undefined
    let firstDial: Promise<void> | undefined
    for (const attempt of [1, 2] as const) {
      remaining()
      const now = performance.now()
      if (availableConnection(route, now)) return
      const exclude = this.#exclusions(route, failedAddresses, now)
      const query = exclude.size ? { service, exclude: Array.from(exclude.values(), address => ({ ...address })) }
        : { service }
      const pickTimeout = new AbortController()
      const deadline = AbortSignal.any([selection, pickTimeout.signal])
      const pick = async () => {
        const expiresAt = performance.now() + this.#connectTimeoutMs
        const expire = () => pickTimeout.abort(new DOMException('Micro discovery timed out', 'TimeoutError'))
        const timer = setTimeout(expire, this.#connectTimeoutMs).unref()
        try {
          return await waitFor(this.#discovery.pick(query, { signal: deadline }), deadline)
        } finally {
          clearTimeout(timer)
          // The discovery promise can settle before the event loop runs an overdue timer.
          if (!deadline.aborted && performance.now() >= expiresAt) expire()
          deadline.throwIfAborted()
        }
      }
      let selected: RpcAddress | null
      try {
        selected = await (this.#onTiming ? this.#measure({ phase: 'discovery', service, attempt }, pick) : pick())
      } catch (error) {
        remaining()
        if (availableConnection(route)) return
        if (firstDial) break
        throw deadline.aborted ? unavailable(service, error) : error
      }
      remaining()
      if (availableConnection(route)) return
      const target = selected === null ? null : readEndpoint(selected)
      if (!target || exclude.has(target.key)) {
        if (!target && attempt === 1 && exclude.size) {
          const current = this.#exclusions(route, failedAddresses, performance.now())
          if ([...exclude.keys()].some(key => !current.has(key))) continue
        }
        break
      }
      const endpoint = this.#endpoint(target.key, target.address, route)
      const selectedAt = performance.now()
      if (route.endpoints.get(endpoint)?.allows(selectedAt) === false) continue
      if (endpoint.retryAt <= selectedAt && [...endpoint.connections].some(available)) return
      const half = Math.max(1, Math.floor(remaining() / 2))
      // Reserve time for a second selection without cancelling the address's shared dial.
      const cutoff = attempt === 1 && half < this.#connectTimeoutMs ? AbortSignal.timeout(half) : undefined
      const signal = cutoff ? AbortSignal.any([selection, cutoff]) : selection
      const dial = this.#connect(endpoint)
      const connect = () => waitFor(dial, signal)
      try {
        await (this.#onTiming ? this.#measure({ phase: 'connect', service, attempt }, connect) : connect())
      } catch (error) {
        remaining()
        if (availableConnection(route)) return
        if (cutoff?.aborted && Object.is(error, cutoff.reason)) {
          firstDial = dial
          const recovered = new AbortController()
          selection = AbortSignal.any([resolution, recovered.signal])
          // The first socket can finish while the route looks for an alternative.
          void dial.then(() => recovered.abort(), () => {})
        } else if (!(error instanceof RpcError) || error.code !== 'UNAVAILABLE') {
          if (firstDial) break
          throw error
        }
        failure = unavailable(service, error)
        failedAddresses.set(target.key, endpoint.address)
        continue
      }
      remaining()
      return
    }
    if (firstDial) {
      remaining()
      const connect = () => waitFor(firstDial, resolution)
      try {
        await (this.#onTiming ? this.#measure({ phase: 'connect', service, attempt: 2 }, connect) : connect())
      } catch (error) {
        remaining()
        throw unavailable(service, error)
      }
      remaining()
      return
    }
    throw failure ?? unavailable(service)
  }

  #exclusions(route: Route, failedAddresses: ReadonlyMap<string, RpcAddress>, now: number): Map<string, RpcAddress> {
    const exclude = new Map(failedAddresses)
    for (const [endpoint, breaker] of route.endpoints) {
      if (endpoint.retryAt > now || breaker?.allows(now) === false) {
        exclude.set(addressKey(endpoint.address), endpoint.address)
      }
    }
    return exclude
  }

  #endpoint(key: string, address: RpcAddress, route: Route): Endpoint {
    let endpoint = this.#endpoints.get(key)
    if (!endpoint) {
      endpoint = { address, connections: new Set(), routes: new Set(), retryAt: 0 }
      this.#endpoints.set(key, endpoint)
    }
    if (!route.endpoints.has(endpoint)) {
      const breaker = this.#circuitSettings && new CircuitBreaker(this.#circuitSettings)
      route.endpoints.set(endpoint, breaker)
      endpoint.routes.add(route)
    }
    return endpoint
  }

  async #connect(endpoint: Endpoint): Promise<void> {
    if (endpoint.pending) return endpoint.pending
    if (endpoint.retryAt > performance.now()) throw new RpcError('UNAVAILABLE', 'Micro address is cooling down')
    const pending = this.#dial(endpoint).finally(() => {
      endpoint.pending = undefined
      this.#dials.delete(pending)
    })
    endpoint.pending = pending
    this.#dials.add(pending)
    return pending
  }

  async #dial(endpoint: Endpoint): Promise<void> {
    const lifetime = this.#lifetime.signal
    let peer: RpcPeer
    try {
      const expiresAt = performance.now() + this.#connectTimeoutMs
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(this.#connectTimeoutMs)])
      peer = await RpcPeer.connect(endpoint.address, { signal })
      if (performance.now() >= expiresAt) {
        await peer.close()
        throw new DOMException('Micro dial timed out', 'TimeoutError')
      }
    } catch (cause) {
      lifetime.throwIfAborted()
      const now = performance.now()
      if (!endpoint.connections.size && endpoint.retryAt <= now) endpoint.retryAt = now + FAILED_ADDRESS_MS
      throw new RpcError('UNAVAILABLE', 'Micro could not establish the RPC connection', { cause })
    }
    if (lifetime.aborted) {
      await peer.close()
      throw lifetime.reason
    }
    const connection: Connection = { peer, active: 0, reservedIds: 0, idleSince: performance.now() }
    endpoint.retryAt = 0
    endpoint.connections.add(connection)
    this.#peers.add(peer)
    peer.onClose(async ({ reason }) => {
      endpoint.connections.delete(connection)
      if (reason !== 'local' && !endpoint.connections.size) endpoint.retryAt = performance.now() + FAILED_ADDRESS_MS
      // The endpoint can be reused before close() releases the native socket.
      await peer.close()
      this.#peers.delete(peer)
    })
  }

  #release(connection: Connection): void {
    if (--connection.active !== 0) return
    connection.idleSince = performance.now()
    if (connection.peer.remainingOutgoingCallIds === 0) void connection.peer.close()
  }

  #prune(): void {
    const now = performance.now()
    for (const [key, endpoint] of this.#endpoints) {
      for (const connection of endpoint.connections) {
        if (!connection.active && now - connection.idleSince >= this.#idleTimeoutMs) void connection.peer.close()
      }
      if (endpoint.connections.size || endpoint.pending || endpoint.retryAt > now) continue
      if ([...endpoint.routes].some(route => {
        const retryAt = route.endpoints.get(endpoint)?.retryAt
        return retryAt !== undefined && now - retryAt < this.#idleTimeoutMs
      })) continue
      for (const route of endpoint.routes) route.endpoints.delete(endpoint)
      this.#endpoints.delete(key)
    }
    for (const [service, route] of this.#routes) {
      if (!route.pending && !route.endpoints.size && (!route.failure || route.failure.retryAt <= now)) {
        this.#routes.delete(service)
      }
    }
  }

  async #dispose(): Promise<void> {
    clearInterval(this.#sweep)
    await Promise.allSettled([
      ...this.#lookups, ...this.#dials, ...Array.from(this.#peers, peer => peer.close()),
    ])
    this.#routes.clear()
    this.#endpoints.clear()
  }
}

export function createMicroClient(options: MicroOptions): MicroClient {
  return new Client(options)
}
