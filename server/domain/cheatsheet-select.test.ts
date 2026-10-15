import { describe, expect, it } from "vitest"
import { cheatsheetsForDoor } from "./cheatsheet-select.ts"
import type { AgeBand } from "../db/schema/cheatsheets.ts"

const sheets = [
  { id: "a", ageBand: "18-25" as const, title: "Young" },
  { id: "b", ageBand: "26-40" as const, title: "Adult" },
  { id: "c", ageBand: "61+" as const, title: "Senior 1" },
  { id: "d", ageBand: "61+" as const, title: "Senior 2" },
  { id: "e", ageBand: "generale" as const, title: "General" },
]

describe("cheatsheetsForDoor", () => {
  it("returns the 18-25 and 61+ sheets for a door with a 22-year-old and a 70-year-old", () => {
    const bands: AgeBand[] = ["61+", "18-25"]
    expect(cheatsheetsForDoor(bands, sheets).map((s) => s.id)).toEqual(["a", "c", "d"])
  })

  it("does not duplicate a band present several times", () => {
    expect(cheatsheetsForDoor(["61+", "61+"], sheets).map((s) => s.id)).toEqual(["c", "d"])
  })

  it("returns the general sheets for an address without a targeted registered voter", () => {
    expect(cheatsheetsForDoor([], sheets).map((s) => s.id)).toEqual(["e"])
  })
})
