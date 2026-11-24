import { stat } from 'node:fs/promises'
import { scanModules, type LoadModulesOptions } from '@ainess/loader'

export interface ModelFilesOptions extends Omit<LoadModulesOptions, 'suffix'> {
  allowMissing?: boolean
}

export function toJavaScriptPath(path: string): string {
  return path.replace(/\.([mc]?)ts$/, '.$1js')
}

export async function scanModelFiles({ allowMissing, ...options }: ModelFilesOptions) {
  const scan = { ...options, suffix: 'model' }
  try {
    return await scanModules(scan)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const directory = await stat(options.directory).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'ENOENT') throw cause
    })
    // If the scan lost a nested path during a move, rescan the existing Model directory.
    return directory ? scanModules(scan) : []
  }
}
