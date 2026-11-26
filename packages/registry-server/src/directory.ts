import type { RpcPeer } from '@ainess/rpc'
import { registryAddressKey } from '@ainess/registry-shared'
import type { PickQuery, RegistrationRequest, RpcAddress } from '@ainess/registry-shared'

interface Candidate {
  key: string
  address: RpcAddress
  owners: number
  previous?: Candidate
  next?: Candidate
}

class Candidates {
  #byAddress = new Map<string, Candidate>()
  #first: Candidate | undefined
  #last: Candidate | undefined
  #next: Candidate | undefined

  add(key: string, address: RpcAddress): void {
    const existing = this.#byAddress.get(key)
    if (existing) {
      existing.owners++
      return
    }
    const candidate: Candidate = { key, address, owners: 1, previous: this.#last }
    this.#byAddress.set(key, candidate)
    if (this.#last) this.#last.next = candidate
    this.#last = candidate
    this.#first ??= candidate
    this.#next ??= candidate
  }

  /** Returns true when the last address is removed. */
  remove(key: string): boolean {
    const candidate = this.#byAddress.get(key)!
    if (--candidate.owners > 0) return false
    this.#byAddress.delete(key)
    const { previous, next } = candidate
    if (previous) previous.next = next
    else this.#first = next
    if (next) next.previous = previous
    else this.#last = previous
    if (this.#next === candidate) this.#next = next ?? this.#first
    return this.#byAddress.size === 0
  }

  list(): RpcAddress[] {
    return Array.from(this.#byAddress.values(), candidate => candidate.address)
  }

  pick(excluded?: ReadonlySet<string>): RpcAddress | null {
    const start = this.#next!
    const first = this.#first!
    let candidate = start
    do {
      const next = candidate.next ?? first
      if (!excluded?.has(candidate.key)) {
        this.#next = next
        return candidate.address
      }
      candidate = next
    } while (candidate !== start)
    return null
  }
}

export class RegistryDirectory {
  #services = new Map<string, Candidates>()
  #owners = new Map<RpcPeer, Map<string, Set<string>>>()

  register(peer: RpcPeer, { host, port, services }: RegistrationRequest): void {
    if (!services.length) return
    const address = { host, port }
    const key = registryAddressKey(address)
    let addresses = this.#owners.get(peer)
    if (!addresses) this.#owners.set(peer, addresses = new Map())
    let claims = addresses.get(key)
    if (!claims) addresses.set(key, claims = new Set())
    for (const service of services) {
      if (claims.has(service)) continue
      let candidates = this.#services.get(service)
      if (!candidates) this.#services.set(service, candidates = new Candidates())
      candidates.add(key, address)
      claims.add(service)
    }
  }

  unregister(peer: RpcPeer, request: RegistrationRequest): string[] {
    const key = registryAddressKey(request)
    const addresses = this.#owners.get(peer)
    const claims = addresses?.get(key)
    if (!addresses || !claims) return []
    const removed: string[] = []
    for (const service of request.services) {
      if (!claims.delete(service)) continue
      this.#remove(service, key)
      removed.push(service)
    }
    if (!claims.size) addresses.delete(key)
    if (!addresses.size) this.#owners.delete(peer)
    return removed
  }

  disconnect(peer: RpcPeer): void {
    const addresses = this.#owners.get(peer)
    if (!addresses) return
    this.#owners.delete(peer)
    for (const [key, services] of addresses) {
      for (const service of services) this.#remove(service, key)
    }
  }

  list(service: string): RpcAddress[] {
    return this.#services.get(service)?.list() ?? []
  }

  pick({ service, exclude }: PickQuery): RpcAddress | null {
    const candidates = this.#services.get(service)
    if (!candidates) return null
    const excluded = exclude?.length ? new Set(exclude.map(registryAddressKey)) : undefined
    return candidates.pick(excluded)
  }

  #remove(service: string, key: string): void {
    if (this.#services.get(service)!.remove(key)) this.#services.delete(service)
  }
}
