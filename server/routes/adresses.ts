// Address sheet (R9): registered voters of the current list, dwellings, dated feedback history.
// Names and feedback free texts go through `anonymize` (KTD7); the birthplace is never served here.
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import { addresses, electors, registrations, voteHistory } from "../db/schema/index.ts"
import type { AgeBand } from "../db/schema/cheatsheets.ts"
import { ageAt, ageBand } from "../domain/age.ts"
import { anonymize, namesAllowed } from "../domain/anonymize.ts"
import { activeExclusion, type Category, type ExclusionQualification, type FollowUp } from "../domain/qualification.ts"
import { EMARGEMENT_ELECTION, type ListType, type VoteValue, type VoterLevel } from "../domain/voter-level.ts"
import { computeAddressStatuses } from "../services/address-status.ts"
import { addressLabel, currentRepImportId } from "../services/current-list.ts"
import { loadCurrentVoterLevels } from "../services/voter-levels.ts"
import { listVisits, type Visit } from "../services/visits.ts"

export interface SheetVoter {
  electorId: string
  birthName: string | null
  usageName: string | null
  firstNames: string | null
  age: number | null
  ageBand: AgeBand | null
  sex: "F" | "M" | null
  level: VoterLevel
  bureau: string
  listTypes: ListType[]
  votes: { t1: VoteValue | null; t2: VoteValue | null }
}

export interface AddressSheet {
  id: string
  label: string
  kind: "number" | "street"
  category: Category
  followUp: FollowUp
  lastVisit: string | null
  dwellings: number | null
  /** Qualification excluding the address (R5), which the administrator may cancel; null otherwise. */
  exclusion: ExclusionQualification | null
  voters: SheetVoter[]
  visits: Visit[]
}

function sheetVoters(ctx: AppContext, addressId: string): SheetVoter[] {
  const importId = currentRepImportId(ctx.db)
  if (importId === null) return []
  const rows = ctx.db
    .select({
      electorId: registrations.electorId,
      bureau: registrations.bureau,
      orderNumber: registrations.orderNumber,
      listType: registrations.listType,
      birthName: electors.birthName,
      usageName: electors.usageName,
      firstNames: electors.firstNames,
      sex: electors.sex,
      birthDate: electors.birthDate,
    })
    .from(registrations)
    .innerJoin(electors, eq(electors.id, registrations.electorId))
    .where(and(eq(registrations.importId, importId), eq(registrations.addressId, addressId)))
    .orderBy(registrations.bureau, registrations.orderNumber)
    .all()
  if (rows.length === 0) return []

  const levels = loadCurrentVoterLevels(ctx.db)
  const votes = new Map<string, { t1: VoteValue | null; t2: VoteValue | null }>()
  for (const v of ctx.db
    .select({ electorId: voteHistory.electorId, round: voteHistory.round, value: voteHistory.value })
    .from(voteHistory)
    .where(
      and(
        eq(voteHistory.election, EMARGEMENT_ELECTION),
        inArray(
          voteHistory.electorId,
          rows.map((r) => r.electorId),
        ),
      ),
    )
    .all()) {
    const entry = votes.get(v.electorId) ?? { t1: null, t2: null }
    if (v.round === 1) entry.t1 = v.value
    if (v.round === 2) entry.t2 = v.value
    votes.set(v.electorId, entry)
  }

  const now = ctx.now()
  const byElector = new Map<string, SheetVoter>()
  for (const r of rows) {
    const existing = byElector.get(r.electorId)
    if (existing) {
      if (!existing.listTypes.includes(r.listType)) existing.listTypes.push(r.listType)
      continue
    }
    const age = ageAt(r.birthDate, now)
    byElector.set(r.electorId, {
      electorId: r.electorId,
      birthName: r.birthName,
      usageName: r.usageName,
      firstNames: r.firstNames,
      age,
      ageBand: ageBand(age),
      sex: r.sex,
      level: levels.get(r.electorId) ?? "inconnu",
      bureau: r.bureau,
      listTypes: [r.listType],
      votes: votes.get(r.electorId) ?? { t1: null, t2: null },
    })
  }
  return [...byElector.values()]
}

function addressSheet(ctx: AppContext, id: string): AddressSheet | null {
  const place = ctx.db
    .select({ id: addresses.id, kind: addresses.kind, number: addresses.number, rep: addresses.rep, streetName: addresses.streetName })
    .from(addresses)
    .where(eq(addresses.id, id))
    .get()
  if (!place) return null
  const status = computeAddressStatuses(ctx, { addressIds: [id] })[0]
  if (!status) return null
  const history = listVisits(ctx.db, id)
  return {
    id,
    label: addressLabel(place),
    kind: place.kind,
    category: status.category,
    followUp: status.followUp,
    lastVisit: status.lastVisit,
    dwellings: status.dwellings,
    exclusion: activeExclusion(history),
    voters: sheetVoters(ctx, id),
    visits: history,
  }
}

const dwellingsSchema = z.object({ dwellings: z.number().int().min(0).max(999).nullable() }).strict()

/** Mounted at /api/adresses. */
export function adressesRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  app.get("/:id", (c) => {
    const sheet = addressSheet(ctx, c.req.param("id"))
    if (sheet === null) return c.json({ error: "address_not_found" }, 404)
    return c.json(anonymize(sheet, namesAllowed(ctx)))
  })

  app.patch("/:id", async (c) => {
    const parsed = dwellingsSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const updated = ctx.db
      .update(addresses)
      .set({ dwellings: parsed.data.dwellings, updatedAt: ctx.now().getTime() })
      .where(eq(addresses.id, c.req.param("id")))
      .returning({ id: addresses.id, dwellings: addresses.dwellings })
      .all()[0]
    if (!updated) return c.json({ error: "address_not_found" }, 404)
    return c.json(updated)
  })

  return app
}
