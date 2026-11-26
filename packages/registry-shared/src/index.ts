import { rpcPayloadLimit } from '@ainess/rpc'
import type { RpcAddress } from '@ainess/rpc'

export type { RpcAddress } from '@ainess/rpc'

export const registryKeepAliveInitialDelayMs = 5_000

export interface RegistrationRequest extends RpcAddress {
  services: readonly string[]
}

export interface ServiceQuery {
  service: string
}

export interface PickQuery extends ServiceQuery {
  exclude?: readonly RpcAddress[]
}

export interface RegisterResponse {
  registered: string[]
}

export interface UnregisterResponse {
  removed: string[]
}

export const registryMethods = Object.freeze({
  register: 'registry.discovery.register',
  unregister: 'registry.discovery.unregister',
  list: 'registry.discovery.list',
  pick: 'registry.discovery.pick',
} as const)

const frameBodyBytes = rpcPayloadLimit()
const registrationRequestBytes = Math.min(
  rpcPayloadLimit(registryMethods.register),
  rpcPayloadLimit(registryMethods.unregister),
)
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeRegistryMessage(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

export function decodeRegistryMessage(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch (cause) {
    throw new TypeError('Expected a UTF-8 JSON registry message', { cause })
  }
}

export function registryAddressKey({ host, port }: RpcAddress): string {
  return JSON.stringify([host, port])
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a registry message object')
  }
  return value as Record<string, unknown>
}

function field(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Expected ${label} to be a non-blank string`)
  }
  return value
}

function readServices(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`Expected ${label} to be an array`)
  const services = new Set<string>()
  for (const service of value) services.add(readString(service, label + ' entry'))
  return [...services]
}

function readAddress(value: Record<string, unknown>): RpcAddress {
  const host = readString(field(value, 'host'), 'host')
  const port = field(value, 'port')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Expected port to be an integer from 1 to 65535')
  }
  return { host, port }
}

function registrationPrefix({ host, port }: RpcAddress): string {
  // Leave the opening bracket of the empty services array in the prefix.
  return JSON.stringify({ host, port, services: [] }).slice(0, -2)
}

export function parseRegistration(value: unknown): RegistrationRequest {
  const request = record(value)
  const address = readAddress(request)
  const services = readServices(field(request, 'services'), 'services')
  const remaining = registrationRequestBytes - Buffer.byteLength(registrationPrefix(address)) - 2
  if (services.some((service) => Buffer.byteLength(JSON.stringify(service)) > remaining)) {
    throw new TypeError(`Registry service and address exceed ${registrationRequestBytes} bytes`)
  }
  return { ...address, services }
}

export function parseServiceQuery(value: unknown): ServiceQuery {
  return { service: readString(field(record(value), 'service'), 'service') }
}

export function parsePickQuery(value: unknown): PickQuery {
  const query = record(value)
  const service = readString(field(query, 'service'), 'service')
  const exclude = field(query, 'exclude')
  if (exclude === undefined) return { service }
  if (!Array.isArray(exclude)) throw new TypeError('Expected exclude to be an array')
  return { service, exclude: Array.from(exclude, (address) => readAddress(record(address))) }
}

export function parseRegisterResponse(value: unknown): RegisterResponse {
  return { registered: readServices(field(record(value), 'registered'), 'registered') }
}

export function parseUnregisterResponse(value: unknown): UnregisterResponse {
  return { removed: readServices(field(record(value), 'removed'), 'removed') }
}

export function parseRegistryListBatch(value: unknown): RpcAddress[] {
  if (!Array.isArray(value)) throw new TypeError('Expected a registry list batch')
  return Array.from(value, (address) => readAddress(record(address)))
}

export function parseRegistryPickResponse(value: unknown): RpcAddress | null {
  return value === null ? null : readAddress(record(value))
}

export function encodeRegistryRegistration(request: RegistrationRequest): Uint8Array {
  const bytes = encodeRegistryMessage(request)
  if (bytes.byteLength > registrationRequestBytes) {
    throw new TypeError(`Registry registration exceeds ${registrationRequestBytes} bytes`)
  }
  return bytes
}

function* encodeBatches(
  values: Iterable<unknown>,
  prefix: string,
  suffix: string,
  limit: number,
): Iterable<{ data: Uint8Array; count: number }> {
  const overhead = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)
  let parts: string[] = []
  let size = overhead
  for (const value of values) {
    const part = JSON.stringify(value)
    const partBytes = Buffer.byteLength(part)
    if (overhead + partBytes > limit) throw new TypeError(`Registry batch entry exceeds ${limit} bytes`)
    if (parts.length > 0 && size + 1 + partBytes > limit) {
      yield { data: Buffer.from(prefix + parts.join(',') + suffix), count: parts.length }
      parts = []
      size = overhead
    }
    size += partBytes + (parts.length > 0 ? 1 : 0)
    parts.push(part)
  }
  if (parts.length > 0) yield { data: Buffer.from(prefix + parts.join(',') + suffix), count: parts.length }
}

export function* encodeRegistryRegistrationBatches(
  request: RegistrationRequest,
): Iterable<{ data: Uint8Array; services: readonly string[] }> {
  const { services } = request
  const prefix = registrationPrefix(request)
  let offset = 0
  for (const { data, count } of encodeBatches(services, prefix, ']}', registrationRequestBytes)) {
    yield { data, services: services.slice(offset, offset + count) }
    offset += count
  }
}

export function* encodeRegistryListBatches(addresses: Iterable<RpcAddress>): Iterable<Uint8Array> {
  for (const { data } of encodeBatches(addresses, '[', ']', frameBodyBytes)) yield data
}
