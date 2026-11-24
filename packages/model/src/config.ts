import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelFilesOptions } from './files.js'

export interface ModelDirectoryConfig {
  sourceRoot: string
  typegen: ModelFilesOptions & { directory: string; output: string }
  loader: ModelFilesOptions & { directory: string; extensions: readonly string[] }
}

export function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

function readPath(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = Object.hasOwn(config, key) ? config[key] : fallback
  if (typeof value !== 'string' || !value) throw new TypeError(`${key} must be a non-empty string`)
  return value
}

function readExtensions(config: Record<string, unknown>, key: string): readonly string[] | undefined {
  if (!Object.hasOwn(config, key)) return undefined
  const value = config[key]
  if (!Array.isArray(value) || !value.every(ext => typeof ext === 'string' && ext.startsWith('.'))) {
    throw new TypeError(`${key} must be an array of file extensions`)
  }
  return value
}

export async function readModelConfig(location: string | URL): Promise<ModelDirectoryConfig> {
  const filename = typeof location === 'string' ? resolve(location) : fileURLToPath(location)
  try {
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Model directory config must be an object')
    }
    const config = value as Record<string, unknown>
    const base = dirname(filename)
    const sourceRoot = resolve(base, readPath(config, 'sourceRoot', 'src'))
    const runtimeRoot = resolve(base, readPath(config, 'runtimeRoot', 'dist'))
    const directory = readPath(config, 'directory', 'models')
    const sourceDirectory = resolve(sourceRoot, directory)
    if (isAbsolute(directory) || !containsPath(sourceRoot, sourceDirectory)) {
      throw new TypeError('directory must be relative to sourceRoot and runtimeRoot')
    }
    return {
      sourceRoot,
      typegen: {
        directory: sourceDirectory,
        output: resolve(sourceRoot, readPath(config, 'declaration', 'models.generated.d.ts')),
        extensions: readExtensions(config, 'sourceExtensions') ?? ['.ts', '.mts', '.js', '.mjs'],
        allowMissing: true,
      },
      loader: {
        directory: resolve(runtimeRoot, directory),
        extensions: readExtensions(config, 'runtimeExtensions') ?? ['.js', '.mjs'],
        allowMissing: true,
      },
    }
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : ''
    throw new Error(`Failed to read Model config ${filename}${detail}`, { cause })
  }
}
