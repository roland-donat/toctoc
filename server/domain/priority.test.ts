import { describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import { DEFAULT_PARAMETERS, loadParameters, PARAMETERS_KEY, saveParameters } from "./parameters.ts"
import { priority, serviceSeconds } from "./priority.ts"
import type { AddressStatus } from "./qualification.ts"
import { setSetting } from "../db/settings.ts"

const P = DEFAULT_PARAMETERS

function status(
  over: Partial<AddressStatus> & { fort?: number; moyen?: number; votant?: number; inconnu?: number; nouveaux?: number },
): AddressStatus {
  const { fort = 0, moyen = 0, votant = 0, inconnu = 0, nouveaux = 0, ...rest } = over
  return {
    addressId: "a",
    kind: "number",
    category: "votants",
    followUp: "jamais_visitee",
    lastVisit: null,
    counts: { fort, moyen, votant, hors_cible: 0, inconnu, nouvel_inscrit: nouveaux },
    ageBands: [],
    registeredCount: fort + moyen + votant + inconnu + nouveaux,
    dwellings: null,
    ...rest,
  }
}

describe("priority", () => {
  it("sums the weights of the voters and caps at 100", () => {
    expect(priority(status({ category: "abstention_forte", fort: 1 }), P)).toBe(40)
    expect(priority(status({ category: "abstention_forte", fort: 1, moyen: 1, votant: 3 }), P)).toBe(60)
    // A building of 6 strong abstainers outranks a house with 1.
    expect(priority(status({ category: "abstention_forte", fort: 6 }), P)).toBe(100)
  })

  it("gives 70 to an address without voter, and 0 when it is excluded (AE2)", () => {
    expect(priority(status({ category: "sans_inscrit" }), P)).toBe(70)
    expect(priority(status({ category: "exclue" }), P)).toBe(0)
  })

  it("keeps the weights plus 30 for an address à revoir, even visited 21 days ago (AE3)", () => {
    expect(priority(status({ category: "abstention_moyenne", moyen: 1, followUp: "a_revoir", lastVisit: "2027-02-08" }), P)).toBe(50)
    expect(priority(status({ category: "sans_inscrit", followUp: "a_revoir" }), P)).toBe(100)
  })

  it("drops to 10 after a visit without follow-up the day before, below a never visited door (AE3)", () => {
    const visited = priority(status({ category: "abstention_forte", fort: 2, followUp: "visitee_recemment" }), P)
    const never = priority(status({ category: "abstention_forte", fort: 1 }), P)
    expect(visited).toBe(10)
    expect(never).toBeGreaterThan(visited)
  })

  it("keeps the full weights once the last visit is older", () => {
    expect(priority(status({ category: "abstention_forte", fort: 2, followUp: "visitee" }), P)).toBe(80)
  })

  it("is 0 for addresses without fort or moyen voter that are not sans_inscrit", () => {
    expect(priority(status({ category: "votants", inconnu: 1 }), P)).toBe(0)
    expect(priority(status({ category: "votants", votant: 2 }), P)).toBe(0)
    expect(priority(status({ category: "non_localise" }), P)).toBe(0)
  })

  it("keeps a door à revoir as a candidate even when all its voters vote (R13)", () => {
    expect(priority(status({ category: "votants", votant: 2, followUp: "a_revoir" }), P)).toBe(30)
    expect(priority(status({ category: "non_localise", followUp: "a_revoir" }), P)).toBe(30)
    expect(priority(status({ category: "exclue", followUp: "a_revoir" }), P)).toBe(0)
  })

  it("counts a 2027 new registrant as a target weighing 40 (decided on 13/10/2026)", () => {
    expect(priority(status({ category: "abstention_forte", nouveaux: 1 }), P)).toBe(40)
    expect(priority(status({ category: "abstention_forte", nouveaux: 1, moyen: 1 }), P)).toBe(60)
  })

  it("is 0 for a street-level address, whatever its voters", () => {
    expect(priority(status({ kind: "street", category: "abstention_forte", fort: 1 }), P)).toBe(0)
  })

  it("follows edited weights", () => {
    const edited = { ...P, weights: { ...P.weights, fort: 25 } }
    expect(priority(status({ category: "abstention_forte", fort: 2 }), edited)).toBe(50)
  })
})

describe("serviceSeconds", () => {
  it("is 3 minutes for a house with one voter", () => {
    expect(serviceSeconds(status({ fort: 1 }), P)).toBe(180)
    expect(serviceSeconds(status({ category: "sans_inscrit" }), P)).toBe(180)
  })

  it("adds a minute per dwelling or voter beyond the first, the larger of the two", () => {
    expect(serviceSeconds(status({ fort: 6 }), P)).toBe(8 * 60)
    expect(serviceSeconds(status({ fort: 2, dwellings: 4 }), P)).toBe(6 * 60)
    expect(serviceSeconds(status({ dwellings: 12 }), P)).toBe(14 * 60)
  })

  it("is capped at 15 minutes for a large building", () => {
    expect(serviceSeconds(status({ dwellings: 12, votant: 16 }), P)).toBe(15 * 60)
    expect(serviceSeconds(status({ dwellings: 40 }), P)).toBe(15 * 60)
  })
})

describe("parameters", () => {
  it("defaults to the KTD8 values", () => {
    const { ctx } = createTestContext()
    expect(loadParameters(ctx.db)).toEqual({
      weights: { fort: 40, moyen: 20, sansInscrit: 70, aRevoir: 30, nouvelInscrit: 40 },
      cap: 100,
      recentDays: 30,
      recentPriority: 10,
      noVoterShareCap: 0.3,
      doorTime: { baseMinutes: 3, perExtraMinutes: 1, capMinutes: 15 },
    })
  })

  it("stores edited values under one key and reads them back", () => {
    const { ctx } = createTestContext()
    saveParameters(ctx.db, { ...P, recentDays: 14, weights: { ...P.weights, sansInscrit: 50 } })
    const loaded = loadParameters(ctx.db)
    expect(loaded.recentDays).toBe(14)
    expect(loaded.weights.sansInscrit).toBe(50)
    expect(loaded.weights.fort).toBe(40)
  })

  it("completes a partial stored value with the defaults", () => {
    const { ctx } = createTestContext()
    setSetting(ctx.db, PARAMETERS_KEY, { weights: { fort: 45 } })
    const loaded = loadParameters(ctx.db)
    expect(loaded.weights).toEqual({ fort: 45, moyen: 20, sansInscrit: 70, aRevoir: 30, nouvelInscrit: 40 })
    expect(loaded.cap).toBe(100)
  })
})
