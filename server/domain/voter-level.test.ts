import { describe, expect, it } from "vitest"
import { voterLevel, type VoterLevelInput } from "./voter-level.ts"

const principal = (rounds: VoterLevelInput["rounds"]): VoterLevelInput => ({
  listTypes: ["principale"],
  onReferenceList: true,
  rounds,
})

describe("voterLevel (R3, KTD13)", () => {
  it("Covers AE1. Absent at T1 and present at T2 on the principal list: moyen", () => {
    expect(voterLevel(principal(["non", "oui"]))).toBe("moyen")
  })

  it("Covers AE1. Absent at both rounds on an EU complementary list: hors_cible", () => {
    expect(voterLevel({ listTypes: ["complementaire_ue"], onReferenceList: true, rounds: ["non", "non"] })).toBe("hors_cible")
  })

  it("is hors_cible on both complementary lists, even absent from the reference list", () => {
    expect(
      voterLevel({ listTypes: ["complementaire_ue", "complementaire_municipale"], onReferenceList: false, rounds: [] }),
    ).toBe("hors_cible")
  })

  it("keeps the principal-list rules for an elector also on a complementary list", () => {
    expect(voterLevel({ listTypes: ["principale", "complementaire_municipale"], onReferenceList: true, rounds: ["non", "non"] })).toBe(
      "fort",
    )
  })

  it("absent at both rounds: fort; voted at both: votant; missed one: moyen", () => {
    expect(voterLevel(principal(["non", "non"]))).toBe("fort")
    expect(voterLevel(principal(["oui", "oui"]))).toBe("votant")
    expect(voterLevel(principal(["oui", "non"]))).toBe("moyen")
  })

  it("an unreadable round counts neither as a vote nor as an absence", () => {
    expect(voterLevel(principal(["illisible", "non"]))).toBe("moyen")
    expect(voterLevel(principal(["oui", "illisible"]))).toBe("votant")
  })

  it("two unreadable rounds: inconnu", () => {
    expect(voterLevel(principal(["illisible", "illisible"]))).toBe("inconnu")
  })

  it("on the reference list without any applied row: inconnu", () => {
    expect(voterLevel(principal([]))).toBe("inconnu")
  })

  it("absent from the reference list: nouvel_inscrit", () => {
    expect(voterLevel({ listTypes: ["principale"], onReferenceList: false, rounds: [] })).toBe("nouvel_inscrit")
  })
})
