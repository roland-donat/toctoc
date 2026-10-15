import { describe, expect, it } from "vitest"
import { matchKey, normalizeStreet, normalizeText, splitNumber, streetKey } from "./address-normalize.ts"

describe("normalizeText", () => {
  it("lowercases, strips accents, turns hyphens, apostrophes and dots into spaces", () => {
    expect(normalizeText("  Allée de l'Étang-Neuf. ")).toBe("allee de l etang neuf")
    expect(normalizeText("Keravélo")).toBe("keravelo")
    expect(normalizeText("Rue  du   Golfe")).toBe("rue du golfe")
  })
})

describe("normalizeStreet", () => {
  it.each([
    ["R. du Golfe", "rue du golfe"],
    ["r du golfe", "rue du golfe"],
    ["Av. des Pins", "avenue des pins"],
    ["BD de la Mer", "boulevard de la mer"],
    ["Imp. des Mouettes", "impasse des mouettes"],
    ["Chem. du Moulin", "chemin du moulin"],
    ["Ch du Moulin", "chemin du moulin"],
    ["All. des Chênes", "allee des chenes"],
    ["Pl. de l'Église", "place de l eglise"],
    ["Rte de Vannes", "route de vannes"],
    ["Rés. Les Hauts", "residence les hauts"],
    ["Sq. Mozart", "square mozart"],
    ["Lot. Le Clos", "lotissement le clos"],
    ["LD Kerarden", "lieu dit kerarden"],
    ["Lieu-dit Kerarden", "lieu dit kerarden"],
    ["Lieudit Kerarden", "lieu dit kerarden"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeStreet(input)).toBe(expected)
  })

  it("expands abbreviations only at the start of the street name", () => {
    expect(normalizeStreet("Rue de la Pl")).toBe("rue de la pl")
    expect(normalizeStreet("Impasse du Ch")).toBe("impasse du ch")
  })

  it("leaves full words untouched", () => {
    expect(normalizeStreet("Rue de Limur")).toBe("rue de limur")
    expect(normalizeStreet("Route de Nantes")).toBe("route de nantes")
  })
})

describe("splitNumber", () => {
  it.each([
    ["13Bis", { number: 13, rep: "bis" }],
    ["13 bis", { number: 13, rep: "bis" }],
    ["12 bis", { number: 12, rep: "bis" }],
    ["12B", { number: 12, rep: "bis" }],
    ["12b", { number: 12, rep: "bis" }],
    ["12 ter", { number: 12, rep: "ter" }],
    ["12T", { number: 12, rep: "ter" }],
    ["12 quater", { number: 12, rep: "quater" }],
    ["12Q", { number: 12, rep: "quater" }],
    ["12 A", { number: 12, rep: "a" }],
    ["7", { number: 7, rep: null }],
    [" 7 ", { number: 7, rep: null }],
  ])("%s", (input, expected) => {
    expect(splitNumber(input)).toEqual(expected)
  })

  it("returns no number for an empty or non-numeric value", () => {
    expect(splitNumber("")).toEqual({ number: null, rep: null })
    expect(splitNumber("Kerarden")).toEqual({ number: null, rep: null })
  })
})

describe("matchKey and streetKey", () => {
  it("gives the same key to '12 bis R. du Golfe' and '12B rue du golfe'", () => {
    const a = splitNumber("12 bis")
    const b = splitNumber("12B")
    expect(matchKey(a.number, a.rep, "R. du Golfe")).toBe(matchKey(b.number, b.rep, "rue du golfe"))
    expect(matchKey(a.number, a.rep, "R. du Golfe")).toBe("12|bis|rue du golfe")
  })

  it("keeps the lieu-dit in '3 lieu-dit Kerarden'", () => {
    expect(matchKey(3, null, "lieu-dit Kerarden")).toBe("3||lieu dit kerarden")
    expect(streetKey("lieu-dit Kerarden")).toBe("lieu dit kerarden")
  })

  it("normalizes BAN rep values the same way as electoral list ones", () => {
    expect(matchKey(13, "bis", "Rue de Limur")).toBe(matchKey(13, "B", "R. de Limur"))
  })

  it("keeps an empty number slot when the address has no number", () => {
    expect(matchKey(null, null, "Keravélo")).toBe("||keravelo")
  })
})
