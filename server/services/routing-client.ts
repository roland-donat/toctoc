// Client for the local routing services (OSRM foot profile, VROOM), both bound to 127.0.0.1 (KTD1, R14).
// Only coordinates, matrix indexes, priorities and durations are sent: never an address or a name.

import type { AppConfig } from "../lib/config.ts"
import { logInfo } from "../lib/log.ts"

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface RoutingClientOptions {
  fetch?: FetchLike
  timeoutMs?: number
}

export interface RoutingConfig {
  routing: AppConfig["routing"]
}

export interface LatLon {
  lat: number
  lon: number
}

/** Walking time used for a pair OSRM cannot connect: large enough that no session can include it. */
export const UNREACHABLE_SECONDS = 1_000_000

const DEFAULT_MATRIX_TIMEOUT_MS = 10_000
const DEFAULT_SOLVE_TIMEOUT_MS = 30_000

export type RoutingService = "osrm" | "vroom"

class RoutingError extends Error {
  override name = "RoutingError"
  readonly code: string = "routing_failed"
  readonly service: RoutingService
  constructor(service: RoutingService, message: string) {
    super(message)
    this.service = service
  }
}

/** The routing service is stopped, unreachable, failing or too slow. */
export class RoutingUnavailableError extends RoutingError {
  override name = "RoutingUnavailableError"
  override readonly code = "routing_unavailable"
}

/** One door to visit. `locationIndex` points into `RoutingProblem.durations`; index 0 is the start point. */
export interface RoutingJob {
  id: number
  locationIndex: number
  serviceSeconds: number
  /** 0 to 100 (KTD8). */
  priority: number
}

export interface RoutingProblem {
  /** Square walking-time matrix in whole seconds; index 0 is the start and end point of the loop. */
  durations: number[][]
  jobs: RoutingJob[]
  /** Session length, walking and time at doors included (KTD1). */
  maxDurationSeconds: number
}

export interface RoutingStep {
  jobId: number
  /** Seconds since the start of the session. */
  arrivalSeconds: number
}

export interface RoutingSolution {
  orderedJobIds: number[]
  steps: RoutingStep[]
  /** Back at the start point, walking and service included. */
  totalSeconds: number
  travelSeconds: number
  serviceSeconds: number
  unassignedJobIds: number[]
}

async function request(
  service: RoutingService,
  url: string,
  init: RequestInit,
  opts: RoutingClientOptions,
  defaultTimeoutMs: number,
): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? defaultTimeoutMs) })
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "is unreachable"
    throw new RoutingUnavailableError(service, `Routing service ${service} ${reason}`)
  }
  if (response.status >= 500) {
    throw new RoutingUnavailableError(service, `Routing service ${service} answered HTTP ${response.status}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new RoutingError(service, `Routing service ${service} returned invalid JSON (HTTP ${response.status})`)
  }
  if (!response.ok) {
    throw new RoutingError(service, `Routing service ${service} rejected the request (HTTP ${response.status})`)
  }
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Walking times between every pair of points, in whole seconds, indexed like `points`. */
export async function walkMatrix(
  config: RoutingConfig,
  points: LatLon[],
  opts: RoutingClientOptions = {},
): Promise<number[][]> {
  if (points.length === 0) return []
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";")
  const url = `${config.routing.osrmUrl.replace(/\/$/, "")}/table/v1/foot/${coords}?annotations=duration`
  const body = await request("osrm", url, { method: "GET" }, opts, DEFAULT_MATRIX_TIMEOUT_MS)

  if (!isRecord(body) || body.code !== "Ok" || !Array.isArray(body.durations)) {
    throw new RoutingError("osrm", "OSRM table response has no duration matrix")
  }
  const rows: unknown[] = body.durations
  if (rows.length !== points.length) {
    throw new RoutingError("osrm", "OSRM table size does not match the number of points")
  }
  let unreachable = 0
  const matrix = rows.map((row) => {
    if (!Array.isArray(row) || row.length !== points.length) {
      throw new RoutingError("osrm", "OSRM table row size does not match the number of points")
    }
    return row.map((cell: unknown) => {
      if (typeof cell === "number") return Math.round(cell)
      unreachable += 1
      return UNREACHABLE_SECONDS
    })
  })
  if (unreachable > 0) logInfo("routing_unreachable_pairs", { pairs: unreachable, points: points.length })
  return matrix
}

interface VroomStep {
  type: string
  id?: number
  arrival: number
}

/** Solves the door selection and order with VROOM on a custom foot matrix (KTD1). */
export async function solveWithVroom(
  config: RoutingConfig,
  problem: RoutingProblem,
  opts: RoutingClientOptions = {},
): Promise<RoutingSolution> {
  const payload = {
    vehicles: [
      { id: 1, profile: "foot", start_index: 0, end_index: 0, time_window: [0, problem.maxDurationSeconds] },
    ],
    jobs: problem.jobs.map((j) => ({
      id: j.id,
      location_index: j.locationIndex,
      service: j.serviceSeconds,
      priority: j.priority,
    })),
    matrices: { foot: { durations: problem.durations } },
  }
  const url = `${config.routing.vroomUrl.replace(/\/$/, "")}/`
  const body = await request(
    "vroom",
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
    opts,
    DEFAULT_SOLVE_TIMEOUT_MS,
  )

  if (!isRecord(body) || body.code !== 0 || !Array.isArray(body.routes) || !Array.isArray(body.unassigned)) {
    throw new RoutingError("vroom", "VROOM response is not a solution")
  }
  const unassignedJobIds = body.unassigned.flatMap((u: unknown) =>
    isRecord(u) && typeof u.id === "number" ? [u.id] : [],
  )
  const route: unknown = body.routes[0]
  if (!isRecord(route) || !Array.isArray(route.steps)) {
    return { orderedJobIds: [], steps: [], totalSeconds: 0, travelSeconds: 0, serviceSeconds: 0, unassignedJobIds }
  }
  const vroomSteps = route.steps.filter(
    (s: unknown): s is VroomStep => isRecord(s) && typeof s.type === "string" && typeof s.arrival === "number",
  )
  const steps = vroomSteps.flatMap((s) =>
    s.type === "job" && typeof s.id === "number" ? [{ jobId: s.id, arrivalSeconds: s.arrival }] : [],
  )
  const end = vroomSteps.find((s) => s.type === "end")
  const num = (v: unknown): number => (typeof v === "number" ? v : 0)
  return {
    orderedJobIds: steps.map((s) => s.jobId),
    steps,
    totalSeconds: end ? end.arrival : num(route.duration) + num(route.service) + num(route.waiting_time),
    travelSeconds: num(route.duration),
    serviceSeconds: num(route.service),
    unassignedJobIds,
  }
}
