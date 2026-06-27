#!/usr/bin/env bun
// Programmatic end-to-end test for the YouTube fallback ladder.
//
// Drives the REAL server extraction path (info + audio download) against one or
// more YouTube URLs and reports, per URL, whether it succeeded — and which
// player-client strategy won. This is how we verify "can it download X?"
// without launching the UI and clicking around.
//
//   bun scripts/probe-video.ts                       # built-in sample video
//   bun scripts/probe-video.ts <url> [<url> ...]     # your own URLs
//   bun scripts/probe-video.ts --info-only <url>     # skip the audio download
//
// Uses the vendored yt-dlp/ffmpeg in ./vendor (run `npm run build:exe` once, or
// let `npm run dev` populate it). Exits non-zero if any URL fails.

import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

import {
    defaultConfig,
    downloadAudioViaYtDlp,
    extractYoutubeVideoId,
    fetchVideoInfoViaYtDlp,
    playerClientStrategies,
    type ServerConfig
} from "../server/app"
import { vendorPathsFor } from "../server/vendor-fetch"

const ROOT = resolve(import.meta.dir, "..")
const vendor = vendorPathsFor(ROOT)

const rawArgs = process.argv.slice(2)
const infoOnly = rawArgs.includes("--info-only")
const urls = rawArgs.filter(a => !a.startsWith("--"))
if (urls.length === 0) urls.push("https://www.youtube.com/watch?v=5mptP0Fvr3A")

function makeConfig(downloadDir: string): ServerConfig {
    return {
        ...defaultConfig,
        downloadDir,
        ytDlp: process.env.YT_DLP || vendor.ytDlp,
        ffmpeg: process.env.FFMPEG || vendor.ffmpeg
    }
}

async function probe(url: string): Promise<boolean> {
    const videoId = extractYoutubeVideoId(url)
    console.log(`\n── ${url}`)
    if (!videoId) {
        console.log("   ✗ not a recognizable YouTube URL")
        return false
    }

    const dir = await mkdtemp(join(tmpdir(), "o-sample-probe-"))
    const config = makeConfig(dir)
    console.log(`   strategies: ${playerClientStrategies(config).join("  →  ")}`)

    try {
        const info = await fetchVideoInfoViaYtDlp(config, videoId)
        if (!info.ok) {
            console.log(`   ✗ info failed (${info.status}): ${info.error}`)
            return false
        }
        console.log(`   ✓ info: "${(info.info.title ?? "").slice(0, 60)}"  (${info.info.duration ?? "?"}s)`)

        if (infoOnly) return true

        const dl = await downloadAudioViaYtDlp(config, videoId)
        if (!dl.ok) {
            console.log(`   ✗ download failed (${dl.status}): ${dl.error}`)
            return false
        }
        const bytes = (await stat(join(dir, dl.filename))).size
        console.log(`   ✓ download: ${dl.filename}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
        return bytes > 0
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
}

let failures = 0
for (const url of urls) {
    const ok = await probe(url).catch(err => {
        console.log(`   ✗ threw: ${err instanceof Error ? err.message : String(err)}`)
        return false
    })
    if (!ok) failures++
}

console.log(`\n${urls.length - failures}/${urls.length} passed`)
process.exit(failures === 0 ? 0 : 1)
