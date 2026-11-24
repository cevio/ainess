import { stat } from 'node:fs/promises'
import { readModelConfig, type ModelDirectoryConfig } from './config.js'
import { writeModelDeclaration } from './declaration.js'
import { scanModelFiles } from './files.js'
import { readGeneratedFile } from './generated-file.js'
import { runtimeModelPaths, scanRuntimeModels, writeModelManifest } from './manifest.js'
import { watchModelDirectory } from './watch.js'

async function prepareConfiguredModels(config: ModelDirectoryConfig) {
  if (!(await stat(config.sourceRoot)).isDirectory()) {
    throw new Error(`Model source root is not a directory: ${config.sourceRoot}`)
  }
  const files = await scanModelFiles(config.typegen)
  const paths = runtimeModelPaths(files.map(file => file.relativePath), config.loader)
  const declaration = await writeModelDeclaration(config.typegen.output, files)
  return { paths, declaration }
}

export async function prepareModelBuild(location: string | URL): Promise<() => Promise<void>> {
  const config = await readModelConfig(location)
  const { paths, declaration } = await prepareConfiguredModels(config)
  return async () => {
    await scanRuntimeModels(config.loader, paths)
    if (await readGeneratedFile(config.typegen.output) !== declaration) {
      throw new Error(`Model declaration ${config.typegen.output} changed after preparing the build`)
    }
    await writeModelManifest(config.loader.directory, paths)
  }
}

export async function watchModelTypes(
  location: string | URL,
  reportError: (error: unknown) => void = console.error,
): Promise<() => Promise<void>> {
  const config = await readModelConfig(location)
  return watchModelDirectory(config, async () => {
    const { paths } = await prepareConfiguredModels(config)
    await writeModelManifest(config.loader.directory, paths)
  }, reportError)
}
