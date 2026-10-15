import type { Hono } from "hono"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { anonymizationMode } from "../domain/anonymize.ts"
import { DEFAULT_PARAMETERS, loadParameters } from "../domain/parameters.ts"
import { setSetting } from "../db/settings.ts"
import { LAST_BACKUP_KEY } from "../services/backup.ts"
import { parametresRoutes } from "./parametres.ts"

let ctx: AppContext
let router: Hono

const put = (path: string, body: unknown) =>
  router.request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

beforeEach(() => {
  ctx = createTestContext().ctx
  router = parametresRoutes(ctx)
})

describe("GET /api/parametres", () => {
  it("starts anonyme with the default KTD8 parameters", async () => {
    const res = await router.request("/")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ anonymization: "anonyme", parameters: DEFAULT_PARAMETERS, lastBackupAt: null })
  })

  it("reports the date of the last successful backup (U15)", async () => {
    setSetting(ctx.db, LAST_BACKUP_KEY, "2027-02-01T03:30:00.000Z")
    const res = await router.request("/")
    expect(((await res.json()) as { lastBackupAt: string | null }).lastBackupAt).toBe("2027-02-01T03:30:00.000Z")
  })
})

describe("PUT /api/parametres/anonymisation", () => {
  it("switches the global mode", async () => {
    const res = await put("/anonymisation", { mode: "nominatif" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ anonymization: "nominatif" })
    expect(anonymizationMode(ctx.db)).toBe("nominatif")
  })

  it("refuses an unknown mode", async () => {
    expect((await put("/anonymisation", { mode: "nominative" })).status).toBe(400)
    expect(anonymizationMode(ctx.db)).toBe("anonyme")
  })
})

describe("PUT /api/parametres/priorite", () => {
  const changed = { ...DEFAULT_PARAMETERS, weights: { ...DEFAULT_PARAMETERS.weights, fort: 55 }, recentDays: 21 }

  it("stores valid parameters", async () => {
    const res = await put("/priorite", changed)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ parameters: changed })
    expect(loadParameters(ctx.db)).toEqual(changed)
  })

  it("refuses an out-of-range value and keeps the stored parameters", async () => {
    expect((await put("/priorite", { ...DEFAULT_PARAMETERS, cap: 500 })).status).toBe(400)
    expect((await put("/priorite", { ...DEFAULT_PARAMETERS, noVoterShareCap: 1.5 })).status).toBe(400)
    expect(loadParameters(ctx.db)).toEqual(DEFAULT_PARAMETERS)
  })
})
