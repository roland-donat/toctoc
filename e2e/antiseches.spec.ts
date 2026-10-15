import { expect, test } from "@playwright/test"
import { openAsAdmin } from "./helpers.ts"

const PAYLOAD = `<img src=x onerror="window.__xss=1">Bonjour`

test("cheat sheet body is rendered as text, never executed", async ({ page }) => {
  await openAsAdmin(page, "/antiseches")
  await expect(page.getByRole("heading", { name: "Antisèches" })).toBeVisible()

  const section = page.getByRole("region", { name: "Générale" })
  await section.getByRole("button", { name: "Ajouter une antisèche" }).click()
  const body = section.getByLabel("Texte de l'antisèche").first()
  await body.fill(PAYLOAD)
  await expect(section.getByText("Enregistré").first()).toBeVisible()

  await page.reload()
  await expect(page.getByTestId("cheatsheet-preview").filter({ hasText: PAYLOAD }).first()).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
})
