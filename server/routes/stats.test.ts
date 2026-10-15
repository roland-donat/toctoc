import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Hono } from "hono"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { electors, registrations, voteHistory } from "../db/schema/index.ts"
import { setAnonymizationMode } from "../domain/anonymize.ts"
import { SMALL_COUNT, type DimensionRow, type StatsReport, type TurnoutCell } from "../domain/stats.ts"
import { loadBanFile } from "../services/ban-loader.ts"
import { currentRepImportId } from "../services/current-list.ts"
import { EMARGEMENT_ELECTION } from "../domain/voter-level.ts"
import { commitEmargementImport, prepareEmargementImport } from "../services/emargement-import.ts"
import type { GeocodeFetch } from "../services/geocode-fallback.ts"
import { commitRepImport, prepareRepImport } from "../services/rep-import.ts"
import { recordVisit } from "../services/visits.ts"
import { statsRoutes, type CampaignReport } from "./stats.ts"

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const REP = readFileSync(join(FIXTURES, "rep-2026.csv"))
const EMARGEMENT = readFileSync(join(FIXTURES, "emargement-2026.csv"))

const unreachable: GeocodeFetch = async () => {
  throw new Error("offline")
}
const geocode = { fetch: unreachable, sleep: async (): Promise<void> => {} }

const SANS_INSCRIT = "56243_0110_00013"
const SANS_INSCRIT_2 = "56243_0110_00029"
const BUILDING = "56243_0110_00022"
const KERAVELO = "street:keravelo"
const MASKED: TurnoutCell = { eligible: SMALL_COUNT, voters: SMALL_COUNT, abstainers: SMALL_COUNT, rate: SMALL_COUNT }

let ctx: AppContext
let router: Hono
let seq = 0

function uuid(): string {
  seq += 1
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`
}

/** Adds fictional electors of the principal list, on the current list and on the emargement's reference list. */
function addElectors(n: number, opts: { addressId: string; birthDate: string; t1: "oui" | "non"; t2: "oui" | "non" }): void {
  const importId = currentRepImportId(ctx.db)
  if (importId === null) throw new Error("no current list")
  for (let i = 0; i < n; i++) {
    const id = uuid()
    ctx.db
      .insert(electors)
      .values({ id, identityKey: `extra-${id}`, birthName: "ZOULOU", firstNames: `Test ${seq}`, sex: "F", birthDate: opts.birthDate, createdAt: 0 })
      .run()
    ctx.db
      .insert(registrations)
      .values({ id: uuid(), electorId: id, importId, listType: "principale", bureau: "0003", addressId: opts.addressId, matchStatus: "manual" })
      .run()
    for (const [round, value] of [
      [1, opts.t1],
      [2, opts.t2],
    ] as const) {
      ctx.db.insert(voteHistory).values({ id: uuid(), electorId: id, election: EMARGEMENT_ELECTION, round, value, proxy: "non" }).run()
    }
  }
}

async function getStats(): Promise<StatsReport> {
  const res = await router.request("/")
  expect(res.status).toBe(200)
  return (await res.json()) as StatsReport
}

async function getCampaign(): Promise<CampaignReport> {
  const res = await router.request("/campagne")
  expect(res.status).toBe(200)
  return (await res.json()) as CampaignReport
}

function row(rows: DimensionRow[], key: string): DimensionRow {
  const r = rows.find((x) => x.key === key)
  if (!r) throw new Error(`no row ${key}`)
  return r
}

let base: { ctx: AppContext }
beforeAll(async () => {
  base = createTestContext({ now: new Date("2027-02-10T10:00:00Z") })
  ctx = base.ctx
  await loadBanFile(ctx, join(FIXTURES, "ban-sample.csv"))
  commitRepImport(ctx, await prepareRepImport(ctx, REP, geocode))
  commitEmargementImport(ctx, await prepareEmargementImport(ctx, EMARGEMENT))
  // 10 young electors (aged 21 on 2026-03-15): 5 voted at both rounds, 5 at neither.
  addElectors(5, { addressId: SANS_INSCRIT, birthDate: "2005-01-01", t1: "oui", t2: "oui" })
  addElectors(5, { addressId: SANS_INSCRIT, birthDate: "2005-01-01", t1: "non", t2: "non" })
  // Keravélo: NOVEMBER plus 2, a street of 3 electors.
  addElectors(2, { addressId: KERAVELO, birthDate: "1950-01-01", t1: "oui", t2: "oui" })
})

beforeEach(() => {
  router = statsRoutes(ctx)
})

describe("GET /api/stats", () => {
  it("computes turnout by age band as hand-computed on the fictional set", async () => {
    const { dimensions } = await getStats()
    // 18-25 at T1: ECHO, SIERRA (non) + 5 oui + 5 non = 12 eligible, 5 voters.
    expect(row(dimensions.age, "18-25").t1).toEqual({ eligible: 12, voters: 5, abstainers: 7, rate: 5 / 12 })
    // 41-60: CHARLIE, DELTA, KILO, OSCAR, VICTOR = 5 eligible, 3 voters: counts and rate masked.
    expect(row(dimensions.age, "41-60").t1).toEqual({ eligible: 5, voters: SMALL_COUNT, abstainers: SMALL_COUNT, rate: SMALL_COUNT })
    // 26-40: FOXTROT, HOTEL, INDIA.
    expect(row(dimensions.age, "26-40").t1).toEqual(MASKED)
    // 61+: ALPHA, GOLF, JULIETT, NOVEMBER, TANGO + 2 at Keravélo = 7 eligible, 5 voters, 2 abstainers.
    expect(row(dimensions.age, "61+").t1).toEqual({ eligible: 7, voters: SMALL_COUNT, abstainers: SMALL_COUNT, rate: SMALL_COUNT })
    // UNIFORM, unreadable birth date.
    expect(row(dimensions.age, "inconnu").t1).toEqual(MASKED)
  })

  it("shows a street of 3 electors as < 5 and never its numbers", async () => {
    const { dimensions } = await getStats()
    const keravelo = row(dimensions.rue, "keravelo")
    expect(keravelo.t1).toEqual(MASKED)
    expect(keravelo.t2).toEqual(MASKED)
    expect(keravelo.profile.voters).toEqual({ count: SMALL_COUNT, share: SMALL_COUNT })
    expect(keravelo.profile.abstainers).toEqual({ count: SMALL_COUNT, share: SMALL_COUNT })
    expect(JSON.stringify(keravelo)).not.toMatch(/:[1-4][,}]/)
  })

  it("keeps EU electors out of numerator and denominator, and an unreadable round out of that round", async () => {
    const { overall, population, flows } = await getStats()
    // 17 targeted fixture electors + 12 extras = 29; MIKE's T1 is unreadable; LIMA (EU) is never counted.
    // T1: 6 fixture voters + 5 + 2 = 13 of 28. T2: 6 + 5 + 2 = 13 of 29.
    expect(overall.t1).toEqual({ eligible: 28, voters: 13, abstainers: 15, rate: 13 / 28 })
    expect(overall.t2).toEqual({ eligible: 29, voters: 13, abstainers: 16, rate: 13 / 29 })
    expect(population).toEqual({ targeted: 29, unknown: SMALL_COUNT, newRegistrants: SMALL_COUNT })
    // Flows: both 4 + 7 = 11, T1 only 2 (GOLF, TANGO), T2 only 2 (CHARLIE, UNIFORM), neither 8 + 5 = 13: 28.
    expect(flows).toEqual({ total: 28, both: 11, t1Only: SMALL_COUNT, t2Only: SMALL_COUNT, neither: 13 })
  })
})

describe("campaign", () => {
  it("counts a door visited twice once, and sessions as distinct dates since the start", async () => {
    recordVisit(ctx, { id: uuid(), addressId: BUILDING, source: "admin", visitDate: "2027-01-12", contact: "absent" })
    recordVisit(ctx, { id: uuid(), addressId: BUILDING, source: "admin", visitDate: "2027-01-19", contact: "obtenu" })
    recordVisit(ctx, { id: uuid(), addressId: SANS_INSCRIT_2, source: "admin", visitDate: "2027-01-19", contact: "absent" })
    recordVisit(ctx, { id: uuid(), addressId: SANS_INSCRIT_2, source: "admin", visitDate: "2026-12-05", contact: "absent" })
    const c = await getCampaign()
    expect(c.startDate).toBe("2027-01-01")
    expect(c.registrationDeadline).toBe("2027-03-12")
    expect(c.daysToDeadline).toBe(30)
    expect(c.activity).toEqual({ doorsVisited: 2, sessions: 2 })
    expect(c.coverage.highPotential.covered).toBe(1)
    expect(c.coverage.noVoter.covered).toBe(1)
  })

  it("removes an item set to fait from the to-do list", async () => {
    const id = uuid()
    recordVisit(ctx, { id, addressId: SANS_INSCRIT_2, source: "admin", visitDate: "2027-01-26", dwelling: "Rez-de-chaussée", toAccompany: true })
    let c = await getCampaign()
    // Default anonyme mode: the dwelling free text may carry a name read on a mailbox (KTD7).
    expect(c.accompany.todo).toEqual([
      { visitId: id, addressId: SANS_INSCRIT_2, addressLabel: "29 Rue de Limur", visitDate: "2027-01-26", dwelling: null, done: false },
    ])
    const res = await router.request(`/accompagnement/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ visitId: id, dwelling: null, done: true })
    c = await getCampaign()
    expect(c.accompany.todo).toEqual([])
    expect(c.accompany.done.map((i) => i.visitId)).toEqual([id])
  })

  it("shows the dwelling of an accompany item only in nominatif mode, on the list and on the PATCH answer", async () => {
    setAnonymizationMode(ctx.db, "nominatif")
    const id = uuid()
    recordVisit(ctx, { id, addressId: SANS_INSCRIT_2, source: "admin", visitDate: "2027-01-26", dwelling: "Rez-de-chaussée", toAccompany: true })
    expect((await getCampaign()).accompany.todo.find((i) => i.visitId === id)?.dwelling).toBe("Rez-de-chaussée")
    const res = await router.request(`/accompagnement/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    })
    expect(await res.json()).toMatchObject({ visitId: id, dwelling: "Rez-de-chaussée", done: true })
    setAnonymizationMode(ctx.db, "anonyme")
  })
})
