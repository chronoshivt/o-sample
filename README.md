# o-sample

YouTube to MP3 clipper, built for samplers and producers. Paste a URL, trim the part you want, export a clean MP3 — no accounts, no ads, no installs.

## I just want to use it

Build a standalone executable for your machine. The exe bundles everything (yt-dlp, ffmpeg, the UI, the server) so it runs with zero other installs.

You need **Node.js ≥ 20** and **Bun ≥ 1.1** ([install Bun](https://bun.sh)).

```bash
git clone https://github.com/chronoshivt/o-sample.git
cd o-sample
npm install
npm run build:exe
./dist/o-sample        # macOS / Linux
.\dist\o-sample.exe    # Windows
```

The exe will start a local server, open your browser, and that's it. The first run extracts the bundled yt-dlp + ffmpeg into `~/.o-sample/bin/` (subsequent runs are instant). If you already have yt-dlp installed on your `PATH`, the exe prefers that one — useful for keeping yt-dlp current as YouTube tweaks its anti-bot checks.

The exe is built only for your platform; if you want one for a different OS, run `npm run build:exe` on that OS.

## I want to hack on it

```bash
git clone https://github.com/chronoshivt/o-sample.git
cd o-sample
npm install
npm run dev
```

That's it. The first run auto-downloads `yt-dlp` and `ffmpeg` into `vendor/` if they're not already on your `PATH` (~80 MB, one-time, cached). If you'd rather use system installs, `brew install yt-dlp ffmpeg` (or your platform's equivalent) before `npm run dev` and the server will pick those up instead.

`npm run dev` starts:

- the Vite dev server at <http://localhost:5173> (the UI you'll edit)
- the Bun API server at <http://localhost:3847> (handles YouTube + ffmpeg)

## I want to self-host

A production `Dockerfile` lives in [`server/`](./server/Dockerfile). It pins yt-dlp + ffmpeg to known paths and exposes the API on port 3847:

```bash
docker build -t o-sample-server -f server/Dockerfile server/
docker run -p 3847:3847 o-sample-server
```

The client is served separately — build it with `npm run build` and host `client/dist/` on any static host (Netlify, Cloudflare Pages, etc.). Point the client at your server with the `VITE_SAMPLE_SERVER_ORIGIN` build-time env var.

## Layout

```
o-sample/
├── client/   # React + Vite UI (the part users see)
├── server/   # Bun HTTP server + yt-dlp/ffmpeg orchestration
└── scripts/  # build-exe.ts (vite build → bundle binaries → bun --compile)
```

## Scripts

| Command              | What it does                                     |
| -------------------- | ------------------------------------------------ |
| `npm run dev`        | Run client + server in parallel for development  |
| `npm run build`      | Build the client into `client/dist/`             |
| `npm run build:exe`  | Build a standalone exe for your platform         |
| `npm test`           | Run the server test suite                        |
| `npm run preview`    | Preview the production client build              |

## Server configuration

The server reads its config from environment variables. See [`server/.env.example`](./server/.env.example) for the full list.

| Variable           | Default               | Purpose                                                    |
| ------------------ | --------------------- | ---------------------------------------------------------- |
| `PORT`             | `3847`                | HTTP port                                                  |
| `DOWNLOAD_DIR`     | `./downloads`         | Where downloaded audio + clips are cached                  |
| `YT_DLP`           | `yt-dlp`              | Path to the `yt-dlp` binary (defaults to `PATH` lookup)    |
| `FFMPEG`           | `ffmpeg`              | Path to the `ffmpeg` binary                                |
| `YT_PROXY`         | _(unset)_             | HTTP/HTTPS/SOCKS5 proxy URL                                |
| `YT_COOKIES_FILE`  | _(unset)_             | Netscape-format cookies file for YouTube auth              |
| `YT_PLAYER_CLIENT` | _(yt-dlp default)_    | Override yt-dlp player client (e.g. `tv_embedded`)         |

## Notes for contributors

- `server/embedded-assets.gen.ts` and `server/vendored-binaries.gen.ts` are committed as empty stubs and overwritten by `npm run build:exe`. After a build, `git status` shows them modified — that's expected, just `git checkout server/*.gen.ts` to reset before committing other changes.
- `vendor/` is the cache directory for downloaded yt-dlp + ffmpeg binaries. Gitignored. Delete it to force a fresh download on the next build.

## License

[MIT](./LICENSE)

## Disclaimer

This tool is for personal, fair-use clipping (e.g. sampling for music production). Respect YouTube's Terms of Service and the rights of content creators. The maintainers are not responsible for misuse.
