import { addAbortListener } from 'node:events'
import {
  decodeWebSocketFrame,
  encodeWebSocketFrame,
  hasStreamingInput,
  hasStreamingOutput,
  isWebSocketMethodMode,
  pumpWebSocketStream,
  waitWithAbort,
  WebSocketEndpointError,
  WebSocketMethodMode,
  WebSocketStreamQueue,
  type WebSocketFrame,
} from '@ainess/websocket-shared'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { namedEndpoint, type TransportRoute } from './route.js'
import type { WebSocketAuthorize, WebSocketCloseInfo, WebSocketConnection, WebSocketRoute } from './types.js'

type MaybePromise<Value> = Value | Promise<Value>
type SchemaMap = Record<string, StandardSchemaV1 | undefined>
type InferSchema<Schema> = Schema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<Schema> : unknown
type SchemaOption<Name extends string, Schema extends StandardSchemaV1 | undefined> =
  Partial<Record<Name, Schema>> & (undefined extends Schema ? unknown : Record<Name, Schema>)

export interface WebSocketEndpointContext<State = undefined> {
  readonly connection: WebSocketConnection<State>
  emit(name: string, data?: unknown): Promise<void>
}

export interface WebSocketMethodContext<State = undefined> extends WebSocketEndpointContext<State> {
  readonly signal: AbortSignal
}

export interface WebSocketStreamingContext<State = undefined, Input = unknown> extends WebSocketMethodContext<State> {
  readonly input: AsyncIterable<Input>
}

export interface WebSocketMiddlewareContext<State = undefined> extends WebSocketMethodContext<State> {
  readonly kind: 'method' | 'event'
  readonly name: string
  readonly data: unknown
}

export type WebSocketEndpointMiddleware<State = undefined> = (
  ctx: WebSocketMiddlewareContext<State>, next: () => Promise<void>,
) => MaybePromise<void>

type Method<State, Data, InputSchema extends StandardSchemaV1 | undefined> =
  | { mode?: WebSocketMethodMode.Unary, inputSchema?: never,
    handle(data: Data, ctx: WebSocketMethodContext<State>): unknown }
  | { mode: WebSocketMethodMode.ServerStream, inputSchema?: never,
    handle(data: Data, ctx: WebSocketMethodContext<State>): MaybePromise<AsyncIterable<unknown>> }
  | (SchemaOption<'inputSchema', InputSchema> & {
    mode: WebSocketMethodMode.ClientStream
    handle(data: Data, ctx: WebSocketStreamingContext<State, InferSchema<InputSchema>>): unknown
  })
  | (SchemaOption<'inputSchema', InputSchema> & {
    mode: WebSocketMethodMode.Bidi
    handle(data: Data, ctx: WebSocketStreamingContext<State, InferSchema<InputSchema>>):
      MaybePromise<AsyncIterable<unknown>>
  })

export type WebSocketMethodDefinition<
  State = unknown,
  Schema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  InputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = SchemaOption<'schema', Schema> & Method<State, InferSchema<Schema>, InputSchema>

export type WebSocketEndpointMethod<State = unknown> = WebSocketMethodDefinition<State>

export function defineWebSocketMethod<
  Schema extends StandardSchemaV1 | undefined = undefined,
  InputSchema extends StandardSchemaV1 | undefined = undefined,
  State = unknown,
>(method: WebSocketMethodDefinition<State, Schema, InputSchema>): WebSocketEndpointMethod<State> {
  // The endpoint supplies schema-validated values before invoking this declaration.
  return method as WebSocketEndpointMethod<State>
}

export interface WebSocketEndpointOptions<
  State = undefined,
  Events extends SchemaMap = SchemaMap,
> {
  authorize?: WebSocketAuthorize<State>
  middlewares?: readonly WebSocketEndpointMiddleware<NoInfer<State>>[]
  methods?: Readonly<Record<string, WebSocketEndpointMethod<NoInfer<State>>>>
  events?: {
    [Name in keyof Events]: {
      schema?: Events[Name]
      handle(data: InferSchema<Events[Name]>, ctx: WebSocketEndpointContext<State>): MaybePromise<void>
    }
  }
  onOpen?(ctx: WebSocketEndpointContext<State>): MaybePromise<void>
  onClose?(ctx: WebSocketEndpointContext<State>, info: WebSocketCloseInfo): MaybePromise<void>
  onError?(error: unknown, ctx: WebSocketEndpointContext<State>): MaybePromise<void>
}

type CallFrame = Extract<WebSocketFrame, { type: 'call' }>
type EventFrame = Extract<WebSocketFrame, { type: 'event' }>

interface PreparedMethod {
  readonly mode: WebSocketMethodMode
  readonly schema?: StandardSchemaV1
  readonly inputSchema?: StandardSchemaV1
  readonly handle: (data: unknown, ctx: WebSocketMethodContext<unknown> & { input?: AsyncIterable<unknown> }) => unknown
}

interface PreparedEvent {
  readonly schema?: StandardSchemaV1
  readonly handle: (data: unknown, ctx: WebSocketEndpointContext<unknown>) => MaybePromise<void>
}

interface PendingEvent {
  readonly frame: EventFrame
  readonly event: PreparedEvent
}

interface Invocation {
  readonly controller: AbortController
  readonly input?: WebSocketStreamQueue<unknown>
  inputEnded: boolean
}

function definition(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function schemaOption(schema: unknown, name: string): StandardSchemaV1 | undefined {
  if (schema !== undefined && typeof (schema as StandardSchemaV1 | null)?.['~standard']?.validate !== 'function') {
    throw new TypeError(`${name} must implement Standard Schema`)
  }
  return schema as StandardSchemaV1 | undefined
}

function prepareMethod(name: string, entry: unknown): PreparedMethod {
  const { mode = WebSocketMethodMode.Unary, schema, inputSchema, handle } = definition(entry, `Method ${name}`)
  if (!isWebSocketMethodMode(mode) || typeof handle !== 'function') {
    throw new TypeError(`Invalid WebSocket method ${JSON.stringify(name)}`)
  }
  if (inputSchema !== undefined && !hasStreamingInput(mode)) {
    throw new TypeError(`WebSocket method ${name} requires streaming input to use inputSchema`)
  }
  return {
    mode,
    schema: schemaOption(schema, `${name} schema`),
    inputSchema: schemaOption(inputSchema, `${name} inputSchema`),
    handle: handle as PreparedMethod['handle'],
  }
}

function prepareMethods(value: unknown): ReadonlyMap<string, PreparedMethod> {
  return new Map(Object.entries(definition(value ?? {}, 'WebSocket methods')).map(([name, entry]) => {
    if (!name) throw new TypeError('A WebSocket method name is required')
    return [name, prepareMethod(name, entry)]
  }))
}

function prepareEvents(value: unknown): ReadonlyMap<string, PreparedEvent> {
  const events = new Map<string, PreparedEvent>()
  for (const [name, entry] of Object.entries(definition(value ?? {}, 'WebSocket events'))) {
    const { schema, handle } = definition(entry, `Event ${name}`)
    if (!name || typeof handle !== 'function') throw new TypeError(`Invalid WebSocket event ${JSON.stringify(name)}`)
    events.set(name, { schema: schemaOption(schema, `${name} schema`), handle: handle as PreparedEvent['handle'] })
  }
  return events
}

async function validate(schema: StandardSchemaV1 | undefined, data: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!schema) return data
  const validation = schema['~standard'].validate(data)
  const result = 'then' in validation ? await waitWithAbort(validation, signal) : validation
  signal.throwIfAborted()
  if (result.issues) throw new WebSocketEndpointError('INVALID_PARAMS', result.issues[0]?.message)
  return result.value
}

async function runMiddlewares(
  middlewares: readonly WebSocketEndpointMiddleware<unknown>[],
  ctx: WebSocketMiddlewareContext<unknown>,
  handle: () => MaybePromise<void>,
): Promise<boolean> {
  let invoked = false
  async function dispatch(index: number): Promise<void> {
    ctx.signal.throwIfAborted()
    const middleware = middlewares[index]
    if (!middleware) {
      invoked = true
      await handle()
      return
    }
    let downstream: Promise<void> | undefined
    let settled = false
    let returned = false
    let completion: MaybePromise<void>
    try {
      completion = middleware(ctx, () => {
        if (returned || downstream) {
          throw new Error('WebSocket middleware next can only be called once before completion')
        }
        downstream = dispatch(index + 1)
        const settle = () => { settled = true }
        void downstream.then(settle, settle)
        return downstream
      })
      if (completion !== undefined) await completion
    } catch (error) {
      returned = true
      // Events share an ordered queue. Method failures cancel their own downstream work.
      if (ctx.kind === 'event' && downstream) await downstream.catch(() => {})
      throw error
    }
    returned = true
    // A synchronous middleware delegates downstream failures to the dispatcher.
    // An async middleware may already have handled a rejection from next().
    if (completion === undefined || !settled) await downstream
  }
  await dispatch(0)
  return invoked
}

class EndpointSession {
  readonly context: WebSocketEndpointContext<unknown>
  private readonly calls = new Map<string, Invocation>()
  private latestId = '0'
  private pendingEvents?: WebSocketStreamQueue<PendingEvent>

  constructor(
    connection: WebSocketConnection<unknown>,
    private readonly methods: ReadonlyMap<string, PreparedMethod>,
    private readonly events: ReadonlyMap<string, PreparedEvent>,
    private readonly middlewares: readonly WebSocketEndpointMiddleware<unknown>[],
    private readonly onError: WebSocketEndpointOptions<unknown>['onError'],
  ) {
    this.context = {
      connection,
      emit: async (name, data) => {
        if (typeof name !== 'string' || !name) throw new TypeError('A WebSocket event name is required')
        await this.send({ type: 'event', name, data })
      },
    }
    addAbortListener(connection.signal, () => {
      this.pendingEvents?.discard()
      for (const [id, call] of this.calls) this.cancel(id, call, new WebSocketEndpointError('DISCONNECTED'))
    })
  }

  receive(message: string | Uint8Array): void {
    try {
      const frame = decodeWebSocketFrame(message)
      switch (frame.type) {
        case 'call': this.open(frame); break
        case 'event': this.event(frame); break
        case 'chunk':
        case 'input-end':
        case 'cancel': this.update(frame); break
        default: throw new WebSocketEndpointError('PROTOCOL_ERROR', 'Unexpected frame from client')
      }
    } catch (error) {
      this.context.connection.close(1002, 'Invalid protocol frame')
      void this.report(error)
    }
  }

  private open(frame: CallFrame): void {
    const { id, name, mode } = frame
    const previous = this.latestId
    if (id.length < previous.length || (id.length === previous.length && id <= previous)) {
      throw new WebSocketEndpointError('PROTOCOL_ERROR', 'Call IDs must increase on each connection')
    }
    this.latestId = id
    const method = this.methods.get(name)
    if (!method) {
      void this.sendError(id, new WebSocketEndpointError('METHOD_NOT_FOUND')).catch(this.report)
      return
    }
    if (method.mode !== mode) {
      void this.sendError(id, new WebSocketEndpointError('MODE_MISMATCH')).catch(this.report)
      return
    }
    const call: Invocation = {
      controller: new AbortController(),
      input: hasStreamingInput(mode) ? new WebSocketStreamQueue() : undefined,
      inputEnded: false,
    }
    this.calls.set(id, call)
    void Promise.resolve().then(() => this.execute(frame, method, call)).catch(this.report)
  }

  private update(frame: Extract<WebSocketFrame, { type: 'chunk' | 'input-end' | 'cancel' }>) {
    const call = this.calls.get(frame.id)
    if (!call) return
    if (frame.type === 'cancel') {
      this.cancel(frame.id, call, new WebSocketEndpointError('CANCELLED'))
      return
    }
    if (!call.input || call.inputEnded) {
      const error = new WebSocketEndpointError('PROTOCOL_ERROR', 'Unexpected input for this WebSocket call')
      this.cancel(frame.id, call, error)
      void this.sendError(frame.id, error).catch(this.report)
      return
    }
    if (frame.type === 'chunk') call.input.push(frame.data)
    else {
      call.inputEnded = true
      call.input.end()
    }
  }

  private async execute({ id, name, data }: CallFrame, method: PreparedMethod, call: Invocation) {
    const { signal } = call.controller
    try {
      const parsed = await validate(method.schema, data, signal)
      const ctx = { ...this.context, signal }
      const input = call.input && this.readInput(call.input, method.inputSchema, signal)
      const streaming = hasStreamingOutput(method.mode)
      let result: unknown
      const invocation: WebSocketMiddlewareContext<unknown> = { ...ctx, kind: 'method', name, data: parsed }
      const invoked = await runMiddlewares(this.middlewares, invocation, async () => {
        result = await method.handle(parsed, input ? { ...ctx, input } : ctx)
        if (!streaming || signal.aborted) return
        await pumpWebSocketStream(result as AsyncIterable<unknown>, signal, (data) => {
          return this.send({ type: 'chunk', id, data })
        })
      })
      if (signal.aborted) return
      if (!invoked) throw new WebSocketEndpointError('REQUEST_BLOCKED')
      this.calls.delete(id)
      call.input?.discard()
      await this.send(streaming ? { type: 'end', id } : { type: 'result', id, data: result })
    } catch (cause) {
      if (signal.aborted) return
      const error = cause instanceof WebSocketEndpointError ? cause : new WebSocketEndpointError('INTERNAL_ERROR')
      this.cancel(id, call, error)
      if (!this.context.connection.signal.aborted) await this.sendError(id, cause)
    }
  }

  private async *readInput(
    input: WebSocketStreamQueue<unknown>, schema: StandardSchemaV1 | undefined, signal: AbortSignal,
  ) {
    for await (const data of input) yield await validate(schema, data, signal)
  }

  private event(frame: EventFrame) {
    const event = this.events.get(frame.name)
    if (!event) return
    if (!this.pendingEvents) {
      this.pendingEvents = new WebSocketStreamQueue()
      void this.runEvents(this.pendingEvents)
    }
    this.pendingEvents.push({ frame, event })
  }

  private async runEvents(pending: WebSocketStreamQueue<PendingEvent>) {
    const { signal } = this.context.connection
    for await (const { frame, event } of pending) {
      if (signal.aborted) return
      try {
        const data = await validate(event.schema, frame.data, signal)
        const ctx: WebSocketMiddlewareContext<unknown> = {
          ...this.context, signal, kind: 'event', name: frame.name, data,
        }
        await runMiddlewares(this.middlewares, ctx, () => event.handle(data, this.context))
      } catch (error) {
        if (!signal.aborted) void this.report(error)
      }
    }
  }

  private cancel(id: string, call: Invocation, error: WebSocketEndpointError) {
    this.calls.delete(id)
    call.controller.abort(error)
    call.input?.fail(error)
  }

  private async send(frame: WebSocketFrame) {
    this.context.connection.signal.throwIfAborted()
    await this.context.connection.send(encodeWebSocketFrame(frame))
  }

  private sendError(id: string, cause: unknown): Promise<void> {
    if (cause instanceof WebSocketEndpointError) {
      const { code, message } = cause
      if (typeof code === 'string' && code.length > 0 && typeof message === 'string') {
        return this.send({ type: 'error', id, error: { code, message } })
      }
    }
    void this.report(cause)
    const code = 'INTERNAL_ERROR'
    return this.send({ type: 'error', id, error: { code, message: code } })
  }

  readonly report = async (error: unknown) => {
    try {
      await this.onError?.(error, this.context)
    } catch {
      // Observers do not own the endpoint's transport or calls.
    }
  }
}

export function defineWebSocketEndpoint<State, Events extends SchemaMap>(
  options: WebSocketEndpointOptions<State, Events> & { authorize: WebSocketAuthorize<State> },
): WebSocketRoute<State>
export function defineWebSocketEndpoint<Events extends SchemaMap>(
  options: WebSocketEndpointOptions<undefined, Events> & { authorize?: undefined },
): WebSocketRoute
export function defineWebSocketEndpoint(options: unknown): TransportRoute<unknown> {
  const config = definition(options, 'WebSocket endpoint') as WebSocketEndpointOptions<unknown>
  const { authorize, onOpen, onClose, onError } = config
  for (const [name, callback] of Object.entries({ authorize, onOpen, onClose, onError })) {
    if (callback !== undefined && typeof callback !== 'function') throw new TypeError(`${name} must be a function`)
  }
  const methods = prepareMethods(config.methods)
  const events = prepareEvents(config.events)
  const middlewares = config.middlewares ?? []
  const chain = Array.isArray(middlewares) ? [...middlewares] : undefined
  if (!chain || chain.some(middleware => typeof middleware !== 'function')) {
    throw new TypeError('WebSocket endpoint middlewares must be an array of functions')
  }
  const sessions = new WeakMap<WebSocketConnection<unknown>, EndpointSession>()
  return {
    [namedEndpoint]: true,
    authorize,
    onOpen(connection) {
      const session = new EndpointSession(connection, methods, events, chain, onError)
      sessions.set(connection, session)
      if (onOpen) void Promise.resolve().then(() => onOpen(session.context)).catch(session.report)
    },
    onMessage(connection, message) {
      sessions.get(connection)?.receive(message)
    },
    onClose(connection, info) {
      const session = sessions.get(connection)
      sessions.delete(connection)
      if (onClose && session) return onClose(session.context, info)
    },
  }
}
