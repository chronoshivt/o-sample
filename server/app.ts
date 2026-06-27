import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

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

interface YtDlpVideoInfo {
    id?: string
    title?: string
    uploader?: string
    channel?: string
    channel_id?: string
    duration?: number
    view_count?: number
    description?: string
    thumbnails?: { url: string; width?: number; height?: number }[]
}

type VideoInfoResult =
    | { ok: true; info: YtDlpVideoInfo }
    | { ok: false; status: number; error: string }

// Ordered yt-dlp player-client strategies, tried in turn until one yields the
// video. YouTube blocks different clients for different videos — datacenter-IP
// bot checks, "not available on this app", DRM, region — so when one run fails
// with a retryable error we re-run with the next set. Each entry is itself a
// comma list yt-dlp also iterates internally, so the ladder is cheap breadth:
//   1. tv_embedded — bypasses the datacenter bot check; best general default.
//   2. android,ios  — mobile clients; cover videos the tv/web clients reject.
//   3. tv,web       — last-resort web players for anything still missing.
export const YT_CLIENT_STRATEGIES = [
    "tv_embedded,mweb,web_safari,default",
    "android,ios",
    "tv,web"
] as const

// Strategies to attempt for this request. An explicit YT_PLAYER_CLIENT override
// means the operator picked one on purpose — honor it and don't second-guess.
export function playerClientStrategies(config: ServerConfig): string[] {
    return config.playerClient ? [config.playerClient] : [...YT_CLIENT_STRATEGIES]
}

export interface YtDlpFailure {
    // terminal: no other client/strategy will help — stop laddering, fail fast.
    terminal: boolean
    status: number
    label: string
    tail: string
}

// Classify a failed yt-dlp run from its output. Terminal failures (private,
// removed, age/members/geo-gated) won't change with a different player client,
// so we surface them immediately. Everything else — crucially the
// "not available on this app" / "requested format" client blocks — is treated
// as retryable so the fallback ladder gets a chance.
export function classifyYtDlpFailure(output: string): YtDlpFailure {
    const tail = (output || "").trim().split("\n").slice(-3).join(" | ")
    const lower = tail.toLowerCase()
    const term = (status: number, label: string): YtDlpFailure => ({ terminal: true, status, label, tail })

    if (lower.includes("private video")) return term(404, "video is private")
    if (lower.includes("members-only") || lower.includes("join this channel")) {
        return term(404, "members-only video")
    }
    if (
        lower.includes("sign in to confirm your age") ||
        lower.includes("age-restricted") ||
        lower.includes("inappropriate for some users")
    ) {
        return term(403, "age-restricted video (requires sign-in cookies)")
    }
    if (lower.includes("removed by the user") || (lower.includes("account") && lower.includes("terminated"))) {
        return term(404, "video no longer available")
    }
    if (
        lower.includes("not available in your country") ||
        lower.includes("not available in your location") ||
        lower.includes("blocked it in your country")
    ) {
        return term(451, "video is geo-blocked")
    }
    // "Video unavailable" (truly removed) is terminal, but the superficially
    // similar "not available on this app" is a client block — keep it retryable.
    if (lower.includes("video unavailable") && !lower.includes("not available on this app")) {
        return term(404, "video unavailable")
    }
    return { terminal: false, status: 502, label: "could not fetch this video", tail }
}

interface YtDlpRun {
    code: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    enoent: boolean
}

// Spawn yt-dlp once and collect its result. Never rejects — spawn errors are
// folded into the resolved value so callers can drive the fallback ladder with
// a plain loop instead of try/catch around every attempt.
function spawnYtDlp(config: ServerConfig, args: string[], timeoutMs: number): Promise<YtDlpRun> {
    return new Promise<YtDlpRun>(resolve => {
        const child = spawn(config.ytDlp, args, { stdio: ["ignore", "pipe", "pipe"] })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        child.stdout.on("data", c => {
            stdout += String(c)
        })
        child.stderr.on("data", c => {
            stderr += String(c)
        })
        const timer = setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
        }, timeoutMs)
        timer.unref?.()
        child.on("error", err => {
            clearTimeout(timer)
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                console.error("[y-sample] yt-dlp spawn ENOENT", { path: config.ytDlp, err: err.message })
                resolve({ code: null, stdout, stderr, timedOut: false, enoent: true })
            } else {
                console.error("[y-sample] yt-dlp spawn error", err)
                resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false, enoent: false })
            }
        })
        child.on("close", (code, signal) => {
            clearTimeout(timer)
            resolve({ code, stdout, stderr, timedOut: timedOut || signal === "SIGKILL", enoent: false })
        })
    })
}

export async function fetchVideoInfoViaYtDlp(config: ServerConfig, videoId: string): Promise<VideoInfoResult> {
    const baseArgs = ["--dump-single-json", "--skip-download", "--no-playlist", "--no-progress", "--no-warnings"]
    if (config.proxy) baseArgs.push("--proxy", config.proxy)
    if (config.cookiesFile) baseArgs.push("--cookies", config.cookiesFile)
    const url = `https://www.youtube.com/watch?v=${videoId}`

    let lastFailure: YtDlpFailure = { terminal: false, status: 502, label: "could not load video info", tail: "" }

    for (const clients of playerClientStrategies(config)) {
        const args = [...baseArgs, "--extractor-args", `youtube:player_client=${clients}`, url]
        const run = await spawnYtDlp(config, args, 30_000)

        if (run.enoent) {
            return { ok: false, status: 500, error: `yt-dlp not installed on server (tried: ${config.ytDlp})` }
        }
        if (run.timedOut) {
            return { ok: false, status: 504, error: "video info lookup timed out" }
        }
        if (run.code === 0) {
            try {
                return { ok: true, info: JSON.parse(run.stdout) as YtDlpVideoInfo }
            } catch (e) {
                console.error("[y-sample] yt-dlp json parse error", e)
                return { ok: false, status: 502, error: "could not parse video info" }
            }
        }

        lastFailure = classifyYtDlpFailure(run.stderr || run.stdout)
        console.error(`[y-sample] yt-dlp info failed [client=${clients}]`, run.code, lastFailure.label, "|", lastFailure.tail)
        if (lastFailure.terminal) break
    }

    return { ok: false, status: lastFailure.status, error: lastFailure.label }
}

type YtDlpResult = { ok: true; filename: string; cached: boolean } | { ok: false; status: number; error: string }

const inFlightDownloads = new Map<string, Promise<YtDlpResult>>()

export async function downloadAudioViaYtDlp(config: ServerConfig, videoId: string): Promise<YtDlpResult> {
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

    const baseArgs = [
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
    if (config.proxy) baseArgs.push("--proxy", config.proxy)
    if (config.cookiesFile) baseArgs.push("--cookies", config.cookiesFile)
    // ffmpeg-location lets the bundled exe point yt-dlp at its extracted ffmpeg.
    if (config.ffmpeg && config.ffmpeg !== "ffmpeg") baseArgs.push("--ffmpeg-location", config.ffmpeg)
    const url = `https://www.youtube.com/watch?v=${videoId}`
    const partialPath = path.join(config.downloadDir, filename)

    let lastFailure: YtDlpFailure = { terminal: false, status: 502, label: "download failed", tail: "" }

    for (const clients of playerClientStrategies(config)) {
        const args = [...baseArgs, "--extractor-args", `youtube:player_client=${clients}`, url]
        const run = await spawnYtDlp(config, args, config.downloadTimeoutMs)

        if (run.enoent) {
            return { ok: false, status: 500, error: `yt-dlp not installed on server (tried: ${config.ytDlp})` }
        }
        if (run.timedOut) {
            await rm(partialPath, { force: true }).catch(() => {})
            return { ok: false, status: 504, error: "download timed out" }
        }
        if (run.code === 0) {
            return { ok: true, filename, cached: false }
        }

        // Failed attempt — drop any partial file before retrying the next client.
        await rm(partialPath, { force: true }).catch(() => {})
        lastFailure = classifyYtDlpFailure(run.stderr || run.stdout)
        console.error(`[y-sample] yt-dlp download failed [client=${clients}]`, run.code, lastFailure.label, "|", lastFailure.tail)
        if (lastFailure.terminal) break
    }

    const detail = lastFailure.tail ? `${lastFailure.label}: ${lastFailure.tail}` : lastFailure.label
    return { ok: false, status: lastFailure.status, error: detail }
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

        const result = await fetchVideoInfoViaYtDlp(config, videoId)
        if (!result.ok) {
            return json({ error: result.error }, { status: result.status })
        }
        const bi = result.info

        let desc = bi.description ?? ""
        if (desc.length > DESC_MAX) {
            desc = desc.slice(0, DESC_MAX - 1) + "…"
        }

        const video = {
            id: bi.id ?? videoId,
            title: bi.title ?? "",
            author: bi.uploader ?? bi.channel ?? "",
            channel_id: bi.channel_id ?? "",
            duration: typeof bi.duration === "number" ? bi.duration : null,
            view_count: typeof bi.view_count === "number" ? bi.view_count : null,
            short_description: desc || null,
            thumbnail: pickBestThumbnail(
                bi.thumbnails?.map(t => ({ url: t.url, width: t.width ?? 0, height: t.height ?? 0 }))
            )
        }

        console.log("[y-sample] url:", url, "→", video.id, video.title?.slice(0, 60))
        return json({ ok: true, video })
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
