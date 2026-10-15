import { describe, expect, it } from "vitest"
import { CATEGORY_COLORS, type MapAddress } from "./carte-api"
import { BASE_RADIUS, doorPoints, groupCounts, MAX_RADIUS, radiusFor } from "./door-symbols"

const none: MapAddress["counts"] = { fort: 0, moyen: 0, votant: 0, hors_cible: 0, inconnu: 0, nouvel_inscrit: 0 }

describe("radiusFor", () => {
  it("makes the area proportional to the count, with a floor and a ceiling", () => {
    expect(radiusFor(0)).toBe(BASE_RADIUS)
    expect(radiusFor(1)).toBe(BASE_RADIUS)
    expect(radiusFor(4)).toBeCloseTo(2 * BASE_RADIUS)
    expect(radiusFor(500)).toBe(MAX_RADIUS)
  })
})

describe("groupCounts", () => {
  it("merges new registrants with strong abstention and unknown with off-target, in legend order", () => {
    expect(groupCounts({ ...none, votant: 3, nouvel_inscrit: 1, fort: 2, hors_cible: 1, inconnu: 1 })).toEqual([
      { group: "abstention_forte", count: 3 },
      { group: "votants", count: 3 },
      { group: "autres", count: 2 },
    ])
  })
})

describe("doorPoints", () => {
  it("draws a single centered point for a house with one behavior", () => {
    const points = doorPoints({ category: "votants", counts: { ...none, votant: 2 } })
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ key: "votants", count: 2, offset: [0, 0] })
  })

  it.each([
    [{ ...none, fort: 4, votant: 1 }],
    [{ ...none, fort: 4, moyen: 1, votant: 9 }],
    [{ ...none, fort: 1, moyen: 30, votant: 2, inconnu: 1 }],
  ])("spreads one point per behavior around a building without overlap (%o)", (counts) => {
    const points = doorPoints({ category: "abstention_forte", counts })
    expect(points.length).toBeGreaterThan(1)
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const [a, b] = [points[i]!, points[j]!]
        const distance = Math.hypot(a.offset[0] - b.offset[0], a.offset[1] - b.offset[1])
        expect(distance).toBeGreaterThanOrEqual(a.radius + b.radius - 0.2)
      }
    }
  })

  it("keeps the category color for an excluded door or a door without elector", () => {
    expect(doorPoints({ category: "exclue", counts: { ...none, fort: 3 } })).toEqual([
      { key: "door", color: CATEGORY_COLORS.exclue, count: 0, radius: BASE_RADIUS, offset: [0, 0] },
    ])
    expect(doorPoints({ category: "sans_inscrit", counts: none })[0]?.color).toBe(CATEGORY_COLORS.sans_inscrit)
  })
})
