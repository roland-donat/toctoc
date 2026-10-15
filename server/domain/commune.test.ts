import { describe, expect, it } from "vitest"
import { departmentOf, INSEE_CODE_PATTERN } from "./commune.ts"

describe("commune", () => {
  it("accepts INSEE codes, Corsica included, and refuses postal codes in another shape", () => {
    for (const code of ["93014", "56243", "2A004", "97411"]) expect(INSEE_CODE_PATTERN.test(code)).toBe(true)
    for (const code of ["9301", "930140", "2C004", "Séné", ""]) expect(INSEE_CODE_PATTERN.test(code)).toBe(false)
  })

  it("gives the department of the BAN file", () => {
    expect(departmentOf("93014")).toBe("93")
    expect(departmentOf("2A004")).toBe("2A")
    expect(departmentOf("97411")).toBe("974")
  })
})
