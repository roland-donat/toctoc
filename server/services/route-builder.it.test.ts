// Integration test against the real local OSRM and VROOM (U11). Skipped unless TOCTOC_ROUTING_IT=1.
// Fictional addresses placed around Séné town centre; only coordinates reach the routing services.
import { describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import { timeline } from "../domain/time-model.ts"
import { addDoor, defaultRouteDeps, generateItinerary, removeDoor } from "./route-builder.ts"
import { seedAddresses, type FictionalAddress, type FictionalLevel } from "./route-builder.test-support.ts"
import { walkMatrix } from "./routing-client.ts"

const enabled = process.env.TOCTOC_ROUTING_IT === "1"
const routing = {
  osrmUrl: process.env.TOCTOC_IT_OSRM_URL ?? "http://127.0.0.1:5001",
  vroomUrl: process.env.TOCTOC_IT_VROOM_URL ?? "http://127.0.0.1:3010",
}
const CENTRE = { lat: 47.6195, lon: -2.7375 }

/** A 7 x 7 grid of fictional doors about 60 m apart; one in four has no voter, the others mix levels. */
function grid(): FictionalAddress[] {
  const levels: FictionalLevel[][] = [["fort"], ["fort", "fort"], ["moyen"], ["fort", "moyen", "votant"]]
  const out: FictionalAddress[] = []
  for (let i = 0; i < 7; i++)
    for (let j = 0; j < 7; j++) {
      const k = i * 7 + j
      out.push({
        id: `g${k}`,
        at: { lat: CENTRE.lat + (i - 3) * 0.00055, lon: CENTRE.lon + (j - 3) * 0.0008 },
        voters: k % 4 === 0 ? [] : levels[k % levels.length],
      })
    }
  return out
}

const zone = {
  type: "polygon" as const,
  points: [
    [CENTRE.lat - 0.003, CENTRE.lon - 0.004],
    [CENTRE.lat - 0.003, CENTRE.lon + 0.004],
    [CENTRE.lat + 0.003, CENTRE.lon + 0.004],
    [CENTRE.lat + 0.003, CENTRE.lon - 0.004],
  ] as [number, number][],
}

describe.skipIf(!enabled)("route generation on the real routing services", () => {
  it("builds a 60 minute loop back at the start, with at most 30 % of doors without voter", async () => {
    const { ctx } = createTestContext({ now: new Date("2027-03-01T10:00:00Z"), config: { routing } })
    seedAddresses(ctx, grid())
    const r = await generateItinerary(ctx, { zone, durationMinutes: 60 }, defaultRouteDeps(ctx))
    const doors = r.itinerary.doors
    expect(doors.length).toBeGreaterThan(3)
    expect(r.itinerary.totalSeconds).toBeLessThanOrEqual(3600)
    expect(r.leftOut.length).toBeGreaterThan(0)
    expect(doors.filter((d) => d.category === "sans_inscrit").length / doors.length).toBeLessThanOrEqual(0.3)

    // Same total recomputed from a fresh OSRM matrix: every leg, every door, and the walk back to the start.
    const points = [r.itinerary.start, ...doors.map((d) => ({ lat: d.lat, lon: d.lon }))]
    const m = await walkMatrix(ctx.config, points)
    const t = timeline(doors.map((_, k) => k + 1), m, [0, ...doors.map((d) => d.serviceSeconds)])
    expect(t.totalSeconds).toBe(r.itinerary.totalSeconds)
    expect(r.itinerary.returnWalkSeconds).toBe(t.returnWalkSeconds)
  })

  it("reorders the fixed set after a removal and a manual addition", async () => {
    const { ctx } = createTestContext({ now: new Date("2027-03-01T10:00:00Z"), config: { routing } })
    seedAddresses(ctx, [...grid(), { id: "far", at: { lat: CENTRE.lat + 0.006, lon: CENTRE.lon }, voters: ["votant"] }])
    const deps = defaultRouteDeps(ctx)
    const r = await generateItinerary(ctx, { zone, durationMinutes: 60 }, deps)
    const first = r.itinerary.doors[0]?.addressId ?? ""
    const removed = await removeDoor(ctx, r.itinerary.id, first, deps)
    expect(removed.doors.map((d) => d.addressId)).not.toContain(first)
    expect(removed.doors).toHaveLength(r.itinerary.doors.length - 1)
    const added = await addDoor(ctx, r.itinerary.id, "far", deps)
    expect(added.doors).toHaveLength(r.itinerary.doors.length)
    expect(added.doors.find((d) => d.addressId === "far")?.manual).toBe(true)
    expect(added.totalSeconds).toBeGreaterThan(removed.totalSeconds)
  })
})
