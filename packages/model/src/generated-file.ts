import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readGeneratedFile(filename: string): Promise<string | undefined> {
  return readFile(filename, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
}

export async function writeGeneratedFile(filename: string, content: string, header: string): Promise<void> {
  const previous = await readGeneratedFile(filename)
  if (previous === content) return
  if (previous !== undefined && !previous.startsWith(header)) {
    throw new Error(`Refusing to overwrite ${filename}: it is not a generated Model file`)
  }

  await mkdir(dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true })
  }
}
