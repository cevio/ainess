import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { containsPath, type ModelDirectoryConfig } from './config.js'

export async function watchModelDirectory(
  { sourceRoot, typegen }: ModelDirectoryConfig,
  generate: () => Promise<void>,
  reportError: (error: unknown) => void,
): Promise<() => Promise<void>> {
  let closed = false
  let timeout: NodeJS.Timeout | undefined
  let refresh = Promise.resolve()

  const watcher = watch(sourceRoot, { recursive: true }, (_event, filename) => {
    if (filename) {
      const path = resolve(sourceRoot, filename)
      if (!containsPath(typegen.directory, path) && !containsPath(path, typegen.directory)) return
    }
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      refresh = refresh.then(async () => {
        if (!closed) await generate()
      }).catch(reportError)
    }, 50)
  })
  watcher.on('error', reportError)

  const close = async () => {
    closed = true
    watcher.close()
    clearTimeout(timeout)
    await refresh
  }

  const initial = generate()
  refresh = initial.catch(() => {})
  try {
    await initial
    return close
  } catch (error) {
    await close()
    throw error
  }
}
