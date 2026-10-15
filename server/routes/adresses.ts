// Address sheet (R9): registered voters of the current list, dwellings, dated feedback history.
// Names and feedback free texts go through `anonymize` (KTD7); the birthplace is never served here.
import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { cleanUnitLabel, UNIT_LABEL_MAX } from "../domain/dwelling-units.ts"
import { addUnit, unitsByAddress, UnitError, updateUnit, type UnitView } from "../services/dwelling-units.ts"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import { addresses, commerces, electors, registrations, voteHistory } from "../db/schema/index.ts"
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
  /**
   * Shop fronts OpenStreetMap lists at the address (main tags), and whether the administrator said the address is
   * lived in anyway; null when none.
   */
  commerce: { kinds: string[]; dismissed: boolean } | null
  /** Qualification excluding the address (R5), which the administrator may cancel; null otherwise. */
  exclusion: ExclusionQualification | null
  voters: SheetVoter[]
  /** Dwellings of the building with their latest feedback (15/10/2026). */
  units: UnitView[]
  /** Households met that are not on the electoral list. */
  nonRegisteredMet: number
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
    .select({
      id: addresses.id,
      kind: addresses.kind,
      number: addresses.number,
      rep: addresses.rep,
      streetName: addresses.streetName,
      commerceDismissedAt: addresses.commerceDismissedAt,
    })
    .from(addresses)
    .where(eq(addresses.id, id))
    .get()
  if (!place) return null
  const status = computeAddressStatuses(ctx, { addressIds: [id] })[0]
  if (!status) return null
  const history = listVisits(ctx.db, id)
  const kinds = ctx.db.select({ kind: commerces.kind }).from(commerces).where(eq(commerces.addressId, id)).all().map((k) => k.kind)
  return {
    id,
    label: addressLabel(place),
    kind: place.kind,
    category: status.category,
    followUp: status.followUp,
    lastVisit: status.lastVisit,
    dwellings: status.dwellings,
    commerce: kinds.length === 0 ? null : { kinds: [...new Set(kinds)].sort(), dismissed: place.commerceDismissedAt !== null },
    exclusion: activeExclusion(history),
    voters: sheetVoters(ctx, id),
    units: unitsByAddress(ctx, [id]).get(id) ?? [],
    nonRegisteredMet: history.filter((v) => v.nonRegistered).length,
    visits: history,
  }
}

/** Number of dwellings (R9), and "this commerce probable is lived in" (15/10/2026); at least one of them. */
const updateSchema = z
  .object({ dwellings: z.number().int().min(0).max(999).nullable().optional(), commerceDismissed: z.boolean().optional() })
  .strict()
  .refine((v) => v.dwellings !== undefined || v.commerceDismissed !== undefined)

/** Mounted at /api/adresses. */
export function adressesRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  app.get("/:id", (c) => {
    const sheet = addressSheet(ctx, c.req.param("id"))
    if (sheet === null) return c.json({ error: "address_not_found" }, 404)
    return c.json(anonymize(sheet, namesAllowed(ctx)))
  })

  app.patch("/:id", async (c) => {
    const parsed = updateSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const now = ctx.now().getTime()
    const { dwellings, commerceDismissed } = parsed.data
    const updated = ctx.db
      .update(addresses)
      .set({
        ...(dwellings !== undefined ? { dwellings } : {}),
        ...(commerceDismissed !== undefined ? { commerceDismissedAt: commerceDismissed ? now : null } : {}),
        updatedAt: now,
      })
      .where(eq(addresses.id, c.req.param("id")))
      .returning({ id: addresses.id, dwellings: addresses.dwellings, commerceDismissedAt: addresses.commerceDismissedAt })
      .all()[0]
    if (!updated) return c.json({ error: "address_not_found" }, 404)
    return c.json(updated)
  })

  // Dwellings of the building: added, renamed or removed by the administrator.
  const unitLabelSchema = z.object({ label: z.string().min(1).max(UNIT_LABEL_MAX) }).strict()
  const unitPatchSchema = z
    .object({ label: z.string().min(1).max(UNIT_LABEL_MAX).optional(), retired: z.boolean().optional() })
    .strict()
    .refine((v) => v.label !== undefined || v.retired !== undefined)

  app.post("/:id/logements", async (c) => {
    const parsed = unitLabelSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const addressId = c.req.param("id")
    const exists = ctx.db.select({ id: addresses.id }).from(addresses).where(eq(addresses.id, addressId)).get()
    if (!exists) return c.json({ error: "address_not_found" }, 404)
    const label = cleanUnitLabel(parsed.data.label)
    if (label === null) return c.json({ error: "unit_label_required" }, 422)
    return c.json({ id: addUnit(ctx, { id: randomUUID(), addressId, label, source: "admin" }) }, 201)
  })

  app.patch("/:id/logements/:unitId", async (c) => {
    const parsed = unitPatchSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    try {
      updateUnit(ctx, c.req.param("id"), c.req.param("unitId"), parsed.data)
      return c.json({ id: c.req.param("unitId") })
    } catch (err) {
      if (err instanceof UnitError) return c.json({ error: err.code }, err.code === "unit_label_required" ? 422 : 404)
      throw err
    }
  })

  return app
}
