import { defineModel, defineModelOperation } from '@ainess/model'
import { EntitySchema } from 'typeorm'

/** @typedef {{ id: number, tenantId: string, buyerId: string, status: 'pending' | 'paid' | 'cancelled' }} Order */
/** @typedef {{ tenantId: string, userId: string }} OrderCaller */

/** @type {EntitySchema<Order>} */
export const orderEntity = new EntitySchema({
  name: 'ModelTestOrder',
  columns: {
    id: { type: Number, primary: true },
    tenantId: { type: String },
    buyerId: { type: String },
    status: { type: String },
  },
})

/** @type {import('@standard-schema/spec').StandardSchemaV1<{ status: string }, { status: 'pending' | 'paid' }>} */
const policySchema = {
  '~standard': {
    version: 1,
    vendor: 'ainess-test',
    validate(value) {
      if (value && typeof value === 'object' && 'status' in value
        && (value.status === 'pending' || value.status === 'paid')) {
        return { value: { status: value.status } }
      }
      return { issues: [{ message: 'Invalid status' }] }
    },
  },
}

export let cancelValidations = 0

/** @type {import('@standard-schema/spec').StandardSchemaV1<{ orderId: string }, { orderId: number }>} */
const cancelSchema = {
  '~standard': {
    version: 1,
    vendor: 'ainess-test',
    validate(value) {
      cancelValidations++
      if (value && typeof value === 'object' && 'orderId' in value && typeof value.orderId === 'string') {
        const orderId = Number(value.orderId)
        if (Number.isSafeInteger(orderId) && orderId > 0) return { value: { orderId } }
      }
      return { issues: [{ message: 'Invalid order ID' }] }
    },
  },
}

export const ordersModel = defineModel('orders', {
  cancellationPolicy: defineModelOperation({
    schema: policySchema,
    execute({ status }) {
      return { canCancel: status === 'pending' }
    },
  }),
  cancelOrder: defineModelOperation({
    schema: cancelSchema,
    inject: ['typeorm'],
    /**
     * @param {import('@standard-schema/spec').StandardSchemaV1.InferOutput<typeof cancelSchema>} input
     * @param {import('@ainess/model').ModelCall<OrderCaller>} call
     */
    execute(input, call, { typeorm }) {
      const scope = { id: input.orderId, tenantId: call.caller.tenantId, buyerId: call.caller.userId }
      return typeorm.transaction(async (manager) => {
        const orders = manager.getRepository(orderEntity)
        await orders.update({ ...scope, status: 'pending' }, { status: 'cancelled' })
        const order = await orders.findOneBy(scope)
        if (!order) return /** @type {const} */ ({ kind: 'rejected', code: 'ORDER_NOT_FOUND' })
        if (order.status !== 'cancelled') {
          return /** @type {const} */ ({ kind: 'rejected', code: 'ORDER_NOT_CANCELLABLE' })
        }
        return /** @type {const} */ ({ kind: 'success', value: { id: order.id, status: order.status } })
      })
    },
  }),
})

/** @type {import('@standard-schema/spec').StandardSchemaV1<undefined>} */
const emptySchema = {
  '~standard': {
    version: 1,
    vendor: 'ainess-test',
    validate(value) {
      if (value === undefined) return { value }
      return { issues: [{ message: 'Expected no input' }] }
    },
  },
}

export const resourceModel = defineModel('resource', {
  read: defineModelOperation({
    schema: emptySchema,
    inject: ['modelTestResource'],
    execute(_input, _call, { modelTestResource }) {
      return modelTestResource.read()
    },
  }),
})
