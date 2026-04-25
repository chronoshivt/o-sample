import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
    extractYoutubeVideoId,
    handleRequest,
    parseRangeHeader,
    sanitizeDownloadFileName,
    type ServerConfig
} from "./app"

let tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
    tempDirs = []
})

async function makeConfig(): Promise<ServerConfig> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "y-sample-test-"))
    tempDirs.push(dir)
    return {
        port: 0,
        downloadDir: dir,
        ytDlp: "yt-dlp",
        ffmpeg: "ffmpeg",
        downloadTimeoutMs: 1000,
        clipTimeoutMs: 1000
    }
}

describe("server helpers", () => {
    test("extractYoutubeVideoId supports watch, short, and youtu.be urls", () => {
        expect(extractYoutubeVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toBe("jNQXAC9IVRw")
        expect(extractYoutubeVideoId("https://youtu.be/jNQXAC9IVRw")).toBe("jNQXAC9IVRw")
        expect(extractYoutubeVideoId("https://www.youtube.com/shorts/jNQXAC9IVRw")).toBe("jNQXAC9IVRw")
    })

    test("sanitizeDownloadFileName rejects traversal", () => {
        expect(sanitizeDownloadFileName("good-file.mp3")).toBe("good-file.mp3")
        expect(sanitizeDownloadFileName("../bad.mp3")).toBeNull()
        expect(sanitizeDownloadFileName("bad.wav")).toBeNull()
    })

    test("parseRangeHeader parses open and bounded ranges", () => {
        expect(parseRangeHeader("bytes=0-4", 10)).toEqual({ start: 0, end: 4 })
        expect(parseRangeHeader("bytes=5-", 10)).toEqual({ start: 5, end: 9 })
        expect(parseRangeHeader("bytes=-4", 10)).toEqual({ start: 6, end: 9 })
        expect(parseRangeHeader("bytes=20-30", 10)).toBeNull()
    })
})

describe("download file serving", () => {
    test("serves full files without range header", async () => {
        const config = await makeConfig()
        await writeFile(path.join(config.downloadDir, "test.mp3"), "abcdef")

        const response = await handleRequest(new Request("http://localhost/downloads/test.mp3"), config)

        expect(response.status).toBe(200)
        expect(response.headers.get("accept-ranges")).toBe("bytes")
        expect(await response.text()).toBe("abcdef")
    })

    test("serves partial content for range requests", async () => {
        const config = await makeConfig()
        await writeFile(path.join(config.downloadDir, "test.mp3"), "abcdef")

        const response = await handleRequest(
            new Request("http://localhost/downloads/test.mp3", {
                headers: { range: "bytes=2-4" }
            }),
            config
        )

        expect(response.status).toBe(206)
        expect(response.headers.get("content-range")).toBe("bytes 2-4/6")
        expect(await response.text()).toBe("cde")
    })

    test("returns 416 for invalid range requests", async () => {
        const config = await makeConfig()
        await writeFile(path.join(config.downloadDir, "test.mp3"), "abcdef")

        const response = await handleRequest(
            new Request("http://localhost/downloads/test.mp3", {
                headers: { range: "bytes=99-120" }
            }),
            config
        )

        expect(response.status).toBe(416)
        expect(response.headers.get("content-range")).toBe("bytes */6")
    })
})

describe("clip endpoint validation", () => {
    test("returns 404 when source audio has not been downloaded", async () => {
        const config = await makeConfig()

        const response = await handleRequest(
            new Request("http://localhost/clip-audio", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    videoId: "jNQXAC9IVRw",
                    startSeconds: 1,
                    endSeconds: 2
                })
            }),
            config
        )

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: "source audio not found; download it first" })
    })

    test("rejects invalid clip ranges before touching ffmpeg", async () => {
        const config = await makeConfig()
        await writeFile(path.join(config.downloadDir, "jNQXAC9IVRw.mp3"), "abcdef")

        const response = await handleRequest(
            new Request("http://localhost/clip-audio", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    videoId: "jNQXAC9IVRw",
                    startSeconds: 5,
                    endSeconds: 2
                })
            }),
            config
        )

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: "invalid clip range" })
    })
})
