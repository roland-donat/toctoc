import { expect, test } from "@playwright/test"
import { openAsAdmin } from "./helpers.ts"

// Desktop project. "e2e-a-supprimer" is a fictional session of e2e/prepare.ts used by this spec only: it is
// renamed, archived, restored, then deleted with its feedback.
test("sessions are listed with their progress, renamed, archived, restored and deleted after confirmation", async ({ page }) => {
  await openAsAdmin(page, "/sessions")
  await expect(page.getByRole("heading", { name: "Sessions TocToc" })).toBeVisible()
  await expect(page.getByTestId("session-row")).toHaveCount(3)
  await expect(page.getByTestId("session-row").first().getByTestId("session-progress")).toContainText("portes")

  // The old addresses lead to the new screens.
  await page.goto("/suivi?itineraire=e2e-a-supprimer")
  await expect(page).toHaveURL(/\/sessions\/e2e-a-supprimer\?onglet=retours/)

  await page.goto("/sessions/e2e-a-supprimer")
  const name = page.getByLabel("Nom de la session")
  await name.fill("Tournée test")
  // Saved as typed: the list shows it after the save delay.
  await expect(async () => {
    await page.goto("/sessions")
    await expect(page.getByRole("link", { name: "Tournée test" })).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })

  const row = page.getByTestId("session-row").filter({ hasText: "Tournée test" })
  await row.getByRole("button", { name: "Historique de Tournée test" }).click()
  await expect(page.getByTestId("session-history")).toContainText("Renommée « Tournée test »")
  await page.keyboard.press("Escape")

  await row.getByRole("button", { name: "Archiver" }).click()
  await expect(page.getByTestId("session-row")).toHaveCount(2)
  await page.getByRole("link", { name: "Archivées" }).click()
  const archived = page.getByTestId("session-row").filter({ hasText: "Tournée test" })
  await expect(archived).toContainText("Aucun lien")
  await archived.getByRole("link", { name: "Tournée test" }).click()
  await expect(page.getByTestId("session-archived")).toBeVisible()
  await page.getByRole("button", { name: "Restaurer" }).click()
  await expect(page.getByTestId("session-archived")).toHaveCount(0)

  await page.getByRole("button", { name: "Supprimer" }).click()
  const box = page.getByRole("checkbox", { name: /Supprimer aussi les retours/ })
  await expect(box).toBeChecked()
  await page.getByRole("button", { name: "Supprimer la session" }).click()
  await expect(page).toHaveURL(/\/sessions$/)
  await expect(page.getByTestId("session-row")).toHaveCount(2)
  await expect(page.getByRole("link", { name: "Tournée test" })).toHaveCount(0)
})
