import { addAbortListener } from 'node:events'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { startApp, type ConfiguredPlugin } from './start.js'

export interface PluginEntry {
  mount(ctx: Context): Fiber
}

export interface AppConfig {
  plugins?: Readonly<Record<string, PluginEntry | false>>
  entries?: Readonly<Record<string, PluginEntry | false>>
  startupTimeoutMs?: number
}

export interface AppStartOptions {
  signal?: AbortSignal
}

export type AppConfigFactory = (options: Readonly<AppStartOptions>) => AppConfig | PromiseLike<AppConfig>

export interface AppDefinition {
  start(options?: AppStartOptions): Promise<RunningApp>
}

export interface RunningApp {
  readonly ctx: Context
  stop(): Promise<void>
}

declare const register: Context['plugin']

export function use<P extends Plugin>(...args: Parameters<typeof register<P>>): PluginEntry {
  return { mount: (ctx) => ctx.plugin<P>(...args) }
}

export function defineApp(config: AppConfig | AppConfigFactory): AppDefinition {
  if (typeof config === 'function') {
    return {
      async start({ signal } = {}) {
        const resolved = await resolveConfig(config, signal)
        signal?.throwIfAborted()
        return startApp(readConfig(resolved), signal)
      },
    }
  }
  const plan = readConfig(config)
  return { start: ({ signal } = {}) => startApp(plan, signal) }
}

async function resolveConfig(factory: AppConfigFactory, signal?: AbortSignal): Promise<AppConfig> {
  if (!signal) return factory({})
  signal.throwIfAborted()
  let abort: ReturnType<typeof addAbortListener> | undefined
  try {
    return await new Promise<AppConfig>((resolve, reject) => {
      abort = addAbortListener(signal, () => reject(signal.reason))
      void Promise.resolve(factory({ signal })).then(resolve, reject)
    })
  } finally {
    abort?.[Symbol.dispose]()
  }
}

function readConfig(config: AppConfig) {
  if (!isRecord(config)) throw new TypeError('App config must be an object')
  for (const key of Object.keys(config)) {
    if (key !== 'plugins' && key !== 'entries' && key !== 'startupTimeoutMs') {
      throw new TypeError(`Unknown app config option "${key}"`)
    }
  }
  const { startupTimeoutMs } = config
  if (startupTimeoutMs !== undefined
    && (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 2_147_483_647)) {
    throw new RangeError('startupTimeoutMs must be an integer from 1 to 2147483647')
  }
  return {
    plugins: readGroup(config.plugins, 'plugins'),
    entries: readGroup(config.entries, 'entries'),
    startupTimeoutMs,
  }
}

function isRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readGroup(group: AppConfig['plugins'], name: string): ConfiguredPlugin[] {
  if (group === undefined) return []
  if (!isRecord(group)) throw new TypeError(`${name} must be an object of Cordis plugin entries`)
  const plugins: ConfiguredPlugin[] = []
  for (const [key, entry] of Object.entries(group)) {
    if (entry === false) continue
    const path = `${name}.${key}`
    if (typeof entry?.mount !== 'function') throw new TypeError(`${path} must be a plugin entry or false`)
    plugins.push({ path, entry })
  }
  return plugins
}
