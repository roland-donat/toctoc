import { describe, expect, it } from "vitest"
import { birthPlaceGroup } from "./birth-place.ts"

const place = (birthCommuneCode: string | null, birthDepartment: string | null, birthCountry: string | null) => ({
  birthCommuneCode,
  birthDepartment,
  birthCountry,
})

describe("birthPlaceGroup", () => {
  it("groups births into the five KTD9 groups", () => {
    expect(birthPlaceGroup(place("56243", "56", "France"))).toBe("sene")
    expect(birthPlaceGroup(place("56260", "56", "France"))).toBe("morbihan")
    expect(birthPlaceGroup(place("35238", "35", "France"))).toBe("bretagne")
    expect(birthPlaceGroup(place("75056", "75", "France"))).toBe("france")
    expect(birthPlaceGroup(place(null, "99", "Portugal"))).toBe("etranger")
    expect(birthPlaceGroup(place(null, null, "Portugal"))).toBe("etranger")
  })
  it("keeps an empty birthplace apart", () => {
    expect(birthPlaceGroup(place(null, null, null))).toBe("inconnu")
  })
})
