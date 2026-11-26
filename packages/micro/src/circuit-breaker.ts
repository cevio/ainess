export interface CircuitBreakerSettings {
  windowMs: number
  minimumCalls: number
  failureRateThreshold: number
  openMs: number
}

const WINDOW_BUCKETS = 10

export class CircuitBreaker {
  readonly #bucketMs: number
  readonly #callCounts = new Float64Array(WINDOW_BUCKETS)
  readonly #failureCounts = new Float64Array(WINDOW_BUCKETS)
  #lastBucket = 0
  #calls = 0
  #failures = 0
  #openUntil?: number
  #probing = false
  #generation = 0

  constructor(private readonly settings: CircuitBreakerSettings) {
    this.#bucketMs = settings.windowMs / WINDOW_BUCKETS
  }

  get retryAt(): number | undefined {
    return this.#openUntil
  }

  allows(now: number): boolean {
    return this.#openUntil === undefined || this.probeReady(now)
  }

  probeReady(now: number): boolean {
    return this.#openUntil !== undefined && now >= this.#openUntil && !this.#probing
  }

  admit(now: number): number | undefined {
    if (this.#openUntil === undefined) return this.#generation
    if (!this.probeReady(now)) return
    this.#probing = true
    return ++this.#generation
  }

  settle(ticket: number, success: boolean | undefined, now: number): void {
    if (ticket !== this.#generation) return
    if (this.#probing) {
      this.#probing = false
      this.#generation++
      if (success === true) this.#openUntil = undefined
      if (success === false) this.#openUntil = now + this.settings.openMs
      return
    }
    if (success === undefined || this.#openUntil !== undefined) return
    this.#record(success, now)
    if (this.#calls >= this.settings.minimumCalls &&
      this.#failures * 100 >= this.settings.failureRateThreshold * this.#calls) {
      this.#openUntil = now + this.settings.openMs
      this.#generation++
      this.#callCounts.fill(0)
      this.#failureCounts.fill(0)
      this.#calls = 0
      this.#failures = 0
    }
  }

  #record(success: boolean, now: number): void {
    const bucket = Math.floor(now / this.#bucketMs)
    // Each crossed bucket replaces the sample interval one window behind it.
    const first = Math.max(this.#lastBucket + 1, bucket - WINDOW_BUCKETS + 1)
    for (let crossed = first; crossed <= bucket; crossed++) {
      const slot = crossed % WINDOW_BUCKETS
      this.#calls -= this.#callCounts[slot]
      this.#failures -= this.#failureCounts[slot]
      this.#callCounts[slot] = 0
      this.#failureCounts[slot] = 0
    }
    this.#lastBucket = bucket
    const slot = bucket % WINDOW_BUCKETS
    this.#callCounts[slot]++
    this.#calls++
    if (!success) {
      this.#failureCounts[slot]++
      this.#failures++
    }
  }
}
