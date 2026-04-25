import { file } from "bun"
import { mkdir, chmod, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE_ROOT = join(homedir(), ".o-sample", "bin")

export async function extractEmbeddedBinary(
  embeddedPath: string,
  binaryName: string
): Promise<string> {
  await mkdir(CACHE_ROOT, { recursive: true })

  const isWin = process.platform === "win32"
  const outName = isWin && !binaryName.endsWith(".exe") ? `${binaryName}.exe` : binaryName
  const outPath = join(CACHE_ROOT, outName)

  const embedded = file(embeddedPath)
  const embeddedSize = embedded.size

  // Skip extraction if a same-sized copy already exists. Size match is a good
  // proxy for "same binary" without paying the cost of a hash on every launch.
  if (existsSync(outPath)) {
    const cached = await stat(outPath)
    if (cached.size === embeddedSize) return outPath
  }

  const bytes = new Uint8Array(await embedded.arrayBuffer())
  await writeFile(outPath, bytes)
  if (!isWin) await chmod(outPath, 0o755)

  return outPath
}
