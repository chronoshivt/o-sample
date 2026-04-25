// Production entry for the standalone executable built by `npm run build:exe`.
// Wires together: the embedded SPA, the embedded yt-dlp/ffmpeg binaries, and
// the same HTTP API used in dev. Auto-opens the user's browser.

import { file } from "bun"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

import { defaultConfig, handleRequest, type ServerConfig } from "./app"
import { extractEmbeddedBinary } from "./extract-vendored"
import { ASSETS } from "./embedded-assets.gen"
import { VENDORED } from "./vendored-binaries.gen"

// In a compiled exe, `import.meta.dir` resolves inside Bun's read-only $bunfs,
// so the dev default downloadDir (./downloads next to source) isn't writable.
// Cache to ~/.o-sample/downloads/ alongside the extracted binaries.
const DEFAULT_DOWNLOAD_DIR = join(homedir(), ".o-sample", "downloads")

const SPA_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
}

function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase()
  switch (ext) {
    case ".html": return "text/html; charset=utf-8"
    case ".js":
    case ".mjs":  return "application/javascript; charset=utf-8"
    case ".css":  return "text/css; charset=utf-8"
    case ".json": return "application/json"
    case ".svg":  return "image/svg+xml"
    case ".png":  return "image/png"
    case ".jpg":
    case ".jpeg": return "image/jpeg"
    case ".webp": return "image/webp"
    case ".wasm": return "application/wasm"
    case ".woff": return "font/woff"
    case ".woff2": return "font/woff2"
    case ".ico":  return "image/x-icon"
    default:      return "application/octet-stream"
  }
}

async function isOnPath(cmd: string): Promise<boolean> {
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

// Prefer a system install over the embedded copy when one is present. yt-dlp
// in particular benefits from staying current (YouTube anti-bot churn), so a
// brew/winget-installed yt-dlp will get used instead of the bundled version.
async function resolveBinary(
  name: "yt-dlp" | "ffmpeg",
  embeddedKey: "ytDlp" | "ffmpeg",
): Promise<string> {
  if (await isOnPath(name)) return name

  const embeddedPath = VENDORED[embeddedKey]
  if (!embeddedPath) {
    throw new Error(
      `${name} is not installed and no vendored binary is embedded. ` +
      `Install ${name} via your package manager and try again.`,
    )
  }
  return extractEmbeddedBinary(embeddedPath, name)
}

const [ytDlpPath, ffmpegPath] = await Promise.all([
  resolveBinary("yt-dlp", "ytDlp"),
  resolveBinary("ffmpeg", "ffmpeg"),
])

const config: ServerConfig = {
  ...defaultConfig,
  downloadDir: process.env.DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR,
  ytDlp: process.env.YT_DLP || ytDlpPath,
  ffmpeg: process.env.FFMPEG || ffmpegPath,
}

Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    let pathname = url.pathname
    if (pathname === "/") pathname = "/index.html"

    const assetPath = ASSETS[pathname]
    if (assetPath) {
      return new Response(file(assetPath), {
        headers: {
          "Content-Type": guessMime(pathname),
          ...SPA_HEADERS,
        },
      })
    }

    return handleRequest(req, config)
  },
})

const launchUrl = `http://localhost:${config.port}`
console.log(`\n  o-sample is running.`)
console.log(`  → Open ${launchUrl} in your browser`)
console.log(`  → Press Ctrl+C to quit\n`)

// Auto-open the default browser. Best-effort — the URL is already printed if
// this fails (e.g. running over SSH or in a sandbox without a window manager).
try {
  const args =
    process.platform === "darwin" ? ["open", launchUrl] :
    process.platform === "win32"  ? ["cmd", "/c", "start", "", launchUrl] :
    ["xdg-open", launchUrl]
  spawn(args[0], args.slice(1), { stdio: "ignore", detached: true }).unref()
} catch {
  /* fall through */
}
