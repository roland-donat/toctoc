import { describe, expect, it } from "vitest"
import {
  RoutingUnavailableError,
  UNREACHABLE_SECONDS,
  solveWithVroom,
  walkMatrix,
  type FetchLike,
  type RoutingProblem,
} from "./routing-client.ts"

const config = { routing: { osrmUrl: "http://127.0.0.1:5000", vroomUrl: "http://127.0.0.1:3010" } }

interface Captured {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(body: unknown, captured: Captured[] = [], status = 200): FetchLike {
  return async (input, init) => {
    captured.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }
}

// Fictional points around Séné (no real address attached).
const points = [
  { lat: 47.62, lon: -2.75 },
  { lat: 47.621, lon: -2.751 },
  { lat: 47.6, lon: -2.72 },
]

describe("walkMatrix", () => {
  it("queries OSRM foot table with lon,lat pairs and returns whole seconds indexed like the points", async () => {
    const captured: Captured[] = []
    const osrm = {
      code: "Ok",
      durations: [
        [0, 125.4, 1800.6],
        [124.5, 0, 1750.2],
        [1801, 1749.9, 0],
      ],
    }
    const matrix = await walkMatrix(config, points, { fetch: fakeFetch(osrm, captured) })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toBe(
      "http://127.0.0.1:5000/table/v1/foot/-2.75,47.62;-2.751,47.621;-2.72,47.6?annotations=duration",
    )
    expect(matrix).toEqual([
      [0, 125, 1801],
      [125, 0, 1750],
      [1801, 1750, 0],
    ])
  })

  it("turns unreachable pairs (null) into the large sentinel, never zero", async () => {
    const osrm = {
      code: "Ok",
      durations: [
        [0, null, 60],
        [null, 0, null],
        [60, null, 0],
      ],
    }
    const matrix = await walkMatrix(config, points, { fetch: fakeFetch(osrm) })
    expect(matrix[0]?.[1]).toBe(UNREACHABLE_SECONDS)
    expect(matrix[1]?.[2]).toBe(UNREACHABLE_SECONDS)
    expect(matrix[0]?.[2]).toBe(60)
    expect(UNREACHABLE_SECONDS).toBeGreaterThanOrEqual(24 * 3600)
  })

  it("raises RoutingUnavailableError when OSRM cannot be reached", async () => {
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed")
    }
    const err = await walkMatrix(config, points, { fetch: down }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RoutingUnavailableError)
    expect((err as RoutingUnavailableError).code).toBe("routing_unavailable")
  })

  it("raises RoutingUnavailableError when OSRM does not answer before the timeout", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })
    const err = await walkMatrix(config, points, { fetch: hanging, timeoutMs: 20 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RoutingUnavailableError)
    expect((err as RoutingUnavailableError).service).toBe("osrm")
  })
})

const problem: RoutingProblem = {
  durations: [
    [0, 120, 300, 400],
    [120, 0, 200, 350],
    [300, 200, 0, 150],
    [400, 350, 150, 0],
  ],
  jobs: [
    { id: 11, locationIndex: 1, serviceSeconds: 180, priority: 70 },
    { id: 12, locationIndex: 2, serviceSeconds: 240, priority: 40 },
    { id: 13, locationIndex: 3, serviceSeconds: 900, priority: 10 },
  ],
  maxDurationSeconds: 1800,
}

const vroomSolution = {
  code: 0,
  summary: { cost: 620, routes: 1, unassigned: 1, service: 420, duration: 620, waiting_time: 0, priority: 110 },
  unassigned: [{ id: 13, location_index: 3, type: "job" }],
  routes: [
    {
      vehicle: 1,
      cost: 620,
      service: 420,
      duration: 620,
      waiting_time: 0,
      priority: 110,
      steps: [
        { type: "start", location_index: 0, arrival: 0, duration: 0, service: 0, waiting_time: 0 },
        { type: "job", id: 11, job: 11, location_index: 1, arrival: 120, duration: 120, service: 180, waiting_time: 0 },
        { type: "job", id: 12, job: 12, location_index: 2, arrival: 500, duration: 320, service: 240, waiting_time: 0 },
        { type: "end", location_index: 0, arrival: 1040, duration: 620, service: 0, waiting_time: 0 },
      ],
    },
  ],
}

describe("solveWithVroom", () => {
  it("converts the VROOM solution into ordered job ids, arrivals, totals and unassigned ids", async () => {
    const solution = await solveWithVroom(config, problem, { fetch: fakeFetch(vroomSolution) })
    expect(solution).toEqual({
      orderedJobIds: [11, 12],
      steps: [
        { jobId: 11, arrivalSeconds: 120 },
        { jobId: 12, arrivalSeconds: 500 },
      ],
      totalSeconds: 1040,
      travelSeconds: 620,
      serviceSeconds: 420,
      unassignedJobIds: [13],
    })
  })

  it("returns every job as unassigned when VROOM finds no route", async () => {
    const empty = {
      code: 0,
      summary: { cost: 0, routes: 0, unassigned: 3, service: 0, duration: 0, waiting_time: 0, priority: 0 },
      unassigned: [
        { id: 11, type: "job" },
        { id: 12, type: "job" },
        { id: 13, type: "job" },
      ],
      routes: [],
    }
    const solution = await solveWithVroom(config, problem, { fetch: fakeFetch(empty) })
    expect(solution.orderedJobIds).toEqual([])
    expect(solution.totalSeconds).toBe(0)
    expect(solution.unassignedJobIds).toEqual([11, 12, 13])
  })

  it("posts only matrix indexes, priorities and durations, with the session bounded by the vehicle time window", async () => {
    const captured: Captured[] = []
    await solveWithVroom(config, problem, { fetch: fakeFetch(vroomSolution, captured) })
    expect(captured[0]?.url).toBe("http://127.0.0.1:3010/")
    expect(captured[0]?.init?.method).toBe("POST")
    const body = JSON.parse(String(captured[0]?.init?.body)) as Record<string, unknown>
    expect(body).toEqual({
      vehicles: [{ id: 1, profile: "foot", start_index: 0, end_index: 0, time_window: [0, 1800] }],
      jobs: [
        { id: 11, location_index: 1, service: 180, priority: 70 },
        { id: 12, location_index: 2, service: 240, priority: 40 },
        { id: 13, location_index: 3, service: 900, priority: 10 },
      ],
      matrices: { foot: { durations: problem.durations } },
    })
    // KTD1: the walking-only cap would ignore time spent at doors.
    expect(JSON.stringify(body)).not.toContain("max_travel_time")
    expect(JSON.stringify(body)).not.toMatch(/"(location|description|address|name)"/)
  })

  it("raises RoutingUnavailableError when VROOM is down or times out", async () => {
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed")
    }
    const downErr = await solveWithVroom(config, problem, { fetch: down }).catch((e: unknown) => e)
    expect(downErr).toBeInstanceOf(RoutingUnavailableError)
    expect((downErr as RoutingUnavailableError).service).toBe("vroom")

    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })
    const timeoutErr = await solveWithVroom(config, problem, { fetch: hanging, timeoutMs: 20 }).catch(
      (e: unknown) => e,
    )
    expect(timeoutErr).toBeInstanceOf(RoutingUnavailableError)
  })
})
