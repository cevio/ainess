import type { Context } from '@deepseek-ai/cordis'
import type { WebSocketConnection, WebSocketMessage, WebSocketRoute } from '@ainess/websocket'
import { defineWebSocketEndpoint, defineWebSocketMethod, WebSocketMethodMode } from '@ainess/websocket'
import { websocketRoutes } from '@ainess/websocket/loader'
import type { StandardSchemaV1 } from '@standard-schema/spec'

declare const ctx: Context

ctx.websocket.route('/echo', {
  onMessage(connection, message) {
    const state: undefined = connection.state
    const payload: WebSocketMessage = message
    void state
    return connection.send(payload)
  },
})

ctx.websocket.route('/identity', {
  async authorize({ request, signal }) {
    signal.throwIfAborted()
    const user = request.headers['x-user']
    if (typeof user !== 'string') return { accept: false, status: 401 }
    return { accept: true, state: { user } }
  },
  onMessage(connection) {
    const typed: WebSocketConnection<{ user: string }> = connection
    return typed.send(typed.state.user)
  },
})

const typedRoute: WebSocketRoute<{ user: string }> = {
  authorize: () => ({ accept: true, state: { user: 'demo' } }),
  onMessage(connection) {
    return connection.send(connection.state.user)
  },
}
ctx.websocket.route('/typed', typedRoute)

declare const stringSchema: StandardSchemaV1<unknown, string>
declare const numberSchema: StandardSchemaV1<unknown, number>

ctx.websocket.route('/named', defineWebSocketEndpoint({
  authorize: () => ({ accept: true, state: { user: 'demo' } }),
  methods: {
    identity: {
      handle(_data, { connection }) {
        return connection.state.user.toUpperCase()
      },
    },
    stream: defineWebSocketMethod({
      mode: WebSocketMethodMode.Bidi,
      schema: stringSchema,
      inputSchema: numberSchema,
      async *handle(data, { input }) {
        for await (const value of input) yield data.toUpperCase() + value.toFixed(2)
      },
    }),
    upload: {
      mode: WebSocketMethodMode.ClientStream,
      async handle(_data, { connection, input }) {
        const source: AsyncIterable<unknown> = input
        for await (const item of source) return { item, user: connection.state.user.toUpperCase() }
      },
    },
  },
  events: {
    changed: {
      schema: numberSchema,
      handle(value, { emit }) { return emit('output', value.toFixed(2)) },
    },
  },
}))

defineWebSocketEndpoint({ methods: {
  // @ts-expect-error A server-streaming method must return a stream.
  invalidOutput: { mode: WebSocketMethodMode.ServerStream, handle: () => 1 },
  // @ts-expect-error Only methods with streaming input can declare a chunk schema.
  invalidSchema: { inputSchema: stringSchema, handle: () => undefined },
} })

// @ts-expect-error A unary method cannot validate streaming input.
defineWebSocketMethod({ mode: WebSocketMethodMode.Unary, inputSchema: stringSchema, handle: () => undefined })

// @ts-expect-error Declaring a typed startup schema requires its runtime validator.
defineWebSocketMethod<typeof stringSchema>({ handle: data => data.toUpperCase() })

// @ts-expect-error Declaring a typed chunk schema requires its runtime validator.
defineWebSocketMethod<undefined, typeof numberSchema>({ mode: WebSocketMethodMode.ClientStream, handle: () => 1 })

// @ts-expect-error The loader exposes its service dependencies by name.
const numericService: number = websocketRoutes({ directory: '.' }).inject[0]
void numericService
