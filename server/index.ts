import { resolve } from "node:path"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { openDatabase } from "./db/index.ts"
import { ConfigError, loadConfig, REPO_ROOT } from "./lib/config.ts"
import { logInfo } from "./lib/log.ts"

function main() {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`TOCTOC cannot start: ${err.message}`)
      process.exit(1)
    }
    throw err
  }
  const { db } = openDatabase(resolve(config.dataDir, "toctoc.db"))
  const app = createApp(
    { db, config, now: () => new Date() },
    { distDir: process.env.NODE_ENV === "production" ? resolve(REPO_ROOT, "dist") : undefined },
  )
  serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, (info) => {
    logInfo("server_started", { address: info.address, port: info.port })
  })
}

main()
