import { describe, expect, it } from "vitest"
import { ageAt, ageBand } from "./age.ts"

describe("age bands", () => {
  const ref = new Date("2027-04-10T00:00:00Z")
  it("computes the age the day before and on the birthday", () => {
    expect(ageAt("2001-04-11", ref)).toBe(25)
    expect(ageAt("2001-04-10", ref)).toBe(26)
  })
  it("maps ages to the four bands and unknown dates to null", () => {
    expect([18, 25, 26, 40, 41, 60, 61, 90].map(ageBand)).toEqual([
      "18-25", "18-25", "26-40", "26-40", "41-60", "41-60", "61+", "61+",
    ])
    expect(ageBand(ageAt(null, ref))).toBeNull()
  })
})
