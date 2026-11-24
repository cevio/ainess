import { addAbortListener } from 'node:events'
import { Context, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import type { PluginEntry, RunningApp } from './index.js'

// Cordis 4.1 exports FiberState as a const enum in its declarations only.
const active: FiberState.ACTIVE = 2

export interface ConfiguredPlugin {
  readonly path: string
  readonly entry: PluginEntry
}

interface MountedPlugin {
  readonly path: string
  readonly fiber: Fiber
}

interface StartupConfig {
  readonly plugins: readonly ConfiguredPlugin[]
  readonly entries: readonly ConfiguredPlugin[]
  readonly startupTimeoutMs?: number
}

export async function startApp(config: StartupConfig, signal?: AbortSignal): Promise<RunningApp> {
  signal?.throwIfAborted()
  const ctx = new Context()
  const plugins: MountedPlugin[] = []
  const entries: MountedPlugin[] = []
  const { startupTimeoutMs } = config
  let startup = signal
  let timeout: ReturnType<typeof setTimeout> | undefined
  if (startupTimeoutMs !== undefined) {
    const deadline = new AbortController()
    startup = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
    timeout = setTimeout(() => {
      deadline.abort(timeoutError(startupTimeoutMs, [...plugins, ...entries]))
    }, startupTimeoutMs)
  }
  let entryScope: Fiber | undefined
  let stopping: Promise<void> | undefined
  const stop = () => stopping ??= disposeApp(ctx, entryScope)

  try {
    mountPlugins(ctx, config.plugins, plugins, startup)
    if (config.entries.length) {
      entryScope = ctx.plugin({ name: 'app-entries', apply() {} }).ctx.fiber
    }
    while (!plugins.every(isActive)) await waitForActivation(ctx, plugins, startup)
    if (entryScope) mountPlugins(entryScope.ctx, config.entries, entries, startup)
    const mounted = [...plugins, ...entries]
    while (!mounted.every(isActive)) await waitForActivation(ctx, mounted, startup)
    startup?.throwIfAborted()
    return { ctx, stop }
  } catch (error) {
    try {
      await stop()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Application startup and cleanup failed', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function isActive({ fiber }: MountedPlugin): boolean {
  return fiber.uid !== null && fiber.state === active
}

function mountPlugins(
  ctx: Context,
  configured: readonly ConfiguredPlugin[],
  mounted: MountedPlugin[],
  signal?: AbortSignal,
): void {
  for (const { path, entry } of configured) {
    signal?.throwIfAborted()
    try {
      const fiber = entry.mount(ctx).ctx.fiber
      if (fiber === ctx.fiber || fiber.parent.fiber !== ctx.fiber) {
        throw new TypeError('Expected a child Fiber in this application')
      }
      mounted.push({ path, fiber })
    } catch (cause) {
      throw new Error(`Failed to mount ${path}`, { cause })
    }
  }
}

async function waitForActivation(ctx: Context, plugins: readonly MountedPlugin[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const byFiber = new Map(plugins.map((item) => [item.fiber, item]))
  let unsubscribe: ReturnType<Context['on']> | undefined
  let abort: ReturnType<typeof addAbortListener> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (plugins.every(isActive)) resolve()
      }
      const observe = ({ path, fiber }: MountedPlugin) => {
        void fiber.await().then(() => {
          if (fiber.uid === null) reject(new Error(`${path} was disposed during startup`))
          check()
        }, (cause) => reject(new Error(`Failed to start ${path}`, { cause })))
      }
      unsubscribe = ctx.on('internal/status', (fiber) => {
        const item = byFiber.get(fiber)
        if (item) observe(item)
      })
      if (signal) abort = addAbortListener(signal, () => reject(signal.reason))
      for (const item of plugins) observe(item)
      check()
    })
  } finally {
    abort?.[Symbol.dispose]()
    await unsubscribe?.()
  }
}

function timeoutError(milliseconds: number, plugins: readonly MountedPlugin[]): Error {
  const waiting = plugins.filter((item) => !isActive(item)).map(({ path, fiber }) => {
    const missing = Object.keys(fiber.inject).filter((name) => fiber.ctx.get(name) === undefined)
    return missing.length ? `${path} (missing ${missing.join(', ')})` : path
  })
  return new Error(`Application startup timed out after ${milliseconds} ms waiting for ${waiting.join(', ')}`)
}

async function disposeApp(ctx: Context, entryScope?: Fiber): Promise<void> {
  const errors: unknown[] = []
  for (const fiber of entryScope ? [entryScope, ctx.fiber] : [ctx.fiber]) {
    try {
      await fiber.dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Application cleanup failed')
}
