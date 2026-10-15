import { describe, expect, it } from "vitest"
import {
  campaignActivity,
  campaignCoverage,
  computeStats,
  maskCount,
  SMALL_COUNT,
  type ElectorFacts,
  type RoundFact,
} from "./stats.ts"

const oui: RoundFact = { value: "oui", proxy: false }
const non: RoundFact = { value: "non", proxy: false }
const illisible: RoundFact = { value: "illisible", proxy: false }

function elector(overrides: Partial<ElectorFacts> = {}): ElectorFacts {
  return {
    level: "votant",
    sex: "F",
    ageBand: "41-60",
    bureau: "0001",
    streetKey: "rue de limur",
    streetName: "Rue de Limur",
    birthPlace: "sene",
    t1: oui,
    t2: oui,
    ...overrides,
  }
}

function times(n: number, overrides: Partial<ElectorFacts>): ElectorFacts[] {
  return Array.from({ length: n }, () => elector(overrides))
}

describe("maskCount", () => {
  it("hides counts below 5 and keeps 5 and above", () => {
    expect(maskCount(0)).toBe(SMALL_COUNT)
    expect(maskCount(4)).toBe(SMALL_COUNT)
    expect(maskCount(5)).toBe(5)
    expect(SMALL_COUNT).toBe("< 5")
  })
})

describe("computeStats", () => {
  // 18-25: 6 votant (oui/oui) + 6 fort (non/non) -> T1 6/12.
  // 61+: 10 votant + 5 moyen (oui/non) -> T1 15/15, no abstainer at T1 so voters and rate are masked.
  const facts: ElectorFacts[] = [
    ...times(6, { ageBand: "18-25", level: "votant" }),
    ...times(6, { ageBand: "18-25", level: "fort", t1: non, t2: non }),
    ...times(10, { ageBand: "61+", level: "votant" }),
    ...times(5, { ageBand: "61+", level: "moyen", t1: oui, t2: non }),
    ...times(3, { ageBand: "26-40", level: "votant" }),
    // Out of the turnout figures, counted apart.
    ...times(2, { level: "hors_cible", t1: non, t2: non }),
    ...times(6, { level: "inconnu", t1: null, t2: null }),
    ...times(1, { level: "nouvel_inscrit", t1: null, t2: null }),
  ]
  const report = computeStats(facts)

  it("computes turnout per age band, masking cells under 5 persons", () => {
    const rows = report.dimensions.age
    expect(rows.map((r) => r.key)).toEqual(["18-25", "26-40", "61+"])
    expect(rows[0]?.t1).toEqual({ eligible: 12, voters: 6, abstainers: 6, rate: 0.5 })
    expect(rows[0]?.t2).toEqual({ eligible: 12, voters: 6, abstainers: 6, rate: 0.5 })
    expect(rows[1]?.t1).toEqual({ eligible: SMALL_COUNT, voters: SMALL_COUNT, abstainers: SMALL_COUNT, rate: SMALL_COUNT })
    // 15 eligible, 0 abstainers at T1: the voters and the rate would reveal the small group.
    expect(rows[2]?.t1).toEqual({ eligible: 15, voters: SMALL_COUNT, abstainers: SMALL_COUNT, rate: SMALL_COUNT })
    expect(rows[2]?.t2).toEqual({ eligible: 15, voters: 10, abstainers: 5, rate: 10 / 15 })
  })

  it("leaves hors cible, inconnu and nouvel inscrit out of the figures", () => {
    expect(report.overall.t1).toEqual({ eligible: 30, voters: 24, abstainers: 6, rate: 24 / 30 })
    expect(report.population).toEqual({ targeted: 30, unknown: 6, newRegistrants: SMALL_COUNT })
  })

  it("splits flows between rounds and they sum to the electors with both rounds readable", () => {
    expect(report.flows).toEqual({ total: 30, both: 19, t1Only: 5, t2Only: SMALL_COUNT, neither: 6 })
    const big = computeStats([
      ...times(7, {}),
      ...times(8, { level: "moyen", t1: oui, t2: non }),
      ...times(9, { level: "moyen", t1: non, t2: oui }),
      ...times(10, { level: "fort", t1: non, t2: non }),
      ...times(4, { level: "moyen", t1: illisible, t2: non }),
    ])
    const f = big.flows
    expect(f).toEqual({ total: 34, both: 7, t1Only: 8, t2Only: 9, neither: 10 })
  })

  it("excludes an unreadable round for that elector in that round only", () => {
    const r = computeStats([
      ...times(5, {}),
      ...times(5, { level: "moyen", t1: illisible, t2: non }),
      ...times(5, { level: "fort", t1: non, t2: non }),
    ])
    expect(r.overall.t1).toEqual({ eligible: 10, voters: 5, abstainers: 5, rate: 0.5 })
    expect(r.overall.t2).toEqual({ eligible: 15, voters: 5, abstainers: 10, rate: 5 / 15 })
    expect(r.flows.total).toBe(10)
  })

  it("groups streets by key and shows a street of 3 electors as < 5", () => {
    const r = computeStats([
      ...times(6, {}),
      ...times(5, { level: "fort", t1: non, t2: non }),
      ...times(3, { streetKey: "keravelo", streetName: "Keravélo" }),
      ...times(2, { streetKey: null, streetName: null }),
    ])
    const rows = r.dimensions.rue
    expect(rows.map((x) => x.label)).toEqual(["Keravélo", "Rue de Limur", "Adresse à rattacher"])
    expect(rows[0]?.t1).toEqual({ eligible: SMALL_COUNT, voters: SMALL_COUNT, abstainers: SMALL_COUNT, rate: SMALL_COUNT })
    expect(rows[0]?.profile.voters).toEqual({ count: SMALL_COUNT, share: SMALL_COUNT })
    expect(rows[1]?.t1).toEqual({ eligible: 11, voters: 6, abstainers: 5, rate: 6 / 11 })
  })

  it("compares the profile of voters and abstainers (fort and moyen) as shares", () => {
    const r = computeStats([
      ...times(10, { sex: "F" }),
      ...times(5, { sex: "M" }),
      ...times(6, { sex: "F", level: "fort", t1: non, t2: non }),
      ...times(6, { sex: "M", level: "moyen", t1: oui, t2: non }),
      ...times(2, { sex: null, level: "moyen", t1: oui, t2: non }),
    ])
    expect(r.profileTotals).toEqual({ voters: 15, abstainers: 14 })
    const [f, m, unknown] = r.dimensions.sexe
    expect(f?.label).toBe("Femmes")
    expect(f?.profile).toEqual({ voters: { count: 10, share: 10 / 15 }, abstainers: { count: 6, share: 6 / 14 } })
    expect(m?.profile).toEqual({ voters: { count: 5, share: 5 / 15 }, abstainers: { count: 6, share: 6 / 14 } })
    expect(unknown?.profile.abstainers).toEqual({ count: SMALL_COUNT, share: SMALL_COUNT })
  })

  it("counts proxies per round as indicative, masked when small", () => {
    const r = computeStats([...times(6, { t1: { value: "oui", proxy: true } }), ...times(2, { t2: { value: "oui", proxy: true } })])
    expect(r.proxies.t1).toBe(6)
    expect(r.proxies.t2).toBe(SMALL_COUNT)
    expect(r.proxies.note).toBe("Indicatif : l'annotation des procurations varie selon les registres.")
  })
})

describe("campaign", () => {
  it("counts a door visited twice once, sessions as distinct dates, ignoring cancellations and earlier visits", () => {
    const a = campaignActivity(
      [
        { addressId: "a", visitDate: "2027-01-10", qualification: null },
        { addressId: "a", visitDate: "2027-01-17", qualification: null },
        { addressId: "b", visitDate: "2027-01-17", qualification: null },
        { addressId: "c", visitDate: "2027-01-20", qualification: "annulation" },
        { addressId: "d", visitDate: "2026-12-20", qualification: null },
      ],
      "2027-01-01",
    )
    expect(a).toEqual({ doorsVisited: 2, sessions: 2 })
  })

  it("measures the coverage of high-potential doors and of addresses without voters", () => {
    const c = campaignCoverage(
      [
        { kind: "number", category: "abstention_forte", lastVisit: "2027-01-10" },
        { kind: "number", category: "abstention_forte", lastVisit: "2026-12-01" },
        { kind: "number", category: "abstention_forte", lastVisit: null },
        { kind: "street", category: "abstention_forte", lastVisit: null },
        { kind: "number", category: "sans_inscrit", lastVisit: "2027-02-01" },
        { kind: "number", category: "votants", lastVisit: "2027-02-01" },
      ],
      "2027-01-01",
    )
    expect(c.highPotential).toEqual({ total: 3, covered: 1, share: 1 / 3 })
    expect(c.noVoter).toEqual({ total: 1, covered: 1, share: 1 })
  })
})
