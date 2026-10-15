import { expect, type Page } from "@playwright/test"

/** Opens an admin page, logging in first when the session is missing, and waits until the page is shown. */
export async function openAsAdmin(page: Page, path: string): Promise<void> {
  await page.goto(path)
  const logout = page.getByRole("button", { name: "Se déconnecter" })
  const passwordField = page.getByLabel("Mot de passe")
  // The URL still shows `path` until the auth check redirects, so wait for what the page renders instead.
  await expect(logout.or(passwordField)).toBeVisible()
  if (await passwordField.isVisible()) {
    await passwordField.fill(process.env.TOCTOC_E2E_PASSWORD ?? "")
    await page.getByRole("button", { name: "Se connecter" }).click()
    await page.waitForURL((url) => url.pathname === path)
  }
  await expect(logout).toBeVisible()
}
