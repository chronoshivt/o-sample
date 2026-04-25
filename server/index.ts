import { defaultConfig, startServer } from "./app"
import { ensureBinariesAvailable } from "./bootstrap"

const resolved = await ensureBinariesAvailable(defaultConfig)
const config = {
  ...defaultConfig,
  ytDlp: resolved.ytDlp,
  ffmpeg: resolved.ffmpeg,
}

startServer(config)
console.log(`o-sample server listening on :${config.port}`)
const proxyLabel = config.proxy
  ? config.proxy.replace(/\/\/[^@]+@/, "//***@")
  : "(none)"
console.log(
  `o-sample config: ytDlp=${config.ytDlp} ffmpeg=${config.ffmpeg}` +
  ` downloadDir=${config.downloadDir} proxy=${proxyLabel}` +
  ` cookies=${config.cookiesFile ?? "(none)"}` +
  ` playerClient=${config.playerClient ?? "(default)"}`
)
