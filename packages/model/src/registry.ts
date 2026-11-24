import { Service, type Context, type Fiber } from '@deepseek-ai/cordis'
import { isModelDefinition, type ModelDefinition, type ModelMethods } from './definition.js'
import type { ModelTypes } from './index.js'
import { mountOperation, type ModelOperationDefinition } from './operation.js'

export const registerDefinition = Symbol('registerModelDefinition')

type ModelName = keyof ModelTypes & string

type RegisteredDefinition<Name extends ModelName> = Name extends ModelName ? ModelDefinition<Name, {
  readonly [Method in keyof ModelTypes[Name]]: ModelOperationDefinition<ModelTypes[Name][Method]>
}> : never

export interface ModelRegistration<Name extends string = ModelName> {
  readonly name: Name
  readonly fiber: Fiber
}

export interface ModelRegistry {
  register<Name extends ModelName>(
    definition: { readonly name: Name } & RegisteredDefinition<NoInfer<Name>>,
  ): ModelRegistration<Name>
  unregister(registration: ModelRegistration<string>): Promise<void>
}

interface ModelRegistryService extends ModelRegistry {
  [registerDefinition]<Name extends string>(definition: ModelDefinition<Name, ModelMethods>): ModelRegistration<Name>
}

class ModelNamespace extends Service {
  constructor(ctx: Context, path: string) {
    super(ctx, path)
  }
}

class Models extends Service implements ModelRegistryService {
  private readonly registrations = new WeakMap<ModelRegistration<string>, Fiber>()

  constructor(ctx: Context) {
    super(ctx, 'models')
  }

  register<Name extends ModelName>(
    definition: { readonly name: Name } & RegisteredDefinition<NoInfer<Name>>,
  ): ModelRegistration<Name> {
    if (!isModelDefinition(definition)) throw new TypeError('Model must be defined with defineModel()')
    return this[registerDefinition](definition)
  }

  [registerDefinition]<Name extends string>(definition: ModelDefinition<Name, ModelMethods>): ModelRegistration<Name> {
    const { name, methods } = definition
    if (name in this) throw new TypeError(`Reserved Model name "${name}"`)

    const path = `models.${name}`
    const fiber = this.ctx.plugin({
      name: path,
      inject: ['models'],
      apply(ctx) {
        new ModelNamespace(ctx, path)
        for (const [methodName, method] of Object.entries(methods)) {
          const methodPath = `${path}.${methodName}`
          ctx.inject([path, ...method.inject], (methodCtx) => {
            methodCtx.provide(methodPath, method[mountOperation](methodCtx, methodPath))
          })
        }
      },
    })

    const registration: ModelRegistration<Name> = { name, fiber }
    this.registrations.set(registration, fiber)
    return registration
  }

  async unregister(registration: ModelRegistration<string>): Promise<void> {
    await this.registrations.get(registration)?.dispose()
  }
}

export { Models as models }

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly models: ModelRegistryService & Readonly<ModelTypes>
  }
}
