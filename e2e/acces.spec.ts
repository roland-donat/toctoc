import { expect, test } from "@playwright/test"

// Covers AE6: an anonymous visitor sees only the login page, never the preparation.
test.describe("visiteur anonyme", () => {
  test("ouvrir l'application mène à la page de connexion, sans navigation d'administration", async ({ page }) => {
    await page.goto("/")
    await expect(page).toHaveURL(/\/login(\?|$)/)
    await expect(page.getByLabel("Mot de passe")).toBeVisible()
    await expect(page.getByRole("button", { name: "Se connecter" })).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Navigation principale" })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Carte" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Se déconnecter" })).toHaveCount(0)
  })

  test("l'API refuse les lectures d'administration sans session", async ({ request }) => {
    for (const path of ["/api/auth/me", "/api/carte", "/api/stats"]) {
      const res = await request.get(path)
      expect(res.status(), path).toBe(401)
      expect(await res.json(), path).toEqual({ error: "unauthenticated" })
    }
  })
})
