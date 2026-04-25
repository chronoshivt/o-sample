# o-sample

YouTube to MP3 clipper, built for samplers and producers. Paste a URL, trim the part you want, export a clean MP3 — no accounts, no ads, no installs.

## Getting started

You'll need:

- **Node.js** ≥ 20 — for the workspace tooling and the React/Vite client
- **Bun** ≥ 1.1 — the server runtime ([install](https://bun.sh))
- **yt-dlp** + **ffmpeg** — for the server to actually download and clip audio. Either on `PATH` or pointed at via `YT_DLP` / `FFMPEG` env vars.

Then:

```bash
git clone https://github.com/chronoshivt/o-sample.git
cd o-sample
npm install
npm run dev
```

This starts:

- the Vite dev server at <http://localhost:5173> (the UI)
- the Bun API server at <http://localhost:3847> (handles YouTube + ffmpeg)

Open the first URL in your browser.

## Layout

```
o-sample/
├── client/   # React + Vite UI (the part users see)
└── server/   # Bun HTTP server that orchestrates yt-dlp + ffmpeg
```

Workspaces are wired with `npm` workspaces — running `npm install` at the root installs both.

## Scripts

| Command          | What it does                                    |
| ---------------- | ----------------------------------------------- |
| `npm run dev`    | Run client + server in parallel for development |
| `npm run build`  | Build the client into `client/dist/`            |
| `npm test`       | Run the server test suite                       |
| `npm run preview` | Preview the production client build             |

## Server configuration

The server reads its config from environment variables. See [`server/.env.example`](./server/.env.example) for the full list. The most relevant ones:

| Variable           | Default        | Purpose                                                           |
| ------------------ | -------------- | ----------------------------------------------------------------- |
| `PORT`             | `3847`         | HTTP port                                                         |
| `DOWNLOAD_DIR`     | `./downloads`  | Where downloaded audio + clips are cached                         |
| `YT_DLP`           | `yt-dlp`       | Path to the `yt-dlp` binary (defaults to `PATH` lookup)           |
| `FFMPEG`           | `ffmpeg`       | Path to the `ffmpeg` binary                                       |
| `YT_PROXY`         | _(unset)_      | HTTP/HTTPS/SOCKS5 proxy URL (residential proxies dodge bot blocks) |
| `YT_COOKIES_FILE`  | _(unset)_      | Netscape-format cookies file for YouTube auth                     |
| `YT_PLAYER_CLIENT` | _(yt-dlp default)_ | Override yt-dlp player client (e.g. `tv_embedded`, `ios`)     |

Cookies and proxies compose — use both for maximum reliability against YouTube's anti-bot checks.

## Self-hosting with Docker

A production `Dockerfile` lives in [`server/`](./server/Dockerfile). It pins `yt-dlp` and `ffmpeg` to known paths and exposes the API on `:3847`. Build and run:

```bash
docker build -t o-sample-server -f server/Dockerfile server/
docker run -p 3847:3847 o-sample-server
```

The client is served separately — build it (`npm run build`) and host `client/dist/` on any static host (Netlify, Cloudflare Pages, etc.). Point the client at your server with the `VITE_SAMPLE_SERVER_ORIGIN` build-time env var.

## License

[MIT](./LICENSE)

## Disclaimer

This tool is for personal, fair-use clipping (e.g. sampling for music production). Respect YouTube's Terms of Service and the rights of content creators. The maintainers are not responsible for misuse.
