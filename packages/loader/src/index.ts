import { readdir } from 'node:fs'
import { opendir, realpath } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { glob } from 'glob'

export { parseFileRoute, type FileRouteOptions, type FileRouteSegment } from './file-route.js'

export interface ModuleFile {
  readonly absolutePath: string
  readonly relativePath: string
  readonly stem: string
}

export interface LoadModulesOptions {
  directory: string | URL
  suffix: string
  extensions?: readonly string[]
}

export async function scanModules(
  { directory, suffix, extensions = ['.js', '.mjs'] }: LoadModulesOptions,
): Promise<readonly ModuleFile[]> {
  if (!suffix || suffix.includes('/') || suffix.includes('\\')) {
    throw new TypeError('The module suffix must be a non-empty part of a file name')
  }
  const root = typeof directory === 'string' ? resolve(directory) : fileURLToPath(directory)
  const scanRoot = await realpath(root)
  // Surface errors opening the scan root before checking for matches.
  const handle = await opendir(scanRoot)
  await handle.close()

  const allowedExtensions = new Set(extensions)
  let scanError: NodeJS.ErrnoException | null = null
  const files = await glob('**/*', {
    cwd: scanRoot,
    dot: true,
    nocase: false,
    withFileTypes: true,
    ignore: {
      childrenIgnored: (entry) => entry.isSymbolicLink(),
      ignored(entry) {
        if (!entry.isFile()) return true
        const extension = extname(entry.name)
        return !allowedExtensions.has(extension) || !entry.name.endsWith(`.${suffix}${extension}`)
      },
    },
    fs: {
      readdir(path, options, callback) {
        readdir(path, options, (error, entries) => {
          scanError ??= error
          callback(error, entries)
        })
      },
    },
  })
  if (scanError) throw scanError
  return files.map((file) => file.relativePosix()).sort().map((relativePath) => ({
    absolutePath: join(root, relativePath),
    relativePath,
    stem: relativePath.slice(0, -(suffix.length + extname(relativePath).length + 1)),
  }))
}

export async function importModules<T>(
  files: readonly ModuleFile[],
  decode: (value: unknown, file: ModuleFile) => T | Promise<T>,
): Promise<readonly { file: ModuleFile; value: T }[]> {
  const modules: { file: ModuleFile; value: T }[] = []
  for (const file of files) {
    try {
      const namespace: { default?: unknown } = await import(pathToFileURL(file.absolutePath).href)
      if (!Object.hasOwn(namespace, 'default')) throw new TypeError('A default export is required')
      modules.push({ file, value: await decode(namespace.default, file) })
    } catch (cause) {
      const detail = cause instanceof Error ? `: ${cause.message}` : ''
      throw new Error(`Failed to load ${file.relativePath}${detail}`, { cause })
    }
  }
  return modules
}

export async function loadModules<T>(
  options: LoadModulesOptions,
  decode: (value: unknown, file: ModuleFile) => T | Promise<T>,
): Promise<readonly { file: ModuleFile; value: T }[]> {
  return importModules(await scanModules(options), decode)
}
