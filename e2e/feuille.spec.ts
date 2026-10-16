import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { openAsAdmin } from "./helpers.ts"

// Desktop project. The fictional itinerary "e2e-itineraire" of three fixture doors is inserted by e2e/prepare.ts.
// Names are masked: the switch is on "anonyme" by default, so the sheet must not carry any fixture name.

/** Surnames, usage names and first names of the fictional REP fixture (columns 4 to 6). */
function fixtureNames(): string[] {
  const lines = readFileSync("tests/fixtures/rep-2026.csv", "utf8").split(/\r?\n/).slice(1)
  const names = new Set<string>()
  for (const line of lines) {
    const cells = line.split(";").map((c) => c.replace(/^"|"$/g, "").trim())
    for (const cell of cells.slice(3, 6)) {
      for (const word of cell.split(/\s+/)) if (word.length >= 3) names.add(word)
    }
  }
  return [...names]
}

test("the printable sheet lists the doors in visit order, without any name, and hides the admin navigation on paper", async ({ page }) => {
  await openAsAdmin(page, "/sessions/e2e-itineraire/feuille")

  const rows = page.getByTestId("sheet-door")
  await expect(rows).toHaveCount(3)
  await expect(page.getByRole("button", { name: "Imprimer" })).toBeVisible()

  // The visit order of the itinerary, read from its detail with the same admin session.
  const detail = (await (await page.request.get("/api/itineraires/e2e-itineraire")).json()) as { doors: { label: string }[] }
  await expect(page.getByTestId("sheet-door-label")).toHaveText(detail.doors.map((d) => d.label))

  const names = fixtureNames()
  expect(names.length).toBeGreaterThan(10)
  const table = (await page.getByRole("table", { name: "Portes dans l'ordre de visite" }).innerText()).toUpperCase()
  expect(names.filter((n) => table.includes(n.toUpperCase()))).toEqual([])

  const nav = page.getByRole("navigation", { name: "Navigation principale" })
  await expect(nav).toBeVisible()
  await page.emulateMedia({ media: "print" })
  await expect(nav).toBeHidden()
  await expect(page.getByRole("button", { name: "Imprimer" })).toBeHidden()
  await expect(rows).toHaveCount(3)
  await expect(rows.first()).toBeVisible()
})
