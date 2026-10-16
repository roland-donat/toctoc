import { resolve } from "node:path"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { openDatabase } from "./db/index.ts"
import { ConfigError, loadConfig, REPO_ROOT } from "./lib/config.ts"
import { logError, logInfo } from "./lib/log.ts"
import { loadCommercesIfNewer } from "./services/commerces-loader.ts"
import { syncListUnits } from "./services/dwelling-units.ts"
import { recheckFallbackProposals } from "./services/rep-import.ts"

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
  // Dwellings of the list in force, for a base imported before they existed; idempotent.
  const startup = { db, config, now: () => new Date() }
  // The queue against the current fallback check, for a list imported under a stricter one; idempotent.
  const attached = recheckFallbackProposals(startup)
  if (attached > 0) logInfo("fallback_proposals_attached", { registrations: attached })
  syncListUnits(startup)
  // Shop fronts extracted by the installation: loaded when the file is newer than the last load.
  void loadCommercesIfNewer(startup).then(
    (r) => r && logInfo("commerces_loaded", { total: r.total, attached: r.attached }),
    (err: unknown) => logError("commerces_load_failed", err),
  )
  const app = createApp(
    { db, config, now: () => new Date() },
    { distDir: process.env.NODE_ENV === "production" ? resolve(REPO_ROOT, "dist") : undefined },
  )
  serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, (info) => {
    logInfo("server_started", { address: info.address, port: info.port })
  })
}

main()
