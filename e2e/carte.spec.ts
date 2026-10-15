import { expect, test, type Page } from "@playwright/test"
import { openAsAdmin } from "./helpers.ts"

// Runs on the fictional fixtures loaded by e2e/prepare.ts (32 BAN numbers + the Keravélo street address,
// 20 located electors). Names are masked: the switch is on "anonyme" by default.

/** Number of painted pixels of the markers canvas (Leaflet draws circle markers on one canvas with preferCanvas). */
function paintedMarkerPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".leaflet-overlay-pane canvas")
    const g = canvas?.getContext("2d")
    if (!canvas || !g || canvas.width === 0 || canvas.height === 0) return 0
    const { data } = g.getImageData(0, 0, canvas.width, canvas.height)
    let painted = 0
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) painted++
    return painted
  })
}

test("map shows the fixture doors, filters them and opens an address sheet", async ({ page }) => {
  const tile = page.waitForResponse(
    (r) =>
      r.url().startsWith("https://tile.openstreetmap.org/") &&
      r.status() === 200 &&
      (r.headers()["content-type"] ?? "").startsWith("image/"),
  )
  await openAsAdmin(page, "/carte")

  const counters = page.getByTestId("map-counters")
  await expect(counters).toContainText("33 portes, 20 électeurs")
  await expect.poll(() => paintedMarkerPixels(page)).toBeGreaterThan(0)

  // Abstention forte: 13 bis, 22 and 8 rue de Limur, and the Keravélo street address (1 + 6 + 1 + 1 electors).
  // The checkbox is driven by the URL search params, so its state changes after the navigation settles.
  const strong = page.getByRole("checkbox", { name: "Abstention forte" })
  await strong.click()
  await expect(strong).toBeChecked()
  await expect(counters).toContainText("4 portes, 9 électeurs")

  // Then 18-25 and bureau 0001: only the building at 22, with one such elector.
  await page.getByRole("button", { name: "18-25 ans" }).click()
  await page.getByLabel("Bureau").selectOption("0001")
  await expect(counters).toContainText("1 porte, 1 électeur")

  // The view fits the single remaining door, so it sits at the center of the map.
  const sheet = page.getByRole("complementary", { name: "Fiche adresse" })
  const map = page.getByTestId("door-map")
  await expect(async () => {
    const box = await map.boundingBox()
    if (!box) throw new Error("map not laid out")
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(sheet).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })

  await expect(sheet.getByRole("heading", { name: "22 Rue de Limur" })).toBeVisible()
  await expect(sheet.getByTestId("sheet-voter")).toHaveCount(6)
  await expect(sheet.getByRole("columnheader", { name: "Nom" })).toHaveCount(0)
  await expect(sheet).not.toContainText("ECHO")

  // At least one base-map tile answered with an image.
  const response = await tile
  expect(response.status()).toBe(200)
})
