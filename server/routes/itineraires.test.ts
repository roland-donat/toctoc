import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { addresses, cheatsheets, electors, itineraries, itineraryDoors, visits } from "../db/schema/index.ts"
import { setAnonymizationMode } from "../domain/anonymize.ts"
import type { RouteDeps } from "../services/route-builder.ts"
import { greedyStubSolver, P, seedAddresses, square, stubMatrix } from "../services/route-builder.test-support.ts"
import { RoutingUnavailableError } from "../services/routing-client.ts"
import { recordVisit } from "../services/visits.ts"
import { itinerairesRoutes } from "./itineraires.ts"

let ctx: AppContext
let router: Hono
const deps: RouteDeps = { matrix: async (points) => stubMatrix(points), solver: greedyStubSolver() }

const post = (path: string, body: unknown) =>
  router.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const zone = { type: "polygon", points: square(1000) }
const origin = P(0, 0)

beforeEach(() => {
  ctx = createTestContext({ now: new Date("2027-03-01T10:00:00Z") }).ctx
  router = itinerairesRoutes(ctx, deps)
})

interface Detail {
  id: string
  totalSeconds: number
  durationMinutes: number
  doors: { addressId: string; manual: boolean }[]
}

describe("POST /api/itineraires", () => {
  it("creates an itinerary from a zone, a start and a duration", async () => {
    seedAddresses(ctx, [
      { id: "a", at: P(100, 0), voters: ["fort"] },
      { id: "b", at: P(200, 0), voters: ["moyen"] },
    ])
    const res = await post("/", { zone, start: origin, durationMinutes: 60 })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { itinerary: Detail; leftOut: unknown[]; droppedByCap: unknown[] }
    expect(body.itinerary.doors.map((d) => d.addressId)).toEqual(["a", "b"])
    expect(body.itinerary.totalSeconds).toBe(760)
    expect(body.leftOut).toEqual([])

    const list = (await (await router.request("/")).json()) as { itineraries: { id: string; doorCount: number }[] }
    expect(list.itineraries).toEqual([expect.objectContaining({ id: body.itinerary.id, doorCount: 2 })])
    const detail = (await (await router.request(`/${body.itinerary.id}`)).json()) as Detail
    expect(detail).toEqual(body.itinerary)
  })

  it("answers an explicit no_candidate error and creates nothing for a zone without candidate", async () => {
    seedAddresses(ctx, [{ id: "voters", at: P(100, 0), voters: ["votant"] }])
    const res = await post("/", { zone, durationMinutes: 90 })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "no_candidate" })
    expect(ctx.db.select().from(itineraries).all()).toEqual([])
  })

  it("answers 503 routing_unavailable when the routing service is down", async () => {
    seedAddresses(ctx, [{ id: "a", at: P(100, 0), voters: ["fort"] }])
    const down = itinerairesRoutes(ctx, {
      matrix: async () => {
        throw new RoutingUnavailableError("osrm", "Routing service osrm is unreachable")
      },
      solver: greedyStubSolver(),
    })
    const res = await down.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ zone, durationMinutes: 60 }),
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "routing_unavailable" })
    expect(ctx.db.select().from(itineraries).all()).toEqual([])
  })

  it("refuses a duration other than 60, 90 or 120 minutes and a polygon of fewer than 3 points", async () => {
    expect((await post("/", { zone, durationMinutes: 45 })).status).toBe(400)
    expect((await post("/", { zone: { type: "polygon", points: square(10).slice(0, 2) }, durationMinutes: 60 })).status).toBe(400)
  })
})

describe("adjusting doors", () => {
  it("removes a door and adds one by hand, each change saved at once", async () => {
    seedAddresses(ctx, [
      { id: "a", at: P(100, 0), voters: ["fort"] },
      { id: "b", at: P(200, 0), voters: ["fort"] },
      { id: "out", at: P(3000, 0), voters: ["votant"] },
    ])
    const created = (await (await post("/", { zone, start: origin, durationMinutes: 60 })).json()) as { itinerary: Detail }
    const id = created.itinerary.id

    const removed = await router.request(`/${id}/portes/b`, { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect(((await removed.json()) as Detail).doors.map((d) => d.addressId)).toEqual(["a"])

    const added = await post(`/${id}/portes`, { addressId: "out" })
    expect(added.status).toBe(200)
    const after = (await added.json()) as Detail
    expect(after.doors.map((d) => [d.addressId, d.manual]).sort()).toEqual([
      ["a", false],
      ["out", true],
    ])
    const stored = (await (await router.request(`/${id}`)).json()) as Detail
    expect(stored.totalSeconds).toBe(after.totalSeconds)
  })

  it("answers 404 for an unknown itinerary or door", async () => {
    expect((await router.request("/nope")).status).toBe(404)
    expect((await post("/nope/portes", { addressId: "a" })).status).toBe(404)
    seedAddresses(ctx, [{ id: "a", at: P(100, 0), voters: ["fort"] }])
    const created = (await (await post("/", { zone, start: origin, durationMinutes: 60 })).json()) as { itinerary: Detail }
    expect((await router.request(`/${created.itinerary.id}/portes/zzz`, { method: "DELETE" })).status).toBe(404)
    expect((await post(`/${created.itinerary.id}/portes`, { addressId: "zzz" })).status).toBe(404)
  })
})

interface LinkInfo {
  link: { issuedAt: number; expiresAt: number | null; revokedAt: number | null; state: string; url: string | null } | null
  showNames: boolean
  namesAvailable: boolean
}

describe("field link of an itinerary", () => {
  async function created(): Promise<string> {
    seedAddresses(ctx, [{ id: "a", at: P(100, 0), voters: ["fort"] }])
    const body = (await (await post("/", { zone, start: origin, durationMinutes: 60 })).json()) as { itinerary: Detail }
    return body.itinerary.id
  }

  it("creates a link whose full URL carries the token in the fragment, shown again while it serves, gone once revoked", async () => {
    const id = await created()
    const before = (await (await router.request(`/${id}/lien`)).json()) as LinkInfo
    expect(before).toEqual({ link: null, showNames: false, namesAvailable: false })

    const res = await post(`/${id}/lien`, {})
    expect(res.status).toBe(201)
    const issued = (await res.json()) as { url: string; link: NonNullable<LinkInfo["link"]> }
    const match = /^https:\/\/toctoc\.test\/terrain#([A-Za-z0-9_-]{43})$/.exec(issued.url)
    expect(match).not.toBeNull()
    const token = match?.[1] ?? ""
    expect(issued.link).toEqual({ issuedAt: ctx.now().getTime(), expiresAt: null, revokedAt: null, state: "actif", url: issued.url })

    const info = (await (await router.request(`/${id}/lien`)).json()) as LinkInfo
    expect(info.link).toMatchObject({ state: "actif", url: issued.url })
    expect(info.link?.url).toContain(token)
    await router.request(`/${id}/lien`, { method: "DELETE" })
    const revoked = (await (await router.request(`/${id}/lien`)).json()) as LinkInfo
    expect(revoked.link).toMatchObject({ state: "revoque", url: null })
  })

  it("revokes the link in one call", async () => {
    const id = await created()
    await post(`/${id}/lien`, {})
    const res = await router.request(`/${id}/lien`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(((await res.json()) as LinkInfo).link?.state).toBe("revoque")
  })

  it("stores the show-names toggle of the itinerary, off by default, and says whether the global switch allows names", async () => {
    const id = await created()
    const res = await router.request(`/${id}/noms`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ showNames: true }),
    })
    expect(res.status).toBe(200)
    expect(ctx.db.select({ showNames: itineraries.showNames }).from(itineraries).all()).toEqual([{ showNames: true }])
    setAnonymizationMode(ctx.db, "nominatif")
    expect(((await (await router.request(`/${id}/lien`)).json()) as LinkInfo)).toMatchObject({ showNames: true, namesAvailable: true })
  })

  it("answers 404 for the link of an unknown itinerary", async () => {
    expect((await router.request("/nope/lien")).status).toBe(404)
    expect((await post("/nope/lien", {})).status).toBe(404)
    expect((await router.request("/nope/lien", { method: "DELETE" })).status).toBe(404)
  })
})

// Printable sheet and paper re-entry (U13). Fictional data only: invented names and birthplaces, so the scan has
// something to miss.
describe("printable sheet and paper re-entry", () => {
  const SURNAMES = ["FICTIVIER", "IMAGINOT", "INVENTAL", "SONGERIE"]
  const USAGE = "DEUXIEMENOM"
  const FIRST = ["Zéphyrin", "Ondine", "Barnabé", "Clothilde"]
  const BIRTHPLACES = ["Lisbonne", "Rennes", "Vannes", "Paris"]
  const scan = (text: string) => [...SURNAMES, USAGE, ...FIRST, ...BIRTHPLACES, "PORTUGAL"].filter((w) => text.includes(w))
  let seq = 0
  const uuid = () => {
    seq += 1
    return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`
  }

  interface Sheet {
    namesShown: boolean
    durationMinutes: number
    zoneLabel: string
    doors: {
      number: number
      addressId: string
      label: string
      dwellings: number | null
      ageBands: string[]
      lastPassage: { visitDate: string; contact: string | null } | null
      voters: { birthName: string | null; usageName: string | null; firstNames: string | null }[]
    }[]
    cheatsheetGroups: { ageBand: string; sheets: { id: string; title: string }[] }[]
  }

  interface Reentry {
    results: { id: string; created: boolean; possibleDuplicate: boolean }[]
  }

  beforeEach(() => {
    seq = 0
    // a: 3 voters aged 18-25; b: one voter and one EU voter (hors cible); c: no voter.
    seedAddresses(ctx, [
      { id: "a", at: P(100, 0), voters: ["fort", "fort", "moyen"], dwellings: 6 },
      { id: "b", at: P(200, 0), voters: ["moyen", "hors_cible"] },
      { id: "c", at: P(300, 0) },
    ])
    ctx.db
      .select({ id: electors.id })
      .from(electors)
      .all()
      .forEach((r, i) =>
        ctx.db
          .update(electors)
          .set({
            birthName: SURNAMES[i % SURNAMES.length] ?? "FICTIF",
            usageName: USAGE,
            firstNames: FIRST[i % FIRST.length] ?? "Fictif",
            birthCommune: BIRTHPLACES[i % BIRTHPLACES.length] ?? null,
            birthCountry: "PORTUGAL",
            birthDate: "2008-06-01",
          })
          .where(eq(electors.id, r.id))
          .run(),
      )
    ctx.db
      .insert(cheatsheets)
      .values([
        { id: "s-young", ageBand: "18-25", title: "Jeunes", body: "Ligne 1", position: 0, updatedAt: 0 },
        { id: "s-old", ageBand: "61+", title: "Retraités", body: "Pensions", position: 0, updatedAt: 0 },
        { id: "s-gen", ageBand: "generale", title: "Général", body: "Programme", position: 0, updatedAt: 0 },
      ])
      .run()
    // Visit order c, a, b on purpose: neither the address id order nor the insertion order.
    ctx.db
      .insert(itineraries)
      .values({ id: "it", createdAt: ctx.now().getTime(), name: null, zone: JSON.stringify({ type: "bureau", bureau: "0001" }), startLat: 47.6, startLon: -2.75, durationMinutes: 60, totalSeconds: 600 })
      .run()
    ;(["b", "a", "c"] as const).forEach((addressId) =>
      ctx.db
        .insert(itineraryDoors)
        .values({ itineraryId: "it", addressId, position: { c: 0, a: 1, b: 2 }[addressId], serviceSeconds: 120, walkSecondsFromPrevious: 60, priority: 10, manual: false })
        .run(),
    )
  })

  async function sheet(): Promise<{ text: string; body: Sheet }> {
    const res = await router.request("/it/feuille")
    expect(res.status).toBe(200)
    const text = await res.text()
    return { text, body: JSON.parse(text) as Sheet }
  }

  it("serves the doors in itinerary order, without any name nor birthplace for an anonymized itinerary", async () => {
    // A dwelling text may carry a name read on a mailbox (KTD7): it must not leak through the last passage either.
    recordVisit(ctx, { id: uuid(), addressId: "a", source: "lien", visitDate: "2027-02-20", contact: "absent", dwelling: `Boîte ${SURNAMES[0]}` })
    const { text, body } = await sheet()
    expect(scan(text)).toEqual([])
    expect(body.namesShown).toBe(false)
    expect(body.doors.map((d) => [d.number, d.addressId])).toEqual([
      [1, "c"],
      [2, "a"],
      [3, "b"],
    ])
    expect(body.doors.map((d) => d.voters)).toEqual([[], [], []])
    expect(body.doors[1]).toMatchObject({ dwellings: 6, ageBands: ["18-25"], lastPassage: { visitDate: "2027-02-20", contact: "absent" } })
    expect(body).toMatchObject({ durationMinutes: 60, zoneLabel: "Bureau 0001" })
    // Cheat sheets once, grouped by age band: the young ones (doors a, b), the general ones (door c without voter).
    expect(body.cheatsheetGroups.map((g) => [g.ageBand, g.sheets.map((s) => s.id)])).toEqual([
      ["18-25", ["s-young"]],
      ["generale", ["s-gen"]],
    ])
  })

  it("shows the names only when the global switch and the itinerary allow them, never the birthplace", async () => {
    setAnonymizationMode(ctx.db, "nominatif")
    expect(scan((await sheet()).text)).toEqual([])
    ctx.db.update(itineraries).set({ showNames: true }).where(eq(itineraries.id, "it")).run()
    const { text, body } = await sheet()
    expect(body.namesShown).toBe(true)
    expect(body.doors[1]?.voters).toHaveLength(3)
    // The EU voter of door b is not a target: only one name there.
    expect(body.doors[2]?.voters).toHaveLength(1)
    expect(text).toContain(SURNAMES[0])
    expect(BIRTHPLACES.filter((p) => text.includes(p))).toEqual([])
    expect(text).not.toContain("PORTUGAL")
  })

  it("answers 404 for the sheet of an unknown itinerary", async () => {
    expect((await router.request("/nope/feuille")).status).toBe(404)
  })

  it("records a paper re-entry dated the session date with source feuille, and a resend creates nothing more", async () => {
    const feedbacks = [
      { id: uuid(), addressId: "a", dwelling: "apt 3", contact: "obtenu", contactQuality: "poli", toRevisit: true },
      { id: uuid(), addressId: "c", qualification: "logement_vide", qualificationScope: "immeuble" },
    ]
    const res = await post("/it/ressaisie", { visitDate: "2027-02-27", feedbacks })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Reentry
    expect(body.results).toEqual([
      { id: feedbacks[0]?.id, created: true, possibleDuplicate: false },
      { id: feedbacks[1]?.id, created: true, possibleDuplicate: false },
    ])
    const stored = ctx.db.select().from(visits).orderBy(visits.addressId).all()
    expect(stored.map((v) => [v.addressId, v.visitDate, v.source, v.itineraryId])).toEqual([
      ["a", "2027-02-27", "feuille", "it"],
      ["c", "2027-02-27", "feuille", "it"],
    ])
    expect(stored[0]).toMatchObject({ dwelling: "apt 3", contact: "obtenu", contactQuality: "poli", toRevisit: true })
    expect(stored[1]).toMatchObject({ qualification: "logement_vide", qualificationScope: "immeuble" })

    const again = (await (await post("/it/ressaisie", { visitDate: "2027-02-27", feedbacks })).json()) as Reentry
    expect(again.results.map((r) => r.created)).toEqual([false, false])
    expect(ctx.db.select().from(visits).all()).toHaveLength(2)
  })

  it("flags a paper feedback as a possible duplicate of a phone feedback on the same door and date, and still records it", async () => {
    recordVisit(ctx, { id: uuid(), addressId: "a", source: "lien", itineraryId: "it", visitDate: "2027-02-27", contact: "absent" })
    // Same door another day, and another door the same day: not duplicates.
    recordVisit(ctx, { id: uuid(), addressId: "b", source: "lien", itineraryId: "it", visitDate: "2027-02-26", contact: "absent" })
    const feedbacks = [
      { id: uuid(), addressId: "a", contact: "absent" },
      { id: uuid(), addressId: "b", contact: "absent" },
      { id: uuid(), addressId: "c", contact: "obtenu" },
    ]
    const body = (await (await post("/it/ressaisie", { visitDate: "2027-02-27", feedbacks })).json()) as Reentry
    expect(body.results.map((r) => r.possibleDuplicate)).toEqual([true, false, false])
    expect(ctx.db.select().from(visits).where(eq(visits.source, "feuille")).all()).toHaveLength(3)
  })

  it("lists the feedbacks recorded through the itinerary only, free texts masked unless names are shown", async () => {
    recordVisit(ctx, { id: uuid(), addressId: "a", source: "lien", itineraryId: "it", visitDate: "2027-02-27", contact: "absent", dwelling: "apt 3" })
    recordVisit(ctx, { id: uuid(), addressId: "b", source: "admin", visitDate: "2027-02-27", contact: "absent" })
    type Listed = { namesShown: boolean; visits: { addressId: string; dwelling: string | null }[] }
    const masked = (await (await router.request("/it/retours")).json()) as Listed
    expect(masked).toMatchObject({ namesShown: false, visits: [{ addressId: "a", dwelling: null }] })
    setAnonymizationMode(ctx.db, "nominatif")
    const shown = (await (await router.request("/it/retours")).json()) as Listed
    expect(shown).toMatchObject({ namesShown: true, visits: [{ addressId: "a", dwelling: "apt 3" }] })
    expect((await router.request("/nope/retours")).status).toBe(404)
  })

  it("refuses a re-entry without a session date, on a door outside the itinerary, or on an unknown itinerary", async () => {
    expect((await post("/it/ressaisie", { feedbacks: [{ id: uuid(), addressId: "a", contact: "absent" }] })).status).toBe(400)
    seedOther()
    const outside = await post("/it/ressaisie", { visitDate: "2027-02-27", feedbacks: [{ id: uuid(), addressId: "z", contact: "absent" }] })
    expect(outside.status).toBe(404)
    expect((await post("/nope/ressaisie", { visitDate: "2027-02-27", feedbacks: [{ id: uuid(), addressId: "a", contact: "absent" }] })).status).toBe(404)
    expect(ctx.db.select().from(visits).all()).toEqual([])
  })

  function seedOther(): void {
    ctx.db
      .insert(addresses)
      .values({ id: "z", kind: "number", number: 9, rep: null, streetName: "Rue fictive z", streetKey: "fictive-z", inseeCode: "56243", matchKey: "9 fictive-z", lat: 47.6, lon: -2.75, dwellings: null, updatedAt: 0 })
      .run()
  }
})
