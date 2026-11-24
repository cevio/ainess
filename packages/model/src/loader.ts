import { importModules } from '@ainess/loader'
import type { Context } from '@deepseek-ai/cordis'
import { readModelConfig } from './config.js'
import { isModelDefinition } from './definition.js'
import { scanModelFiles, type ModelFilesOptions } from './files.js'
import { scanRuntimeModels } from './manifest.js'
import { registerDefinition, type ModelRegistration } from './registry.js'

export type ModelLoaderOptions = ModelFilesOptions | { config: string | URL }

export const modelDirectory = {
  name: 'model-directory',
  inject: ['models'],
  async apply(ctx: Context, options: ModelLoaderOptions): Promise<void> {
    await loadModels(ctx, options)
  },
}

export async function loadModels(
  ctx: Context,
  options: ModelLoaderOptions,
): Promise<readonly ModelRegistration<string>[]> {
  const loading = new AbortController()
  const { signal } = loading
  const stopPreparing = ctx.effect(function* () {
    yield () => loading.abort()
    yield ctx.on('internal/plugin', (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) loading.abort()
    })
    yield ctx.on('internal/service', (name) => {
      if ((name === 'models' || Object.hasOwn(ctx.fiber.inject, name)) && ctx.get(name) === undefined) {
        loading.abort()
      }
    })
  }, 'loadModels.prepare()')
  const isCancelled = () => signal.aborted || ctx.fiber.uid === null
  const registrations: ModelRegistration<string>[] = []
  let committed = false

  try {
    const files = 'config' in options
      ? await scanRuntimeModels((await readModelConfig(options.config)).loader)
      : await scanModelFiles(options)
    if (isCancelled()) return []

    const definitions = await importModules(files, (value) => {
      if (!isModelDefinition(value)) throw new TypeError('The default export must be a result of defineModel()')
      return value
    }, signal)
    if (isCancelled()) return []

    const sources = new Map<string, string>()
    for (const { file, value: definition } of definitions) {
      const previous = sources.get(definition.name)
      if (previous !== undefined) {
        throw new Error(`Duplicate Model "${definition.name}" in ${previous} and ${file.relativePath}`)
      }
      sources.set(definition.name, file.relativePath)
    }

    for (const { file, value: definition } of definitions) {
      if (isCancelled()) break
      try {
        const registration = ctx.models[registerDefinition](definition)
        registrations.push(registration)
        await registration.fiber.await()
      } catch (cause) {
        const detail = cause instanceof Error ? `: ${cause.message}` : ''
        throw new Error(`Failed to register Model from ${file.relativePath}${detail}`, { cause })
      }
    }
    if (isCancelled()) return []
    committed = true
    return registrations
  } catch (error) {
    if (!signal.aborted || error !== signal.reason) throw error
    return []
  } finally {
    if (!committed && registrations.length) {
      await Promise.allSettled(registrations.map(({ fiber }) => fiber.dispose()))
    }
    await stopPreparing()
  }
}
