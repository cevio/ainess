#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import type { AppDefinition, RunningApp } from '@ainess/framework'
import { Command, Option } from 'commander'

async function loadApp(location: string): Promise<AppDefinition> {
  try {
    const { default: app }: { default?: AppDefinition } = await import(pathToFileURL(location).href)
    if (typeof app?.start !== 'function') throw new TypeError('Expected a default export from defineApp()')
    return app
  } catch (cause) {
    throw new Error(`Failed to load app config ${location}`, { cause })
  }
}

async function start({ config }: { config: string }): Promise<void> {
  const location = resolve(config)
  const startup = new AbortController()
  const shutdown = new Promise<void>((resolve) => {
    startup.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  const interrupted = new Error('Application startup interrupted')
  const requestStop = () => startup.abort(interrupted)
  let loading = true
  const onIdle = () => startup.abort(loading
    ? new Error(`Failed to load app config ${location}: module evaluation did not complete`)
    : interrupted)
  process.on('SIGINT', requestStop)
  process.on('SIGTERM', requestStop)
  process.once('beforeExit', onIdle)
  try {
    const app = await Promise.race([
      loadApp(location),
      shutdown.then(() => { throw startup.signal.reason }),
    ])
    loading = false
    startup.signal.throwIfAborted()
    // Pending injections may leave the event loop idle before any entry starts.
    const keepAlive = setInterval(() => {}, 2_147_483_647)
    let running: RunningApp
    try {
      running = await app.start({ signal: startup.signal })
    } finally {
      clearInterval(keepAlive)
    }
    await shutdown
    await running.stop()
  } catch (error) {
    if (error !== interrupted) throw error
  } finally {
    process.off('SIGINT', requestStop)
    process.off('SIGTERM', requestStop)
    process.off('beforeExit', onIdle)
  }
}

const commandExited = Symbol('command exited')
const program = new Command('ainess')
  .description('Run Ainess applications')
  .exitOverride(({ exitCode }) => {
    process.exitCode = exitCode
    throw commandExited
  })

const configOption = new Option('--config <file>', 'Path to the ESM application config').default('ainess.config.mjs')
// Let Commander leave a following flag untouched and validate the missing value here.
configOption.required = false
configOption.optional = true

const startCommand = program.command('start')
  .description('Start an Ainess application')
  .addOption(configOption)
  .action(start)
startCommand.on('option:config', (file: string | null) => {
  if (!file) startCommand.error(`error: option '${configOption.flags}' argument missing`)
})

try {
  await program.parseAsync()
} catch (error) {
  if (error !== commandExited) {
    process.exitCode = 1
    process.stderr.write(`${inspect(error)}\n`)
  }
}

// Long-lived runtime handles can outlive the app. Flush both streams before exiting.
await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => {
  stream.write('', () => resolve())
})))
process.exit()
