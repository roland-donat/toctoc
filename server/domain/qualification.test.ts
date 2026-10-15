import { describe, expect, it } from "vitest"
import {
  activeExclusion,
  addressCategory,
  followUpState,
  latestVisitDate,
  parisDate,
  type VisitFacts,
} from "./qualification.ts"

const TODAY = "2027-03-01"

function visit(over: Partial<VisitFacts>): VisitFacts {
  return {
    visitDate: "2027-02-01",
    recordedAt: 0,
    dwelling: null,
    toRevisit: false,
    toAccompany: false,
    qualification: null,
    qualificationScope: null,
    ...over,
  }
}

describe("activeExclusion", () => {
  it("excludes an address qualified as a whole, until a later cancellation (AE2)", () => {
    const qualified = visit({ visitDate: "2027-02-01", qualification: "residence_secondaire" })
    expect(activeExclusion([qualified])).toBe("residence_secondaire")
    const cancelled = visit({ visitDate: "2027-02-10", qualification: "annulation" })
    expect(activeExclusion([qualified, cancelled])).toBeNull()
  })

  it("lets a qualification entered after a cancellation exclude again", () => {
    const events = [
      visit({ visitDate: "2027-02-01", qualification: "non_habitation" }),
      visit({ visitDate: "2027-02-10", qualification: "annulation" }),
      visit({ visitDate: "2027-02-20", qualification: "logement_vide", qualificationScope: "immeuble", dwelling: "hall" }),
    ]
    expect(activeExclusion(events)).toBe("logement_vide")
  })

  it("never excludes a building for a qualification on one dwelling", () => {
    expect(activeExclusion([visit({ dwelling: "apt 4", qualification: "logement_vide" })])).toBeNull()
    expect(
      activeExclusion([visit({ dwelling: "apt 4", qualification: "logement_vide", qualificationScope: "logement" })]),
    ).toBeNull()
  })

  it("orders events by visit date, then by entry time", () => {
    const sameDay = [
      visit({ visitDate: "2027-02-10", recordedAt: 2, qualification: "annulation" }),
      visit({ visitDate: "2027-02-10", recordedAt: 1, qualification: "non_habitation" }),
    ]
    expect(activeExclusion(sameDay)).toBeNull()
    // A paper re-entry of an older visit, typed after the cancellation, does not override it.
    const reentered = [
      visit({ visitDate: "2027-02-10", recordedAt: 1, qualification: "annulation" }),
      visit({ visitDate: "2027-02-05", recordedAt: 2, qualification: "non_habitation" }),
    ]
    expect(activeExclusion(reentered)).toBeNull()
  })
})

describe("followUpState", () => {
  it("is jamais_visitee without any visit", () => {
    expect(followUpState([], TODAY, 30)).toBe("jamais_visitee")
  })

  it("is a_revoir when the latest visit asked to come back 21 days ago (AE3)", () => {
    expect(followUpState([visit({ visitDate: "2027-02-08", toRevisit: true })], TODAY, 30)).toBe("a_revoir")
  })

  it("is a_revoir whatever the age of the visit when someone is to accompany", () => {
    expect(followUpState([visit({ visitDate: "2026-11-01", toAccompany: true })], TODAY, 30)).toBe("a_revoir")
  })

  it("is visitee_recemment after a visit without follow-up the day before (AE3)", () => {
    expect(followUpState([visit({ visitDate: "2027-02-28" })], TODAY, 30)).toBe("visitee_recemment")
  })

  it("is visitee once the last visit is 30 days old or more", () => {
    expect(followUpState([visit({ visitDate: "2027-01-30" })], TODAY, 30)).toBe("visitee")
    expect(followUpState([visit({ visitDate: "2027-01-31" })], TODAY, 30)).toBe("visitee_recemment")
  })

  it("follows the latest visit date, not the entry time (paper re-entry)", () => {
    const visits = [
      visit({ visitDate: "2027-02-25", recordedAt: 1 }),
      visit({ visitDate: "2027-02-08", recordedAt: 9, toRevisit: true }),
    ]
    expect(followUpState(visits, TODAY, 30)).toBe("visitee_recemment")
  })

  it("keeps a_revoir when one dwelling of the latest session asked to come back", () => {
    const visits = [
      visit({ visitDate: "2027-02-25", recordedAt: 1, dwelling: "apt 7", toAccompany: true }),
      visit({ visitDate: "2027-02-25", recordedAt: 2, dwelling: "hall" }),
    ]
    expect(followUpState(visits, TODAY, 30)).toBe("a_revoir")
  })

  it("ignores cancellation rows", () => {
    const visits = [visit({ visitDate: "2027-02-28", qualification: "annulation" })]
    expect(followUpState(visits, TODAY, 30)).toBe("jamais_visitee")
    expect(latestVisitDate(visits)).toBeNull()
  })
})

describe("addressCategory", () => {
  const none = { excluded: false, streetLevelElectorsOnStreet: false, proposedForQueuedElector: false }

  it("ranks the worst potential first", () => {
    expect(addressCategory({ ...none, levels: ["votant", "moyen", "fort"] })).toBe("abstention_forte")
    // A 2027 new registrant is a strong-potential target (decided on 13/10/2026).
    expect(addressCategory({ ...none, levels: ["votant", "nouvel_inscrit"] })).toBe("abstention_forte")
    expect(addressCategory({ ...none, levels: ["votant", "moyen"] })).toBe("abstention_moyenne")
    expect(addressCategory({ ...none, levels: ["votant"] })).toBe("votants")
  })

  it("puts an address whose only voter is inconnu or hors cible with the votants", () => {
    expect(addressCategory({ ...none, levels: ["inconnu"] })).toBe("votants")
    expect(addressCategory({ ...none, levels: ["hors_cible"] })).toBe("votants")
  })

  it("is sans_inscrit without voter, non_localise when the street has street-level electors", () => {
    expect(addressCategory({ ...none, levels: [] })).toBe("sans_inscrit")
    expect(addressCategory({ ...none, streetLevelElectorsOnStreet: true, levels: [] })).toBe("non_localise")
    expect(addressCategory({ ...none, proposedForQueuedElector: true, levels: [] })).toBe("non_localise")
  })

  it("is exclue before anything else", () => {
    expect(addressCategory({ ...none, excluded: true, levels: ["fort"] })).toBe("exclue")
    expect(addressCategory({ ...none, excluded: true, levels: [] })).toBe("exclue")
  })
})

describe("parisDate", () => {
  it("gives the calendar date in Paris", () => {
    expect(parisDate(new Date("2027-03-01T23:30:00Z"))).toBe("2027-03-02")
    expect(parisDate(new Date("2027-03-01T10:00:00Z"))).toBe("2027-03-01")
  })
})
