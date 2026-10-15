import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { itineraries, itineraryDoors } from "../db/schema/index.ts"
import {
  addDoor,
  generateItinerary,
  getItinerary,
  listItineraries,
  MAX_CANDIDATES,
  NoCandidateError,
  pointInPolygon,
  removeDoor,
  type RouteDeps,
} from "./route-builder.ts"
import { UNREACHABLE_SECONDS, type RoutingProblem } from "./routing-client.ts"
import { greedyStubSolver, P, seedAddresses, square, stubMatrix, type FictionalAddress } from "./route-builder.test-support.ts"
import { recordVisit } from "./visits.ts"
import { issueFieldLink, revokeFieldLinks } from "../lib/tokens.ts"

const NOW = new Date("2027-03-01T10:00:00Z")
let ctx: AppContext
let calls: RoutingProblem[]
let deps: RouteDeps
let seq = 0

function uuid(): string {
  seq += 1
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`
}

beforeEach(() => {
  ctx = createTestContext({ now: NOW }).ctx
  calls = []
  deps = { matrix: async (points) => stubMatrix(points), solver: greedyStubSolver(calls) }
})

const ZONE = { type: "polygon" as const, points: square(5000) }
const ORIGIN = P(0, 0)

async function generate(list: FictionalAddress[], durationMinutes: 60 | 90 | 120 = 60) {
  seedAddresses(ctx, list)
  return generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes }, deps)
}

const keptIds = (r: Awaited<ReturnType<typeof generate>>) => r.itinerary.doors.map((d) => d.addressId)

describe("pointInPolygon", () => {
  it("tells inside from outside of a concave polygon", () => {
    // L shape: [0,0] [0,4] [2,4] [2,2] [4,2] [4,0] in (lat, lon).
    const poly: [number, number][] = [
      [0, 0],
      [0, 4],
      [2, 4],
      [2, 2],
      [4, 2],
      [4, 0],
    ]
    expect(pointInPolygon({ lat: 1, lon: 1 }, poly)).toBe(true)
    expect(pointInPolygon({ lat: 3, lon: 1 }, poly)).toBe(true)
    expect(pointInPolygon({ lat: 3, lon: 3 }, poly)).toBe(false)
    expect(pointInPolygon({ lat: 5, lon: 1 }, poly)).toBe(false)
  })
})

describe("generateItinerary", () => {
  it("never exceeds 60 minutes, walking and time at doors included, back at the start", async () => {
    // Twelve strong-abstention houses on a line, 300 s apart: far more than an hour of work.
    const list = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, at: P(300 * (i + 1), 0), voters: ["fort" as const] }))
    const r = await generate(list)
    expect(calls[0]?.maxDurationSeconds).toBe(3600)
    expect(r.itinerary.totalSeconds).toBeLessThanOrEqual(3600)
    // Recomputed from the stub matrix: every leg plus 180 s per house, then back to the origin.
    const order = r.itinerary.doors
    let expected = 0
    let previous = ORIGIN
    for (const d of order) {
      const here = { lat: d.lat, lon: d.lon }
      expected += (stubMatrix([previous, here])[0]?.[1] ?? 0) + 180
      previous = here
    }
    expected += stubMatrix([previous, ORIGIN])[0]?.[1] ?? 0
    expect(r.itinerary.totalSeconds).toBe(expected)
    expect(order.length).toBeGreaterThan(0)
    expect(r.leftOut.length).toBe(12 - order.length)
  })

  it("keeps a building of 6 strong abstainers before a house with one at the same distance", async () => {
    // Opposite sides, 1500 s each way: only one of them fits in an hour.
    const r = await generate([
      { id: "house", at: P(-1500, 0), voters: ["fort"] },
      { id: "building", at: P(1500, 0), voters: ["fort", "fort", "fort", "fort", "fort", "fort"] },
    ])
    expect(keptIds(r)).toEqual(["building"])
    expect(r.leftOut.map((d) => d.addressId)).toEqual(["house"])
    expect(r.itinerary.doors[0]?.priority).toBe(100)
  })

  it("does not make an address a candidate for a voter at level inconnu", async () => {
    const r = await generate([
      { id: "unknown", at: P(10, 0), voters: ["inconnu", "inconnu"] },
      { id: "strong", at: P(20, 0), voters: ["fort"] },
    ])
    expect(keptIds(r)).toEqual(["strong"])
    expect(r.leftOut).toEqual([])
    expect(r.candidateCount).toBe(1)
  })

  it("keeps a close strong-abstention door and never proposes a close voters-only door", async () => {
    const r = await generate([
      { id: "voters", at: P(10, 0), voters: ["votant", "votant"] },
      { id: "strong", at: P(0, 10), voters: ["fort"] },
    ])
    expect(keptIds(r)).toEqual(["strong"])
    expect(r.candidateCount).toBe(1)
  })

  it("never proposes an excluded address nor an address of electors hors cible only", async () => {
    seedAddresses(ctx, [
      { id: "secondary", at: P(10, 0) },
      { id: "eu", at: P(20, 0), voters: ["hors_cible", "hors_cible"] },
      { id: "strong", at: P(30, 0), voters: ["fort"] },
    ])
    recordVisit(ctx, {
      id: uuid(),
      addressId: "secondary",
      source: "admin",
      visitDate: "2027-01-10",
      qualification: "residence_secondaire",
      qualificationScope: "immeuble",
    })
    const r = await generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes: 60 }, deps)
    expect(keptIds(r)).toEqual(["strong"])
    expect(r.candidateCount).toBe(1)
  })

  it("Covers AE3. keeps an address to come back to (21 days ago) before a never visited one, itself before one visited yesterday", async () => {
    // Three abstention moyenne houses 1000 s from the start and about 1730 s from each other: two fit in 90 minutes.
    seedAddresses(ctx, [
      { id: "yesterday", at: P(1000, 0), voters: ["moyen"] },
      { id: "never", at: P(-500, 866), voters: ["moyen"] },
      { id: "revisit", at: P(-500, -866), voters: ["moyen"] },
    ])
    recordVisit(ctx, { id: uuid(), addressId: "revisit", source: "admin", visitDate: "2027-02-08", toRevisit: true })
    recordVisit(ctx, { id: uuid(), addressId: "yesterday", source: "admin", visitDate: "2027-02-28", contact: "absent" })

    const one = await generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes: 60 }, deps)
    expect(keptIds(one)).toEqual(["revisit"])

    const two = await generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes: 90 }, deps)
    expect(keptIds(two).sort()).toEqual(["never", "revisit"])
    expect(two.leftOut.map((d) => d.addressId)).toEqual(["yesterday"])
    const priorities = Object.fromEntries(two.itinerary.doors.map((d) => [d.addressId, d.priority]))
    expect(priorities).toEqual({ revisit: 50, never: 20 })
  })

  it("keeps the share of sans inscrit doors at 30 % at most, relaunching the solver once when needed", async () => {
    // Five no-voter addresses next to the start, ten strong-abstention houses 900 s away.
    const list: FictionalAddress[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, at: P(60 * (i + 1), 0) })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, at: P(0, 900 + 60 * i), voters: ["fort" as const] })),
    ]
    const r = await generate(list)
    const kept = r.itinerary.doors
    const noVoter = kept.filter((d) => d.category === "sans_inscrit").length
    expect(noVoter / kept.length).toBeLessThanOrEqual(0.3)
    // Before solving: 3600 / (180 + 120) = 12 doors estimated, so 3 no-voter candidates; s3 and s4 dropped.
    expect(calls[0]?.jobs.length).toBe(13)
    // The first solution held 3 doors without voter out of 6: one relaunch with the best one only (30 % of 6).
    expect(calls).toHaveLength(2)
    expect(calls[1]?.jobs.length).toBe(11)
    expect(r.droppedByCap.map((d) => d.addressId).sort()).toEqual(["s1", "s2", "s3", "s4"])
    expect(noVoter).toBe(1)
    expect(kept).toHaveLength(6)
  })

  it("refuses a zone of sans inscrit doors only instead of saving an empty itinerary", async () => {
    seedAddresses(ctx, Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, at: P(60 * (i + 1), 0) })))
    await expect(generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes: 60 }, deps)).rejects.toBeInstanceOf(
      NoCandidateError,
    )
    expect(ctx.db.select().from(itineraries).all()).toEqual([])
    // The relaunch would have no job at all: it is never sent to the solver.
    expect(calls.every((c) => c.jobs.length > 0)).toBe(true)
  })

  it("lists a door trimmed by the cap after the relaunch once, as dropped by the cap, not as left out", async () => {
    const r = await generate([
      ...Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, at: P(60 * (i + 1), 0) })),
      { id: "f0", at: P(0, 300), voters: ["fort"] },
    ])
    expect(keptIds(r)).toEqual(["f0"])
    const dropped = new Set(r.droppedByCap.map((d) => d.addressId))
    expect([...dropped].sort()).toEqual(["s0", "s1", "s2"])
    expect(r.leftOut.filter((d) => dropped.has(d.addressId))).toEqual([])
  })

  it("caps the time at a large building's door through the door-time model", async () => {
    const r = await generate([
      { id: "twelve", at: P(50, 0), voters: ["fort"], dwellings: 12 },
      { id: "twenty", at: P(-50, 0), voters: ["fort"], dwellings: 20 },
    ])
    const service = Object.fromEntries(r.itinerary.doors.map((d) => [d.addressId, d.serviceSeconds]))
    // 3 min + 11 extra dwellings = 14 min; 3 + 19 = 22, capped at 15 min.
    expect(service).toEqual({ twelve: 840, twenty: 900 })
    const stored = ctx.db.select().from(itineraryDoors).where(eq(itineraryDoors.addressId, "twenty")).get()
    expect(stored?.serviceSeconds).toBe(900)
  })

  it("refuses a zone without candidate and creates nothing", async () => {
    seedAddresses(ctx, [{ id: "voters", at: P(10, 0), voters: ["votant"] }])
    await expect(generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes: 60 }, deps)).rejects.toBeInstanceOf(
      NoCandidateError,
    )
    expect(ctx.db.select().from(itineraries).all()).toEqual([])
    expect(calls).toEqual([])
  })

  it("only takes the doors inside the drawn polygon, and starts at its centre by default", async () => {
    seedAddresses(ctx, [
      { id: "inside", at: P(100, 100), voters: ["fort"] },
      { id: "outside", at: P(3000, 3000), voters: ["fort"] },
    ])
    const zone = { type: "polygon" as const, points: square(500) }
    const r = await generateItinerary(ctx, { zone, durationMinutes: 60 }, deps)
    expect(keptIds(r)).toEqual(["inside"])
    expect(r.itinerary.start.lat).toBeCloseTo(ORIGIN.lat, 7)
    expect(r.itinerary.start.lon).toBeCloseTo(ORIGIN.lon, 7)
  })

  it("takes the addresses with a voter registered in the chosen bureau", async () => {
    seedAddresses(ctx, [
      { id: "b1", at: P(100, 0), voters: ["fort"], bureau: "0001" },
      { id: "b2", at: P(-100, 0), voters: ["fort"], bureau: "0002" },
    ])
    const r = await generateItinerary(ctx, { zone: { type: "bureau", bureau: "0002" }, start: ORIGIN, durationMinutes: 60 }, deps)
    expect(keptIds(r)).toEqual(["b2"])
    expect(r.itinerary.zoneLabel).toBe("Bureau 0002")
  })

  it(`keeps the ${MAX_CANDIDATES} best candidates when the zone holds more, and says so`, async () => {
    const list: FictionalAddress[] = [
      ...Array.from({ length: MAX_CANDIDATES }, (_, i) => ({ id: `m${i}`, at: P(i % 50, Math.floor(i / 50)), voters: ["moyen" as const] })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, at: P(2000 + i, 2000), voters: ["fort" as const] })),
    ]
    const r = await generate(list)
    expect(r.candidateCount).toBe(MAX_CANDIDATES + 5)
    expect(r.truncatedCount).toBe(5)
    expect(calls[0]?.jobs.length).toBe(MAX_CANDIDATES)
    // The five strong doors (40) are kept among the candidates, five abstention moyenne doors (20) are not.
    expect(calls[0]?.jobs.filter((j) => j.priority === 40)).toHaveLength(5)
  })

  it("persists the doors in visit order with their walking time from the previous stop", async () => {
    const r = await generate([
      { id: "a", at: P(100, 0), voters: ["fort"] },
      { id: "b", at: P(200, 0), voters: ["moyen"] },
    ])
    const stored = ctx.db.select().from(itineraryDoors).where(eq(itineraryDoors.itineraryId, r.itinerary.id)).all()
    expect(stored.sort((x, y) => x.position - y.position).map((d) => [d.addressId, d.walkSecondsFromPrevious, d.manual])).toEqual([
      ["a", 100, false],
      ["b", 100, false],
    ])
    // 100 + 180 + 100 + 180 + 200 back.
    expect(r.itinerary.totalSeconds).toBe(760)
    expect(r.itinerary.doors.map((d) => d.arrivalSeconds)).toEqual([100, 380])
    expect(getItinerary(ctx, r.itinerary.id)).toEqual(r.itinerary)
    expect(listItineraries(ctx)).toEqual([
      expect.objectContaining({ id: r.itinerary.id, doorCount: 2, totalSeconds: 760, durationMinutes: 60, zoneLabel: "Zone tracée" }),
    ])
  })
})

describe("adjusting an itinerary", () => {
  it("refuses to add a door the walking network cannot reach, leaving the itinerary and its total unchanged", async () => {
    const island = P(9000, 0)
    const r = await generate([
      { id: "a", at: P(100, 0), voters: ["fort"] },
      { id: "b", at: P(200, 0), voters: ["fort"] },
      { id: "island", at: island, voters: ["fort"] },
    ])
    expect(keptIds(r).sort()).toEqual(["a", "b"])
    // OSRM gives no route to or from the island (null cells become UNREACHABLE_SECONDS).
    const isIsland = (p: { lat: number; lon: number }) => p.lat === island.lat && p.lon === island.lon
    const cut: RouteDeps = {
      ...deps,
      matrix: async (points) =>
        stubMatrix(points).map((row, i) =>
          row.map((v, j) => (i !== j && (isIsland(points[i] ?? island) || isIsland(points[j] ?? island)) ? UNREACHABLE_SECONDS : v)),
        ),
    }
    await expect(addDoor(ctx, r.itinerary.id, "island", cut)).rejects.toMatchObject({ code: "door_unreachable" })
    expect(getItinerary(ctx, r.itinerary.id)).toEqual(r.itinerary)
  })

  it("removes a door, reorders the rest and updates the total", async () => {
    const r = await generate([
      { id: "a", at: P(100, 0), voters: ["fort"] },
      { id: "b", at: P(200, 0), voters: ["fort"] },
      { id: "c", at: P(300, 0), voters: ["fort"] },
    ])
    expect(keptIds(r).sort()).toEqual(["a", "b", "c"])
    const after = await removeDoor(ctx, r.itinerary.id, "b", deps)
    expect(after.doors.map((d) => d.addressId).sort()).toEqual(["a", "c"])
    expect(after.doors.map((d) => d.position)).toEqual([0, 1])
    // Every remaining door forced in: same priority, unbounded window.
    const forced = calls.at(-1)
    expect(forced?.jobs.map((j) => j.priority)).toEqual([100, 100])
    expect(forced?.maxDurationSeconds).toBeGreaterThan(24 * 3600)
    // a then c, or c then a: 300 walking each way plus 360 at doors.
    expect(after.totalSeconds).toBe(960)
    expect(getItinerary(ctx, r.itinerary.id)?.totalSeconds).toBe(960)
  })

  it("adds any numbered address by hand, flagged manual, even outside the rules", async () => {
    seedAddresses(ctx, [
      { id: "a", at: P(100, 0), voters: ["fort"] },
      { id: "voters", at: P(5000, 5000), voters: ["votant"] },
    ])
    const r = await generateItinerary(ctx, { zone: { type: "polygon", points: square(500) }, start: ORIGIN, durationMinutes: 60 }, deps)
    const after = await addDoor(ctx, r.itinerary.id, "voters", deps)
    const added = after.doors.find((d) => d.addressId === "voters")
    expect(added).toMatchObject({ manual: true, priority: 0, serviceSeconds: 180 })
    expect(after.doors).toHaveLength(2)
    expect(after.totalSeconds).toBeGreaterThan(r.itinerary.totalSeconds)
  })
})

describe("soft reservation of the doors of a fresh field link (KTD11)", () => {
  const HOUR = 3600 * 1000
  let setNow: (d: Date) => void

  beforeEach(() => {
    const t = createTestContext({ now: NOW })
    ctx = t.ctx
    setNow = t.setNow
    seedAddresses(ctx, [
      { id: "a", at: P(100, 0), voters: ["fort"] },
      { id: "b", at: P(200, 0), voters: ["fort"] },
    ])
  })

  async function firstWithLinkOn(addressId: string): Promise<string> {
    const first = await generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes: 60 }, deps)
    for (const d of first.itinerary.doors) if (d.addressId !== addressId) await removeDoor(ctx, first.itinerary.id, d.addressId, deps)
    issueFieldLink(ctx, first.itinerary.id)
    return first.itinerary.id
  }

  const next = async () => keptIds(await generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes: 60 }, deps))

  it("does not propose a door of a link issued less than 24 h ago that has no feedback", async () => {
    await firstWithLinkOn("a")
    setNow(new Date(NOW.getTime() + 23 * HOUR))
    expect(await next()).toEqual(["b"])
  })

  it("proposes it again once 24 h have passed", async () => {
    await firstWithLinkOn("a")
    setNow(new Date(NOW.getTime() + 24 * HOUR))
    expect((await next()).sort()).toEqual(["a", "b"])
  })

  it("proposes it again as soon as it has received a feedback since the link was issued", async () => {
    const id = await firstWithLinkOn("a")
    setNow(new Date(NOW.getTime() + HOUR))
    recordVisit(ctx, { id: uuid(), addressId: "a", source: "lien", itineraryId: id, contact: "absent", toRevisit: true })
    expect(await next()).toContain("a")
  })

  it("does not reserve the doors of a revoked link, and a reserved door can still be added by hand", async () => {
    const id = await firstWithLinkOn("a")
    const second = await generateItinerary(ctx, { zone: ZONE, start: ORIGIN, durationMinutes: 60 }, deps)
    expect(keptIds(second)).toEqual(["b"])
    const added = await addDoor(ctx, second.itinerary.id, "a", deps)
    expect(added.doors.map((d) => d.addressId).sort()).toEqual(["a", "b"])
    revokeFieldLinks(ctx, id)
    expect((await next()).sort()).toEqual(["a", "b"])
  })
})
