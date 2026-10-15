import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { addresses, visits } from "../db/schema/index.ts"
import { cancelQualification, listVisits, recordVisit, VisitError } from "./visits.ts"

const BUILDING = "56243_0110_00022"
const ID1 = "11111111-1111-4111-8111-111111111111"
const ID2 = "22222222-2222-4222-8222-222222222222"
const ID3 = "33333333-3333-4333-8333-333333333333"

let ctx: AppContext
let setNow: (d: Date) => void

beforeEach(() => {
  const t = createTestContext({ now: new Date("2027-03-01T10:00:00Z") })
  ctx = t.ctx
  setNow = t.setNow
  ctx.db
    .insert(addresses)
    .values({
      id: BUILDING,
      kind: "number",
      number: 22,
      streetName: "Rue de Limur",
      streetKey: "rue de limur",
      inseeCode: "56243",
      matchKey: "22|rue de limur",
      lat: 47.6,
      lon: -2.7,
      updatedAt: 0,
    })
    .run()
})

describe("recordVisit", () => {
  it("stores the R18 fields, the dwelling, the visit date and the source", () => {
    const { visit, created } = recordVisit(ctx, {
      id: ID1,
      addressId: BUILDING,
      source: "feuille",
      visitDate: "2027-02-20",
      dwelling: "apt 7",
      contact: "obtenu",
      contactQuality: "chaleureux",
      toAccompany: true,
      remarks: "Rappeler en soirée",
    })
    expect(created).toBe(true)
    expect(visit).toMatchObject({
      id: ID1,
      addressId: BUILDING,
      source: "feuille",
      visitDate: "2027-02-20",
      recordedAt: new Date("2027-03-01T10:00:00Z").getTime(),
      dwelling: "apt 7",
      contact: "obtenu",
      contactQuality: "chaleureux",
      toAccompany: true,
      toRevisit: false,
      qualification: null,
      remarks: "Rappeler en soirée",
    })
  })

  it("dates an admin entry without visit date with today in Paris", () => {
    setNow(new Date("2027-03-01T23:30:00Z"))
    const { visit } = recordVisit(ctx, { id: ID1, addressId: BUILDING, source: "admin", contact: "absent" })
    expect(visit.visitDate).toBe("2027-03-02")
  })

  it("creates one row when the same client id is sent twice (KTD10)", () => {
    const first = recordVisit(ctx, { id: ID1, addressId: BUILDING, source: "lien", contact: "absent" })
    setNow(new Date("2027-03-01T10:05:00Z"))
    const second = recordVisit(ctx, { id: ID1, addressId: BUILDING, source: "lien", contact: "absent" })
    expect(second.created).toBe(false)
    expect(second.visit).toEqual(first.visit)
    expect(ctx.db.select().from(visits).all()).toHaveLength(1)
  })

  it("keeps three feedbacks on three dwellings of one building on the address (AE5)", () => {
    recordVisit(ctx, { id: ID1, addressId: BUILDING, source: "lien", dwelling: "apt 4", contact: "absent" })
    recordVisit(ctx, { id: ID2, addressId: BUILDING, source: "lien", dwelling: "apt 7", toAccompany: true })
    recordVisit(ctx, { id: ID3, addressId: BUILDING, source: "lien", dwelling: "hall", remarks: "Boîtes sans nom" })
    expect(listVisits(ctx.db, BUILDING).map((v) => v.dwelling).sort()).toEqual(["apt 4", "apt 7", "hall"])
  })

  it("refuses an unknown address", () => {
    expect(() => recordVisit(ctx, { id: ID1, addressId: "nope", source: "admin" })).toThrow(VisitError)
  })
})

describe("listVisits", () => {
  it("lists the history newest visit first, then by entry time", () => {
    recordVisit(ctx, { id: ID1, addressId: BUILDING, source: "feuille", visitDate: "2027-01-10" })
    recordVisit(ctx, { id: ID2, addressId: BUILDING, source: "feuille", visitDate: "2027-02-10" })
    setNow(new Date("2027-03-01T11:00:00Z"))
    recordVisit(ctx, { id: ID3, addressId: BUILDING, source: "feuille", visitDate: "2027-02-10" })
    expect(listVisits(ctx.db, BUILDING).map((v) => v.id)).toEqual([ID3, ID2, ID1])
  })
})

describe("cancelQualification", () => {
  it("records the cancellation as a dated admin row", () => {
    recordVisit(ctx, { id: ID1, addressId: BUILDING, source: "lien", qualification: "residence_secondaire" })
    const { visit } = cancelQualification(ctx, { addressId: BUILDING })
    expect(visit).toMatchObject({ addressId: BUILDING, source: "admin", qualification: "annulation", visitDate: "2027-03-01" })
    expect(listVisits(ctx.db, BUILDING)).toHaveLength(2)
  })

  it("refuses when no qualification excludes the address", () => {
    recordVisit(ctx, { id: ID1, addressId: BUILDING, source: "lien", dwelling: "apt 4", qualification: "logement_vide" })
    expect(() => cancelQualification(ctx, { addressId: BUILDING })).toThrow(VisitError)
  })
})
