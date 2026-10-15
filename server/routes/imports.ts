import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Hono, type Context } from "hono"
import { z } from "zod"
import {
  CommercesFormatError,
  commercesFilePath,
  commercesStatus,
  loadCommerces,
  loadCommercesFile,
  parseCommerces,
} from "../services/commerces-loader.ts"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import { addresses, registrations } from "../db/schema/index.ts"
import { normalizeStreet } from "../domain/address-normalize.ts"
import { logError } from "../lib/log.ts"
import {
  BanDownloadError,
  BanFormatError,
  banStatus,
  downloadBan,
  loadBanFile,
  type FetchFn,
} from "../services/ban-loader.ts"
import { addressLabel, currentListSummary, currentQueue } from "../services/current-list.ts"
import {
  commitEmargementImport,
  decideRowException,
  EmargementImportError,
  emargementStatus,
  listRowExceptions,
  listUnknownElectors,
  prepareEmargementImport,
  setRoundValue,
  type EmargementErrorCode,
  type PendingEmargementImport,
} from "../services/emargement-import.ts"
import type { GeocodeFetch } from "../services/geocode-fallback.ts"
import { PendingImports, type PendingImport } from "../services/pending-imports.ts"
import { commitRepImport, prepareRepImport, RepFormatError, type PendingRepImport } from "../services/rep-import.ts"

export interface ImportRoutesDeps {
  /** Injected in tests; defaults to the global fetch. Only used for the public BAN file. */
  fetch?: FetchFn
  /** Injected in tests; defaults to the global fetch. Géoplateforme address fallback (address fields only). */
  geocodeFetch?: GeocodeFetch
  /** Injected in tests to skip the fallback retry delays. */
  geocodeSleep?: (ms: number) => Promise<void>
}

const attachSchema = z.object({ addressId: z.string().min(1) })
const decisionSchema = z.object({ decision: z.enum(["accepted", "rejected"]) })
const roundValueSchema = z.object({ value: z.enum(["oui", "non", "illisible"]) })

const EMARGEMENT_ERROR_STATUS: Record<EmargementErrorCode, 400 | 404 | 409> = {
  emargement_invalid_header: 400,
  emargement_empty: 400,
  no_current_list: 409,
  reference_list_replaced: 409,
  exception_not_found: 404,
  exception_already_resolved: 409,
  exception_without_candidate: 409,
  elector_not_found: 404,
}

/** The multipart "file" field of an upload, or null when it is absent or not a file. */
async function readUpload(c: Context): Promise<File | null> {
  const file = (await c.req.parseBody())["file"]
  return file instanceof File ? file : null
}

/** Confirms the pending simulation named in the path, then forgets it (its file now belongs to the import). */
function confirmPending<T extends PendingImport, R extends object>(store: PendingImports<T>, commit: (pending: T) => R) {
  return (c: Context) => {
    const pending = store.get(c.req.param("pendingId") ?? "")
    if (pending === null) return c.json({ error: "pending_import_not_found" }, 404)
    const result = commit(pending)
    store.forget(pending.id)
    return c.json(result)
  }
}

/** Maximum number of addresses returned by the queue search. */
const ADDRESS_SEARCH_LIMIT = 50

/**
 * Admin import routes (the auth middleware is applied globally). BAN part: U3. Electoral list and
 * manual matching queue: U4. Emargement, address search and exceptions: U5. The pending simulations
 * live in memory, in this router instance.
 */
export function importRoutes(ctx: AppContext, deps: ImportRoutesDeps = {}): Hono {
  const app = new Hono()
  const fetchFn = deps.fetch ?? fetch
  const geocode = { fetch: deps.geocodeFetch ?? fetch, ...(deps.geocodeSleep ? { sleep: deps.geocodeSleep } : {}) }
  const pendingRep = new PendingImports<PendingRepImport>()
  const pendingEmargement = new PendingImports<PendingEmargementImport>()

  app.onError((err, c) => {
    if (err instanceof BanFormatError) {
      return c.json({ error: "ban_invalid_header", missingColumns: err.missingColumns }, 400)
    }
    if (err instanceof RepFormatError) {
      return c.json({ error: err.code, missingColumns: err.missingColumns, line: err.line }, 400)
    }
    if (err instanceof EmargementImportError) {
      const body = err.code === "emargement_invalid_header" ? { error: err.code, missingColumns: err.missingColumns } : { error: err.code }
      return c.json(body, EMARGEMENT_ERROR_STATUS[err.code])
    }
    if (err instanceof CommercesFormatError) return c.json({ error: "commerces_invalid_file" }, 400)
    if (err instanceof BanDownloadError) {
      logError("ban_download_failed", err)
      return c.json({ error: "ban_download_failed" }, 502)
    }
    throw err
  })

  app.post("/ban", async (c) => {
    const file = await readUpload(c)
    if (file === null) return c.json({ error: "file_required" }, 400)
    const dir = join(ctx.config.dataDir, "sources")
    await mkdir(dir, { recursive: true })
    const path = join(dir, `ban-upload-${randomUUID()}.tmp`)
    await writeFile(path, Buffer.from(await file.arrayBuffer()))
    try {
      return c.json(await loadBanFile(ctx, path))
    } finally {
      await rm(path, { force: true })
    }
  })

  app.post("/ban/download", async (c) => {
    const path = await downloadBan(ctx, fetchFn)
    return c.json(await loadBanFile(ctx, path))
  })

  app.get("/ban/status", (c) => c.json(banStatus(ctx)))

  // Shop fronts from OpenStreetMap: the file the installation dropped on the server, or one uploaded.
  app.post("/commerces/load", async (c) => {
    const path = commercesFilePath(ctx)
    if (!existsSync(path)) return c.json({ error: "commerces_file_missing" }, 404)
    return c.json(await loadCommercesFile(ctx, path))
  })

  app.post("/commerces", async (c) => {
    const file = await readUpload(c)
    if (file === null) return c.json({ error: "file_required" }, 400)
    return c.json(loadCommerces(ctx, parseCommerces(await file.text())))
  })

  app.get("/commerces/status", (c) => c.json(commercesStatus(ctx)))

  app.post("/rep", async (c) => {
    const file = await readUpload(c)
    if (file === null) return c.json({ error: "file_required" }, 400)
    const pending = await prepareRepImport(ctx, Buffer.from(await file.arrayBuffer()), geocode)
    await pendingRep.put(pending)
    return c.json(pending.simulation)
  })

  app.post("/rep/:pendingId/confirm", confirmPending(pendingRep, (pending) => commitRepImport(ctx, pending)))

  app.get("/rep/status", (c) => c.json({ current: currentListSummary(ctx.db) }))

  app.get("/queue", (c) => c.json({ items: currentQueue(ctx.db) }))

  app.patch("/queue/:registrationId", async (c) => {
    const parsed = attachSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const id = c.req.param("registrationId")
    const registration = ctx.db.select({ id: registrations.id }).from(registrations).where(eq(registrations.id, id)).get()
    if (!registration) return c.json({ error: "registration_not_found" }, 404)
    const address = ctx.db
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(eq(addresses.id, parsed.data.addressId), isNull(addresses.retiredAt)))
      .get()
    if (!address) return c.json({ error: "unknown_address" }, 400)
    ctx.db.update(registrations).set({ addressId: address.id, matchStatus: "manual" }).where(eq(registrations.id, id)).run()
    return c.json({ id, addressId: address.id, matchStatus: "manual" as const })
  })

  // Address search for the manual queue (U5): every word of `q` must start a word of the address label,
  // so the raw street of a queued registration lists the addresses of that street.
  app.get("/addresses", (c) => {
    const words = normalizeStreet(c.req.query("q") ?? "")
      .split(" ")
      .filter((w) => w !== "")
    if (words.length === 0) return c.json({ items: [] })
    const items = ctx.db
      .select({ id: addresses.id, number: addresses.number, rep: addresses.rep, streetName: addresses.streetName })
      .from(addresses)
      .where(isNull(addresses.retiredAt))
      .orderBy(asc(addresses.streetName), asc(addresses.number), asc(addresses.rep))
      .all()
      .map((a) => ({ id: a.id, label: addressLabel(a) }))
      .filter((a) => {
        const labelWords = normalizeStreet(a.label).split(" ")
        return words.every((w) => labelWords.some((l) => l.startsWith(w)))
      })
      .slice(0, ADDRESS_SEARCH_LIMIT)
    return c.json({ items })
  })

  app.post("/emargement", async (c) => {
    const file = await readUpload(c)
    if (file === null) return c.json({ error: "file_required" }, 400)
    const pending = await prepareEmargementImport(ctx, Buffer.from(await file.arrayBuffer()))
    await pendingEmargement.put(pending)
    return c.json(pending.simulation)
  })

  app.post("/emargement/:pendingId/confirm", confirmPending(pendingEmargement, (pending) => commitEmargementImport(ctx, pending)))

  app.get("/emargement/status", (c) => c.json({ current: emargementStatus(ctx.db) }))

  app.get("/exceptions/rows", (c) => c.json(listRowExceptions(ctx.db)))

  app.patch("/exceptions/rows/:id", async (c) => {
    const parsed = decisionSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    return c.json(decideRowException(ctx, c.req.param("id"), parsed.data.decision))
  })

  app.get("/exceptions/unknown", (c) => c.json(listUnknownElectors(ctx.db)))

  app.put("/exceptions/unknown/:electorId/rounds/:round", async (c) => {
    const round = c.req.param("round")
    if (round !== "1" && round !== "2") return c.json({ error: "invalid_round" }, 400)
    const parsed = roundValueSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    return c.json(setRoundValue(ctx, c.req.param("electorId"), round === "1" ? 1 : 2, parsed.data.value))
  })

  return app
}
