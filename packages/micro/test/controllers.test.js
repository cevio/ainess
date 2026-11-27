import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createMicroClient } from '@ainess/micro'
import { loadMicroControllers } from '@ainess/micro/controllers'
import { registry, RegistryClient } from '@ainess/registry-client'
import { RegistryServer } from '@ainess/registry-server'
import { RpcMode, RpcServer } from '@ainess/rpc'
import { Context } from '@deepseek-ai/cordis'

const host = '127.0.0.1'
const unary = 'export default () => ({ mode: 0, handle: ({ data }) => data })'
const bytes = (/** @type {string} */ value) => new TextEncoder().encode(value)
const decode = (/** @type {Uint8Array} */ value) => new TextDecoder().decode(value)

/** @param {import('node:test').TestContext} t @param {Record<string, string>} files */
async function fixture(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-micro-controllers-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [filename, content] of Object.entries(files)) {
    const path = join(directory, filename)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return directory
}

test('loads Micro factories, serves all RPC modes over TCP, and unregisters and closes on disposal', {
  timeout: 5_000,
}, async (t) => {
  const directory = await fixture(t, {
    'package.json': '{"type":"module"}',
    'echo.rpc.js': unary,
    'ignore.controller.mjs': 'throw new Error("unexpected HTTP controller import")',
    'ignore.micro.mjs': 'throw new Error("unexpected micro suffix import")',
    '(internal)/health/index.rpc.mjs': `export default ctx => ({
      mode: 0, handle: () => new TextEncoder().encode(ctx.greeting),
    })`,
    'files/download.rpc.mjs': `export default () => ({
      mode: 2, async *handle({ data }) {
        yield data
        yield data
      },
    })`,
    'files/upload.rpc.mjs': `export default () => ({
      mode: 1, async handle({ input }) {
        const result = []
        for await (const chunk of input) result.push(...chunk)
        return Uint8Array.from(result)
      },
    })`,
    'files/relay.rpc.mjs': 'export default () => ({ mode: 3, handle: ({ input }) => input })',
  })
  const registryServer = await RegistryServer.listen({ host, port: 0 })
  const app = new Context()
  t.after(async () => {
    try {
      await app.fiber.dispose()
    } finally {
      await registryServer.close()
    }
  })
  const observer = await RegistryClient.connect(registryServer.address)
  t.after(() => observer.close())
  const client = createMicroClient({ discovery: observer.discovery })
  t.after(() => client.close())
  await app.plugin(registry, { address: registryServer.address }).await()
  await app.plugin({ apply: ctx => { ctx.provide('greeting', 'through Cordis') } }).await()

  /** @type {import('@ainess/rpc').RpcAddress | undefined} */
  let address
  const entry = await app.plugin({
    inject: ['registryClient', 'greeting'],
    async apply(ctx) {
      const methods = await loadMicroControllers(ctx, { directory, prefix: 'demo.v1' })
      const { discovery } = ctx.registryClient
      await ctx.effect(async () => {
        const server = await RpcServer.listen({ host, port: 0, methods })
        address = server.address
        const registration = { ...address, services: ['demo'] }
        try {
          await discovery.register(registration)
        } catch (error) {
          await server.close()
          throw error
        }
        return async () => {
          try {
            await discovery.unregister(registration)
          } finally {
            await server.close()
          }
        }
      })
    },
  }).await()
  assert.ok(address)
  assert.deepEqual(await observer.discovery.list({ service: 'demo' }), [address])
  assert.equal(decode(await client.request('demo', 'demo.v1.health')), 'through Cordis')
  assert.equal(decode(await client.request('demo', 'demo.v1.echo', bytes('echo'))), 'echo')
  const downloaded = []
  for await (const chunk of client.stream('demo', 'demo.v1.files.download', bytes('chunk'))) {
    downloaded.push(decode(chunk))
  }
  assert.deepEqual(downloaded, ['chunk', 'chunk'])
  const input = async function* () {
    yield bytes('a')
    yield bytes('b')
  }
  assert.equal(decode(await client.request('demo', 'demo.v1.files.upload', undefined, { input })), 'ab')
  const relayed = []
  for await (const chunk of client.stream('demo', 'demo.v1.files.relay', undefined, { input })) {
    relayed.push(decode(chunk))
  }
  assert.deepEqual(relayed, ['a', 'b'])
  await assert.rejects(client.request('demo', 'demo.v1.ignore'), { code: 'NOT_FOUND' })

  await entry.dispose()
  assert.deepEqual(await observer.discovery.list({ service: 'demo' }), [])
  await assert.rejects(client.request('demo', 'demo.v1.echo'), { code: 'UNAVAILABLE' })
  const rebound = await RpcServer.listen(address)
  await rebound.close()
})

test('returns the business port when registration fails after listening', { timeout: 5_000 }, async (t) => {
  const directory = await fixture(t, { 'echo.rpc.mjs': unary })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const registryServer = await RegistryServer.listen({ host, port: 0 })
  t.after(() => registryServer.close())
  const registryClient = await RegistryClient.connect(registryServer.address)
  t.after(() => registryClient.close())
  const methods = await loadMicroControllers(app, { directory })
  const provider = await RpcServer.listen({ host, port: 0, methods })
  t.after(() => provider.close())
  const address = provider.address
  await registryServer.close()
  await assert.rejects(async () => {
    try {
      await registryClient.discovery.register({ ...address, services: ['echo'] })
    } catch (error) {
      await provider.close()
      throw error
    }
  }, { code: 'UNAVAILABLE' })
  const rebound = await RpcServer.listen(address)
  await rebound.close()
})

test('maps a root index and honors custom module extensions', async (t) => {
  const directory = await fixture(t, {
    'index.rpc.cjs': 'module.exports = () => ({ mode: 0, handle: ({ data }) => data })',
    'ignored.rpc.mjs': 'throw new Error("unexpected default extension import")',
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const methods = await loadMicroControllers(app, { directory, extensions: ['.cjs'] })
  assert.deepEqual(methods.map(({ name, mode }) => ({ name, mode })), [{ name: 'index', mode: RpcMode.Unary }])
  const prefixed = await loadMicroControllers(app, { directory, extensions: ['.cjs'], prefix: 'orders' })
  assert.equal(prefixed[0]?.name, 'orders')
})

test('loads controllers with an active Cordis marker dependency', async (t) => {
  const directory = await fixture(t, { 'echo.rpc.mjs': unary })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  app.provide('ready')
  await app.plugin({
    inject: ['ready'],
    async apply(ctx) {
      const methods = await loadMicroControllers(ctx, { directory })
      assert.deepEqual(methods.map(({ name }) => name), ['echo'])
    },
  }).await()
})

test('checks entry dependencies in their owner scope and passes the supplied scope to factories', async (t) => {
  const directory = await fixture(t, {
    'echo.rpc.mjs': `export default ctx => {
      if (ctx.get('dependency') !== 'factory scope') throw new Error('Expected the supplied context')
      return { mode: 0, handle: ({ data }) => data }
    }`,
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const scope = Symbol('factory scope')
  app.provide('dependency', 'entry scope')
  app.isolate('dependency', scope).provide('dependency', 'factory scope')
  await app.plugin({
    inject: ['dependency'],
    async apply(ctx) {
      const methods = await loadMicroControllers(ctx.isolate('dependency', scope), { directory })
      assert.deepEqual(methods.map(({ name }) => name), ['echo'])
    },
  }).await()
})

test('rejects a load started with a disposed entry context', async (t) => {
  const directory = await fixture(t, { 'echo.rpc.mjs': unary })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const entry = await app.plugin(() => {}).await()
  await entry.dispose()
  await assert.rejects(loadMicroControllers(entry.ctx, { directory }), { code: 'CANCELLED' })
})

test('preflights path collisions and rejects dynamic paths before importing any controller', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const forbidden = 'throw new Error("module must not be imported")'
  const duplicate = await fixture(t, { 'orders.get.rpc.mjs': forbidden, 'orders/get.rpc.mjs': forbidden })
  await assert.rejects(loadMicroControllers(app, { directory: duplicate }),
    /Duplicate.*orders\.get.*orders\.get\.rpc\.mjs.*orders\/get\.rpc\.mjs/)
  for (const stem of ['[id]', '[...parts]']) {
    const dynamic = await fixture(t, { 'a.rpc.mjs': forbidden, [`z/${stem}.rpc.mjs`]: forbidden })
    await assert.rejects(loadMicroControllers(app, { directory: dynamic }), /z\/\[.*\]\.rpc\.mjs.*static/)
  }
  const long = await fixture(t, { 'index.rpc.mjs': forbidden })
  await assert.rejects(loadMicroControllers(app, { directory: long, prefix: '界'.repeat(86) }), /255 bytes/)
})

test('reports the failing default export or method definition with its file', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  /** @type {[string, RegExp][]} */
  const invalidDefinitions = [
    ['export default {}', /invalid\.rpc\.mjs.*factory/],
    ['export default async () => { throw new Error("factory rejected") }', /invalid\.rpc\.mjs.*synchronous/],
    ['export default () => ({ mode: 4, handle: () => new Uint8Array() })', /invalid\.rpc\.mjs.*mode/],
    ['export default () => ({ mode: 0, handle: null })', /invalid\.rpc\.mjs.*handle/],
  ]
  for (const [content, message] of invalidDefinitions) {
    const directory = await fixture(t, { 'ok.rpc.mjs': unary, 'invalid.rpc.mjs': content })
    await assert.rejects(loadMicroControllers(app, { directory }), message)
  }
})

for (const owner of ['entry', 'dependency']) {
  test(`cancels loading if the ${owner} is disposed during import`, { timeout: 5_000 }, async (t) => {
    const gate = new EventEmitter()
    const laterImport = t.mock.fn()
    const factory = t.mock.fn()
    const listen = t.mock.fn()
    gate.on('later', laterImport)
    gate.on('factory', factory)
    const app = new Context()
    const key = `ainess-micro-loader:${owner}`
    Reflect.set(globalThis, key, gate)
    t.after(async () => {
      gate.emit('continue')
      await app.fiber.dispose()
      Reflect.deleteProperty(globalThis, key)
    })
    const directory = await fixture(t, {
      'a.rpc.mjs': `const gate = Reflect.get(globalThis, ${JSON.stringify(key)})
        await new Promise(resolve => {
          gate.once('continue', resolve)
          gate.emit('importing')
        })
        export default () => {
          gate.emit('factory')
          return { mode: 0, handle: ({ data }) => data }
        }`,
      'b.rpc.mjs': `Reflect.get(globalThis, ${JSON.stringify(key)}).emit('later')
        ${unary}`,
    })
    const dependency = await app.plugin({ apply: ctx => { ctx.provide('dependency', true) } }).await()
    const importing = once(gate, 'importing', { signal: AbortSignal.timeout(3_000) })
    const cancelled = once(gate, 'cancelled', { signal: AbortSignal.timeout(3_000) })
    const entry = app.plugin({
      inject: ['dependency'],
      async apply(ctx) {
        try {
          await loadMicroControllers(ctx, { directory })
          listen()
        } catch (error) {
          gate.emit('cancelled', error)
        }
      },
    })
    await importing
    const disposed = (owner === 'entry' ? entry : dependency).dispose()
    gate.emit('continue')
    const [error] = await cancelled
    await disposed
    await entry.await()
    assert.equal(error.code, 'CANCELLED')
    assert.equal(laterImport.mock.callCount(), 0)
    assert.equal(factory.mock.callCount(), 0)
    assert.equal(listen.mock.callCount(), 0)
  })
}

for (const owner of ['entry', 'parent']) {
  test(`cancels a superseded controller load before the ${owner} restarts`, { timeout: 5_000 }, async (t) => {
    const app = new Context()
    const gate = new EventEmitter()
    const key = `ainess-micro-loader:restart-${owner}`
    Reflect.set(globalThis, key, gate)
    t.after(async () => {
      gate.emit('continue')
      await app.fiber.dispose()
      Reflect.deleteProperty(globalThis, key)
    })
    const directory = await fixture(t, {
      'a.rpc.mjs': `const gate = Reflect.get(globalThis, ${JSON.stringify(key)})
        await new Promise(resolve => {
          gate.once('continue', resolve)
          gate.emit('importing')
        })
        ${unary}`,
      'b.rpc.mjs': `Reflect.get(globalThis, ${JSON.stringify(key)}).emit('later')
        ${unary}`,
    })
    const importing = once(gate, 'importing', { signal: AbortSignal.timeout(3_000) })
    /** @type {unknown[]} */
    const outcomes = []
    gate.on('later', () => outcomes.push('imported second controller'))
    const controller = {
      /** @param {Context} ctx */
      async apply(ctx) {
        try {
          const methods = await loadMicroControllers(ctx, { directory })
          outcomes.push(methods.map(({ name }) => name))
        } catch (error) {
          assert.ok(error instanceof Error && 'code' in error)
          outcomes.push(error.code)
        }
      },
    }
    const fiber = app.plugin(owner === 'entry' ? controller : {
      async apply(ctx) {
        await ctx.plugin(controller).await()
      },
    })
    await importing
    const restarted = fiber.restart()
    gate.emit('continue')
    await restarted
    assert.deepEqual(outcomes, ['CANCELLED', 'imported second controller', ['a', 'b']])
  })
}

test('stops a nested controller load before it opens a TCP listener during root disposal', {
  timeout: 5_000,
}, async (t) => {
  const app = new Context()
  const gate = new EventEmitter()
  const key = 'ainess-micro-loader:dispose-ancestor'
  Reflect.set(globalThis, key, gate)
  /** @type {ReturnType<typeof app.fiber.dispose> | undefined} */
  let shutdown
  t.after(async () => {
    await (shutdown ?? app.fiber.dispose())
    Reflect.deleteProperty(globalThis, key)
  })
  const directory = await fixture(t, {
    'echo.rpc.mjs': `export default () => {
      Reflect.get(globalThis, ${JSON.stringify(key)}).emit('factory')
      return { mode: 0, handle: ({ data }) => data }
    }`,
  })
  gate.once('factory', () => { shutdown = app.fiber.dispose() })
  const parent = await app.plugin(() => {}).await()
  const container = await parent.ctx.plugin(() => {}).await()
  /** @type {unknown[]} */
  const outcomes = []
  await container.ctx.plugin({
    async apply(ctx) {
      try {
        const methods = await loadMicroControllers(ctx, { directory })
        await ctx.effect(async () => {
          const server = await RpcServer.listen({ host, port: 0, methods })
          outcomes.push('listening')
          return () => server.close()
        })
      } catch (error) {
        assert.ok(error instanceof Error && 'code' in error)
        outcomes.push(error.code)
      }
    },
  }).await()
  await shutdown
  assert.deepEqual(outcomes, ['CANCELLED'])
})

for (const stage of ['scan', 'factory']) {
  test(`reports cancellation when the entry is disposed before the loader result at ${stage}`, {
    timeout: 5_000,
  }, async (t) => {
    const directory = await fixture(t, {
      'a.rpc.mjs': `export default ctx => {
        queueMicrotask(() => { void ctx.fiber.dispose() })
        return { mode: 0, handle: ({ data }) => data }
      }`,
    })
    const app = new Context()
    t.after(() => app.fiber.dispose())
    const result = new Promise((resolve, reject) => {
      app.plugin({
        async apply(ctx) {
          if (stage === 'scan') queueMicrotask(() => { void ctx.fiber.dispose() })
          const path = stage === 'scan' ? join(directory, 'missing') : directory
          await loadMicroControllers(ctx, { directory: path }).then(resolve, reject)
        },
      })
    })
    await assert.rejects(result, { code: 'CANCELLED' })
  })
}

test('cancels a load whose injected service is replaced before methods are returned', async (t) => {
  const directory = await fixture(t, {
    'a.rpc.mjs': `export default ctx => {
      const dependency = ctx.dependency
      queueMicrotask(() => ctx.replaceDependency())
      return { mode: 0, handle: () => new TextEncoder().encode(dependency) }
    }`,
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const removeOriginal = app.provide('dependency', 'old')
  app.provide('replaceDependency', () => {
    if (app.get('dependency') !== 'old') return
    void removeOriginal()
    app.provide('dependency', 'new')
  })
  /** @type {unknown[]} */
  const published = []
  /** @type {{ dependency: unknown; code: unknown }[]} */
  const cancelled = []
  await app.plugin({
    inject: ['dependency', 'replaceDependency'],
    async apply(ctx) {
      const dependency = ctx.get('dependency')
      try {
        const methods = await loadMicroControllers(ctx, { directory })
        published.push(dependency)
        assert.equal(methods.length, 1)
      } catch (error) {
        assert.ok(error instanceof Error && 'code' in error)
        cancelled.push({ dependency, code: error.code })
      }
    },
  }).await()
  assert.deepEqual(cancelled, [{ dependency: 'old', code: 'CANCELLED' }])
  assert.deepEqual(published, ['new'])
})

test('cancels a load when an active provider is no longer ready', { timeout: 5_000 }, async (t) => {
  const app = new Context()
  const gate = new EventEmitter()
  const factory = t.mock.fn()
  const laterImport = t.mock.fn()
  gate.on('factory', factory)
  gate.on('later', laterImport)
  const key = 'ainess-micro-loader:ready'
  Reflect.set(globalThis, key, gate)
  t.after(async () => {
    gate.emit('continue')
    await app.fiber.dispose()
    Reflect.deleteProperty(globalThis, key)
  })
  const directory = await fixture(t, {
    'a.rpc.mjs': `const gate = Reflect.get(globalThis, ${JSON.stringify(key)})
      await new Promise((resolve) => {
        gate.once('continue', resolve)
        gate.emit('importing')
      })
      export default () => {
        gate.emit('factory')
        return { mode: 0, handle: ({ data }) => data }
      }`,
    'b.rpc.mjs': `Reflect.get(globalThis, ${JSON.stringify(key)}).emit('later')
      ${unary}`,
  })
  const dependency = { ready: true }
  /** @this {{ ready: boolean }} */
  function isReady() { return this.ready }
  app.reflect.provide('dependency', dependency, isReady)
  const importing = once(gate, 'importing', { signal: AbortSignal.timeout(3_000) })
  /** @type {unknown[]} */
  const outcomes = []
  const entry = app.plugin({
    inject: ['dependency'],
    async apply(ctx) {
      try {
        await loadMicroControllers(ctx.isolate('dependency'), { directory })
        outcomes.push('loaded')
      } catch (error) {
        assert.ok(error instanceof Error && 'code' in error)
        outcomes.push(error.code)
      }
    },
  })
  await importing
  dependency.ready = false
  app.reflect.notify(['dependency'])
  gate.emit('continue')
  await entry.await()
  assert.deepEqual(outcomes, ['CANCELLED'])
  assert.equal(factory.mock.callCount(), 0)
  assert.equal(laterImport.mock.callCount(), 0)
})
