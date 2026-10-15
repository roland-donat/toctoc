import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"

// Phone project only. The fixture building of e2e/prepare.ts has six apartments read from the list complements
// (fictional people); its link shows them, takes a feedback on one, and a new dwelling met on the spot.
const token = readFileSync("/tmp/toctoc-e2e/field-token-immeuble.txt", "utf8").trim()

test("a building lists its dwellings, takes a feedback on one and a dwelling added on the spot", async ({ page }) => {
  await page.goto(`/terrain#${token}`)
  const units = page.getByTestId("field-units")
  await expect(units).toBeVisible()
  const progress = page.getByTestId("field-units-progress")
  await expect(progress).toHaveText("Logements : 0 visité sur 6")

  // A feedback on apartment 3, from its own line.
  await units.getByRole("listitem").filter({ hasText: "Appartement 3" }).getByRole("button", { name: "Retour" }).click()
  await expect(page.getByRole("combobox", { name: /^Logement/ })).toHaveValue(/.+/)
  await page.getByRole("button", { name: "Absent", exact: true }).click()
  await page.getByRole("button", { name: "Envoyer le retour" }).click()
  await expect(progress).toHaveText("Logements : 1 visité sur 6")
  await expect(units.getByRole("listitem").filter({ hasText: "Appartement 3" })).toContainText("absent")

  // A household met in a dwelling the list does not know, not registered.
  await units.getByRole("button", { name: "Ajouter un logement" }).click()
  await page.getByPlaceholder("Bâtiment, étage, porte (jamais de nom)").fill("Bât. B, 2e gauche")
  await page.getByRole("button", { name: "Contact obtenu" }).click()
  await page.getByRole("button", { name: "Foyer non inscrit sur les listes" }).click()
  await page.getByRole("button", { name: "Envoyer le retour" }).click()
  await expect(progress).toHaveText("Logements : 2 visités sur 7")
  await expect(page.getByTestId("field-entered").last()).toContainText("Bât. B, 2e gauche")
  await expect(page.getByTestId("field-entered").last()).toContainText("Transmis")

  // After a reload, the dwelling added on the phone comes back from the server.
  await page.reload()
  await expect(page.getByTestId("field-units-progress")).toHaveText("Logements : 2 visités sur 7")
  await expect(page.getByTestId("field-units")).toContainText("non inscrit")
})
