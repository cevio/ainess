import type { Context } from '@deepseek-ai/cordis'
import type { StandardSchemaV1 } from '@standard-schema/spec'

type Dependency = keyof Context & string
export const mountOperation = Symbol('mountModelOperation')

// A dependency is required only when it appears in every possible inject tuple.
type IncludesDependency<Inject extends readonly Dependency[], Name extends Dependency> =
  Inject extends readonly [infer First, ...infer Rest extends readonly Dependency[]]
    ? [First] extends [Name] ? true : IncludesDependency<Rest, Name>
    : false

type RequiredDependency<Inject extends readonly Dependency[]> = {
  [Name in Inject[number]]: IncludesDependency<Inject, Name> extends true ? Name : never
}[Inject[number]]

type InjectedServices<Inject extends readonly Dependency[]> = Pick<Context, RequiredDependency<Inject>>
  & Partial<Pick<Context, Exclude<Inject[number], RequiredDependency<Inject>>>>

export interface ModelCall<Caller = unknown> {
  readonly caller: Caller
  readonly signal?: AbortSignal
}

export type ModelOperation<Schema extends StandardSchemaV1, Caller, Output> =
  ((input: StandardSchemaV1.InferOutput<Schema>, call: ModelCall<Caller>) => Promise<Output>)
  & { readonly inputSchema: Schema }

export interface ModelOperationDefinition<Operation = unknown> {
  readonly inject: readonly Dependency[]
  [mountOperation](ctx: Context, path: string): Operation
}

export function defineModelOperation<
  Schema extends StandardSchemaV1,
  const Inject extends readonly Dependency[] = readonly [],
  Caller = unknown,
  Output = unknown,
>(
  options: {
    schema: Schema
    inject?: Inject
    execute: (
      input: StandardSchemaV1.InferOutput<Schema>,
      call: ModelCall<Caller>,
      dependencies: InjectedServices<Inject>,
    ) => Output | Promise<Output>
  } & ([] extends Inject ? unknown : { inject: Inject }),
): ModelOperationDefinition<ModelOperation<Schema, Caller, Output>> {
  const { schema, execute } = options
  if (typeof execute !== 'function') throw new TypeError('Model operation execute must be a function')
  if (typeof schema?.['~standard']?.validate !== 'function') {
    throw new TypeError('Model operation schema must provide Standard Schema validation')
  }
  if (options.inject !== undefined && !Array.isArray(options.inject)) {
    throw new TypeError('Model operation inject must be an array of service names')
  }
  const inject = [...(options.inject ?? [])]
  if (inject.some(name => typeof name !== 'string' || !name)) {
    throw new TypeError('Model operation inject entries must be non-empty service names')
  }

  return {
    inject,
    [mountOperation](ctx, path) {
      const dependencies: Pick<Context, Inject[number]> = Object.create(null)
      for (const name of inject) dependencies[name] = ctx[name]
      const pending = new Set<Promise<unknown>>()
      ctx.effect(() => async () => {
        await Promise.allSettled(pending)
      }, `model operation ${path}`)

      const operation = async (input: StandardSchemaV1.InferOutput<Schema>, call: ModelCall<Caller>) => {
        // Dependents can still hold this reference while Cordis waits for their cleanup.
        if (ctx.get(path) !== operation) throw new Error(`Model operation "${path}" is inactive`)

        const invocation = Promise.resolve().then(() => execute(input, call, dependencies))
        pending.add(invocation)
        try {
          return await invocation
        } finally {
          pending.delete(invocation)
        }
      }
      return Object.assign(operation, { inputSchema: schema })
    },
  }
}
