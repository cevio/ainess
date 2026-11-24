import { extname, join } from 'node:path'
import type { ModelDirectoryConfig } from './config.js'
import { scanModelFiles, toJavaScriptPath } from './files.js'
import { readGeneratedFile, writeGeneratedFile } from './generated-file.js'

type RuntimeDirectory = ModelDirectoryConfig['loader']
const manifestFilename = '.ainess-models.json'
const generator = '@ainess/model'
const header = `{\n  "generatedBy": "${generator}",\n`

export function runtimeModelPaths(paths: readonly string[], { extensions }: RuntimeDirectory): readonly string[] {
  const sources = new Map<string, string>()
  for (const path of paths) {
    const emitted = toJavaScriptPath(path)
    const artifact = extensions.includes(extname(emitted)) ? emitted : path
    if (!extensions.includes(extname(artifact))) {
      throw new Error(`No configured runtime extension for Model source ${path}`)
    }
    const previous = sources.get(artifact)
    if (previous !== undefined) throw new Error(`Model sources ${previous} and ${path} both emit ${artifact}`)
    sources.set(artifact, path)
  }
  return [...sources.keys()].sort()
}

export function writeModelManifest(directory: string, paths: readonly string[]): Promise<void> {
  const content = JSON.stringify({ generatedBy: generator, files: paths }, null, 2) + '\n'
  return writeGeneratedFile(join(directory, manifestFilename), content, header)
}

async function readModelManifest(directory: string): Promise<readonly string[] | undefined> {
  const filename = join(directory, manifestFilename)
  const content = await readGeneratedFile(filename)
  if (content === undefined) return undefined
  try {
    const value = JSON.parse(content) as { generatedBy: unknown; files: unknown }
    if (value?.generatedBy !== generator || !Array.isArray(value.files)
      || !value.files.every(path => typeof path === 'string')) {
      throw new TypeError('Expected a generated Model manifest')
    }
    return [...new Set<string>(value.files)]
  } catch (cause) {
    throw new Error(`Invalid Model manifest ${filename}`, { cause })
  }
}

export async function scanRuntimeModels(options: RuntimeDirectory, paths?: readonly string[]) {
  paths ??= await readModelManifest(options.directory)
  if (paths?.length === 0) return []
  const files = await scanModelFiles(options)
  if (!paths) return files

  const indexed = new Map(files.map(file => [file.relativePath, file]))
  return paths.map(path => {
    const file = indexed.get(path)
    if (!file) throw new Error(`Model artifact ${path} is missing from ${options.directory}`)
    return file
  })
}
