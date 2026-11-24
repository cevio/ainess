import assert from 'node:assert/strict'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { httpControllers } from '@ainess/http/controllers'
import { models } from '@ainess/model'
import { modelDirectory } from '@ainess/model/loader'
import { typeorm } from '@ainess/typeorm'
import { defineApp, use } from '../dist/index.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */

function gate() {
  let release = () => {}
  const promise = new Promise((resolve) => { release = () => resolve(undefined) })
  return { promise, release }
}

test('drains multiple entries before closing the database', { timeout: 5000 }, async (t) => {
  const workerPreparing = gate()
  const workerReady = gate()
  const workerDraining = gate()
  const workerDrained = gate()
  const httpDraining = gate()
  const httpDrained = gate()
  const requestArrived = gate()
  const finishRequest = gate()
  const host = '127.0.0.1'
  const definition = defineApp({
    startupTimeoutMs: 3000,
    plugins: {
      controllers: use(httpControllers({
        directory: new URL('./fixtures/controllers/', import.meta.url),
        prefix: '/api',
        inject: ['models', 'models.application', 'models.application.databaseReady'],
      })),
      modelFiles: use(modelDirectory, { directory: new URL('./fixtures/models/', import.meta.url) }),
      models: use(models),
      http: use(http),
      database: use(typeorm, { type: 'sqljs' }),
      slowRoute: use({
        inject: ['http', 'typeorm'],
        /** @param {Context} ctx */
        apply(ctx) {
          ctx.http.route('GET', '/in-flight', async (request) => {
            requestArrived.release()
            await finishRequest.promise
            request.body = { ready: ctx.typeorm.isInitialized }
          })
        },
      }),
    },
    entries: {
      web: use(httpListener, {
        host,
        port: 0,
        prepare(_server, handle) {
          return {
            handle,
            async dispose() {
              httpDraining.release()
              await httpDrained.promise
            },
          }
        },
      }),
      worker: use({
        inject: ['typeorm'],
        /** @param {Context} ctx */
        async apply(ctx) {
          ctx.effect(() => async () => {
            workerDraining.release()
            await workerDrained.promise
          })
          assert.equal(ctx.typeorm.isInitialized, true)
          workerPreparing.release()
          await workerReady.promise
        },
      }),
      disabled: false,
    },
  })

  let started = false
  const startup = definition.start().then((app) => {
    started = true
    return app
  })
  t.after(async () => {
    workerReady.release()
    workerDrained.release()
    httpDrained.release()
    finishRequest.release()
    await startup.then((app) => app.stop(), () => {})
  })

  await workerPreparing.promise
  assert.equal(started, false)
  workerReady.release()
  const app = await startup
  const database = app.ctx.typeorm
  const address = app.ctx.http.address()
  assert.ok(address)
  const origin = `http://${host}:${address.port}`
  assert.deepEqual(await (await fetch(`${origin}/api`)).json(), { ready: true })

  const inFlight = fetch(`${origin}/in-flight`)
  await requestArrived.promise
  const stop = app.stop()
  assert.equal(stop, app.stop())
  await workerDraining.promise
  finishRequest.release()
  assert.deepEqual(await (await inFlight).json(), { ready: true })
  await httpDraining.promise
  assert.equal(database.isInitialized, true)
  workerDrained.release()
  httpDrained.release()
  await stop
  assert.equal(database.isInitialized, false)
  assert.equal(app.ctx.get('http'), undefined)
})

test('startup can finish after one minute when the timeout is omitted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ready = gate()
  const app = defineApp({
    plugins: { waiting: use(async () => { await ready.promise }) },
  })

  const startup = app.start()
  t.mock.timers.tick(60_000)
  ready.release()
  const running = await startup
  await running.stop()
})

test('a pending plugin reports missing injections without starting an entry', async () => {
  let disposed = false
  const app = defineApp({
    plugins: {
      missing: use({ inject: ['requiredService'], apply: () => assert.fail('Missing service was injected') }),
      provider: use((ctx) => { ctx.effect(() => () => { disposed = true }) }),
    },
    entries: { web: use(() => assert.fail('Entry was opened')) },
    startupTimeoutMs: 40,
  })

  await assert.rejects(app.start(), /plugins\.missing.*requiredService/)
  assert.equal(disposed, true)
})

test('an entry is not mounted if a plugin is disposed while startup is yielding', async () => {
  let disposeProvider = () => Promise.resolve()
  let mounted = false
  const app = defineApp({
    startupTimeoutMs: 500,
    plugins: {
      provider: use((ctx) => {
        ctx.provide('startupDependency', {})
        disposeProvider = ctx.fiber.dispose
      }),
      consumer: use({
        inject: ['startupDependency'],
        /** @param {Context} ctx */
        apply(ctx) {
          ctx.on('internal/status', (fiber) => {
            if (fiber === ctx.fiber && fiber.state === 2) queueMicrotask(() => { void disposeProvider() })
          })
        },
      }),
    },
    entries: {
      web: {
        mount(ctx) {
          mounted = true
          return ctx.plugin(() => {})
        },
      },
    },
  })

  await assert.rejects(app.start(), /plugins\.provider was disposed/)
  assert.equal(mounted, false)
})

test('a failed entry rolls back the whole entry group, including an entry still starting', async () => {
  const preparing = gate()
  const resume = gate()
  const cancelPending = gate()
  const cause = new Error('entry could not start')
  /** @type {string[]} */
  const disposed = []
  const app = defineApp({
    plugins: { provider: use((ctx) => { ctx.effect(() => () => { disposed.push('provider') }) }) },
    entries: {
      active: use((ctx) => { ctx.effect(() => () => { disposed.push('active') }) }),
      pending: use(async (ctx) => {
        ctx.on('internal/plugin', (fiber) => {
          if (fiber === ctx.fiber && fiber.uid === null) {
            cancelPending.release()
            resume.release()
          }
        })
        await ctx.effect(async () => {
          preparing.release()
          await resume.promise
          return () => { disposed.push('pending') }
        })
      }),
      failed: use(async () => {
        await preparing.promise
        throw cause
      }),
    },
  })

  await assert.rejects(app.start(), (error) => error instanceof Error
    && error.cause === cause && /entries\.failed/.test(error.message))
  await cancelPending.promise
  assert.deepEqual(disposed.slice(0, -1).sort(), ['active', 'pending'])
  assert.equal(disposed.at(-1), 'provider')
})

test('drains a partially mounted entry before releasing application plugins', async () => {
  const cause = new Error('entry mount failed after creating a Fiber')
  /** @type {string[]} */
  const disposed = []
  const app = defineApp({
    plugins: { provider: use((ctx) => { ctx.effect(() => () => { disposed.push('provider') }) }) },
    entries: {
      partial: {
        mount(ctx) {
          const entry = ctx.plugin(() => {})
          entry.ctx.effect(() => async () => {
            await new Promise((resolve) => setImmediate(resolve))
            disposed.push('entry')
          })
          throw cause
        },
      },
    },
  })

  await assert.rejects(app.start(), (error) => error instanceof Error && error.cause === cause)
  assert.deepEqual(disposed, ['entry', 'provider'])
})

test('an aborted startup rolls back, and starting the same definition again creates a fresh scope', async () => {
  const abort = new AbortController()
  const preparing = gate()
  let disposed = 0
  const app = defineApp({
    plugins: { service: use((ctx) => { ctx.effect(() => () => { disposed++ }) }) },
    entries: { entry: use(() => { preparing.release() }) },
  })
  const reason = new Error('cancelled by host')
  const startup = app.start({ signal: abort.signal })
  await preparing.promise
  abort.abort(reason)
  await assert.rejects(startup, (error) => error === reason)
  assert.equal(disposed, 1)

  const first = await app.start()
  const second = await app.start()
  assert.notEqual(first.ctx, second.ctx)
  await Promise.all([first.stop(), second.stop()])
  assert.equal(disposed, 3)
})

test('rejects malformed configuration before mounting any plugins', () => {
  assert.throws(() => defineApp({
    entries: {
      // @ts-expect-error Checks JavaScript configuration at runtime.
      broken: true,
    },
  }), /entries\.broken/)
  // @ts-expect-error The public key is entries.
  assert.throws(() => defineApp({ entry: use(() => {}) }), /entry/)
  assert.throws(() => defineApp({ startupTimeoutMs: -1 }), /startupTimeoutMs/)
})
