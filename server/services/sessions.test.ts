import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { fieldLinks, itineraries, itineraryDoors, visits } from "../db/schema/index.ts"
import { issueFieldLink } from "../lib/tokens.ts"
import { itinerairesRoutes } from "../routes/itineraires.ts"
import { terrainRoutes } from "../routes/terrain.ts"
import { P, seedAddresses } from "./route-builder.test-support.ts"
import { listSessionEvents, listSessions } from "./sessions.ts"
import { recordVisit } from "./visits.ts"

// Fictional doors only. Routing is never called here: no door is added or removed through the solver.
const NOW = new Date("2027-03-01T10:00:00Z")
let ctx: AppContext
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`
const json = { "content-type": "application/json" }
const noRouting = {} as never

function insertSession(id: string, addressIds: string[]): void {
  ctx.db
    .insert(itineraries)
    .values({ id, createdAt: NOW.getTime(), name: null, zone: JSON.stringify({ type: "bureau", bureau: "0001" }), startLat: 47.6, startLon: -2.75, durationMinutes: 60, totalSeconds: 600 })
    .run()
  addressIds.forEach((addressId, position) =>
    ctx.db
      .insert(itineraryDoors)
      .values({ itineraryId: id, addressId, position, serviceSeconds: 120, walkSecondsFromPrevious: 60, priority: 10, manual: false })
      .run(),
  )
}

beforeEach(() => {
  ctx = createTestContext({ now: NOW }).ctx
  seq = 0
  seedAddresses(ctx, [
    { id: "a", at: P(100, 0), voters: ["fort"] },
    { id: "b", at: P(200, 0), voters: ["moyen"] },
    { id: "c", at: P(300, 0) },
  ])
  insertSession("s1", ["a", "b", "c"])
})

describe("sessions", () => {
  it("shows the progress of a session and the feedback of its field link in its history", async () => {
    const { token } = issueFieldLink(ctx, "s1")
    const field = terrainRoutes(ctx)
    const res = await field.request("/retours", {
      method: "POST",
      headers: { ...json, "X-Toctoc-Token": token },
      body: JSON.stringify({ id: uuid(), addressId: "a", contact: "absent" }),
    })
    expect(res.status).toBe(201)
    recordVisit(ctx, { id: uuid(), addressId: "a", source: "lien", itineraryId: "s1", contact: "obtenu" })
    const [s] = listSessions(ctx)
    expect(s).toMatchObject({ id: "s1", doorCount: 3, doorsDone: 1, feedbackCount: 2, link: { state: "actif" }, archivedAt: null })
    expect(listSessionEvents(ctx, "s1").map((e) => [e.kind, e.source])).toEqual([["feedback_recorded", "lien"]])
  })

  it("renames, archives (link closed, read-only, listed apart) and restores a session", async () => {
    const app = itinerairesRoutes(ctx, noRouting)
    issueFieldLink(ctx, "s1")
    expect((await app.request("/s1", { method: "PATCH", headers: json, body: JSON.stringify({ name: "  Samedi   matin " }) })).status).toBe(200)
    expect((await app.request("/s1", { method: "PATCH", headers: json, body: JSON.stringify({ archived: true }) })).status).toBe(200)
    expect(listSessions(ctx)).toEqual([])
    // Closed, not revoked: a phone still sends what it queued during 12 hours.
    expect(listSessions(ctx, { archived: true })).toMatchObject([{ id: "s1", name: "Samedi matin", link: { state: "grace" } }])
    expect(ctx.db.select().from(fieldLinks).where(eq(fieldLinks.itineraryId, "s1")).all().every((l) => l.expiresAt !== null)).toBe(true)
    // Read-only: no new link, no paper re-entry, no rename.
    expect((await app.request("/s1/lien", { method: "POST" })).status).toBe(409)
    const reentry = await app.request("/s1/ressaisie", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ visitDate: "2027-02-28", feedbacks: [{ id: uuid(), addressId: "a", contact: "absent" }] }),
    })
    expect(reentry.status).toBe(409)
    expect((await app.request("/s1", { method: "PATCH", headers: json, body: JSON.stringify({ name: "x" }) })).status).toBe(409)
    expect((await app.request("/s1", { method: "PATCH", headers: json, body: JSON.stringify({ archived: false }) })).status).toBe(200)
    expect(listSessions(ctx)).toMatchObject([{ id: "s1", archivedAt: null }])
    const history = (await (await app.request("/s1/historique")).json()) as { events: { kind: string; detail: string | null }[] }
    expect(history.events.map((e) => e.kind)).toEqual(["restored", "archived", "renamed"])
    expect(history.events[2]?.detail).toBe("Samedi matin")
  })

  it("deletes a session with its feedback by default, or keeps the feedback on the addresses", async () => {
    const app = itinerairesRoutes(ctx, noRouting)
    recordVisit(ctx, { id: uuid(), addressId: "a", source: "lien", itineraryId: "s1", contact: "absent" })
    insertSession("s2", ["b"])
    recordVisit(ctx, { id: uuid(), addressId: "b", source: "feuille", itineraryId: "s2", visitDate: "2027-02-28", contact: "obtenu" })

    expect(await (await app.request("/s1", { method: "DELETE" })).json()).toEqual({ feedbackDeleted: 1, feedbackKept: 0 })
    expect(await (await app.request("/s2?retours=0", { method: "DELETE" })).json()).toEqual({ feedbackDeleted: 0, feedbackKept: 1 })
    expect(ctx.db.select().from(itineraries).all()).toEqual([])
    const left = ctx.db.select({ addressId: visits.addressId, itineraryId: visits.itineraryId }).from(visits).all()
    expect(left).toEqual([{ addressId: "b", itineraryId: null }])
    expect((await app.request("/s1", { method: "DELETE" })).status).toBe(404)
  })

  it("ends a session: link closed, itinerary frozen, paper sheet still entered; reopening needs a new link", async () => {
    const app = itinerairesRoutes(ctx, noRouting)
    const { token } = issueFieldLink(ctx, "s1")
    expect((await app.request("/s1", { method: "PATCH", headers: json, body: JSON.stringify({ ended: true }) })).status).toBe(200)
    expect(listSessions(ctx)).toMatchObject([{ id: "s1", endedAt: NOW.getTime(), link: { state: "grace" } }])
    // Frozen itinerary and link, open feedback.
    expect((await app.request("/s1/lien", { method: "POST" })).status).toBe(409)
    expect((await app.request("/s1/portes/a", { method: "DELETE" })).status).toBe(409)
    const reentry = await app.request("/s1/ressaisie", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ visitDate: "2027-02-28", feedbacks: [{ id: uuid(), addressId: "a", contact: "absent" }] }),
    })
    expect(reentry.status).toBe(200)
    // The phone that was offline still sends its feedback right after the end.
    const late = await terrainRoutes(ctx).request("/retours", {
      method: "POST",
      headers: { ...json, "X-Toctoc-Token": token },
      body: JSON.stringify({ id: uuid(), addressId: "b", contact: "absent" }),
    })
    expect(late.status).toBe(201)
    expect((await app.request("/s1", { method: "PATCH", headers: json, body: JSON.stringify({ ended: false }) })).status).toBe(200)
    expect((await app.request("/s1/lien", { method: "POST" })).status).toBe(201)
    expect(listSessionEvents(ctx, "s1").map((e) => e.kind).slice(0, 3)).toEqual(["link_issued", "reopened", "feedback_recorded"])
  })
})
