import { describe, expect, it } from "vitest"
import { cleanUnitLabel, listUnitId, unitLabelFromComplements, unitLabelKey } from "./dwelling-units.ts"

describe("unitLabelFromComplements", () => {
  it("keeps the complements that locate a dwelling", () => {
    expect(unitLabelFromComplements("BAT B", "APT 12")).toBe("BAT B, APT 12")
    expect(unitLabelFromComplements("Résidence Les Pins, Appartement 4", null)).toBe("Résidence Les Pins, Appartement 4")
    expect(unitLabelFromComplements(null, "3EME ETAGE")).toBe("3EME ETAGE")
    expect(unitLabelFromComplements("ESCALIER 2", "RESIDENCE DU PORT")).toBe("ESCALIER 2")
  })

  it("never keeps a complement naming someone, a residence alone or an unknown shape", () => {
    expect(unitLabelFromComplements("CHEZ ALPHA", "APT 3")).toBeNull()
    expect(unitLabelFromComplements("C/O BRAVO", null)).toBeNull()
    expect(unitLabelFromComplements("RESIDENCE DU PORT", null)).toBeNull()
    expect(unitLabelFromComplements("LE CLOS FLEURI", null)).toBeNull()
    expect(unitLabelFromComplements("  ", null)).toBeNull()
  })
})

describe("unit labels", () => {
  it("cleans and keys labels so that the same dwelling is not added twice", () => {
    expect(cleanUnitLabel("  Bât. B   2e  ")).toBe("Bât. B 2e")
    expect(cleanUnitLabel("   ")).toBeNull()
    expect(unitLabelKey("Bât. B 2e")).toBe(unitLabelKey("BAT B 2E"))
    expect(unitLabelKey("Bât. B, 2e gauche")).toBe(unitLabelKey("bat b 2e gauche"))
  })

  it("derives a stable id for a unit of the list", () => {
    expect(listUnitId("a1", "bat b")).toBe(listUnitId("a1", "bat b"))
    expect(listUnitId("a1", "bat b")).not.toBe(listUnitId("a2", "bat b"))
  })
})
