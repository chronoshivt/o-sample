import { defaultConfig, startServer } from "./app"

startServer(defaultConfig)
console.log(`y-sample server listening on :${defaultConfig.port}`)
const proxyLabel = defaultConfig.proxy ? defaultConfig.proxy.replace(/\/\/[^@]+@/, "//***@") : "(none)"
console.log(`y-sample config: ytDlp=${defaultConfig.ytDlp} ffmpeg=${defaultConfig.ffmpeg} downloadDir=${defaultConfig.downloadDir} proxy=${proxyLabel} cookies=${defaultConfig.cookiesFile ?? "(none)"} playerClient=${defaultConfig.playerClient ?? "(default)"}`)
