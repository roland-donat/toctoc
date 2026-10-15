// BAN address reference loader (U3, KTD3). Reads the departmental file adresses-56.csv(.gz),
// keeps the addresses of Séné and upserts them by BAN id. Public data only: no personal data here.
import { randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { createGunzip } from "node:zlib"
import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm"
import Papa from "papaparse"
import type { AppContext } from "../context.ts"
import { addresses, imports } from "../db/schema/index.ts"
import { matchKey, normalizeRep, streetKey } from "../domain/address-normalize.ts"
import { SENE_INSEE } from "../domain/commune.ts"
import { logInfo } from "../lib/log.ts"

export const BAN_URL = "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-56.csv.gz"
const BAN_FILE_NAME = "adresses-56.csv.gz"

const REQUIRED_COLUMNS = ["id", "numero", "rep", "nom_voie", "code_postal", "code_insee", "lon", "lat", "nom_ld"] as const
type BanColumn = (typeof REQUIRED_COLUMNS)[number]

export class BanFormatError extends Error {
  override name = "BanFormatError"
  readonly missingColumns: string[]
  constructor(message: string, missingColumns: string[] = []) {
    super(message)
    this.missingColumns = missingColumns
  }
}

export class BanDownloadError extends Error {
  override name = "BanDownloadError"
}

export interface BanLoadResult {
  /** Séné rows read from the file. */
  loaded: number
  created: number
  updated: number
  /** Addresses retired by this load (absent from the new file). */
  retired: number
  /** Active (non-retired) BAN addresses after the load. */
  total: number
}

export interface BanStatus {
  total: number
  retired: number
  /** Epoch milliseconds of the latest BAN load, null when never loaded. */
  lastImportedAt: number | null
}

interface BanRow {
  id: string
  number: number | null
  rep: string | null
  streetName: string
  lieuDit: string | null
  postalCode: string | null
  lat: number
  lon: number
}

async function isGzip(path: string): Promise<boolean> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(2)
    const { bytesRead } = await handle.read(buffer, 0, 2, 0)
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
  } finally {
    await handle.close()
  }
}

function parseNumber(raw: string): number | null {
  const value = raw.trim()
  if (!/^\d+$/.test(value)) return null
  return Number.parseInt(value, 10)
}

/** Streams the file and returns the Séné rows; throws BanFormatError on a bad header, before any write. */
async function readSeneRows(path: string): Promise<{ rows: Map<string, BanRow>; skipped: number }> {
  const gzip = await isGzip(path)
  const parser = Papa.parse(Papa.NODE_STREAM_INPUT, { delimiter: ";", header: false, skipEmptyLines: true })
  const file = createReadStream(path)
  const decoded = gzip ? file.pipe(createGunzip()) : file
  if (gzip) file.on("error", (err) => decoded.destroy(err))
  decoded.setEncoding("utf8")
  const piping = pipeline(decoded, parser).then(
    () => null,
    (err: unknown) => err,
  )

  const rows = new Map<string, BanRow>()
  let skipped = 0
  let columns: Record<BanColumn, number> | null = null
  try {
    for await (const chunk of parser) {
      const cells = chunk as string[]
      if (columns === null) {
        const header = cells.map((c, i) => (i === 0 ? c.replace(/^\uFEFF/, "") : c).trim())
        const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c))
        if (missing.length > 0) {
          throw new BanFormatError(`BAN file header is invalid: missing column(s): ${missing.join(", ")}`, missing)
        }
        columns = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<BanColumn, number>
        continue
      }
      const cols = columns
      const cell = (c: BanColumn): string => (cells[cols[c]] ?? "").trim()
      if (cell("code_insee") !== SENE_INSEE) continue
      const id = cell("id")
      const lat = Number.parseFloat(cell("lat"))
      const lon = Number.parseFloat(cell("lon"))
      if (id === "" || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        skipped++
        continue
      }
      rows.set(id, {
        id,
        number: parseNumber(cell("numero")),
        rep: normalizeRep(cell("rep")),
        streetName: cell("nom_voie"),
        lieuDit: cell("nom_ld") || null,
        postalCode: cell("code_postal") || null,
        lat,
        lon,
      })
    }
  } catch (err) {
    decoded.destroy()
    await piping
    throw err
  }
  const pipeError = await piping
  if (pipeError) throw pipeError
  if (columns === null) throw new BanFormatError("BAN file is empty")
  return { rows, skipped }
}

/** Loads a BAN file (.csv or .csv.gz) into `addresses`, in one transaction. */
export async function loadBanFile(ctx: AppContext, path: string): Promise<BanLoadResult> {
  const started = Date.now()
  const { rows, skipped } = await readSeneRows(path)
  const now = ctx.now().getTime()

  const result = ctx.db.transaction((tx) => {
    const existing = new Map(
      tx
        .select({ id: addresses.id, retiredAt: addresses.retiredAt })
        .from(addresses)
        .where(eq(addresses.kind, "number"))
        .all()
        .map((r) => [r.id, r.retiredAt]),
    )
    let created = 0
    let updated = 0
    for (const row of rows.values()) {
      const values = {
        kind: "number" as const,
        number: row.number,
        rep: row.rep,
        streetName: row.streetName,
        streetKey: streetKey(row.streetName),
        lieuDit: row.lieuDit,
        postalCode: row.postalCode,
        inseeCode: SENE_INSEE,
        matchKey: matchKey(row.number, row.rep, row.streetName),
        lat: row.lat,
        lon: row.lon,
        retiredAt: null,
        updatedAt: now,
      }
      if (existing.has(row.id)) updated++
      else created++
      tx.insert(addresses)
        .values({ id: row.id, ...values })
        .onConflictDoUpdate({ target: addresses.id, set: values })
        .run()
    }
    let retired = 0
    for (const [id, retiredAt] of existing) {
      if (rows.has(id) || retiredAt !== null) continue
      tx.update(addresses).set({ retiredAt: now, updatedAt: now }).where(eq(addresses.id, id)).run()
      retired++
    }
    tx.insert(imports).values({ id: randomUUID(), kind: "ban", importedAt: now, rowCount: rows.size }).run()
    const total =
      tx
        .select({ n: count() })
        .from(addresses)
        .where(and(eq(addresses.kind, "number"), isNull(addresses.retiredAt)))
        .get()?.n ?? 0
    return { loaded: rows.size, created, updated, retired, total }
  })

  logInfo("ban_loaded", { ...result, skipped, durationMs: Date.now() - started })
  return result
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** Deadline of the whole download (headers and body): the departmental file is a few tens of MB. */
const BAN_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Downloads the public departmental BAN file into <dataDir>/sources/ and returns its path. Written to a
 * .part file renamed at the end; on any failure (status, timeout, broken stream) the .part file is removed
 * and a BanDownloadError is thrown, so the previous complete file, if any, stays in place.
 */
export async function downloadBan(
  ctx: AppContext,
  fetchFn: FetchFn = fetch,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const dir = join(ctx.config.dataDir, "sources")
  await mkdir(dir, { recursive: true })
  const target = join(dir, BAN_FILE_NAME)
  const partial = `${target}.part`
  const signal = AbortSignal.timeout(options.timeoutMs ?? BAN_DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetchFn(BAN_URL, { signal })
    if (!response.ok || response.body === null) {
      throw new BanDownloadError(`BAN download failed with status ${response.status}`)
    }
    await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(partial), { signal })
    await rename(partial, target)
    return target
  } catch (err) {
    await rm(partial, { force: true })
    if (err instanceof BanDownloadError) throw err
    throw new BanDownloadError(`BAN download failed: ${err instanceof Error ? err.name : "unknown"}`)
  }
}

export function banStatus(ctx: AppContext): BanStatus {
  const countWhere = (retired: boolean): number =>
    ctx.db
      .select({ n: count() })
      .from(addresses)
      .where(and(eq(addresses.kind, "number"), retired ? isNotNull(addresses.retiredAt) : isNull(addresses.retiredAt)))
      .get()?.n ?? 0
  const last = ctx.db
    .select({ importedAt: imports.importedAt })
    .from(imports)
    .where(eq(imports.kind, "ban"))
    .orderBy(desc(imports.importedAt))
    .limit(1)
    .get()
  return { total: countWhere(false), retired: countWhere(true), lastImportedAt: last?.importedAt ?? null }
}
