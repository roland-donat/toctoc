import { readFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { dwellingUnits, itineraries, itineraryDoors, registrations, visits } from "../db/schema/index.ts"
import { setAnonymizationMode } from "../domain/anonymize.ts"
import { issueFieldLink } from "../lib/tokens.ts"
import { adressesRoutes } from "../routes/adresses.ts"
import { terrainRoutes } from "../routes/terrain.ts"
import { loadBanFile } from "./ban-loader.ts"
import { syncListUnits, unitsByAddress } from "./dwelling-units.ts"
import type { GeocodeFetch } from "./geocode-fallback.ts"
import { commitRepImport, prepareRepImport } from "./rep-import.ts"
import { recordVisit, updateVisit, VisitError } from "./visits.ts"

// Fictional people on public addresses: the fixture building has six apartments named in the list complements,
// and one complement naming someone ("chez ...") that must never become a unit label.
const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const unreachable: GeocodeFetch = async () => {
  throw new Error("offline")
}
const NOW = new Date("2027-03-01T10:00:00Z")
let ctx: AppContext
let setNow: (d: Date) => void
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`

/** Address of the fixture building: the one whose electors carry "Appartement n" complements. */
function building(): string {
  const r = ctx.db
    .select({ addressId: registrations.addressId })
    .from(registrations)
    .where(eq(registrations.rawComplement1, "Appartement 1"))
    .get()
  if (!r?.addressId) throw new Error("fixture building not found")
  return r.addressId
}

beforeEach(async () => {
  const t = createTestContext({ now: NOW })
  ctx = t.ctx
  setNow = t.setNow
  seq = 0
  await loadBanFile(ctx, join(FIXTURES, "ban-sample.csv"))
  commitRepImport(ctx, await prepareRepImport(ctx, readFileSync(join(FIXTURES, "rep-2026.csv")), { fetch: unreachable, sleep: async () => {} }))
})

describe("units of the electoral list", () => {
  it("reads the apartments of the complements, never a complement naming someone", () => {
    const units = unitsByAddress(ctx, [building()]).get(building()) ?? []
    expect(units.map((u) => u.label)).toEqual(["Appartement 1", "Appartement 2", "Appartement 3", "Appartement 4", "Appartement 5", "Appartement 6"])
    expect(units.every((u) => u.registered >= 1 && u.lastVisit === null)).toBe(true)
    const labels = ctx.db.select({ label: dwellingUnits.label }).from(dwellingUnits).all()
    expect(labels.some((l) => /chez/i.test(l.label))).toBe(false)
  })

  it("is idempotent: a second sync creates nothing", () => {
    const before = ctx.db.select().from(dwellingUnits).all().length
    syncListUnits(ctx)
    expect(ctx.db.select().from(dwellingUnits).all().length).toBe(before)
  })
})

describe("feedback on a unit", () => {
  it("attaches to a unit, creates one from the phone, and merges two labels of the same dwelling", () => {
    const address = building()
    const [first] = unitsByAddress(ctx, [address]).get(address) ?? []
    if (!first) throw new Error("no unit")
    recordVisit(ctx, { id: uuid(), addressId: address, source: "lien", dwellingUnitId: first.id, contact: "absent" })
    const phoneUnit = "11111111-1111-4111-8111-111111111111"
    recordVisit(ctx, { id: uuid(), addressId: address, source: "lien", dwellingUnitId: phoneUnit, dwellingUnitLabel: "Bât. B, 2e gauche", contact: "obtenu", nonRegistered: true })
    // A second volunteer, a minute later, types the same dwelling differently: it is the same unit.
    setNow(new Date(NOW.getTime() + 60_000))
    const again = recordVisit(ctx, { id: uuid(), addressId: address, source: "lien", dwellingUnitLabel: "BAT B 2E GAUCHE", contact: "absent" })
    expect(again.visit.dwellingUnitId).toBe(phoneUnit)

    const units = unitsByAddress(ctx, [address]).get(address) ?? []
    expect(units.find((u) => u.id === first.id)?.lastVisit?.contact).toBe("absent")
    const added = units.find((u) => u.id === phoneUnit)
    expect(added).toMatchObject({ label: "Bât. B, 2e gauche", registered: 0, lastVisit: { contact: "absent", nonRegistered: false } })
  })

  it("never loses a field feedback over its unit, refuses a wrong unit from the administrator", () => {
    const address = building()
    const other = ctx.db.select({ id: dwellingUnits.id }).from(dwellingUnits).get()
    const lost = recordVisit(ctx, { id: uuid(), addressId: address, source: "lien", dwellingUnitId: "unknown-unit", contact: "absent" })
    expect(lost.visit.dwellingUnitId).toBeNull()
    expect(() => recordVisit(ctx, { id: uuid(), addressId: address, source: "admin", dwellingUnitId: "unknown-unit", contact: "absent" })).toThrowError(VisitError)
    const elsewhere = ctx.db.select({ id: registrations.addressId }).from(registrations).where(eq(registrations.rawComplement1, "chez PAPA Paul")).get()
    if (other && elsewhere?.id && elsewhere.id !== address) {
      expect(() => recordVisit(ctx, { id: uuid(), addressId: elsewhere.id ?? "", source: "admin", dwellingUnitId: other.id, contact: "absent" })).toThrowError(
        /unit_other_address/,
      )
    }
  })

  it("moves a feedback to another unit of the address on correction", () => {
    const address = building()
    const [a, b] = unitsByAddress(ctx, [address]).get(address) ?? []
    if (!a || !b) throw new Error("no unit")
    const { visit } = recordVisit(ctx, { id: uuid(), addressId: address, source: "admin", dwellingUnitId: a.id, contact: "absent" })
    expect(updateVisit(ctx, visit.id, { dwellingUnitId: b.id, nonRegistered: true })).toMatchObject({ dwellingUnitId: b.id, nonRegistered: true })
  })
})

describe("units on the screens", () => {
  it("shows the units with their latest feedback on the field link, labels included in anonymous mode", async () => {
    setAnonymizationMode(ctx.db, "anonyme")
    const address = building()
    ctx.db
      .insert(itineraries)
      .values({ id: "it-u", createdAt: NOW.getTime(), name: null, zone: "{}", startLat: 47.6, startLon: -2.75, durationMinutes: 60, totalSeconds: 600, showNames: false })
      .run()
    ctx.db.insert(itineraryDoors).values({ itineraryId: "it-u", addressId: address, position: 0, serviceSeconds: 120, walkSecondsFromPrevious: 0, priority: 10, manual: false }).run()
    const { token } = issueFieldLink(ctx, "it-u")
    const loop = (await (await terrainRoutes(ctx).request("/itineraire", { headers: { "X-Toctoc-Token": token } })).json()) as {
      doors: { units: { label: string }[] }[]
    }
    expect(loop.doors[0]?.units.map((u) => u.label)).toContain("Appartement 3")
  })

  it("lets the administrator add, rename and remove a unit, and counts the households not registered", async () => {
    const address = building()
    const app = adressesRoutes(ctx)
    const json = { "content-type": "application/json" }
    const created = await app.request(`/${address}/logements`, { method: "POST", headers: json, body: JSON.stringify({ label: "Loge du gardien" }) })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    expect((await app.request(`/${address}/logements/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ label: "Loge" }) })).status).toBe(200)
    recordVisit(ctx, { id: uuid(), addressId: address, source: "admin", dwellingUnitId: id, contact: "obtenu", nonRegistered: true })
    let sheet = (await (await app.request(`/${address}`)).json()) as { units: { id: string; label: string }[]; nonRegisteredMet: number }
    expect(sheet.units.find((u) => u.id === id)?.label).toBe("Loge")
    expect(sheet.nonRegisteredMet).toBe(1)
    expect((await app.request(`/${address}/logements/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ retired: true }) })).status).toBe(200)
    sheet = (await (await app.request(`/${address}`)).json()) as { units: { id: string; label: string }[]; nonRegisteredMet: number }
    expect(sheet.units.some((u) => u.id === id)).toBe(false)
    // The feedback keeps pointing to the removed unit.
    expect(ctx.db.select({ unit: visits.dwellingUnitId }).from(visits).all().some((v) => v.unit === id)).toBe(true)
  })
})
