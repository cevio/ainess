import { Service } from '@deepseek-ai/cordis'
import { mountOperation, type ModelOperationDefinition } from './operation.js'

const definitions = new WeakSet<object>()
declare const modelDefinition: unique symbol

export type ModelMethods = Readonly<Record<string, ModelOperationDefinition>>

export interface ModelDefinition<Name extends string, Methods extends ModelMethods> {
  readonly [modelDefinition]: true
  readonly name: Name
  readonly methods: Readonly<Methods>
}

export function checkName(name: string) {
  const reserved = name === 'then' || name === 'ctx' || name === 'name' || name in Service.prototype
  if (!name || name.includes('.') || reserved) {
    throw new TypeError(`Invalid or reserved Model name "${name}"`)
  }
}

export function defineModel<const Name extends string, const Methods extends ModelMethods>(
  name: Name,
  methods: Methods & Record<Extract<keyof Methods, symbol>, never>,
): ModelDefinition<Name, Methods> {
  checkName(name)
  const entries = Reflect.ownKeys(methods).map((methodName) => {
    if (typeof methodName !== 'string') throw new TypeError('Model method name must be a string')
    checkName(methodName)
    const method = methods[methodName]
    if (typeof method?.[mountOperation] !== 'function') {
      throw new TypeError(`Model method "${methodName}" must be defined with defineModelOperation()`)
    }
    return [methodName, method] as const
  })
  const definition = Object.freeze({ name, methods: Object.freeze(Object.fromEntries(entries) as Methods) })
  definitions.add(definition)
  return definition as ModelDefinition<Name, Methods>
}

export type InferModel<Definition extends ModelDefinition<string, ModelMethods>> = {
  readonly [Method in keyof Definition['methods']]: ReturnType<Definition['methods'][Method][typeof mountOperation]>
}

export function isModelDefinition(value: unknown): value is ModelDefinition<string, ModelMethods> {
  return typeof value === 'object' && value !== null && definitions.has(value)
}
