// Fictional data and stubs for the route generator tests (U11). No real address, no real person.
import type { AppContext } from "../context.ts"
import { addresses, electors, imports, registrations, voteHistory } from "../db/schema/index.ts"
import { EMARGEMENT_ELECTION } from "../domain/voter-level.ts"
import type { LatLon, RoutingProblem, RoutingSolution } from "./routing-client.ts"
import type { DoorSolver } from "./solver.ts"

/**
 * Local frame: one unit is one second of walking. P(x, y) is the point x units east and y units north of the origin,
 * and the stub matrix gives the straight-line distance in units between two points.
 */
const LAT0 = 47.6
const LON0 = -2.75
const LAT_UNIT = 1e-5
const LON_UNIT = 1.5e-5

export function P(x: number, y: number): LatLon {
  return { lat: LAT0 + y * LAT_UNIT, lon: LON0 + x * LON_UNIT }
}

function units(p: LatLon): [number, number] {
  return [(p.lon - LON0) / LON_UNIT, (p.lat - LAT0) / LAT_UNIT]
}

export function stubMatrix(points: LatLon[]): number[][] {
  const u = points.map(units)
  return u.map(([ax, ay]) => u.map(([bx, by]) => Math.round(Math.hypot(ax - bx, ay - by))))
}

/** Square polygon covering x and y from -size to size, as [lat, lon] vertices. */
export function square(size: number): [number, number][] {
  return [P(-size, -size), P(size, -size), P(size, size), P(-size, size)].map((p) => [p.lat, p.lon])
}

/**
 * Reference solver for tests, independent of the code under test: takes the jobs by decreasing priority (ties in
 * job order) and appends each one to the loop when the loop, back at the start, still fits in the time window.
 */
export function greedyStubSolver(calls: RoutingProblem[] = []): DoorSolver {
  return {
    name: "stub",
    async solve(problem: RoutingProblem): Promise<RoutingSolution> {
      calls.push(problem)
      const d = problem.durations
      const jobs = [...problem.jobs].sort((a, b) => b.priority - a.priority)
      const route: typeof jobs = []
      let clock = 0
      let last = 0
      const steps: RoutingSolution["steps"] = []
      for (const job of jobs) {
        const arrival = clock + (d[last]?.[job.locationIndex] ?? 0)
        const leave = arrival + job.serviceSeconds
        if (leave + (d[job.locationIndex]?.[0] ?? 0) > problem.maxDurationSeconds) continue
        route.push(job)
        steps.push({ jobId: job.id, arrivalSeconds: arrival })
        clock = leave
        last = job.locationIndex
      }
      const total = clock + (route.length > 0 ? (d[last]?.[0] ?? 0) : 0)
      const service = route.reduce((s, j) => s + j.serviceSeconds, 0)
      return {
        orderedJobIds: route.map((j) => j.id),
        steps,
        totalSeconds: total,
        travelSeconds: total - service,
        serviceSeconds: service,
        unassignedJobIds: problem.jobs.filter((j) => !route.includes(j)).map((j) => j.id),
      }
    },
  }
}

export type FictionalLevel = "fort" | "moyen" | "votant" | "inconnu" | "hors_cible"

export interface FictionalAddress {
  id: string
  at: LatLon
  voters?: FictionalLevel[]
  dwellings?: number
  bureau?: string
  kind?: "number" | "street"
}

const ROUNDS: Record<Exclude<FictionalLevel, "inconnu" | "hors_cible">, ["oui" | "non", "oui" | "non"]> = {
  fort: ["non", "non"],
  moyen: ["non", "oui"],
  votant: ["oui", "oui"],
}

/** Inserts the addresses, a current list and its voting history (no emargement import: everyone is on the reference). */
export function seedAddresses(ctx: AppContext, list: FictionalAddress[]): void {
  const { db } = ctx
  const now = ctx.now().getTime()
  db.insert(imports).values({ id: "rep-test", kind: "rep", importedAt: now, rowCount: 0, isCurrent: true }).run()
  let n = 0
  for (const a of list) {
    db.insert(addresses)
      .values({
        id: a.id,
        kind: a.kind ?? "number",
        number: 1,
        rep: null,
        streetName: `Rue fictive ${a.id}`,
        streetKey: `fictive-${a.id}`,
        inseeCode: "56243",
        matchKey: `1 fictive-${a.id}`,
        lat: a.at.lat,
        lon: a.at.lon,
        dwellings: a.dwellings ?? null,
        updatedAt: now,
      })
      .run()
    for (const level of a.voters ?? []) {
      n += 1
      const electorId = `e${n}`
      db.insert(electors)
        .values({ id: electorId, identityKey: `k${n}`, birthName: `NOM${n}`, firstNames: `Prenom${n}`, birthDate: "1980-01-01", createdAt: now })
        .run()
      db.insert(registrations)
        .values({
          id: `r${n}`,
          electorId,
          importId: "rep-test",
          listType: level === "hors_cible" ? "complementaire_ue" : "principale",
          bureau: a.bureau ?? "0001",
          orderNumber: n,
          addressId: a.id,
          matchStatus: "ban",
        })
        .run()
      if (level === "inconnu" || level === "hors_cible") continue
      ROUNDS[level].forEach((value, i) =>
        db.insert(voteHistory).values({ id: `v${n}-${i}`, electorId, election: EMARGEMENT_ELECTION, round: i + 1, value }).run(),
      )
    }
  }
}
