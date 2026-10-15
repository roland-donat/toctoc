// Shop fronts of the commune from OpenStreetMap (15/10/2026). The file is produced by deploy/osrm/prepare-commune.sh
// from the regional extract already used for routing, so the application never queries a third party for it.
// Public data only: no personal data here.
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm"
import { z } from "zod"
import type { AppContext } from "../context.ts"
import { addresses, commerces, imports } from "../db/schema/index.ts"
import { matchKey, splitNumber } from "../domain/address-normalize.ts"

/** Where the installation drops the file extracted for the commune. */
export function commercesFilePath(ctx: AppContext): string {
  return join(ctx.config.dataDir, "sources", "commerces-osm.json")
}

/** A shop front farther than this from every BAN number stays unattached. */
export const NEAREST_MAX_METERS = 20

const poiSchema = z.object({
  id: z.string().regex(/^[nwr]\d+$/),
  kind: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  housenumber: z.string().max(20).nullish(),
  street: z.string().max(200).nullish(),
})
const fileSchema = z.array(poiSchema).max(100_000)
export type CommercePoi = z.infer<typeof poiSchema>

export class CommercesFormatError extends Error {
  override name = "CommercesFormatError"
}

export interface CommercesLoadResult {
  total: number
  /** Attached to a BAN number. */
  attached: number
}

export interface CommercesStatus {
  total: number
  attached: number
  loadedAt: number | null
  /** The installation has dropped a file to load on the server. */
  fileAvailable: boolean
}

interface BanPoint {
  id: string
  lat: number
  lon: number
}

function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.sqrt(x * x + y * y) * 6_371_000
}

/** The BAN number a shop front stands at: its own number and street when OpenStreetMap has them, else the nearest. */
export function attachPoi(poi: CommercePoi, byKey: Map<string, string>, points: readonly BanPoint[]): string | null {
  if (poi.housenumber && poi.street) {
    const { number, rep } = splitNumber(poi.housenumber)
    const id = number === null ? undefined : byKey.get(matchKey(number, rep, poi.street))
    if (id !== undefined) return id
  }
  let best: string | null = null
  let bestDistance = NEAREST_MAX_METERS
  for (const p of points) {
    const d = distanceMeters(poi, p)
    if (d <= bestDistance) {
      best = p.id
      bestDistance = d
    }
  }
  return best
}

export function parseCommerces(text: string): CommercePoi[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CommercesFormatError("commerces file is not JSON")
  }
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) throw new CommercesFormatError("commerces file does not have the expected shape")
  return parsed.data
}

/** Replaces the shop fronts with those of the file, in one transaction. */
export function loadCommerces(ctx: AppContext, pois: readonly CommercePoi[]): CommercesLoadResult {
  const ban = ctx.db
    .select({ id: addresses.id, matchKey: addresses.matchKey, lat: addresses.lat, lon: addresses.lon })
    .from(addresses)
    .where(and(eq(addresses.kind, "number"), isNull(addresses.retiredAt)))
    .all()
  const byKey = new Map(ban.map((a) => [a.matchKey, a.id]))
  let attached = 0
  ctx.db.transaction((tx) => {
    tx.delete(commerces).run()
    for (const poi of pois) {
      const addressId = attachPoi(poi, byKey, ban)
      if (addressId !== null) attached++
      tx.insert(commerces)
        .values({ id: poi.id, kind: poi.kind, lat: poi.lat, lon: poi.lon, addressId })
        .onConflictDoNothing()
        .run()
    }
    tx.insert(imports)
      .values({ id: randomUUID(), kind: "commerces", importedAt: ctx.now().getTime(), rowCount: pois.length })
      .run()
  })
  return { total: pois.length, attached }
}

export async function loadCommercesFile(ctx: AppContext, path: string): Promise<CommercesLoadResult> {
  return loadCommerces(ctx, parseCommerces(await readFile(path, "utf-8")))
}

export function commercesStatus(ctx: AppContext): CommercesStatus {
  const total = ctx.db.select({ n: count() }).from(commerces).get()?.n ?? 0
  const attached = ctx.db.select({ n: count() }).from(commerces).where(isNotNull(commerces.addressId)).get()?.n ?? 0
  const last = ctx.db
    .select({ importedAt: imports.importedAt })
    .from(imports)
    .where(eq(imports.kind, "commerces"))
    .orderBy(desc(imports.importedAt))
    .limit(1)
    .get()
  return { total, attached, loadedAt: last?.importedAt ?? null, fileAvailable: existsSync(commercesFilePath(ctx)) }
}
