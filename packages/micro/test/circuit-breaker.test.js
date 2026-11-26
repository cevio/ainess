import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CircuitBreaker } from '../dist/circuit-breaker.js'

const settings = {
  windowMs: 100,
  minimumCalls: 4,
  failureRateThreshold: 50,
  openMs: 20,
}

/**
 * @param {CircuitBreaker} breaker
 * @param {number} now
 * @param {boolean | undefined} success
 */
function sample(breaker, now, success) {
  const ticket = breaker.admit(now)
  assert.ok(ticket !== undefined)
  breaker.settle(ticket, success, now)
}

test('opens at the failure rate threshold once there are enough effective samples', () => {
  const breaker = new CircuitBreaker(settings)
  sample(breaker, 10, undefined)
  sample(breaker, 11, false)
  sample(breaker, 12, true)
  sample(breaker, 13, false)
  assert.equal(breaker.allows(14), true)

  sample(breaker, 14, true)
  assert.equal(breaker.allows(14), false)
  assert.equal(breaker.admit(14), undefined)
  assert.equal(breaker.probeReady(33), false)
  assert.equal(breaker.probeReady(34), true)
})

test('keeps admitting calls when the failure rate is below the threshold', () => {
  const breaker = new CircuitBreaker(settings)
  sample(breaker, 10, false)
  for (let now = 11; now <= 14; now++) sample(breaker, now, true)
  assert.equal(breaker.allows(14), true)
})

test('expires old buckets without dropping samples from recent buckets', () => {
  const breaker = new CircuitBreaker(settings)
  sample(breaker, 0, false)
  sample(breaker, 2, false)
  sample(breaker, 11, false)

  sample(breaker, 100, false)
  sample(breaker, 101, true)
  assert.equal(breaker.allows(101), true)
  sample(breaker, 102, true)
  assert.equal(breaker.allows(102), false)
})

test('expires the full window after a long idle period', () => {
  const breaker = new CircuitBreaker(settings)
  sample(breaker, 5, false)
  sample(breaker, 15, false)
  sample(breaker, 25, false)

  sample(breaker, 10_000, false)
  assert.equal(breaker.allows(10_000), true)
})

test('admits one half-open call and extends the cooldown after its failure', () => {
  const breaker = new CircuitBreaker({ ...settings, minimumCalls: 1 })
  sample(breaker, 10, false)
  assert.equal(breaker.admit(29), undefined)
  assert.equal(breaker.probeReady(30), true)

  const probe = breaker.admit(30)
  assert.ok(probe !== undefined)
  assert.equal(breaker.probeReady(30), false)
  assert.equal(breaker.allows(30), false)
  assert.equal(breaker.admit(31), undefined)
  breaker.settle(probe, false, 31)

  assert.equal(breaker.probeReady(50), false)
  assert.equal(breaker.probeReady(51), true)
})

test('neutral probes release admission and stale outcomes cannot reopen or close the breaker', () => {
  const breaker = new CircuitBreaker({ ...settings, minimumCalls: 1 })
  const old = breaker.admit(10)
  assert.ok(old !== undefined)
  sample(breaker, 11, false)
  breaker.settle(old, true, 20)
  assert.equal(breaker.allows(20), false)

  const abandoned = breaker.admit(31)
  assert.ok(abandoned !== undefined)
  breaker.settle(abandoned, undefined, 32)
  assert.equal(breaker.probeReady(32), true)

  const recovered = breaker.admit(32)
  assert.ok(recovered !== undefined)
  breaker.settle(abandoned, true, 33)
  assert.equal(breaker.allows(33), false)
  breaker.settle(recovered, true, 34)
  assert.equal(breaker.probeReady(34), false)

  breaker.settle(old, false, 35)
  breaker.settle(abandoned, false, 36)
  breaker.settle(recovered, false, 37)
  assert.equal(breaker.allows(38), true)
  sample(breaker, 38, true)
  assert.equal(breaker.allows(38), true)
})
