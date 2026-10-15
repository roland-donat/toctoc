import { readFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { addresses, electors, registrations } from "../db/schema/index.ts"
import { DEFAULT_PARAMETERS } from "../domain/parameters.ts"
import { priority } from "../domain/priority.ts"
import type { AddressStatus, Category, FollowUp } from "../domain/qualification.ts"
import { computeAddressStatuses } from "./address-status.ts"
import { loadBanFile } from "./ban-loader.ts"
import { commitEmargementImport, prepareEmargementImport } from "./emargement-import.ts"
import type { GeocodeFetch } from "./geocode-fallback.ts"
import { commitRepImport, prepareRepImport } from "./rep-import.ts"
import { cancelQualification, recordVisit } from "./visits.ts"

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const REP = readFileSync(join(FIXTURES, "rep-2026.csv"))
const EMARGEMENT = readFileSync(join(FIXTURES, "emargement-2026.csv"))

const unreachable: GeocodeFetch = async () => {
  throw new Error("offline")
}
const geocode = { fetch: unreachable, sleep: async (): Promise<void> => {} }

const NOW = new Date("2027-03-01T10:00:00Z")
const L = (n: string) => `56243_0110_${n}`
const K = (n: number) => `56243_73qtny_0000${n}`

/** Expected category of every fictional address once BAN, list and emargement are imported, before any visit. */
const EXPECTED: Record<string, Category> = {
  [L("00013_bis")]: "abstention_forte", // JULIETT fort
  [L("00022")]: "abstention_forte", // building: 4 fort, 1 moyen, 1 votant
  [L("00008")]: "abstention_forte", // SIERRA fort
  "street:keravelo": "abstention_forte", // NOVEMBER, street level
  [L("00028")]: "abstention_moyenne",
  [L("00030")]: "abstention_moyenne",
  [L("00006")]: "abstention_moyenne",
  [L("00012")]: "abstention_moyenne", // MIKE: one unreadable round, missed the other
  [L("00014")]: "votants",
  [L("00002")]: "votants",
  [L("00009")]: "votants",
  [L("00018")]: "votants", // QUEBEC inconnu (no emargement line)
  [L("00020")]: "votants", // ROMEO inconnu (name mismatch pending)
  [L("00004")]: "votants", // BRAVO inconnu (discordant duplicate pending)
  [L("00010")]: "votants", // LIMA hors cible only
  [K(1)]: "non_localise",
  [K(2)]: "non_localise",
  [K(3)]: "non_localise",
  ...Object.fromEntries(
    ["00013", "00029", "00025", "00023", "00007", "00015", "00019", "00026_bis", "00011", "00027", "00017", "00025_bis", "00021", "00026", "00023_bis"].map(
      (n) => [L(n), "sans_inscrit" as Category],
    ),
  ),
}

let ctx: AppContext
let setNow: (d: Date) => void
let seq = 0

function uuid(): string {
  seq += 1
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`
}

async function importFixtures(c: AppContext): Promise<void> {
  await loadBanFile(c, join(FIXTURES, "ban-sample.csv"))
  commitRepImport(c, await prepareRepImport(c, REP, geocode))
  commitEmargementImport(c, await prepareEmargementImport(c, EMARGEMENT))
}

function statuses(): Map<string, AddressStatus> {
  return new Map(computeAddressStatuses(ctx).map((s) => [s.addressId, s]))
}

function get(id: string): AddressStatus {
  const s = computeAddressStatuses(ctx, { addressIds: [id] })[0]
  if (!s) throw new Error(`no status for ${id}`)
  return s
}

const prio = (id: string): number => priority(get(id), DEFAULT_PARAMETERS)

beforeEach(async () => {
  const t = createTestContext({ now: NOW })
  ctx = t.ctx
  setNow = t.setNow
  await importFixtures(ctx)
})

describe("computeAddressStatuses on the fixtures", () => {
  it("gives every fictional address the expected category, never visited", () => {
    const all = statuses()
    const actual = Object.fromEntries([...all.values()].map((s) => [s.addressId, s.category]))
    expect(actual).toEqual(EXPECTED)
    expect(new Set([...all.values()].map((s) => s.followUp))).toEqual(new Set<FollowUp>(["jamais_visitee"]))
  })

  it("a door proposed for an elector still waiting in the manual queue is non localisé, not sans inscrit", () => {
    const door = L("00029")
    expect(get(door).category).toBe("sans_inscrit")
    const victor = ctx.db.select({ id: electors.id }).from(electors).where(eq(electors.birthName, "VICTOR")).get()
    const pending = ctx.db.select().from(registrations).where(eq(registrations.electorId, victor?.id ?? "")).get()
    expect(pending?.addressId).toBeNull()
    ctx.db.update(registrations).set({ fallbackProposalId: door }).where(eq(registrations.id, pending?.id ?? "")).run()
    expect(get(door).category).toBe("non_localise")
    expect(statuses().get(door)?.category).toBe("non_localise")
  })

  it("counts distinct voters by level and gives the age bands of the building", () => {
    const building = get(L("00022"))
    expect(building.kind).toBe("number")
    expect(building.registeredCount).toBe(6)
    expect(building.counts).toEqual({ fort: 4, moyen: 1, votant: 1, hors_cible: 0, inconnu: 0, nouvel_inscrit: 0 })
    expect(building.ageBands).toEqual(["18-25", "26-40", "41-60", "61+"])
    // LIMA is on both complementary lists at the same address: one voter, hors cible, no age band.
    const eu = get(L("00010"))
    expect(eu.registeredCount).toBe(1)
    expect(eu.counts.hors_cible).toBe(1)
    expect(eu.ageBands).toEqual([])
  })

  it("marks the street-level address as such", () => {
    expect(get("street:keravelo")).toMatchObject({ kind: "street", category: "abstention_forte", registeredCount: 1 })
    expect(prio("street:keravelo")).toBe(0)
  })

  it("gives 0 to an address whose only voter is inconnu, and to a non localisé address", () => {
    expect(prio(L("00018"))).toBe(0)
    expect(prio(K(2))).toBe(0)
  })

  it("ranks a building of strong abstainers above a house with one (priority capped at 100)", () => {
    expect(prio(L("00022"))).toBe(100)
    expect(prio(L("00008"))).toBe(40)
  })

  it("leaves out retired addresses unless asked for", () => {
    ctx.db.update(addresses).set({ retiredAt: 1 }).where(eq(addresses.id, L("00029"))).run()
    expect(statuses().has(L("00029"))).toBe(false)
    expect(get(L("00029")).category).toBe("sans_inscrit")
  })
})

describe("feedback drives category and follow-up", () => {
  it("excludes an address without voter qualified résidence secondaire, until cancelled (AE2)", () => {
    const id = L("00029")
    expect(prio(id)).toBe(70)
    recordVisit(ctx, { id: uuid(), addressId: id, source: "lien", visitDate: "2027-02-20", qualification: "residence_secondaire" })
    expect(get(id).category).toBe("exclue")
    expect(prio(id)).toBe(0)
    setNow(new Date("2027-04-15T10:00:00Z"))
    cancelQualification(ctx, { addressId: id })
    expect(get(id).category).toBe("sans_inscrit")
    expect(prio(id)).toBe(70)
  })

  it("keeps an address à revoir 21 days after « à revenir », with its weights plus 30 (AE3)", () => {
    const id = L("00030")
    recordVisit(ctx, { id: uuid(), addressId: id, source: "lien", visitDate: "2027-02-08", contact: "absent", toRevisit: true })
    expect(get(id)).toMatchObject({ followUp: "a_revoir", lastVisit: "2027-02-08" })
    expect(prio(id)).toBe(50)
  })

  it("puts a door visited yesterday without follow-up after a never visited one (AE3)", () => {
    recordVisit(ctx, { id: uuid(), addressId: L("00006"), source: "lien", visitDate: "2027-02-28", contact: "obtenu", contactQuality: "poli" })
    expect(get(L("00006")).followUp).toBe("visitee_recemment")
    expect(prio(L("00006"))).toBe(10)
    expect(prio(L("00012"))).toBeGreaterThan(prio(L("00006")))
  })

  it("dates the follow-up by the visit date of a paper re-entry, not by the entry date", () => {
    const id = L("00028")
    recordVisit(ctx, { id: uuid(), addressId: id, source: "feuille", visitDate: "2027-01-20", contact: "absent" })
    expect(get(id)).toMatchObject({ followUp: "visitee", lastVisit: "2027-01-20" })
    expect(prio(id)).toBe(20)
  })

  it("does not exclude the building for « logement vide » on apartment 4", () => {
    const id = L("00022")
    recordVisit(ctx, { id: uuid(), addressId: id, source: "lien", visitDate: "2027-01-10", dwelling: "apt 4", qualification: "logement_vide" })
    expect(get(id).category).toBe("abstention_forte")
    recordVisit(ctx, {
      id: uuid(),
      addressId: id,
      source: "admin",
      visitDate: "2027-01-11",
      dwelling: "hall",
      qualification: "non_habitation",
      qualificationScope: "immeuble",
    })
    expect(get(id).category).toBe("exclue")
  })

  it("keeps the three feedbacks of a building on the address, à revoir when one dwelling asks for it (AE5)", () => {
    const id = L("00022")
    recordVisit(ctx, { id: uuid(), addressId: id, source: "lien", visitDate: "2027-02-25", dwelling: "apt 4", contact: "absent" })
    recordVisit(ctx, { id: uuid(), addressId: id, source: "lien", visitDate: "2027-02-25", dwelling: "apt 7", toAccompany: true })
    recordVisit(ctx, { id: uuid(), addressId: id, source: "lien", visitDate: "2027-02-25", dwelling: "hall", remarks: "Digicode" })
    expect(get(id)).toMatchObject({ category: "abstention_forte", followUp: "a_revoir" })
  })
})

