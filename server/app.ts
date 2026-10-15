import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import type { AppContext } from "./context.ts"
import { accessControl } from "./lib/auth.ts"
import { logError } from "./lib/log.ts"
import { securityHeaders } from "./lib/security-headers.ts"
import { serveSpa } from "./lib/static.ts"
import { adressesRoutes } from "./routes/adresses.ts"
import { antisechesRoutes } from "./routes/antiseches.ts"
import { authRoutes } from "./routes/auth.ts"
import { carteRoutes } from "./routes/carte.ts"
import { importRoutes } from "./routes/imports.ts"
import { itinerairesRoutes } from "./routes/itineraires.ts"
import { parametresRoutes } from "./routes/parametres.ts"
import { retoursRoutes } from "./routes/retours.ts"
import { statsRoutes } from "./routes/stats.ts"
import { terrainRoutes } from "./routes/terrain.ts"

/** Login and field feedback: a few kilobytes at most. */
const PUBLIC_BODY_MAX = 64 * 1024
/** Any other JSON body (a paper re-entry of 500 rows is about 1.3 MB). */
const JSON_BODY_MAX = 4 * 1024 * 1024
/** Uploaded electoral list or emargement (about 2 MB for a commune of 10,000 electors). */
export const IMPORT_BODY_MAX = 25 * 1024 * 1024

export interface CreateAppOptions {
  /** Built SPA directory; omitted in API-only tests. */
  distDir?: string
}

export function createApp(ctx: AppContext, options: CreateAppOptions = {}) {
  const app = new Hono()

  app.use("*", securityHeaders())

  // Request bodies are capped before anything reads them, so no request can exhaust the memory (the public login
  // and field routes most of all). Caddy caps them too, at the import size.
  const limit = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json({ error: "body_too_large" }, 413) })
  app.use("/api/auth/*", limit(PUBLIC_BODY_MAX))
  app.use("/api/terrain/*", limit(PUBLIC_BODY_MAX))
  app.use("/api/imports/*", limit(IMPORT_BODY_MAX))
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/imports/")) return next()
    return limit(JSON_BODY_MAX)(c, next)
  })

  // Default deny: Origin and media type on mutations, then a session on every non-public API route (KTD5).
  app.use("/api/*", accessControl(ctx))

  app.get("/api/health", (c) => c.json({ ok: true }))
  app.route("/api/auth", authRoutes(ctx))
  app.route("/api/imports", importRoutes(ctx))
  app.route("/api/antiseches", antisechesRoutes(ctx))
  app.route("/api/retours", retoursRoutes(ctx))
  app.route("/api/carte", carteRoutes(ctx))
  app.route("/api/adresses", adressesRoutes(ctx))
  app.route("/api/parametres", parametresRoutes(ctx))
  app.route("/api/stats", statsRoutes(ctx))
  app.route("/api/itineraires", itinerairesRoutes(ctx))
  // Field space: no session, every route guarded by the itinerary token (KTD6).
  app.route("/api/terrain", terrainRoutes(ctx))

  // Unknown API routes answer JSON, never the SPA shell.
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    logError("unhandled_error", err, { method: c.req.method, route: c.req.routePath })
    return c.json({ error: "internal_error" }, 500)
  })

  if (options.distDir) serveSpa(app, options.distDir)

  return app
}
