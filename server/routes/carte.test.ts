import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Hono } from "hono"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { loadBanFile } from "../services/ban-loader.ts"
import { commitEmargementImport, prepareEmargementImport } from "../services/emargement-import.ts"
import type { GeocodeFetch } from "../services/geocode-fallback.ts"
import { commitRepImport, prepareRepImport } from "../services/rep-import.ts"
import { recordVisit } from "../services/visits.ts"
import { carteRoutes } from "./carte.ts"

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const unreachable: GeocodeFetch = async () => {
  throw new Error("offline")
}
const L = (n: string) => `56243_0110_${n}`

interface CarteJson {
  addresses: {
    id: string
    lat: number
    lon: number
    label: string
    category: string
    followUp: string
    registeredCount: number
    counts: Record<string, number>
    ageBands: string[]
  }[]
  totals: { doors: number; electors: number }
}

let ctx: AppContext
let router: Hono

async function importFixtures(c: AppContext): Promise<void> {
  await loadBanFile(c, join(FIXTURES, "ban-sample.csv"))
  commitRepImport(c, await prepareRepImport(c, readFileSync(join(FIXTURES, "rep-2026.csv")), { fetch: unreachable, sleep: async () => {} }))
  commitEmargementImport(c, await prepareEmargementImport(c, readFileSync(join(FIXTURES, "emargement-2026.csv"))))
}

async function carte(query: string): Promise<CarteJson> {
  const res = await router.request(`/${query}`)
  expect(res.status).toBe(200)
  return (await res.json()) as CarteJson
}

const ids = (j: CarteJson) => j.addresses.map((a) => a.id).sort()

beforeEach(async () => {
  ctx = createTestContext({ now: new Date("2027-03-01T10:00:00Z") }).ctx
  router = carteRoutes(ctx)
  await importFixtures(ctx)
})

describe("GET /api/carte", () => {
  it("returns every address with its summary when no filter is set", async () => {
    const j = await carte("")
    // 32 BAN numbers of Séné + the Keravélo street address; electors: 22 rows, LIMA twice, VICTOR unmatched (99).
    expect(j.totals).toEqual({ doors: 33, electors: 20 })
    const building = j.addresses.find((a) => a.id === L("00022"))
    expect(building).toMatchObject({
      label: "22 Rue de Limur",
      category: "abstention_forte",
      followUp: "jamais_visitee",
      registeredCount: 6,
      counts: { fort: 4, moyen: 1, votant: 1 },
      ageBands: ["18-25", "26-40", "41-60", "61+"],
    })
  })

  it("filters abstention forte, 18-25 and bureau 0001 down to the addresses having such an elector", async () => {
    const j = await carte("?category=abstention_forte&ageBand=18-25&bureau=0001")
    expect(ids(j)).toEqual([L("00022")]) // ECHO, 25
    expect(j.totals).toEqual({ doors: 1, electors: 1 })
    // Without the bureau, SIERRA (23, bureau 0002, 8 rue de Limur) joins.
    const all = await carte("?category=abstention_forte&ageBand=18-25")
    expect(ids(all)).toEqual([L("00008"), L("00022")])
    expect(all.totals).toEqual({ doors: 2, electors: 2 })
  })

  it("requires one elector matching every elector filter together", async () => {
    // At 22, ECHO is F and 18-25, DELTA is M: no man aged 18-25 there; BRAVO (M, 22) lives at 4.
    const j = await carte("?ageBand=18-25&sex=M")
    expect(ids(j)).toEqual([L("00004")])
    expect(j.totals).toEqual({ doors: 1, electors: 1 })
  })

  it("refuses a birthplace filter: the birthplace is not a filter", async () => {
    expect((await router.request("/?birthPlace=etranger")).status).toBe(400)
  })

  it("filters by several categories, street and follow-up state", async () => {
    await recordVisit(ctx, {
      id: "00000000-0000-4000-8000-000000000001",
      addressId: L("00029"),
      source: "admin",
      toRevisit: true,
    })
    const revisit = await carte("?followUp=a_revoir&followUp=visitee_recemment")
    expect(ids(revisit)).toEqual([L("00029")])
    expect(revisit.addresses[0]?.followUp).toBe("a_revoir")

    const street = await carte("?street=keravelo&category=abstention_forte&category=sans_inscrit")
    expect(ids(street)).toEqual(["street:keravelo"])
    expect(street.totals).toEqual({ doors: 1, electors: 1 })
  })

  it("never accepts a filter on names", async () => {
    expect((await router.request("/?birthName=ALPHA")).status).toBe(400)
  })
})

describe("GET /api/carte/options", () => {
  it("lists bureaus, streets and the import steps done", async () => {
    const res = await router.request("/options")
    expect(res.status).toBe(200)
    const j = (await res.json()) as { setup: Record<string, boolean>; bureaus: string[]; streets: { key: string; name: string }[] }
    expect(j.setup).toEqual({ ban: true, liste: true, emargement: true })
    expect(j.bureaus).toEqual(["0001", "0002"])
    expect(j.streets.map((s) => s.key)).toContain("keravelo")
  })

  it("reports the missing imports on an empty base", async () => {
    const empty = carteRoutes(createTestContext().ctx)
    const j = (await (await empty.request("/options")).json()) as { setup: Record<string, boolean> }
    expect(j.setup).toEqual({ ban: false, liste: false, emargement: false })
  })
})
