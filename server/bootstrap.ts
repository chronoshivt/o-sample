import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { fetchVendorBinaries, vendorPathsFor, type VendorPaths } from "./vendor-fetch"

async function isBinaryAvailable(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const proc = spawn(cmd, ["--version"], { stdio: "ignore" })
      proc.on("error", () => resolve(false))
      proc.on("exit", code => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

type ResolvedBinary = {
  // Absolute path or PATH-resolvable command to invoke.
  path: string
  // True if we plan to fall back to the vendor copy and need to download it.
  needsDownload: boolean
}

async function resolveBinary(
  systemCmd: string,
  vendorPath: string
): Promise<ResolvedBinary> {
  if (await isBinaryAvailable(systemCmd)) {
    return { path: systemCmd, needsDownload: false }
  }
  if (existsSync(vendorPath)) {
    return { path: vendorPath, needsDownload: false }
  }
  return { path: vendorPath, needsDownload: true }
}

function manualInstallHint(): string {
  switch (process.platform) {
    case "darwin": return "brew install yt-dlp ffmpeg"
    case "win32":  return "winget install yt-dlp.yt-dlp Gyan.FFmpeg"
    default:       return "pipx install yt-dlp && sudo apt install ffmpeg"
  }
}

export async function ensureBinariesAvailable(config: {
  ytDlp: string
  ffmpeg: string
}): Promise<VendorPaths> {
  // bootstrap.ts lives at server/bootstrap.ts; the project root is one dir up.
  const projectRoot = resolve(import.meta.dir, "..")
  const vendor = vendorPathsFor(projectRoot)

  const [ytDlpResolved, ffmpegResolved] = await Promise.all([
    resolveBinary(config.ytDlp, vendor.ytDlp),
    resolveBinary(config.ffmpeg, vendor.ffmpeg),
  ])

  if (ytDlpResolved.needsDownload || ffmpegResolved.needsDownload) {
    console.log("yt-dlp/ffmpeg not found on PATH — downloading local copies (~80 MB, one-time):")
    try {
      await fetchVendorBinaries(projectRoot, msg => console.log(`  → ${msg}`))
      console.log(`  ✓ ready (cached at vendor/)\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("\n=== o-sample can't start ===\n")
      console.error(`Auto-download failed: ${message}\n`)
      console.error(`Workaround: install manually, then restart:\n`)
      console.error(`  ${manualInstallHint()}\n`)
      process.exit(1)
    }
  }

  return {
    ytDlp: ytDlpResolved.path,
    ffmpeg: ffmpegResolved.path,
  }
}
