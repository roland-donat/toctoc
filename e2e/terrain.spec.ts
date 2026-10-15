import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"

// Phone project only. The fictional itinerary of three fixture doors and its active link are inserted by
// e2e/prepare.ts, which writes the (fictional) token to this file. Names are masked: the switch is on "anonyme".
const token = readFileSync("/tmp/toctoc-e2e/field-token.txt", "utf8").trim()

test("the field link works on a phone without a session, and the token never appears in a request URL", async ({ page }) => {
  // Playwright gives each test a fresh browser context: no cookie, no admin session.
  expect(await page.context().cookies()).toEqual([])
  const urls: string[] = []
  // What goes on the wire: the fragment is never part of a sent request, so it is stripped here.
  page.on("request", (r) => urls.push(r.url().split("#")[0] ?? ""))

  await page.goto(`/terrain#${token}`)
  const progress = page.getByTestId("field-progress")
  await expect(progress).toHaveText("0 porte faite sur 3")
  await expect(page.getByTestId("field-door")).toHaveCount(3)
  await expect(page.getByTestId("field-map")).toBeVisible()
  await expect(page.getByRole("button", { name: "Se déconnecter" })).toHaveCount(0)

  const first = page.getByTestId("field-door").first()
  await first.getByPlaceholder("Nom sur la boîte, repère").fill("apt 2")
  await first.getByRole("button", { name: "Absent", exact: true }).click()
  await first.getByRole("button", { name: "À revenir" }).click()
  await first.getByRole("button", { name: "Envoyer le retour" }).click()

  await expect(first.getByText("Transmis")).toBeVisible()
  await expect(progress).toHaveText("1 porte faite sur 3")
  await expect(page.getByTestId("field-pending")).toHaveCount(0)
  // A building door takes another feedback on the same address; it still counts once.
  await expect(first.getByRole("button", { name: "Ajouter un retour" })).toBeVisible()

  // A mistake is corrected, then a second feedback entered by error is removed, from the same card.
  const entered = first.getByTestId("field-entered")
  await entered.first().getByRole("button", { name: "Modifier" }).click()
  await first.getByRole("button", { name: "Contact obtenu" }).click()
  await first.getByRole("button", { name: "Enregistrer la correction" }).click()
  await expect(entered.first()).toContainText("contact obtenu")
  await expect(entered.first().getByText("Transmis")).toBeVisible()
  await first.getByRole("button", { name: "Ajouter un retour" }).click()
  await first.getByRole("button", { name: "Absent", exact: true }).click()
  await first.getByRole("button", { name: "Envoyer le retour" }).click()
  await expect(entered).toHaveCount(2)
  await expect(entered.nth(1).getByText("Transmis")).toBeVisible()
  await entered.nth(1).getByRole("button", { name: "Supprimer" }).click()
  await entered.nth(1).getByRole("button", { name: "Supprimer", exact: true }).click()
  await expect(entered).toHaveCount(1)
  await expect(page.getByTestId("field-pending")).toHaveCount(0)
  await expect(progress).toHaveText("1 porte faite sur 3")

  expect(urls.some((u) => u.includes("/api/terrain/"))).toBe(true)
  expect(urls.filter((u) => u.includes(token))).toEqual([])
  // Only the page address carries it, in the fragment.
  expect(page.url()).toContain(`#${token}`)
})

test("the field page is installable and the installed app finds the round again without the link", async ({ page }) => {
  await page.goto(`/terrain#${token}`)
  await expect(page.getByTestId("field-door")).toHaveCount(3)
  // Only the field page carries the manifest, scoped to /terrain.
  const href = await page.locator('link[rel="manifest"]').getAttribute("href")
  expect(href).toBe("/terrain.webmanifest")
  const manifest = (await (await page.request.get(href ?? "")).json()) as { start_url: string; scope: string }
  expect(manifest).toMatchObject({ start_url: "/terrain", scope: "/terrain" })

  // The home screen icon opens /terrain, without the fragment.
  await page.goto("/terrain")
  await expect(page.getByTestId("field-door")).toHaveCount(3)

  // With nothing remembered, no round is shown.
  await page.evaluate(() => window.localStorage.clear())
  await page.goto("/terrain")
  await expect(page.getByRole("heading", { name: "Aucune tournée en cours." })).toBeVisible()
})
