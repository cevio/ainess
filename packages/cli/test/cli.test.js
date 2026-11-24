import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const cwd = new URL('./fixtures/', import.meta.url)
const exec = promisify(execFile)
const execOptions = { cwd, timeout: 3000 }

test('CLI displays program and start help', { timeout: 5000 }, async () => {
  const help = await exec(process.execPath, [cli, '--help'], execOptions)
  assert.match(help.stdout, /^Usage: ainess\b/m)
  assert.match(help.stdout, /^\s+start\b/m)
  assert.equal(help.stderr, '')

  for (const args of [['start', '--help'], ['help', 'start']]) {
    const startHelp = await exec(process.execPath, [cli, ...args], execOptions)
    assert.match(startHelp.stdout, /^Usage: ainess start\b/m)
    assert.match(startHelp.stdout, /--config <file>/)
    assert.match(startHelp.stdout, /ainess\.config\.mjs/)
    assert.equal(startHelp.stderr, '')
  }
})

test('CLI reports command and option errors before loading an app', { timeout: 5000 }, async () => {
  for (const { args, stderr } of [
    { args: [], stderr: /Usage: ainess\b/ },
    { args: ['invalid'], stderr: /unknown command 'invalid'/ },
    { args: ['start', '--config'], stderr: /--config <file>.*argument missing/ },
    { args: ['start', '--config='], stderr: /--config <file>.*argument missing/ },
    { args: ['start', '--config', '--unknown'], stderr: /--config <file>.*argument missing/ },
    { args: ['start', '--config', '--'], stderr: /--config <file>.*argument missing/ },
    { args: ['start', '--unknown'], stderr: /unknown option '--unknown'/ },
    { args: ['start', 'unexpected'], stderr: /too many arguments/ },
  ]) {
    await assert.rejects(exec(process.execPath, [cli, ...args], execOptions), { code: 1, stderr })
  }
})

test('CLI distinguishes a help option from an explicit dash-prefixed config file', { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-cli-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all([
    writeFile(join(directory, 'package.json'), '{"type":"module"}'),
    writeFile(join(directory, '--help'), `
      console.log('configuration evaluated')
      export default { start() { return { stop() {} } } }
    `),
  ])
  const options = { ...execOptions, cwd: directory }

  await assert.rejects(exec(process.execPath, [cli, 'start', '--config', '--help'], options), {
    code: 1, stdout: '', stderr: /--config <file>.*argument missing/,
  })

  const result = await exec(process.execPath, [cli, 'start', '--config=--help'], options)
  assert.equal(result.stdout.trim(), 'configuration evaluated')
  assert.equal(result.stderr, '')
})

test('CLI starts the default ESM config and waits for SIGTERM cleanup', { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, [cli, 'start'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  const output = createInterface({ input: child.stdout })
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', (part) => { errors += part })
  t.after(async () => {
    output.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })

  const [origin] = await Promise.race([
    once(output, 'line'),
    closed.then(([code]) => assert.fail(`CLI exited before binding (${code}): ${errors}`)),
  ])
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(await (await fetch(`${origin}/status`)).text(), 'ready')

  const drained = once(output, 'line')
  child.kill('SIGTERM')
  assert.deepEqual(await closed, [0, null], errors)
  assert.deepEqual(await drained, ['listener disposed'])
  await assert.rejects(fetch(`${origin}/status`))
})

test('CLI reports the failing config path and exits nonzero', { timeout: 5000 }, async () => {
  const name = 'missing config.mjs'
  const child = spawn(process.execPath, [cli, 'start', '--config', name], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', (part) => { errors += part })
  assert.deepEqual(await once(child, 'close'), [1, null])
  assert.match(errors, /Failed to load app config.*missing config\.mjs/)
})

test('SIGTERM stops the CLI during config import', { timeout: 2500 }, async (t) => {
  const child = spawn(process.execPath, [cli, 'start', '--config', 'delayed.config.mjs'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  const output = createInterface({ input: child.stdout })
  t.after(async () => {
    output.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })

  const [loading] = await Promise.race([
    once(output, 'line'),
    closed.then(([code]) => assert.fail(`CLI exited before loading config (${code})`)),
  ])
  assert.equal(loading, 'config loading')
  child.kill('SIGTERM')
  assert.deepEqual(await closed, [0, null])
})

test('a config that never finishes evaluation is reported as a startup failure', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, [cli, 'start', '--config', 'unsettled.config.mjs'], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', (part) => { errors += part })
  assert.deepEqual(await once(child, 'close'), [1, null])
  assert.match(errors, /Failed to load app config.*unsettled\.config\.mjs/)
})

test('CLI waits for startup without a deadline and cleans up on SIGTERM', { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, [cli, 'start', '--config', 'waiting.config.mjs'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  const output = createInterface({ input: child.stdout })
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', (part) => { errors += part })
  t.after(async () => {
    output.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })

  const exitedEarly = closed.then(([code]) => assert.fail(`CLI exited while waiting for startup (${code}): ${errors}`))
  assert.deepEqual(await Promise.race([once(output, 'line'), exitedEarly]), ['waiting for a service'])
  await Promise.race([delay(100), exitedEarly])

  const disposed = once(output, 'line')
  child.kill('SIGTERM')
  assert.deepEqual(await closed, [0, null], errors)
  assert.deepEqual(await disposed, ['startup resources closed'])
})

test('CLI flushes piped output written during application cleanup', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, [cli, 'start', '--config', 'output.config.mjs'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = 0
  let stderr = 0
  child.stdout.on('data', (part) => { stdout += part.length })
  child.stderr.on('data', (part) => { stderr += part.length })
  assert.deepEqual(await once(child, 'close'), [0, null])
  assert.equal(stdout, 2 * 1024 * 1024)
  assert.equal(stderr, 2 * 1024 * 1024)
})
