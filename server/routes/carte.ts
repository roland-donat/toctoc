// Map of every door of Séné (R7, R8): aggregated per address and filtered on the server (KTD14).
// No filter on names, ever (CNIL); the birthplace is only usable through the KTD9 groups.
import { and, eq, isNotNull, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context.ts"
import { AGE_BANDS, type AgeBand } from "../db/schema/cheatsheets.ts"
import { addresses, electors, registrations } from "../db/schema/index.ts"
import { ageAt, ageBand } from "../domain/age.ts"
import { BIRTH_PLACE_GROUPS, birthPlaceGroup, type BirthPlaceGroup } from "../domain/birth-place.ts"
import { CATEGORIES, FOLLOW_UPS, type Category, type FollowUp } from "../domain/qualification.ts"
import type { VoterLevel } from "../domain/voter-level.ts"
import { computeAddressStatuses } from "../services/address-status.ts"
import { banStatus } from "../services/ban-loader.ts"
import { addressLabel, currentEmargementImport, currentRepImportId } from "../services/current-list.ts"
import { loadCurrentVoterLevels } from "../services/voter-levels.ts"

const single = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(1).optional()
const multi = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(10).optional()

/** URL filters of R8. Unknown keys are refused, so a name can never become a filter. */
const carteFiltersSchema = z
  .object({
    bureau: single(z.string().min(1).max(10)),
    category: multi(z.enum(CATEGORIES)),
    ageBand: multi(z.enum(AGE_BANDS)),
    sex: single(z.enum(["F", "M"])),
    birthPlace: single(z.enum(BIRTH_PLACE_GROUPS)),
    street: single(z.string().min(1).max(200)),
    followUp: multi(z.enum(FOLLOW_UPS)),
  })
  .strict()
  .transform((q) => ({
    bureau: q.bureau?.[0] ?? null,
    categories: q.category ?? [],
    ageBands: q.ageBand ?? [],
    sex: q.sex?.[0] ?? null,
    birthPlace: q.birthPlace?.[0] ?? null,
    street: q.street?.[0] ?? null,
    followUps: q.followUp ?? [],
  }))

export type CarteFilters = z.output<typeof carteFiltersSchema>

export interface MapAddress {
  id: string
  lat: number
  lon: number
  label: string
  category: Category
  followUp: FollowUp
  registeredCount: number
  counts: Record<VoterLevel, number>
  ageBands: AgeBand[]
}

export interface MapResponse {
  addresses: MapAddress[]
  totals: { doors: number; electors: number }
}

interface ElectorFacts {
  bureau: string
  sex: "F" | "M" | null
  band: AgeBand | null
  birthPlace: BirthPlaceGroup
}

/** Distinct electors of the current list per address, with the dimensions the filters use. */
function electorsByAddress(ctx: AppContext): Map<string, Map<string, ElectorFacts>> {
  const out = new Map<string, Map<string, ElectorFacts>>()
  const importId = currentRepImportId(ctx.db)
  if (importId === null) return out
  const levels = loadCurrentVoterLevels(ctx.db)
  const now = ctx.now()
  const rows = ctx.db
    .select({
      electorId: registrations.electorId,
      addressId: registrations.addressId,
      bureau: registrations.bureau,
      sex: electors.sex,
      birthDate: electors.birthDate,
      birthCommuneCode: electors.birthCommuneCode,
      birthDepartment: electors.birthDepartment,
      birthCountry: electors.birthCountry,
    })
    .from(registrations)
    .innerJoin(electors, eq(electors.id, registrations.electorId))
    .where(and(eq(registrations.importId, importId), isNotNull(registrations.addressId)))
    .all()
  for (const r of rows) {
    if (r.addressId === null) continue
    let byElector = out.get(r.addressId)
    if (!byElector) {
      byElector = new Map()
      out.set(r.addressId, byElector)
    }
    if (byElector.has(r.electorId)) continue
    // Same rule as the address summary: complementary-list electors have no target age band.
    const level = levels.get(r.electorId) ?? "inconnu"
    byElector.set(r.electorId, {
      bureau: r.bureau,
      sex: r.sex,
      band: level === "hors_cible" ? null : ageBand(ageAt(r.birthDate, now)),
      birthPlace: birthPlaceGroup(r),
    })
  }
  return out
}

function hasElectorFilter(f: CarteFilters): boolean {
  return f.bureau !== null || f.ageBands.length > 0 || f.sex !== null || f.birthPlace !== null
}

function electorMatches(e: ElectorFacts, f: CarteFilters): boolean {
  if (f.bureau !== null && e.bureau !== f.bureau) return false
  if (f.ageBands.length > 0 && (e.band === null || !f.ageBands.includes(e.band))) return false
  if (f.sex !== null && e.sex !== f.sex) return false
  if (f.birthPlace !== null && e.birthPlace !== f.birthPlace) return false
  return true
}

function buildMap(ctx: AppContext, filters: CarteFilters): MapResponse {
  const statuses = computeAddressStatuses(ctx)
  const places = new Map(
    ctx.db
      .select({
        id: addresses.id,
        number: addresses.number,
        rep: addresses.rep,
        streetName: addresses.streetName,
        streetKey: addresses.streetKey,
        lat: addresses.lat,
        lon: addresses.lon,
      })
      .from(addresses)
      .where(isNull(addresses.retiredAt))
      .all()
      .map((a) => [a.id, a]),
  )
  const byElector = hasElectorFilter(filters) ? electorsByAddress(ctx) : null

  const result: MapAddress[] = []
  let electorCount = 0
  for (const s of statuses) {
    const place = places.get(s.addressId)
    if (!place) continue
    if (filters.categories.length > 0 && !filters.categories.includes(s.category)) continue
    if (filters.followUps.length > 0 && !filters.followUps.includes(s.followUp)) continue
    if (filters.street !== null && place.streetKey !== filters.street) continue
    let matching = s.registeredCount
    if (byElector !== null) {
      matching = [...(byElector.get(s.addressId)?.values() ?? [])].filter((e) => electorMatches(e, filters)).length
      if (matching === 0) continue
    }
    electorCount += matching
    result.push({
      id: s.addressId,
      lat: place.lat,
      lon: place.lon,
      label: addressLabel(place),
      category: s.category,
      followUp: s.followUp,
      registeredCount: s.registeredCount,
      counts: s.counts,
      ageBands: s.ageBands,
    })
  }
  return { addresses: result, totals: { doors: result.length, electors: electorCount } }
}

export interface MapOptions {
  /** Import steps done, in the order the map needs them. */
  setup: { ban: boolean; liste: boolean; emargement: boolean }
  bureaus: string[]
  streets: { key: string; name: string }[]
}

function mapOptions(ctx: AppContext): MapOptions {
  const { db } = ctx
  const importId = currentRepImportId(db)
  const bureaus =
    importId === null
      ? []
      : db
          .selectDistinct({ bureau: registrations.bureau })
          .from(registrations)
          .where(eq(registrations.importId, importId))
          .all()
          .map((r) => r.bureau)
          .sort()
  const streets = new Map<string, string>()
  for (const a of db
    .select({ key: addresses.streetKey, name: addresses.streetName })
    .from(addresses)
    .where(isNull(addresses.retiredAt))
    .all()) {
    if (!streets.has(a.key)) streets.set(a.key, a.name)
  }
  return {
    setup: { ban: banStatus(ctx).total > 0, liste: importId !== null, emargement: currentEmargementImport(db) !== null },
    bureaus,
    streets: [...streets].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name, "fr")),
  }
}

/** Mounted at /api/carte. */
export function carteRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const parsed = carteFiltersSchema.safeParse(c.req.queries())
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400)
    return c.json(buildMap(ctx, parsed.data))
  })

  app.get("/options", (c) => c.json(mapOptions(ctx)))

  return app
}
