// Doors of an itinerary as handed to the canvassers, shared by the field link (U12) and the printed sheet (U13)
// so both apply the same name rule (KTD7) and never carry a birthplace (R25).
import { and, asc, eq, inArray } from "drizzle-orm"
import type { AppContext } from "../context.ts"
import type { AgeBand, CheatsheetBand } from "../db/schema/cheatsheets.ts"
import { addresses, cheatsheets, electors, itineraryDoors, registrations, visits } from "../db/schema/index.ts"
import { cheatsheetsForDoor } from "../domain/cheatsheet-select.ts"
import { computeAddressStatuses } from "./address-status.ts"
import { addressLabel, currentRepImportId } from "./current-list.ts"
import { loadCurrentVoterLevels } from "./voter-levels.ts"

export interface DoorVoter {
  birthName: string | null
  usageName: string | null
  firstNames: string | null
}

export interface DoorCheatsheet {
  id: string
  ageBand: CheatsheetBand
  title: string
  body: string
}

/** Last passage at a door: date and outcome only, never the dwelling nor the remarks (KTD7). */
export interface DoorPassage {
  visitDate: string
  contact: "obtenu" | "absent" | null
  toRevisit: boolean
  toAccompany: boolean
  qualification: "non_habitation" | "logement_vide" | "residence_secondaire" | null
}

export interface CanvassDoor {
  addressId: string
  position: number
  label: string
  lat: number
  lon: number
  dwellings: number | null
  /** Age bands of the targeted voters (hors cible excluded). */
  ageBands: AgeBand[]
  cheatsheets: DoorCheatsheet[]
  lastPassage: DoorPassage | null
  /** Time of the latest feedback recorded on the door, any source; null when none. */
  lastRecordedAt: number | null
  /** Names of the targeted voters, empty unless `namesAllowed` was true. */
  voters: DoorVoter[]
}

const BAND_ORDER: Record<CheatsheetBand, number> = { "18-25": 0, "26-40": 1, "41-60": 2, "61+": 3, generale: 4 }

type CheatsheetRow = typeof cheatsheets.$inferSelect

/** Cheat sheet order: age band, then position, then last update. */
export function compareCheatsheets(a: CheatsheetRow, b: CheatsheetRow): number {
  return BAND_ORDER[a.ageBand] - BAND_ORDER[b.ageBand] || a.position - b.position || a.updatedAt - b.updatedAt
}

/** Every cheat sheet, in age band then position order. */
export function orderedCheatsheets(ctx: AppContext): DoorCheatsheet[] {
  return ctx.db
    .select()
    .from(cheatsheets)
    .all()
    .sort(compareCheatsheets)
    .map((s) => ({ id: s.id, ageBand: s.ageBand, title: s.title, body: s.body }))
}

/** Names of the targeted voters of each address (never the birthplace, never the hors cible electors). */
function votersByAddress(ctx: AppContext, ids: readonly string[]): Map<string, DoorVoter[]> {
  const out = new Map<string, DoorVoter[]>()
  const importId = currentRepImportId(ctx.db)
  if (importId === null || ids.length === 0) return out
  const levels = loadCurrentVoterLevels(ctx.db)
  const rows = ctx.db
    .select({
      electorId: registrations.electorId,
      addressId: registrations.addressId,
      birthName: electors.birthName,
      usageName: electors.usageName,
      firstNames: electors.firstNames,
    })
    .from(registrations)
    .innerJoin(electors, eq(electors.id, registrations.electorId))
    .where(and(eq(registrations.importId, importId), inArray(registrations.addressId, [...ids])))
    .orderBy(asc(registrations.bureau), asc(registrations.orderNumber))
    .all()
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.addressId === null || seen.has(r.electorId)) continue
    seen.add(r.electorId)
    if ((levels.get(r.electorId) ?? "inconnu") === "hors_cible") continue
    const list = out.get(r.addressId) ?? []
    list.push({ birthName: r.birthName, usageName: r.usageName, firstNames: r.firstNames })
    out.set(r.addressId, list)
  }
  return out
}

/** Ordered doors of an itinerary. Callers still pass the result through `anonymize` as a second guard. */
export function canvassDoors(ctx: AppContext, itineraryId: string, options: { namesAllowed: boolean }): CanvassDoor[] {
  const doors = ctx.db
    .select({
      addressId: itineraryDoors.addressId,
      position: itineraryDoors.position,
      number: addresses.number,
      rep: addresses.rep,
      streetName: addresses.streetName,
      lat: addresses.lat,
      lon: addresses.lon,
    })
    .from(itineraryDoors)
    .innerJoin(addresses, eq(addresses.id, itineraryDoors.addressId))
    .where(eq(itineraryDoors.itineraryId, itineraryId))
    .orderBy(asc(itineraryDoors.position))
    .all()
  const ids = doors.map((d) => d.addressId)
  const statuses = new Map(computeAddressStatuses(ctx, { addressIds: ids }).map((s) => [s.addressId, s]))
  const sheets = orderedCheatsheets(ctx)

  const last = new Map<string, typeof visits.$inferSelect>()
  const latestRecorded = new Map<string, number>()
  if (ids.length > 0) {
    for (const v of ctx.db.select().from(visits).where(inArray(visits.addressId, ids)).all()) {
      if (v.qualification === "annulation") continue
      latestRecorded.set(v.addressId, Math.max(latestRecorded.get(v.addressId) ?? 0, v.recordedAt))
      const current = last.get(v.addressId)
      if (!current || v.visitDate > current.visitDate || (v.visitDate === current.visitDate && v.recordedAt > current.recordedAt)) {
        last.set(v.addressId, v)
      }
    }
  }
  const voters = options.namesAllowed ? votersByAddress(ctx, ids) : new Map<string, DoorVoter[]>()

  return doors.map((d) => {
    const status = statuses.get(d.addressId)
    const bands = status?.ageBands ?? []
    const p = last.get(d.addressId)
    return {
      addressId: d.addressId,
      position: d.position,
      label: addressLabel(d),
      lat: d.lat,
      lon: d.lon,
      dwellings: status?.dwellings ?? null,
      ageBands: bands,
      cheatsheets: cheatsheetsForDoor(bands, sheets),
      lastPassage: p
        ? {
            visitDate: p.visitDate,
            contact: p.contact,
            toRevisit: p.toRevisit,
            toAccompany: p.toAccompany,
            qualification: p.qualification === "annulation" ? null : p.qualification,
          }
        : null,
      lastRecordedAt: latestRecorded.get(d.addressId) ?? null,
      voters: voters.get(d.addressId) ?? [],
    }
  })
}
