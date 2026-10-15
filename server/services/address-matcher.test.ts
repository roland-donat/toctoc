import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import Papa from "papaparse"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { addresses } from "../db/schema/index.ts"
import { matchKey, streetKey } from "../domain/address-normalize.ts"
import {
  loadAddressIndex,
  matchAddresses,
  sameStreet,
  streetMainWord,
  type RepAddress,
} from "./address-matcher.ts"
import { loadBanFile } from "./ban-loader.ts"
import type { GeocodeFetch } from "./geocode-fallback.ts"

const BAN_FIXTURE = join(import.meta.dirname, "../../tests/fixtures/ban-sample.csv")

interface FakeResult {
  type: string
  id: string
  housenumber?: string
  street?: string
  label?: string
}

/** Fake Géoplateforme answering each row with `answer(row)`; records every CSV sent. */
function fakeGeocoder(answer: (row: Record<string, string>) => FakeResult | null) {
  const sent: string[] = []
  const fetchFn: GeocodeFetch = async (_url, init) => {
    const file = (init.body as FormData).get("data") as File
    const csv = await file.text()
    sent.push(csv)
    const rows = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data
    const out = rows.map((row) => {
      const r = answer(row)
      return {
        ...row,
        longitude: r ? "-2.7" : "",
        latitude: r ? "47.6" : "",
        result_label: r?.label ?? "",
        result_type: r?.type ?? "",
        result_id: r?.id ?? "",
        result_housenumber: r?.housenumber ?? "",
        result_street: r?.street ?? "",
        result_status: r ? "ok" : "not-found",
      }
    })
    return new Response(Papa.unparse(out))
  }
  return { fetchFn, sent }
}

const neverCalled: GeocodeFetch = async () => {
  throw new Error("the fallback must not be called")
}
const noSleep = async (): Promise<void> => {}

function rep(number: string | null, street: string, lieuDit: string | null = null): RepAddress {
  return { rawNumber: number, rawStreet: street, rawLieuDit: lieuDit, rawPostalCode: "56860", rawCommune: "Séné" }
}

/** Adds a fictional BAN address to the local reference. */
function addBanAddress(ctx: AppContext, id: string, number: number, street: string): void {
  ctx.db
    .insert(addresses)
    .values({
      id,
      kind: "number",
      number,
      rep: null,
      streetName: street,
      streetKey: streetKey(street),
      inseeCode: "56243",
      postalCode: "56860",
      matchKey: matchKey(number, null, street),
      lat: 47.6,
      lon: -2.7,
      updatedAt: 0,
    })
    .run()
}

describe("streetMainWord", () => {
  it("drops the street type and the articles", () => {
    expect(streetMainWord("Rue de Limur")).toBe("limur")
    expect(streetMainWord("Allée des Mimosas")).toBe("mimosas")
    expect(streetMainWord("Lieu-dit Keravélo")).toBe("keravelo")
    expect(streetMainWord("Rue du Général de Gaulle")).toBe("gaulle")
    expect(streetMainWord("Impasse de l'Étang")).toBe("etang")
  })

  it("treats the same main word on another street type as another street", () => {
    expect(sameStreet("Rue du Limur", "Rue de Limur")).toBe(true)
    expect(sameStreet("R. de Limur", "Rue de Limur")).toBe(true)
    expect(sameStreet("Rue de Kerfictif", "Impasse de Kerfictif")).toBe(false)
    expect(sameStreet("Rue de Limur", "Rue de Kerfictif")).toBe(false)
  })
})

describe("matchAddresses", () => {
  let ctx: AppContext

  beforeEach(async () => {
    ctx = createTestContext().ctx
    await loadBanFile(ctx, BAN_FIXTURE)
  })

  async function match(list: RepAddress[], fetchFn: GeocodeFetch = neverCalled) {
    return matchAddresses(loadAddressIndex(ctx.db), list, { fetch: fetchFn, sleep: noSleep })
  }

  it("attaches addresses present in the BAN without any external call", async () => {
    const report = await match([
      rep("2", "Rue de Limur"),
      rep("13Bis", "Rue de Limur"),
      rep("9", "R. de Limur"),
      rep("8", "rue de limur"),
    ])
    expect(report.matches).toEqual([
      { status: "ban", addressId: "56243_0110_00002" },
      { status: "ban", addressId: "56243_0110_00013_bis" },
      { status: "ban", addressId: "56243_0110_00009" },
      { status: "ban", addressId: "56243_0110_00008" },
    ])
    expect(report.fallbackRequested).toBe(0)
  })

  it("attaches an elector without house number to the street-level lieu-dit address", async () => {
    const report = await match([rep(null, "Keravélo", "Keravélo"), rep(null, "", "Keravélo")])
    expect(report.matches).toEqual([
      { status: "street", addressId: "street:keravelo" },
      { status: "street", addressId: "street:keravelo" },
    ])
    const street = report.streets.get("street:keravelo")
    expect(street?.streetName).toBe("Keravélo")
    // Centroid of the three Keravélo BAN addresses of the fixture.
    expect(street?.lat).toBeCloseTo((47.630202 + 47.630348 + 47.630394) / 3, 6)
    expect(street?.lon).toBeCloseTo((-2.735034 + -2.735588 + -2.735568) / 3, 6)
  })

  it("queues an address the fallback does not find", async () => {
    const { fetchFn, sent } = fakeGeocoder(() => null)
    const report = await match([rep("99", "Rue de Limur")], fetchFn)
    expect(sent).toHaveLength(1)
    expect(report.matches).toEqual([{ status: "pending", proposalId: null }])
    expect(report.fallbackAvailable).toBe(true)
  })

  it("accepts a fallback result with the same number on the same street", async () => {
    const { fetchFn } = fakeGeocoder(() => ({ type: "housenumber", id: "56243_0110_00021", housenumber: "21", street: "Rue de Limur" }))
    const report = await match([rep("21", "Rue du Limur")], fetchFn)
    expect(report.matches).toEqual([{ status: "fallback", addressId: "56243_0110_00021" }])
  })

  it("refuses the same number on another street type and queues it with the proposal", async () => {
    addBanAddress(ctx, "56243_fict_00016", 16, "Impasse de Kerfictif")
    const { fetchFn } = fakeGeocoder(() => ({
      type: "housenumber",
      id: "56243_fict_00016",
      housenumber: "16",
      street: "Impasse de Kerfictif",
    }))
    const report = await match([rep("16", "Rue de Kerfictif")], fetchFn)
    expect(report.matches).toEqual([{ status: "pending", proposalId: "56243_fict_00016" }])
  })

  it("refuses a result with another house number", async () => {
    const { fetchFn } = fakeGeocoder(() => ({ type: "housenumber", id: "56243_0110_00015", housenumber: "15", street: "Rue de Limur" }))
    const report = await match([rep("16", "Rue du Limur")], fetchFn)
    expect(report.matches).toEqual([{ status: "pending", proposalId: "56243_0110_00015" }])
  })

  it("refuses a result without the repetition index of the list", async () => {
    const { fetchFn } = fakeGeocoder(() => ({ type: "housenumber", id: "56243_0110_00021", housenumber: "21", street: "Rue de Limur" }))
    const report = await match([rep("21 bis", "Rue du Limur")], fetchFn)
    expect(report.matches).toEqual([{ status: "pending", proposalId: "56243_0110_00021" }])
  })

  it("refuses a street-level result and a BAN id unknown locally", async () => {
    const { fetchFn } = fakeGeocoder((row) =>
      row["numero"] === "99"
        ? { type: "street", id: "56243_0110", street: "Rue de Limur" }
        : { type: "housenumber", id: "56243_0110_00098", housenumber: "98", street: "Rue de Limur" },
    )
    const report = await match([rep("99", "Rue de Limur"), rep("98", "Rue de Limur")], fetchFn)
    expect(report.matches).toEqual([
      { status: "pending", proposalId: null },
      { status: "pending", proposalId: null },
    ])
  })

  it("sends a lieu-dit unknown to the BAN to the fallback, then to the queue", async () => {
    const { fetchFn, sent } = fakeGeocoder(() => ({ type: "locality", id: "56243_zzzz", street: "Fictif" }))
    const report = await match([rep(null, "", "Le Hameau Fictif")], fetchFn)
    expect(sent[0]).toContain("Le Hameau Fictif")
    expect(report.matches).toEqual([{ status: "pending", proposalId: null }])
  })

  it("queues everything unmatched when the fallback is unreachable", async () => {
    const offline: GeocodeFetch = async () => {
      throw new TypeError("fetch failed")
    }
    const report = await match([rep("2", "Rue de Limur"), rep("99", "Rue de Limur")], offline)
    expect(report.matches).toEqual([
      { status: "ban", addressId: "56243_0110_00002" },
      { status: "pending", proposalId: null },
    ])
    expect(report.fallbackAvailable).toBe(false)
  })

  it("ignores retired BAN addresses for local matching", async () => {
    ctx.db.update(addresses).set({ retiredAt: 1 }).run()
    const { fetchFn, sent } = fakeGeocoder(() => null)
    const report = await match([rep("2", "Rue de Limur")], fetchFn)
    expect(sent).toHaveLength(1)
    expect(report.matches).toEqual([{ status: "pending", proposalId: null }])
  })
})
