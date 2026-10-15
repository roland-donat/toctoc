import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Hono } from "hono"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { setAnonymizationMode } from "../domain/anonymize.ts"
import { loadBanFile } from "../services/ban-loader.ts"
import { commitEmargementImport, prepareEmargementImport } from "../services/emargement-import.ts"
import type { GeocodeFetch } from "../services/geocode-fallback.ts"
import { commitRepImport, prepareRepImport } from "../services/rep-import.ts"
import { recordVisit } from "../services/visits.ts"
import { adressesRoutes } from "./adresses.ts"
import { carteRoutes } from "./carte.ts"
import { retoursRoutes } from "./retours.ts"

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const unreachable: GeocodeFetch = async () => {
  throw new Error("offline")
}
const L = (n: string) => `56243_0110_${n}`
const BUILDING = L("00022")
const MAILBOX_VISIT = "00000000-0000-4000-8000-000000000001"

/** Every fictional surname and first name of the fixtures, plus the mailbox name of the feedback below. */
const SURNAMES = [
  "ALPHA", "BRAVO", "CHARLIE", "DURAND", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL", "INDIA", "JULIETT", "KILO",
  "LIMA", "MIKE", "NOVEMBER", "OSCAR", "QUEBEC", "ROMEO", "ROMERO", "SIERRA", "TANGO", "UNIFORM", "VICTOR", "ZULU",
]
const FIRST_NAMES = [
  "Anne", "Bruno", "Claire", "Denis", "Emma", "Fanny", "Gaston", "Hugo", "Inès", "Julie", "Karim", "Luis", "Marc",
  "Nora", "Olivier", "Quentin", "Rose", "Sophie", "Thomas", "Ursule", "Vincent",
]
const NAME_PATTERN = new RegExp(`\\b(${[...SURNAMES, ...FIRST_NAMES].join("|")})\\b`)

interface VoterJson {
  birthName: string | null
  usageName: string | null
  firstNames: string | null
  age: number | null
  sex: string | null
  level: string
  bureau: string
  listTypes: string[]
  votes: { t1: string | null; t2: string | null }
}

interface SheetJson {
  id: string
  label: string
  category: string
  followUp: string
  dwellings: number | null
  exclusion: string | null
  voters: VoterJson[]
  visits: { id: string; dwelling: string | null; remarks: string | null; contact: string | null; visitDate: string }[]
}

let ctx: AppContext
let router: Hono

async function sheet(id: string): Promise<SheetJson> {
  const res = await router.request(`/${encodeURIComponent(id)}`)
  expect(res.status).toBe(200)
  return (await res.json()) as SheetJson
}

beforeEach(async () => {
  ctx = createTestContext({ now: new Date("2027-03-01T10:00:00Z") }).ctx
  router = adressesRoutes(ctx)
  await loadBanFile(ctx, join(FIXTURES, "ban-sample.csv"))
  commitRepImport(ctx, await prepareRepImport(ctx, readFileSync(join(FIXTURES, "rep-2026.csv")), { fetch: unreachable, sleep: async () => {} }))
  commitEmargementImport(ctx, await prepareEmargementImport(ctx, readFileSync(join(FIXTURES, "emargement-2026.csv"))))
  recordVisit(ctx, {
    id: MAILBOX_VISIT,
    addressId: BUILDING,
    source: "admin",
    visitDate: "2027-02-20",
    dwelling: "Boîte aux lettres ZULU, 2e étage",
    contact: "obtenu",
    remarks: "Madame ZULU demande à être rappelée",
  })
})

describe("GET /api/adresses/:id", () => {
  it("anonyme: no name nor first name, but age, sex, level and voting history", async () => {
    const s = await sheet(BUILDING)
    expect(s).toMatchObject({ label: "22 Rue de Limur", category: "abstention_forte", dwellings: null, exclusion: null })
    expect(s.voters).toHaveLength(6)
    for (const v of s.voters) expect([v.birthName, v.usageName, v.firstNames]).toEqual([null, null, null])
    // ECHO: F, born 14/08/2001, missed both rounds.
    expect(s.voters).toContainEqual(
      expect.objectContaining({ age: 25, sex: "F", level: "fort", bureau: "0001", listTypes: ["principale"], votes: { t1: "non", t2: "non" } }),
    )
    // GOLF: M, born 09/09/1945, voted T1 only.
    expect(s.voters).toContainEqual(expect.objectContaining({ age: 81, sex: "M", level: "moyen", votes: { t1: "oui", t2: "non" } }))
    expect(JSON.stringify(s)).not.toMatch(NAME_PATTERN)
  })

  it("never serves the birthplace", async () => {
    const text = JSON.stringify(await sheet(BUILDING))
    expect(text).not.toMatch(/birth(Commune|Department|Country)|Portugal|75056/)
  })

  it("nominatif: names appear in the sheet", async () => {
    setAnonymizationMode(ctx.db, "nominatif")
    const s = await sheet(BUILDING)
    expect(s.voters).toContainEqual(expect.objectContaining({ birthName: "ECHO", firstNames: "Emma", age: 25 }))
    const charlie = await sheet(L("00006"))
    expect(charlie.voters[0]).toMatchObject({ birthName: "CHARLIE", usageName: "DURAND", firstNames: "Claire" })
  })

  it("anonyme: a feedback naming a mailbox exposes neither its dwelling nor its remarks", async () => {
    const s = await sheet(BUILDING)
    expect(s.visits).toEqual([expect.objectContaining({ id: MAILBOX_VISIT, dwelling: null, remarks: null, contact: "obtenu", visitDate: "2027-02-20" })])
    setAnonymizationMode(ctx.db, "nominatif")
    const named = await sheet(BUILDING)
    expect(named.visits[0]).toMatchObject({ dwelling: "Boîte aux lettres ZULU, 2e étage", remarks: "Madame ZULU demande à être rappelée" })
  })

  it("lists both complementary lists of an EU elector once", async () => {
    const s = await sheet(L("00010"))
    expect(s.voters).toHaveLength(1)
    expect(s.voters[0]?.level).toBe("hors_cible")
    expect([...(s.voters[0]?.listTypes ?? [])].sort()).toEqual(["complementaire_municipale", "complementaire_ue"])
  })

  it("shows the exclusion in force, to offer its cancellation", async () => {
    recordVisit(ctx, {
      id: "00000000-0000-4000-8000-000000000002",
      addressId: L("00029"),
      source: "admin",
      qualification: "residence_secondaire",
      qualificationScope: "immeuble",
    })
    const s = await sheet(L("00029"))
    expect(s.category).toBe("exclue")
    expect(s.exclusion).toBe("residence_secondaire")
  })

  it("answers 404 for an unknown address", async () => {
    expect((await router.request("/nope")).status).toBe(404)
  })
})

describe("PATCH /api/adresses/:id", () => {
  const patch = (id: string, body: unknown) =>
    router.request(`/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  it("stores the number of dwellings", async () => {
    const res = await patch(BUILDING, { dwellings: 8 })
    expect(res.status).toBe(200)
    expect((await sheet(BUILDING)).dwellings).toBe(8)
    expect((await patch(BUILDING, { dwellings: null })).status).toBe(200)
    expect((await sheet(BUILDING)).dwellings).toBeNull()
  })

  it("refuses an invalid count", async () => {
    expect((await patch(BUILDING, { dwellings: -1 })).status).toBe(400)
    expect((await patch(BUILDING, { dwellings: 2.5 })).status).toBe(400)
  })
})

describe("anonyme: no read route leaks a name", () => {
  it("carte, carte/options, every address sheet and every feedback history", async () => {
    const carte = carteRoutes(ctx)
    const retours = retoursRoutes(ctx)
    const texts: string[] = []
    const mapText = await (await carte.request("/")).text()
    texts.push(mapText, await (await carte.request("/options")).text())
    const { addresses } = JSON.parse(mapText) as { addresses: { id: string }[] }
    expect(addresses.length).toBeGreaterThan(30)
    for (const a of addresses) {
      texts.push(await (await router.request(`/${encodeURIComponent(a.id)}`)).text())
      texts.push(await (await retours.request(`/?addressId=${encodeURIComponent(a.id)}`)).text())
    }
    for (const t of texts) expect(t).not.toMatch(NAME_PATTERN)

    // The same scan finds the names once the switch is nominatif, so it does look at the right place.
    setAnonymizationMode(ctx.db, "nominatif")
    expect(await (await router.request(`/${BUILDING}`)).text()).toMatch(NAME_PATTERN)
    expect(await (await retours.request(`/?addressId=${BUILDING}`)).text()).toMatch(/ZULU/)
  })
})
