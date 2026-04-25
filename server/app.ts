import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import Innertube from "youtubei.js"

export interface ServerConfig {
    port: number
    downloadDir: string
    ytDlp: string
    ffmpeg: string
    proxy: string | null
    cookiesFile: string | null
    playerClient: string | null
    downloadTimeoutMs: number
    clipTimeoutMs: number
}

export const defaultConfig: ServerConfig = {
    port: Number(process.env.PORT) || 3847,
    downloadDir: process.env.DOWNLOAD_DIR || path.join(import.meta.dir, "downloads"),
    ytDlp: process.env.YT_DLP || "yt-dlp",
    ffmpeg: process.env.FFMPEG || "ffmpeg",
    proxy: process.env.YT_PROXY || null,
    cookiesFile: process.env.YT_COOKIES_FILE || null,
    // Optional override for yt-dlp's player_client. Leave unset to use
    // yt-dlp's own defaults. Set to e.g. "web_safari" or "tv_embedded" on
    // Coolify only if YouTube's bot check starts rejecting the default.
    playerClient: process.env.YT_PLAYER_CLIENT || null,
    downloadTimeoutMs: 90_000,
    clipTimeoutMs: 120_000
}

const YT_ID_RE = /^[\w-]{11}$/
const DOWNLOAD_FILE_RE = /^[\w.-]+\.mp3$/
const MAX_CLIP_SECONDS = 60 * 30
const DESC_MAX = 280

export function withCorsHeaders(headers?: unknown): Headers {
    const h = new Headers()
    if (headers instanceof Headers) {
        headers.forEach((value, key) => h.set(key, value))
    } else if (headers && typeof headers === "object") {
        for (const [key, value] of Object.entries(headers)) {
            if (typeof value === "string") h.set(key, value)
        }
    }
    h.set("Access-Control-Allow-Origin", "*")
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    h.set("Access-Control-Allow-Headers", "Content-Type")
    h.set("Access-Control-Expose-Headers", "X-Clip-Filename")
    h.set("Cross-Origin-Resource-Policy", "cross-origin")
    return h
}

function json(data: unknown, init: ResponseInit = {}): Response {
    return Response.json(data, {
        ...init,
        headers: withCorsHeaders(init.headers)
    })
}

export function sanitizeDownloadFileName(name: string): string | null {
    return DOWNLOAD_FILE_RE.test(name) ? name : null
}

export function parseRangeHeader(rangeHeader: string, size: number): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    if (!match) return null

    const [, startRaw, endRaw] = match
    if (!startRaw && !endRaw) return null

    let start: number
    let end: number

    if (startRaw) {
        start = Number(startRaw)
        end = endRaw ? Number(endRaw) : size - 1
    } else {
        const suffixLength = Number(endRaw)
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
        start = Math.max(0, size - suffixLength)
        end = size - 1
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (start < 0 || end < start || start >= size) return null

    end = Math.min(end, size - 1)
    return { start, end }
}

function formatClipTimeForName(value: number): string {
    return value.toFixed(2).replace(/[^\d]+/g, "-")
}

export function extractYoutubeVideoId(raw: string): string | null {
    let u: URL
    try {
        u = new URL(raw)
    } catch {
        return null
    }
    const host = u.hostname.replace(/^www\./, "").toLowerCase()

    if (host === "youtu.be") {
        const id = u.pathname.split("/").filter(Boolean)[0] ?? ""
        return YT_ID_RE.test(id) ? id : null
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "www.youtube.com") {
        const v = u.searchParams.get("v")
        if (v && YT_ID_RE.test(v)) return v

        const shorts = u.pathname.match(/^\/shorts\/([\w-]{11})(?:\/|$)/)
        if (shorts?.[1]) return shorts[1]

        const embed = u.pathname.match(/^\/embed\/([\w-]{11})(?:\/|$)/)
        if (embed?.[1]) return embed[1]

        const live = u.pathname.match(/^\/live\/([\w-]{11})(?:\/|$)/)
        if (live?.[1]) return live[1]
    }

    return null
}

function pickBestThumbnail(
    thumbs: { url: string; width: number; height: number }[] | null | undefined
): string | null {
    if (!thumbs?.length) return null
    return thumbs.reduce((best, t) => (t.width > best.width ? t : best)).url
}

let ytPromise: Promise<Innertube> | null = null

function getYt(): Promise<Innertube> {
    ytPromise ??= Innertube.create()
    return ytPromise
}

type YtDlpResult = { ok: true; filename: string; cached: boolean } | { ok: false; status: number; error: string }

const inFlightDownloads = new Map<string, Promise<YtDlpResult>>()

async function downloadAudioViaYtDlp(config: ServerConfig, videoId: string): Promise<YtDlpResult> {
    const filename = `${videoId}.mp3`
    const filePath = path.join(config.downloadDir, filename)

    const cached = await stat(filePath).catch(() => null)
    if (cached && cached.isFile() && cached.size > 0) {
        return { ok: true, filename, cached: true }
    }

    const existing = inFlightDownloads.get(videoId)
    if (existing) return existing

    const task = runYtDlp(config, videoId, filename).finally(() => {
        inFlightDownloads.delete(videoId)
    })
    inFlightDownloads.set(videoId, task)
    return task
}

async function runYtDlp(config: ServerConfig, videoId: string, filename: string): Promise<YtDlpResult> {
    const outputTemplate = path.join(config.downloadDir, `${videoId}.%(ext)s`)

    const args = [
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "2",
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        "--force-overwrites",
        "-o",
        outputTemplate
    ]
    args.push("--ffmpeg-location", config.ffmpeg)
    if (config.proxy) args.push("--proxy", config.proxy)
    if (config.cookiesFile) args.push("--cookies", config.cookiesFile)
    if (config.playerClient) args.push("--extractor-args", `youtube:player_client=${config.playerClient}`)
    args.push(`https://www.youtube.com/watch?v=${videoId}`)

    const child = spawn(config.ytDlp, args, { stdio: ["ignore", "pipe", "pipe"] })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", c => {
        stdout += String(c)
    })
    child.stderr.on("data", c => {
        stderr += String(c)
    })

    const timer = setTimeout(() => child.kill("SIGKILL"), config.downloadTimeoutMs)
    let timedOut = false
    timer.unref?.()

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", err => {
            clearTimeout(timer)
            reject(err)
        })
        child.on("close", (code, signal) => {
            clearTimeout(timer)
            if (signal === "SIGKILL") timedOut = true
            resolve(code)
        })
    }).catch((err: Error) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            console.error("[y-sample] yt-dlp spawn ENOENT", { path: config.ytDlp, err: err.message })
            return "ENOENT" as const
        }
        console.error("[y-sample] yt-dlp spawn error", err)
        throw err
    })

    if (exitCode === "ENOENT") {
        return { ok: false, status: 500, error: `yt-dlp not installed on server (tried: ${config.ytDlp})` }
    }

    if (timedOut) {
        await rm(path.join(config.downloadDir, filename), { force: true }).catch(() => {})
        return { ok: false, status: 504, error: "download timed out" }
    }

    if (exitCode !== 0) {
        await rm(path.join(config.downloadDir, filename), { force: true }).catch(() => {})
        const tail = (stderr || stdout).trim().split("\n").slice(-3).join(" | ")
        const lower = tail.toLowerCase()
        console.error("[y-sample] yt-dlp exit", exitCode, tail)
        if (lower.includes("private video") || lower.includes("unavailable") || lower.includes("not available")) {
            return { ok: false, status: 404, error: `video unavailable: ${tail}` }
        }
        return { ok: false, status: 502, error: `download failed: ${tail}` }
    }

    return { ok: true, filename, cached: false }
}

type ClipAudioResult =
    | { ok: true; filePath: string; downloadName: string }
    | { ok: false; status: number; error: string }

async function clipAudioViaFfmpeg(
    config: ServerConfig,
    videoId: string,
    startSeconds: number,
    endSeconds: number,
    pitchSemitones: number = 0,
    crushAmount: number = 0
): Promise<ClipAudioResult> {
    const inputName = `${videoId}.mp3`
    const inputPath = path.join(config.downloadDir, inputName)
    const durationSeconds = endSeconds - startSeconds
    // Clamp pitch to a sane range (matches the UI knob's ±12 but leaves headroom)
    const pitch = Math.max(-24, Math.min(24, Math.round(pitchSemitones || 0)))
    const pitchTag = pitch === 0 ? "" : `-p${pitch > 0 ? "+" : ""}${pitch}st`
    // Clamp crush to [0, 1]. Match the UI knob's mapping: amount 0 → 16 bits, amount 1 → 1 bit.
    const crush = Math.max(0, Math.min(1, Number.isFinite(crushAmount) ? crushAmount : 0))
    const crushBits = 16 - crush * 15
    const crushTag = crush < 0.02 ? "" : `-c${Math.round(crushBits * 10) / 10}b`
    const outputName = `${videoId}-${formatClipTimeForName(startSeconds)}-${formatClipTimeForName(endSeconds)}${pitchTag}${crushTag}.mp3`
    const outputPath = path.join(config.downloadDir, outputName)

    try {
        await stat(inputPath)
    } catch {
        return { ok: false, status: 404, error: "source audio not found; download it first" }
    }

    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
        return { ok: false, status: 400, error: "invalid clip range" }
    }
    if (startSeconds < 0 || endSeconds <= startSeconds) {
        return { ok: false, status: 400, error: "invalid clip range" }
    }
    if (durationSeconds > MAX_CLIP_SECONDS) {
        return { ok: false, status: 400, error: "clip range too long" }
    }

    const args = [
        "-y",
        "-ss",
        String(startSeconds),
        "-t",
        String(durationSeconds),
        "-i",
        inputPath,
        "-vn"
    ]

    const filterChain: string[] = []

    if (pitch !== 0) {
        // Varispeed (tape) pitch shift: matches the preview's audio.playbackRate behavior —
        // pitch and tempo both move together. Normalize to 44.1k first so the ratio
        // is independent of the source file's sample rate.
        const baseSR = 44100
        const ratio = Math.pow(2, pitch / 12)
        const scaledSR = Math.round(baseSR * ratio)
        filterChain.push(`aresample=${baseSR}`, `asetrate=${scaledSR}`, `aresample=${baseSR}`)
    }

    if (crush >= 0.02) {
        // Bit-depth reduction matches the preview's WaveShaper curve (amount 0 → 16 bits,
        // amount 1 → 1 bit). Linear mode with full wet mix reproduces the same staircase
        // quantization audibly — acrusher's `bits` is continuous so fractional values are fine.
        filterChain.push(`acrusher=bits=${crushBits.toFixed(3)}:mix=1:mode=lin`)
    }

    if (filterChain.length > 0) {
        args.push("-af", filterChain.join(","))
    }

    args.push("-acodec", "libmp3lame", "-b:a", "192k", outputPath)

    const child = spawn(config.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", c => {
        stdout += String(c)
    })
    child.stderr.on("data", c => {
        stderr += String(c)
    })

    const timer = setTimeout(() => child.kill("SIGKILL"), config.clipTimeoutMs)
    let timedOut = false
    timer.unref?.()

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", err => {
            clearTimeout(timer)
            reject(err)
        })
        child.on("close", (code, signal) => {
            clearTimeout(timer)
            if (signal === "SIGKILL") timedOut = true
            resolve(code)
        })
    }).catch((err: Error) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return "ENOENT" as const
        }
        throw err
    })

    if (exitCode === "ENOENT") {
        return { ok: false, status: 500, error: "ffmpeg not installed on server" }
    }

    if (timedOut) {
        await rm(outputPath, { force: true }).catch(() => {})
        return { ok: false, status: 504, error: "clip export timed out" }
    }

    if (exitCode !== 0) {
        await rm(outputPath, { force: true }).catch(() => {})
        const tail = (stderr || stdout).trim().split("\n").slice(-3).join(" | ")
        console.error("[y-sample] ffmpeg exit", exitCode, tail)
        return { ok: false, status: 502, error: "clip export failed" }
    }

    return { ok: true, filePath: outputPath, downloadName: outputName }
}

export async function handleRequest(req: Request, config: ServerConfig = defaultConfig): Promise<Response> {
    const { pathname } = new URL(req.url)

    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: withCorsHeaders()
        })
    }

    if (req.method === "POST" && pathname === "/url") {
        let body: unknown
        try {
            body = await req.json()
        } catch {
            return json({ error: "invalid json" }, { status: 400 })
        }
        const url =
            typeof body === "object" &&
            body !== null &&
            "url" in body &&
            typeof (body as { url: unknown }).url === "string"
                ? (body as { url: string }).url.trim()
                : ""
        if (!url) {
            return json({ error: "missing url" }, { status: 400 })
        }

        const videoId = extractYoutubeVideoId(url)
        if (!videoId) {
            return json({ error: "not a youtube video url" }, { status: 400 })
        }

        try {
            const yt = await getYt()
            const info = await yt.getBasicInfo(videoId)
            const bi = info.basic_info

            const channelId = bi.channel_id ?? bi.channel?.id ?? ""
            let desc = bi.short_description ?? ""
            if (desc.length > DESC_MAX) {
                desc = desc.slice(0, DESC_MAX - 1) + "…"
            }

            const video = {
                id: bi.id ?? videoId,
                title: bi.title ?? "",
                author: bi.author ?? bi.channel?.name ?? "",
                channel_id: channelId,
                duration: bi.duration ?? null,
                view_count: bi.view_count ?? null,
                short_description: desc || null,
                thumbnail: pickBestThumbnail(bi.thumbnail)
            }

            console.log("[y-sample] url:", url, "→", video.id, video.title?.slice(0, 60))
            return json({ ok: true, video })
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            const lower = msg.toLowerCase()
            if (
                lower.includes("not found") ||
                lower.includes("unavailable") ||
                lower.includes("private video")
            ) {
                return json({ error: "video unavailable" }, { status: 404 })
            }
            console.error("[y-sample] getBasicInfo:", msg)
            return json({ error: "could not load video info" }, { status: 502 })
        }
    }

    if (req.method === "POST" && pathname === "/download-audio") {
        let body: unknown
        try {
            body = await req.json()
        } catch {
            return json({ error: "invalid json" }, { status: 400 })
        }
        const videoId =
            typeof body === "object" &&
            body !== null &&
            "videoId" in body &&
            typeof (body as { videoId: unknown }).videoId === "string"
                ? (body as { videoId: string }).videoId.trim()
                : ""
        if (!videoId || !YT_ID_RE.test(videoId)) {
            return json({ error: "missing or invalid videoId" }, { status: 400 })
        }

        try {
            await mkdir(config.downloadDir, { recursive: true })
            const result = await downloadAudioViaYtDlp(config, videoId)
            if (!result.ok) {
                return json({ error: result.error }, { status: result.status })
            }

            const filePath = path.join(config.downloadDir, result.filename)
            const bytes = (await stat(filePath)).size
            console.log(
                "[y-sample]",
                result.cached ? "cache hit:" : "saved audio:",
                result.filename,
                bytes,
                "bytes"
            )
            return json({
                ok: true,
                filename: result.filename,
                path: `downloads/${result.filename}`,
                bytes,
                cached: result.cached
            })
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error("[y-sample] download-audio:", msg)
            return json({ error: "could not complete request" }, { status: 502 })
        }
    }

    if (req.method === "POST" && pathname === "/clip-audio") {
        let body: unknown
        try {
            body = await req.json()
        } catch {
            return json({ error: "invalid json" }, { status: 400 })
        }

        const videoId =
            typeof body === "object" &&
            body !== null &&
            "videoId" in body &&
            typeof (body as { videoId: unknown }).videoId === "string"
                ? (body as { videoId: string }).videoId.trim()
                : ""
        const startSeconds =
            typeof body === "object" &&
            body !== null &&
            "startSeconds" in body &&
            typeof (body as { startSeconds: unknown }).startSeconds === "number"
                ? (body as { startSeconds: number }).startSeconds
                : Number.NaN
        const endSeconds =
            typeof body === "object" &&
            body !== null &&
            "endSeconds" in body &&
            typeof (body as { endSeconds: unknown }).endSeconds === "number"
                ? (body as { endSeconds: number }).endSeconds
                : Number.NaN
        const pitchSemitones =
            typeof body === "object" &&
            body !== null &&
            "pitchSemitones" in body &&
            typeof (body as { pitchSemitones: unknown }).pitchSemitones === "number"
                ? (body as { pitchSemitones: number }).pitchSemitones
                : 0
        const crushAmount =
            typeof body === "object" &&
            body !== null &&
            "crushAmount" in body &&
            typeof (body as { crushAmount: unknown }).crushAmount === "number"
                ? (body as { crushAmount: number }).crushAmount
                : 0

        if (!videoId || !YT_ID_RE.test(videoId)) {
            return json({ error: "missing or invalid videoId" }, { status: 400 })
        }

        try {
            const result = await clipAudioViaFfmpeg(config, videoId, startSeconds, endSeconds, pitchSemitones, crushAmount)
            if (!result.ok) {
                return json({ error: result.error }, { status: result.status })
            }

            const file = Bun.file(result.filePath)
            const bytes = await file.arrayBuffer()
            // Keep the clip file on disk so it can be served via GET /downloads/<name>
            // (needed for drag-out-to-native-app via DownloadURL dataTransfer).

            return new Response(bytes, {
                status: 200,
                headers: withCorsHeaders({
                    "Content-Type": "audio/mpeg",
                    "Content-Disposition": `attachment; filename="${result.downloadName}"`,
                    "Content-Length": String(bytes.byteLength),
                    "X-Clip-Filename": result.downloadName
                })
            })
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error("[y-sample] clip-audio:", msg)
            return json({ error: "could not export clip" }, { status: 502 })
        }
    }

    if (req.method === "GET" && pathname.startsWith("/downloads/")) {
        const name = pathname.slice("/downloads/".length)
        const safeName = sanitizeDownloadFileName(name)
        if (!safeName) {
            return json({ error: "invalid filename" }, { status: 400 })
        }

        const filePath = path.join(config.downloadDir, safeName)
        let fileSize = 0
        try {
            fileSize = (await stat(filePath)).size
        } catch {
            return json({ error: "file not found" }, { status: 404 })
        }

        const rangeHeader = req.headers.get("range")
        const file = Bun.file(filePath)
        // Content-Disposition: attachment is required for Chrome to allow
        // drag-out (DownloadURL dataTransfer) from a cross-origin URL into
        // native apps like FL Studio / Finder.
        const baseHeaders = {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-store",
            "Accept-Ranges": "bytes",
            "Content-Disposition": `attachment; filename="${safeName}"`
        }

        if (!rangeHeader) {
            return new Response(file, {
                status: 200,
                headers: withCorsHeaders({
                    ...baseHeaders,
                    "Content-Length": String(fileSize)
                })
            })
        }

        const parsedRange = parseRangeHeader(rangeHeader, fileSize)
        if (!parsedRange) {
            return new Response(null, {
                status: 416,
                headers: withCorsHeaders({
                    ...baseHeaders,
                    "Content-Range": `bytes */${fileSize}`
                })
            })
        }

        const { start, end } = parsedRange
        const chunkSize = end - start + 1
        return new Response(file.slice(start, end + 1), {
            status: 206,
            headers: withCorsHeaders({
                ...baseHeaders,
                "Content-Length": String(chunkSize),
                "Content-Range": `bytes ${start}-${end}/${fileSize}`
            })
        })
    }

    if (req.method === "GET" && pathname === "/health") {
        return json({ ok: true })
    }

    return new Response("Not Found", {
        status: 404,
        headers: withCorsHeaders()
    })
}

export function startServer(config: ServerConfig = defaultConfig) {
    return Bun.serve({
        port: config.port,
        hostname: "0.0.0.0",
        fetch(req) {
            return handleRequest(req, config)
        }
    })
}
