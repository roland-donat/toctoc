// Re-import of the 2027 electoral list (U14, R6, F4, AE5, KTD12) on the fictional fixtures.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { electors, registrations, voteHistory } from "../db/schema/index.ts"
import { computeAddressStatuses } from "./address-status.ts"
import { loadBanFile } from "./ban-loader.ts"
import { currentRepImportId } from "./current-list.ts"
import { commitEmargementImport, EmargementImportError, prepareEmargementImport } from "./emargement-import.ts"
import { loadCurrentVoterLevels } from "./voter-levels.ts"
import type { GeocodeFetch } from "./geocode-fallback.ts"
import { commitRepImport, prepareRepImport, type RepImportResult } from "./rep-import.ts"
import { listVisits, recordVisit } from "./visits.ts"

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const REP_2026 = readFileSync(join(FIXTURES, "rep-2026.csv"), "utf-8")
const REP_2027 = readFileSync(join(FIXTURES, "rep-2027.csv"), "utf-8")
const EMARGEMENT_2026 = readFileSync(join(FIXTURES, "emargement-2026.csv"), "utf-8")

const BUILDING = "56243_0110_00022"
const NUMBER_2 = "56243_0110_00002"
const NUMBER_7 = "56243_0110_00007"
const NUMBER_12 = "56243_0110_00012"
const NUMBER_29 = "56243_0110_00029"

const unreachable: GeocodeFetch = async () => {
  throw new Error("offline")
}
const geocode = { fetch: unreachable, sleep: async (): Promise<void> => {} }

async function importRep(ctx: AppContext, text: string): Promise<RepImportResult> {
  return commitRepImport(ctx, await prepareRepImport(ctx, Buffer.from(text), geocode))
}

function electorId(ctx: AppContext, birthName: string): string {
  const row = ctx.db.select({ id: electors.id }).from(electors).where(eq(electors.birthName, birthName)).get()
  if (!row) throw new Error(`fixture elector missing: ${birthName}`)
  return row.id
}

function currentRegistrationsOf(ctx: AppContext, birthName: string) {
  const importId = currentRepImportId(ctx.db)
  if (importId === null) return []
  return ctx.db
    .select()
    .from(registrations)
    .where(and(eq(registrations.importId, importId), eq(registrations.electorId, electorId(ctx, birthName))))
    .all()
}

function categoryOf(ctx: AppContext, addressId: string) {
  return computeAddressStatuses(ctx, { addressIds: [addressId] })[0]?.category
}

let ctx: AppContext

beforeEach(async () => {
  ctx = createTestContext().ctx
  await loadBanFile(ctx, join(FIXTURES, "ban-sample.csv"))
  await importRep(ctx, REP_2026)
  commitEmargementImport(ctx, await prepareEmargementImport(ctx, Buffer.from(EMARGEMENT_2026)))
})

describe("re-import of the 2027 list", () => {
  it("Covers AE5. keeps the three feedbacks of the 22 rue de Limur building on the address", async () => {
    const feedbacks = [
      { id: "11111111-1111-4111-8111-111111111111", dwelling: "apt 4", contact: "absent" as const },
      { id: "22222222-2222-4222-8222-222222222222", dwelling: "apt 7", toAccompany: true },
      { id: "33333333-3333-4333-8333-333333333333", dwelling: "hall", remarks: "remarque" },
    ]
    for (const f of feedbacks) recordVisit(ctx, { ...f, addressId: BUILDING, source: "admin", visitDate: "2027-01-10" })
    const before = listVisits(ctx.db, BUILDING)
    expect(before).toHaveLength(3)

    await importRep(ctx, REP_2027)

    const after = listVisits(ctx.db, BUILDING)
    expect(after).toEqual(before)
    expect(after.map((v) => v.dwelling).sort()).toEqual(["apt 4", "apt 7", "hall"])
  })

  it("keeps the 2026 history of an elector who moved and shows it at the new address", async () => {
    const alpha = electorId(ctx, "ALPHA")
    const historyBefore = ctx.db.select().from(voteHistory).where(eq(voteHistory.electorId, alpha)).all()
    expect(historyBefore).toHaveLength(2)
    expect(currentRegistrationsOf(ctx, "ALPHA").map((r) => r.addressId)).toEqual([NUMBER_2])

    await importRep(ctx, REP_2027)

    expect(electorId(ctx, "ALPHA")).toBe(alpha)
    expect(ctx.db.select().from(voteHistory).where(eq(voteHistory.electorId, alpha)).all()).toEqual(historyBefore)
    expect(currentRegistrationsOf(ctx, "ALPHA").map((r) => r.addressId)).toEqual([NUMBER_12])
    expect(loadCurrentVoterLevels(ctx.db).get(alpha)).not.toBe("nouvel_inscrit")
    expect(categoryOf(ctx, NUMBER_12)).not.toBe("sans_inscrit")
  })

  it("an address gaining a registrant in 2027 stops being sans inscrit, the one left empty becomes so", async () => {
    expect(categoryOf(ctx, NUMBER_7)).toBe("sans_inscrit")
    expect(categoryOf(ctx, NUMBER_2)).not.toBe("sans_inscrit")

    await importRep(ctx, REP_2027)

    expect(categoryOf(ctx, NUMBER_7)).not.toBe("sans_inscrit")
    expect(categoryOf(ctx, NUMBER_2)).toBe("sans_inscrit")
    expect(loadCurrentVoterLevels(ctx.db).get(electorId(ctx, "WHISKEY"))).toBe("nouvel_inscrit")
  })

  it("an elector absent from the 2027 list keeps its history without a current registration", async () => {
    const mike = electorId(ctx, "MIKE")
    const history = ctx.db.select().from(voteHistory).where(eq(voteHistory.electorId, mike)).all()
    expect(history).toHaveLength(2)

    await importRep(ctx, REP_2027)

    expect(currentRegistrationsOf(ctx, "MIKE")).toEqual([])
    expect(ctx.db.select().from(voteHistory).where(eq(voteHistory.electorId, mike)).all()).toEqual(history)
  })

  it("reports new registrants, removed and moved electors and the sans inscrit addresses before and after", async () => {
    const sansInscrit = () => computeAddressStatuses(ctx).filter((s) => s.category === "sans_inscrit").length
    const before = sansInscrit()

    const result = await importRep(ctx, REP_2027)

    // WHISKEY is new, MIKE removed, ALPHA moved from 2 to 12; 7 gains a registrant and 2 loses its only one.
    expect(result.reimport).toEqual({
      newRegistrants: 1,
      removed: 1,
      moved: 1,
      sansInscritBefore: before,
      sansInscritAfter: before,
      manualCarriedOver: 0,
    })
    expect(sansInscrit()).toBe(before)
  })

  it("has no re-import report on the first import", async () => {
    const fresh = createTestContext().ctx
    await loadBanFile(fresh, join(FIXTURES, "ban-sample.csv"))
    expect((await importRep(fresh, REP_2026)).reimport).toBeNull()
  })

  it("carries over a manual attachment when the raw address is unchanged", async () => {
    const [victor] = currentRegistrationsOf(ctx, "VICTOR")
    expect(victor?.matchStatus).toBe("pending")
    ctx.db
      .update(registrations)
      .set({ addressId: NUMBER_29, matchStatus: "manual" })
      .where(eq(registrations.id, victor?.id ?? ""))
      .run()

    const result = await importRep(ctx, REP_2027)

    expect(currentRegistrationsOf(ctx, "VICTOR").map((r) => [r.addressId, r.matchStatus])).toEqual([[NUMBER_29, "manual"]])
    expect(result.queueSize).toBe(0)
    expect(result.reimport?.manualCarriedOver).toBe(1)
    expect(result.reimport?.moved).toBe(1)
  })

  it("queues again an elector previously attached by hand whose raw address changed", async () => {
    const [victor] = currentRegistrationsOf(ctx, "VICTOR")
    ctx.db
      .update(registrations)
      .set({ addressId: NUMBER_29, matchStatus: "manual" })
      .where(eq(registrations.id, victor?.id ?? ""))
      .run()

    const changed = REP_2027.replace(/("VICTOR".*?"Française";)"99";/, '$1"98";')
    expect(changed).not.toBe(REP_2027)
    const result = await importRep(ctx, changed)

    expect(currentRegistrationsOf(ctx, "VICTOR").map((r) => [r.addressId, r.matchStatus])).toEqual([[null, "pending"]])
    expect(result.queueSize).toBe(1)
    expect(result.reimport?.manualCarriedOver).toBe(0)
  })

  it("re-importing the 2026 emargement after the 2027 list keeps the levels and the new registrants", async () => {
    await importRep(ctx, REP_2027)
    const levelsBefore = loadCurrentVoterLevels(ctx.db)
    const newBefore = [...levelsBefore.values()].filter((l) => l === "nouvel_inscrit").length
    expect(newBefore).toBeGreaterThan(0)

    const pending = await prepareEmargementImport(ctx, Buffer.from(EMARGEMENT_2026))
    commitEmargementImport(ctx, pending)

    const levelsAfter = loadCurrentVoterLevels(ctx.db)
    expect([...levelsAfter.values()].filter((l) => l === "nouvel_inscrit").length).toBe(newBefore)
    expect(levelsAfter).toEqual(levelsBefore)
  })

  it("refuses a first emargement import once a newer list replaced the 2026 one", async () => {
    const fresh = createTestContext().ctx
    await loadBanFile(fresh, join(FIXTURES, "ban-sample.csv"))
    await importRep(fresh, REP_2026)
    await importRep(fresh, REP_2027)
    await expect(prepareEmargementImport(fresh, Buffer.from(EMARGEMENT_2026))).rejects.toMatchObject({
      constructor: EmargementImportError,
      code: "reference_list_replaced",
    })
  })
})
