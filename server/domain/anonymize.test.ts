import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { setSetting } from "../db/settings.ts"
import { ANONYMIZATION_KEY, anonymizationMode, anonymize, namesAllowed, setAnonymizationMode } from "./anonymize.ts"

let ctx: AppContext

beforeEach(() => {
  ctx = createTestContext().ctx
})

describe("anonymization mode", () => {
  it("is anonyme by default", () => {
    expect(anonymizationMode(ctx.db)).toBe("anonyme")
  })

  it("reads the stored mode at each call", () => {
    setAnonymizationMode(ctx.db, "nominatif")
    expect(anonymizationMode(ctx.db)).toBe("nominatif")
    setAnonymizationMode(ctx.db, "anonyme")
    expect(anonymizationMode(ctx.db)).toBe("anonyme")
  })

  it("falls back to anonyme on an unreadable stored value", () => {
    setSetting(ctx.db, ANONYMIZATION_KEY, "nominative")
    expect(anonymizationMode(ctx.db)).toBe("anonyme")
  })
})

describe("namesAllowed", () => {
  it("refuses names while the global switch is anonyme, whatever the itinerary says", () => {
    expect(namesAllowed(ctx)).toBe(false)
    expect(namesAllowed(ctx, { itineraryShowNames: true })).toBe(false)
  })

  it("allows names on admin screens when nominatif, and on field responses only if the itinerary allows them", () => {
    setAnonymizationMode(ctx.db, "nominatif")
    expect(namesAllowed(ctx)).toBe(true)
    expect(namesAllowed(ctx, { itineraryShowNames: true })).toBe(true)
    expect(namesAllowed(ctx, { itineraryShowNames: false })).toBe(false)
  })
})

describe("anonymize", () => {
  const response = {
    label: "22 Rue de Limur",
    voters: [
      { birthName: "ALPHA", usageName: "DURAND", firstNames: "Anne", age: 76, sex: "F", votes: { t1: "oui", t2: "non" } },
    ],
    visits: [{ id: "v1", dwelling: "Boîte ZULU", remarks: "Parlé à M. ZULU", contact: "obtenu", visitDate: "2027-02-01" }],
  }

  it("removes person names and feedback free texts at any depth, keeping everything else", () => {
    const out = anonymize(response, false)
    expect(out).toEqual({
      label: "22 Rue de Limur",
      voters: [{ birthName: null, usageName: null, firstNames: null, age: 76, sex: "F", votes: { t1: "oui", t2: "non" } }],
      visits: [{ id: "v1", dwelling: null, remarks: null, contact: "obtenu", visitDate: "2027-02-01" }],
    })
    expect(JSON.stringify(out)).not.toMatch(/ALPHA|DURAND|Anne|ZULU/)
  })

  it("does not modify its input", () => {
    anonymize(response, false)
    expect(response.voters[0]?.birthName).toBe("ALPHA")
  })

  it("keeps names when they are allowed", () => {
    expect(anonymize(response, true)).toEqual(response)
  })
})
