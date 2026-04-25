// Shared helper for downloading platform-correct yt-dlp + ffmpeg binaries
// into ./vendor/. Used by both:
//   - the build script (scripts/build-exe.ts) before bundling them into the exe
//   - the dev bootstrap (server/bootstrap.ts) when the user doesn't have
//     either binary on PATH
//
// Skipped at exe runtime: the compiled binary uses pre-extracted assets and
// never imports this file.

import { mkdir, writeFile, chmod } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { gunzipSync } from "node:zlib"

export const YTDLP_URLS: Record<string, string> = {
  "darwin-arm64": "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
  "darwin-x64":   "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
  "linux-x64":    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
  "linux-arm64":  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64",
  "win32-x64":    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
}

export type VendorPaths = { ytDlp: string; ffmpeg: string }

export function vendorPlatformKey(): string {
  return `${process.platform}-${process.arch}`
}

export function isPlatformSupported(): boolean {
  return vendorPlatformKey() in YTDLP_URLS
}

// Windows requires the .exe suffix for spawn() to find the binary via PATHEXT.
export function vendorBinaryName(base: "yt-dlp" | "ffmpeg"): string {
  return process.platform === "win32" ? `${base}.exe` : base
}

export function vendorPathsFor(rootDir: string): VendorPaths {
  const vendorDir = resolve(rootDir, "vendor")
  return {
    ytDlp: resolve(vendorDir, vendorBinaryName("yt-dlp")),
    ffmpeg: resolve(vendorDir, vendorBinaryName("ffmpeg")),
  }
}

export function vendorBinariesExist(rootDir: string): boolean {
  const paths = vendorPathsFor(rootDir)
  return existsSync(paths.ytDlp) && existsSync(paths.ffmpeg)
}

async function downloadToFile(
  url: string,
  outPath: string,
  opts?: { gunzip?: boolean }
): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`)
  let bytes = new Uint8Array(await res.arrayBuffer())
  if (opts?.gunzip) bytes = new Uint8Array(gunzipSync(bytes))
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, bytes)
  if (process.platform !== "win32") await chmod(outPath, 0o755)
}

// Downloads only what's missing — `vendor/` is treated as a cache.
export async function fetchVendorBinaries(
  rootDir: string,
  log: (msg: string) => void = () => {}
): Promise<VendorPaths> {
  const key = vendorPlatformKey()
  if (!YTDLP_URLS[key]) {
    throw new Error(
      `unsupported platform: ${key}\n` +
      `supported: ${Object.keys(YTDLP_URLS).join(", ")}`
    )
  }

  const paths = vendorPathsFor(rootDir)

  if (!existsSync(paths.ytDlp)) {
    log(`download yt-dlp for ${key}`)
    await downloadToFile(YTDLP_URLS[key], paths.ytDlp)
  }

  if (!existsSync(paths.ffmpeg)) {
    log(`resolve ffmpeg-static latest release`)
    const releaseRes = await fetch(
      "https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest"
    )
    if (!releaseRes.ok) {
      throw new Error(`ffmpeg release lookup failed: ${releaseRes.status}`)
    }
    const { tag_name: tag } = (await releaseRes.json()) as { tag_name: string }
    const ffmpegUrl =
      `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}` +
      `/ffmpeg-${process.platform}-${process.arch}.gz`
    log(`download ffmpeg ${tag}`)
    await downloadToFile(ffmpegUrl, paths.ffmpeg, { gunzip: true })
  }

  return paths
}
