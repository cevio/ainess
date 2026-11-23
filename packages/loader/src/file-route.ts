export type FileRouteSegment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'parameter'; readonly name: string }
  | { readonly kind: 'catch-all'; readonly name: string }

export interface FileRouteOptions {
  prefix?: string
  source?: string
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const reservedNames = new Set(['__proto__', 'prototype', 'constructor'])
const groupDirectory = /^\([^()\\]+\)$/

export function parseFileRoute(
  stem: string,
  { prefix = '', source }: FileRouteOptions = {},
): readonly FileRouteSegment[] {
  function invalid(reason: string): never {
    const location = source ? ` in ${source}` : ''
    throw new TypeError(`Invalid file route ${JSON.stringify(stem)}${location}: ${reason}`)
  }

  if (prefix && (!prefix.startsWith('/') || prefix.includes('//'))) {
    invalid(`prefix ${JSON.stringify(prefix)} must start with / and contain no empty segments`)
  }
  const base = prefix.replace(/\/$/, '').slice(1)
  const directories = stem.split('/')
  const filename = directories.pop() ?? ''
  const parts = base ? base.split('/') : []
  parts.push(...directories.filter(part => !groupDirectory.test(part)))
  if (filename !== 'index') parts.push(filename)

  const names = new Set<string>()
  const segments: FileRouteSegment[] = []
  for (const [index, part] of parts.entries()) {
    if (part.startsWith('[') && part.endsWith(']')) {
      const catchAll = part.startsWith('[...')
      const name = part.slice(catchAll ? 4 : 1, -1)
      if (!identifier.test(name) || reservedNames.has(name)) invalid(`invalid parameter name "${name}"`)
      if (names.has(name)) invalid(`duplicate parameter "${name}"`)
      if (catchAll && index !== parts.length - 1) invalid('a catch-all must be the final segment')

      names.add(name)
      segments.push({ kind: catchAll ? 'catch-all' : 'parameter', name })
    } else {
      if (!part || part === '.' || part === '..' || /[\\:*?#{}()[\]]/.test(part)) {
        invalid(`invalid static segment "${part}"`)
      }
      segments.push({ kind: 'static', value: part })
    }
  }
  return segments
}
