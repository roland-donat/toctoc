import { expect, test } from "@playwright/test"
import { openAsAdmin } from "./helpers.ts"

// Desktop project. Correction and removal of a feedback already recorded through the fictional itinerary
// "e2e-itineraire" (e2e/prepare.ts). The phone spec only writes on the first door; this one works on the third.

interface Listed {
  visits: { id: string; addressId: string; toRevisit: boolean; correctedAt: number | null }[]
}

test("a recorded feedback of an itinerary is corrected, then removed, from its re-entry screen", async ({ page, baseURL }) => {
  await openAsAdmin(page, "/suivi")
  const api = (path: string, init: { method: string; data?: unknown }) =>
    page.request.fetch(`/api${path}`, { ...init, headers: { Origin: baseURL ?? "", "Content-Type": "application/json" } })

  const detail = (await (await page.request.get("/api/itineraires/e2e-itineraire")).json()) as { doors: { addressId: string }[] }
  const door = detail.doors[2]?.addressId ?? ""
  const id = crypto.randomUUID()
  const recorded = await api("/itineraires/e2e-itineraire/ressaisie", {
    method: "POST",
    data: { visitDate: "2026-10-10", feedbacks: [{ id, addressId: door, contact: "absent" }] },
  })
  expect(recorded.status()).toBe(200)

  await openAsAdmin(page, "/suivi?itineraire=e2e-itineraire")
  const third = page.getByTestId("paper-door").nth(2)
  const row = third.getByTestId("paper-row").first()
  await expect(row.getByTestId("paper-row-origin")).toHaveText("Feuille, visite du 10/10/2026")
  await expect(row.getByTestId("paper-row-saved")).toBeVisible()
  // Anonymous mode: the free texts of a recorded feedback cannot be overwritten blind.
  await expect(row.getByLabel("Remarques")).toBeDisabled()

  await row.getByRole("button", { name: "À revenir" }).click()
  await expect(row.getByText("Enregistrement…")).toBeVisible()
  await expect(row.getByTestId("paper-row-saved")).toBeVisible()
  await expect(row.getByTestId("paper-row-origin")).toHaveText("Feuille, visite du 10/10/2026, corrigé")
  const corrected = ((await (await page.request.get("/api/itineraires/e2e-itineraire/retours")).json()) as Listed).visits.find((v) => v.id === id)
  expect(corrected).toMatchObject({ toRevisit: true })
  expect(corrected?.correctedAt).not.toBeNull()

  await row.getByRole("button", { name: "Supprimer le retour" }).click()
  await row.getByRole("button", { name: "Supprimer", exact: true }).click()
  // The door is back to one blank line, as before the re-entry.
  await expect(third.getByTestId("paper-row")).toHaveCount(1)
  await expect(third.getByTestId("paper-row-origin")).toHaveCount(0)
  await expect(third.getByText("Choisissez le contact ou la qualification.")).toBeVisible()
  const after = (await (await page.request.get("/api/itineraires/e2e-itineraire/retours")).json()) as Listed
  expect(after.visits.filter((v) => v.id === id)).toEqual([])
})
