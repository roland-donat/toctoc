import { describe, expect, it } from "vitest"
import type { SheetVisit } from "./carte-api"
import { initialRows, isDirty, newRow, patchOf, rowFromVisit, toFeedback } from "./paper-rows"

function visit(overrides: Partial<SheetVisit>): SheetVisit {
  return {
    id: crypto.randomUUID(),
    addressId: "a",
    dwelling: null,
    visitDate: "2027-02-27",
    recordedAt: 0,
    source: "lien",
    contact: "absent",
    contactQuality: null,
    toAccompany: false,
    toRevisit: false,
    qualification: null,
    qualificationScope: null,
    remarks: null,
    itineraryId: "it",
    correctedAt: null,
    ...overrides,
  }
}

describe("initialRows", () => {
  it("puts the recorded feedbacks on their door and a blank line on the others, without cancellations", () => {
    const rows = initialRows(
      ["a", "b", "c"],
      [visit({ addressId: "a" }), visit({ addressId: "a", contact: "obtenu" }), visit({ addressId: "c", qualification: "annulation", contact: null })],
      true,
    )
    expect(rows.map((r) => [r.addressId, r.stored === null])).toEqual([
      ["a", false],
      ["a", false],
      ["b", true],
      ["c", true],
    ])
    expect(rows.slice(0, 2).every((r) => !isDirty(r))).toBe(true)
  })

  it("flags a phone and a paper feedback on the same door and day as possible duplicates", () => {
    const rows = initialRows(
      ["a", "b"],
      [
        visit({ addressId: "a", source: "lien" }),
        visit({ addressId: "a", source: "feuille" }),
        visit({ addressId: "b", source: "lien" }),
        visit({ addressId: "b", source: "feuille", visitDate: "2027-02-28" }),
      ],
      true,
    )
    expect(rows.map((r) => r.possibleDuplicate)).toEqual([true, true, false, false])
  })
})

describe("patchOf", () => {
  it("sends only the changed fields", () => {
    const row = rowFromVisit(visit({ contact: "absent", remarks: "boîte B" }), true)
    const edited = { ...row, contact: "obtenu" as const, quality: "poli" as const, toRevisit: true }
    expect(patchOf(row.stored!, toFeedback(edited), row.textsMasked)).toEqual({ contact: "obtenu", contactQuality: "poli", toRevisit: true })
  })

  it("never sends the texts hidden by the anonymous mode", () => {
    const row = rowFromVisit(visit({ dwelling: null, remarks: null }), false)
    expect(row.textsMasked).toBe(true)
    const edited = { ...row, dwelling: "typed anyway", toAccompany: true }
    expect(patchOf(row.stored!, toFeedback(edited), row.textsMasked)).toEqual({ toAccompany: true })
  })

  it("clears a text emptied by the administrator when the texts are shown", () => {
    const row = rowFromVisit(visit({ remarks: "x" }), true)
    expect(patchOf(row.stored!, toFeedback({ ...row, remarks: " " }), false)).toEqual({ remarks: null })
  })
})

describe("newRow", () => {
  it("starts unsaved and editable", () => {
    const row = newRow("a")
    expect(row.stored).toBeNull()
    expect(isDirty(row)).toBe(true)
  })
})
