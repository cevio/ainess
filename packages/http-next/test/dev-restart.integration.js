import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { dev } from './fixtures/next.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {number} port
 */
async function startNext(t, port) {
  const child = fork(new URL('./fixtures/dev-server.js', import.meta.url), [String(port)], { silent: true })
  const closed = once(child, 'close')
  let errors = ''
  child.stdout?.resume()
  child.stderr?.setEncoding('utf8').on('data', (part) => { errors += part })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })

  const [address] = await Promise.race([
    once(child, 'message'),
    closed.then(([code]) => assert.fail(`Next exited before listening (${code}): ${errors}`)),
  ])
  assert.equal(typeof address, 'number')
  return {
    port: Number(address),
    async stop() {
      child.kill('SIGTERM')
      assert.deepEqual(await closed, [0, null], errors)
    },
  }
}

test('Next dev restarts in a fresh process on the same port', { skip: !dev, timeout: 90_000 }, async (t) => {
  const first = await startNext(t, 0)
  const origin = `http://127.0.0.1:${first.port}`
  const page = await fetch(origin)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Next server component/)
  await first.stop()
  await assert.rejects(fetch(origin), TypeError)

  const second = await startNext(t, first.port)
  assert.equal(second.port, first.port)
  assert.deepEqual(await (await fetch(`${origin}/-/health`)).json(), { ok: true })
  const flight = await fetch(origin, { headers: { rsc: '1' } })
  assert.equal(flight.status, 200)
  assert.match(flight.headers.get('content-type') ?? '', /^text\/x-component/)
  assert.match(await flight.text(), /Next server component/)
  await second.stop()
  await assert.rejects(fetch(origin), TypeError)
})
