import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { cheatsheets, electors, fieldLinks, itineraries, itineraryDoors, visits } from "../db/schema/index.ts"
import { setAnonymizationMode } from "../domain/anonymize.ts"
import { issueFieldLink, revokeFieldLinks } from "../lib/tokens.ts"
import { P, seedAddresses } from "../services/route-builder.test-support.ts"
import { recordVisit } from "../services/visits.ts"
import { terrainRoutes } from "./terrain.ts"

// Fictional data only: invented surnames and first names, birthplaces chosen so the scan has something to miss.
const NOW = new Date("2027-03-01T10:00:00Z")
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const SURNAMES = ["FICTIVIER", "IMAGINOT", "INVENTAL", "SONGERIE"]
const USAGE = "DEUXIEMENOM"
const FIRST = ["Zéphyrin", "Ondine", "Barnabé", "Clothilde"]
const BIRTHPLACES = ["Lisbonne", "Rennes", "Vannes", "Paris"]

let ctx: AppContext
let setNow: (d: Date) => void
let sqlite: ReturnType<typeof createTestContext>["sqlite"]
let router: Hono
let seq = 0

function uuid(): string {
  seq += 1
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`
}

function insertItinerary(id: string, addressIds: string[], showNames = false): void {
  ctx.db
    .insert(itineraries)
    .values({ id, createdAt: NOW.getTime(), name: null, zone: "{}", startLat: 47.6, startLon: -2.75, durationMinutes: 60, totalSeconds: 600, showNames })
    .run()
  addressIds.forEach((addressId, position) =>
    ctx.db
      .insert(itineraryDoors)
      .values({ itineraryId: id, addressId, position, serviceSeconds: 120, walkSecondsFromPrevious: 60, priority: 10, manual: false })
      .run(),
  )
}

beforeEach(() => {
  const t = createTestContext({ now: NOW })
  ctx = t.ctx
  setNow = t.setNow
  sqlite = t.sqlite
  seq = 0
  // a: building of 3 strong abstainers; b: one voter; c: no voter; z: belongs to itinerary B only.
  seedAddresses(ctx, [
    { id: "a", at: P(100, 0), voters: ["fort", "fort", "moyen"], dwellings: 6 },
    { id: "b", at: P(200, 0), voters: ["moyen", "hors_cible"] },
    { id: "c", at: P(300, 0) },
    { id: "z", at: P(900, 0), voters: ["fort"] },
  ])
  const rows = ctx.db.select({ id: electors.id }).from(electors).all()
  rows.forEach((r, i) =>
    ctx.db
      .update(electors)
      .set({
        birthName: SURNAMES[i % SURNAMES.length] ?? "FICTIF",
        usageName: USAGE,
        firstNames: FIRST[i % FIRST.length] ?? "Fictif",
        birthCommune: BIRTHPLACES[i % BIRTHPLACES.length] ?? null,
        birthCountry: "PORTUGAL",
        birthDate: "2001-06-01",
      })
      .where(eq(electors.id, r.id))
      .run(),
  )
  ctx.db
    .insert(cheatsheets)
    .values([
      { id: "s-young", ageBand: "18-25", title: "Jeunes", body: "Ligne 1\nLigne 2", position: 0, updatedAt: 0 },
      { id: "s-old", ageBand: "61+", title: "Retraités", body: "Pensions", position: 0, updatedAt: 0 },
      { id: "s-gen", ageBand: "generale", title: "Général", body: "Programme", position: 0, updatedAt: 0 },
    ])
    .run()
  insertItinerary("it-a", ["a", "b", "c"])
  insertItinerary("it-b", ["z"])
  router = terrainRoutes(ctx)
})

const get = (token: string | null) =>
  router.request("/itineraire", { headers: token === null ? {} : { "X-Toctoc-Token": token } })

const post = (token: string, body: Record<string, unknown>) =>
  router.request("/retours", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Toctoc-Token": token },
    body: JSON.stringify(body),
  })

interface Loop {
  expiresAt: number
  start: { lat: number; lon: number }
  namesShown: boolean
  doors: {
    addressId: string
    position: number
    label: string
    dwellings: number | null
    ageBands: string[]
    cheatsheets: { id: string; title: string; body: string }[]
    lastPassage: { visitDate: string; contact: string | null; toRevisit: boolean; toAccompany: boolean } | null
    done: boolean
    voters: { birthName: string | null; usageName: string | null; firstNames: string | null }[]
  }[]
}

async function loop(token: string): Promise<Loop> {
  const res = await get(token)
  expect(res.status).toBe(200)
  return (await res.json()) as Loop
}

function scanNominative(text: string): string[] {
  return [...SURNAMES, USAGE, ...FIRST, ...BIRTHPLACES, "PORTUGAL"].filter((w) => text.includes(w))
}

describe("GET /api/terrain/itineraire", () => {
  it("Covers AE4. an anonymized link serves the loop, dwellings, age bands and cheat sheets, without any name or birthplace", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    const res = await get(token)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(scanNominative(text)).toEqual([])
    const body = JSON.parse(text) as Loop
    expect(body.namesShown).toBe(false)
    expect(body.doors.map((d) => d.addressId)).toEqual(["a", "b", "c"])
    const [a, b, c] = body.doors
    expect(a?.dwellings).toBe(6)
    expect(a?.ageBands).toEqual(["18-25"])
    expect(a?.cheatsheets.map((s) => s.id)).toEqual(["s-young"])
    expect(a?.cheatsheets[0]?.body).toBe("Ligne 1\nLigne 2")
    expect(b?.ageBands).toEqual(["18-25"])
    expect(c?.ageBands).toEqual([])
    expect(c?.cheatsheets.map((s) => s.id)).toEqual(["s-gen"])
    expect(body.doors.every((d) => d.voters.length === 0)).toBe(true)
    expect(body.start).toEqual({ lat: 47.6, lon: -2.75 })
    expect(body.expiresAt).toBe(NOW.getTime() + 7 * DAY)
  })

  it("shows the names of targeted voters only when the global switch and the itinerary both allow it, never the birthplace", async () => {
    setAnonymizationMode(ctx.db, "nominatif")
    ctx.db.update(itineraries).set({ showNames: true }).where(eq(itineraries.id, "it-a")).run()
    const { token } = issueFieldLink(ctx, "it-a")
    const res = await get(token)
    const text = await res.text()
    const body = JSON.parse(text) as Loop
    expect(body.namesShown).toBe(true)
    expect(body.doors[0]?.voters).toHaveLength(3)
    // b: the hors cible elector (UE complementary list) is never shown.
    expect(body.doors[1]?.voters).toHaveLength(1)
    expect(text).toContain(SURNAMES[0])
    expect(BIRTHPLACES.filter((w) => text.includes(w))).toEqual([])
    expect(text).not.toContain("PORTUGAL")

    // Back to anonyme: the link issued with names hides them at the next request (KTD7).
    setAnonymizationMode(ctx.db, "anonyme")
    const after = await (await get(token)).text()
    expect(scanNominative(after)).toEqual([])
    expect((JSON.parse(after) as Loop).namesShown).toBe(false)
  })

  it("keeps names hidden when the itinerary does not allow them, even in nominatif mode", async () => {
    setAnonymizationMode(ctx.db, "nominatif")
    const { token } = issueFieldLink(ctx, "it-a")
    expect(scanNominative(await (await get(token)).text())).toEqual([])
  })

  it("gives the date and outcome of the last passage, never the dwelling or remarks of earlier feedback", async () => {
    setNow(new Date("2027-02-10T15:00:00Z"))
    recordVisit(ctx, {
      id: uuid(),
      addressId: "a",
      source: "admin",
      visitDate: "2027-02-10",
      dwelling: "Apt 3 boîte FICTIVENOM",
      contact: "absent",
      toRevisit: true,
      remarks: "Remarque fictive confidentielle",
    })
    setNow(NOW)
    setAnonymizationMode(ctx.db, "nominatif")
    ctx.db.update(itineraries).set({ showNames: true }).where(eq(itineraries.id, "it-a")).run()
    const { token } = issueFieldLink(ctx, "it-a")
    const text = await (await get(token)).text()
    expect(text).not.toContain("FICTIVENOM")
    expect(text).not.toContain("Remarque fictive")
    const a = (JSON.parse(text) as Loop).doors[0]
    expect(a?.lastPassage).toEqual({ visitDate: "2027-02-10", contact: "absent", toRevisit: true, toAccompany: false })
    expect(a?.done).toBe(false)
  })

  it("never serves the doors of another itinerary", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    const text = await (await get(token)).text()
    expect(text).not.toContain('"z"')
  })

  it("answers the same 404 for a missing, unknown, revoked or expired token", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    const missing = await get(null)
    const unknown = await get("x".repeat(43))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "not_found" })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: "not_found" })

    revokeFieldLinks(ctx, "it-a")
    const revoked = await get(token)
    expect(revoked.status).toBe(404)
    expect(await revoked.json()).toEqual({ error: "not_found" })
  })
})

describe("POST /api/terrain/retours", () => {
  const feedback = (addressId: string, extra: Record<string, unknown> = {}) => ({ id: uuid(), addressId, contact: "obtenu", ...extra })

  it("records a feedback from the link, dated today in Paris, attached to the itinerary, idempotent on its id", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    const body = feedback("a", { contactQuality: "chaleureux", toAccompany: true, dwelling: "Apt 4", remarks: "RAS" })
    const res = await post(token, body)
    expect(res.status).toBe(201)
    expect((await post(token, body)).status).toBe(200)
    const stored = ctx.db.select().from(visits).all()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      id: body.id,
      addressId: "a",
      source: "lien",
      itineraryId: "it-a",
      visitDate: "2027-03-01",
      contact: "obtenu",
      contactQuality: "chaleureux",
      toAccompany: true,
      dwelling: "Apt 4",
      remarks: "RAS",
    })
  })

  it("Covers AE5. keeps three feedbacks on three dwellings of one building; the door counts once as done", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    for (const dwelling of ["apt 4", "apt 7", "hall"]) {
      expect((await post(token, feedback("a", { dwelling }))).status).toBe(201)
    }
    expect(ctx.db.select().from(visits).where(eq(visits.addressId, "a")).all()).toHaveLength(3)
    const body = await loop(token)
    expect(body.doors.filter((d) => d.done).map((d) => d.addressId)).toEqual(["a"])
  })

  it("keeps both feedbacks when two phones on the same link post on the same door", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    expect((await post(token, feedback("b"))).status).toBe(201)
    expect((await post(token, feedback("b", { contact: "absent" }))).status).toBe(201)
    expect(ctx.db.select().from(visits).where(eq(visits.addressId, "b")).all()).toHaveLength(2)
  })

  it("refuses a door of another itinerary with 404", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    const res = await post(token, feedback("z"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found" })
    expect(ctx.db.select().from(visits).all()).toEqual([])
  })

  it("refuses a feedback with a revoked token", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    revokeFieldLinks(ctx, "it-a")
    expect((await post(token, feedback("a"))).status).toBe(404)
  })

  it("keeps the entry date of a queued feedback flushed on a later day", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    setNow(new Date("2027-03-02T07:30:00Z"))
    const body = feedback("a", { visitDate: "2027-03-01" })
    expect((await post(token, body)).status).toBe(201)
    expect(ctx.db.select().from(visits).where(eq(visits.id, body.id)).get()?.visitDate).toBe("2027-03-01")
  })

  it("clamps an entry date outside [link issue date, today] instead of losing the feedback", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    const early = feedback("a", { visitDate: "2027-02-28" })
    const late = feedback("a", { visitDate: "2027-03-02" })
    expect((await post(token, early)).status).toBe(201)
    expect((await post(token, late)).status).toBe(201)
    const dateOf = (id: string) => ctx.db.select().from(visits).where(eq(visits.id, id)).get()?.visitDate
    expect(dateOf(early.id)).toBe("2027-03-01")
    expect(dateOf(late.id)).toBe("2027-03-01")
  })

  it("has no field for a political opinion", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    expect((await post(token, feedback("a", { opinion: "pour" }))).status).toBe(400)
  })
})

describe("PATCH and DELETE /api/terrain/retours/:id", () => {
  const send = (token: string, method: "PATCH" | "DELETE", id: string, body?: Record<string, unknown>) =>
    router.request(`/retours/${id}`, {
      method,
      headers: { "content-type": "application/json", "X-Toctoc-Token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  it("corrects then removes a feedback sent from the same link", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    const id = uuid()
    await post(token, { id, addressId: "a", contact: "absent" })
    expect((await send(token, "PATCH", id, { contact: "obtenu", contactQuality: "poli" })).status).toBe(200)
    expect(ctx.db.select().from(visits).where(eq(visits.id, id)).get()).toMatchObject({ contact: "obtenu", contactQuality: "poli" })
    expect((await send(token, "DELETE", id)).status).toBe(200)
    expect(ctx.db.select().from(visits).all()).toEqual([])
    expect((await loop(token)).doors.every((d) => !d.done)).toBe(true)
  })

  it("never touches a feedback of the sheet, of another itinerary or of an earlier link", async () => {
    const first = issueFieldLink(ctx, "it-a")
    const earlier = uuid()
    await post(first.token, { id: earlier, addressId: "a", contact: "absent" })
    setNow(new Date(NOW.getTime() + HOUR))
    const { token } = issueFieldLink(ctx, "it-a")
    const paper = uuid()
    recordVisit(ctx, { id: paper, addressId: "b", source: "feuille", itineraryId: "it-a", visitDate: "2027-03-01", contact: "absent" })
    const other = issueFieldLink(ctx, "it-b")
    const elsewhere = uuid()
    await post(other.token, { id: elsewhere, addressId: "z", contact: "absent" })
    for (const id of [earlier, paper, elsewhere]) {
      const res = await send(token, "PATCH", id, { toRevisit: true })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found" })
      expect((await send(token, "DELETE", id)).status).toBe(404)
    }
    expect(ctx.db.select().from(visits).all()).toHaveLength(3)
  })

  it("accepts a correction during grace, refuses one after grace or with a revoked token, and an emptied feedback", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    const id = uuid()
    await post(token, { id, addressId: "a", contact: "absent" })
    expect((await send(token, "PATCH", id, { contact: null })).status).toBe(422)
    setNow(new Date(NOW.getTime() + 7 * DAY + HOUR))
    expect((await send(token, "PATCH", id, { toRevisit: true })).status).toBe(200)
    setNow(new Date(NOW.getTime() + 7 * DAY + 12 * HOUR))
    expect((await send(token, "DELETE", id)).status).toBe(404)
    setNow(NOW)
    revokeFieldLinks(ctx, "it-a")
    expect((await send(token, "DELETE", id)).status).toBe(404)
    expect(ctx.db.select().from(visits).all()).toHaveLength(1)
  })
})

describe("link lifecycle", () => {
  it("during grace, reads answer 404 and a feedback is accepted; after grace, every request answers 404", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    setNow(new Date(NOW.getTime() + 7 * DAY + HOUR))
    expect((await get(token)).status).toBe(404)
    expect((await post(token, { id: uuid(), addressId: "a", contact: "absent" })).status).toBe(201)

    setNow(new Date(NOW.getTime() + 7 * DAY + 12 * HOUR))
    const read = await get(token)
    expect(read.status).toBe(404)
    expect(await read.json()).toEqual({ error: "not_found" })
    const write = await post(token, { id: uuid(), addressId: "a", contact: "absent" })
    expect(write.status).toBe(404)
    expect(await write.json()).toEqual({ error: "not_found" })
  })

  it("stores only the hash of the token: the raw token is nowhere in the database", async () => {
    const { token } = issueFieldLink(ctx, "it-a")
    await post(token, { id: uuid(), addressId: "a", contact: "absent" })
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    expect(tables.length).toBeGreaterThan(5)
    const dump = JSON.stringify(tables.map((t) => sqlite.prepare(`SELECT * FROM "${t.name}"`).all()))
    expect(dump).toContain(ctx.db.select().from(fieldLinks).all()[0]?.tokenHash)
    expect(dump).not.toContain(token)
  })
})
