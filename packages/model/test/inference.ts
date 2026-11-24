import { defineModel, defineModelOperation, type InferModel } from '@ainess/model'
import type { Context } from '@deepseek-ai/cordis'
import { ordersModel, resourceModel } from './fixtures/orders.js'

declare module '@ainess/model' {
  interface ModelTypes {
    orders: InferModel<typeof ordersModel>
    resource: InferModel<typeof resourceModel>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly modelTestResource: { read(): Promise<string> }
  }
}

declare const ctx: Context

const call = { caller: { tenantId: 'shop', userId: 'buyer' } }
const result = await ctx.models.orders.cancelOrder({ orderId: 42 }, call)
if (result.kind === 'success') {
  const status: 'cancelled' = result.value.status
  const id: number = result.value.id
  console.assert(status === 'cancelled' && id === 42)
} else {
  const code: 'ORDER_NOT_FOUND' | 'ORDER_NOT_CANCELLABLE' = result.code
  console.assert(typeof code === 'string')
}

// @ts-expect-error Model methods accept the parsed input type.
await ctx.models.orders.cancelOrder({ orderId: '42' }, call)
// @ts-expect-error The caller is inferred from execute.
await ctx.models.orders.cancelOrder({ orderId: 42 }, { caller: {} })
// @ts-expect-error Only registered type declarations are part of the namespace.
ctx.models.unknown

const registration = ctx.models.register(ordersModel)
const name: 'orders' = registration.name
console.assert(name === 'orders')
// @ts-expect-error The registration name determines the supported Model methods.
ctx.models.register({ ...resourceModel, name: 'orders' })

defineModelOperation({
  schema: ctx.models.orders.cancelOrder.inputSchema,
  execute(input, _call, dependencies) {
    // @ts-expect-error Methods can only use the services they declare.
    dependencies.typeorm
    return input
  },
})

declare const useDatabase: boolean
const inject = useDatabase ? ['typeorm'] as const : [] as const
const schema = ctx.models.orders.cancelOrder.inputSchema

defineModelOperation({
  schema,
  inject,
  execute(input, _call, dependencies) {
    // @ts-expect-error A conditional dependency is not always available.
    dependencies.typeorm.isInitialized
    return input
  },
})

const sharedInject = useDatabase ? ['modelTestResource', 'typeorm'] as const : ['modelTestResource'] as const
defineModelOperation({
  schema,
  inject: sharedInject,
  execute(_input, _call, dependencies) {
    dependencies.typeorm?.isInitialized
    return dependencies.modelTestResource.read()
  },
})

const dependency = useDatabase ? 'modelTestResource' : 'typeorm'
defineModelOperation({
  schema,
  inject: [dependency],
  execute(input, _call, dependencies) {
    // @ts-expect-error A name chosen at runtime does not guarantee either service individually.
    dependencies.modelTestResource.read()
    return input
  },
})

// @ts-expect-error An explicit required dependency must be declared at runtime.
defineModelOperation<typeof schema, readonly ['typeorm']>({ schema, execute: input => input })

const selectedName = useDatabase ? 'orders' : 'resource'
// @ts-expect-error The method definition must match the name selected at runtime.
ctx.models.register({ ...ordersModel, name: selectedName })
ctx.models.register(useDatabase ? ordersModel : resourceModel)

const symbolMethod = Symbol('method')
// @ts-expect-error A Model method must have a name that can be registered as a Cordis service.
defineModel('orders', { [symbolMethod]: ordersModel.methods.cancelOrder })
