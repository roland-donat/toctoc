// Route generator (U11, R12 to R14): candidates of a zone, KTD8 priorities and door times, no-voter cap,
// then the solver behind the single interface of KTD2, and the stored itinerary the administrator adjusts.
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, notExists, or } from "drizzle-orm"
import type { AppContext } from "../context.ts"
import { addresses, fieldLinks, itineraries, itineraryDoors, registrations, visits } from "../db/schema/index.ts"
import { loadParameters, type PriorityParameters } from "../domain/parameters.ts"
import { priority, serviceSeconds } from "../domain/priority.ts"
import type { AddressStatus, Category, FollowUp } from "../domain/qualification.ts"
import { estimateDoorCount, noVoterQuota, timeline } from "../domain/time-model.ts"
import { computeAddressStatuses } from "./address-status.ts"
import { addressLabel, currentRepImportId } from "./current-list.ts"
import { walkMatrix, type LatLon, type RoutingJob, type RoutingProblem } from "./routing-client.ts"
import { vroomSolver, type DoorSolver } from "./solver.ts"

/** Above this many candidates only the best ones go to the solver, so the matrix and the solve stay fast. */
export const MAX_CANDIDATES = 300

/** KTD11: the doors of a field link issued less than this long ago, without feedback since, are not proposed again. */
const RESERVATION_MS = 24 * 3600 * 1000

export const DURATIONS = [60, 90, 120] as const
export type DurationMinutes = (typeof DURATIONS)[number]

/** Polygon vertices are [lat, lon]. */
export type Zone = { type: "polygon"; points: [number, number][] } | { type: "bureau"; bureau: string }

export interface RouteDeps {
  matrix: (points: LatLon[]) => Promise<number[][]>
  solver: DoorSolver
}

export function defaultRouteDeps(ctx: AppContext): RouteDeps {
  return { matrix: (points) => walkMatrix(ctx.config, points), solver: vroomSolver(ctx.config) }
}

/** The zone holds no door worth a visit (or none once the no-voter cap is applied): nothing is created. */
export class NoCandidateError extends Error {
  override name = "NoCandidateError"
  readonly code = "no_candidate"
  constructor() {
    super("The zone has no candidate door")
  }
}

export type ItineraryErrorCode =
  | "itinerary_not_found"
  | "address_not_found"
  | "door_not_found"
  | "door_already_present"
  /** The solver could not place a door of the set (no walking route): its leg would count UNREACHABLE_SECONDS. */
  | "door_unreachable"

export class ItineraryError extends Error {
  override name = "ItineraryError"
  readonly code: ItineraryErrorCode
  constructor(code: ItineraryErrorCode) {
    super(code)
    this.code = code
  }
}

export interface DoorSummary {
  addressId: string
  label: string
  category: Category
  priority: number
}

export interface ItineraryDoorView extends DoorSummary {
  position: number
  lat: number
  lon: number
  followUp: FollowUp
  registeredCount: number
  serviceSeconds: number
  walkSecondsFromPrevious: number
  arrivalSeconds: number
  manual: boolean
}

export interface ItineraryDetail {
  id: string
  createdAt: number
  zone: Zone
  zoneLabel: string
  start: LatLon
  durationMinutes: number
  totalSeconds: number
  walkSeconds: number
  serviceSeconds: number
  returnWalkSeconds: number
  doors: ItineraryDoorView[]
}


export interface GenerateInput {
  zone: Zone
  /** Defaults to the centre of the zone. */
  start?: LatLon | null
  durationMinutes: DurationMinutes
}

export interface GenerateResult {
  itinerary: ItineraryDetail
  /** Candidates the solver could not fit in the session, best first. */
  leftOut: DoorSummary[]
  /** "Sans inscrit" candidates set aside by the no-voter share cap (KTD8), best first. */
  droppedByCap: DoorSummary[]
  /** Candidate doors of the zone, before the MAX_CANDIDATES limit. */
  candidateCount: number
  /** Candidates beyond MAX_CANDIDATES, never sent to the solver. */
  truncatedCount: number
}

interface Candidate extends DoorSummary {
  lat: number
  lon: number
  serviceSeconds: number
}

/** Ray casting on [lat, lon] vertices; enough for a neighbourhood-sized polygon. */
export function pointInPolygon(p: LatLon, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (!a || !b) continue
    const [aLat, aLon] = a
    const [bLat, bLon] = b
    if (aLat > p.lat !== bLat > p.lat && p.lon < ((bLon - aLon) * (p.lat - aLat)) / (bLat - aLat) + aLon) inside = !inside
  }
  return inside
}

/** Area centroid of a polygon, falling back to the mean of its vertices when it is degenerate. */
function polygonCentroid(polygon: readonly (readonly [number, number])[]): LatLon {
  let area = 0
  let cLat = 0
  let cLon = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]
    const b = polygon[i]
    if (!a || !b) continue
    const cross = a[1] * b[0] - b[1] * a[0]
    area += cross
    cLon += (a[1] + b[1]) * cross
    cLat += (a[0] + b[0]) * cross
  }
  if (Math.abs(area) < 1e-15) return meanPoint(polygon.map(([lat, lon]) => ({ lat, lon })))
  return { lat: cLat / (3 * area), lon: cLon / (3 * area) }
}

function meanPoint(points: readonly LatLon[]): LatLon {
  const n = Math.max(points.length, 1)
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / n,
    lon: points.reduce((s, p) => s + p.lon, 0) / n,
  }
}

/** Squared planar distance, only used to break priority ties in favour of the doors closer to the start. */
function closeness(a: LatLon, b: LatLon): number {
  const dLat = a.lat - b.lat
  const dLon = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)
  return dLat * dLat + dLon * dLon
}

export function zoneLabel(zone: Zone): string {
  return zone.type === "bureau" ? `Bureau ${zone.bureau}` : "Zone tracée"
}

interface Place {
  id: string
  lat: number
  lon: number
  label: string
}

function placesOf(ctx: AppContext, ids: readonly string[]): Map<string, Place> {
  if (ids.length === 0) return new Map()
  return new Map(
    ctx.db
      .select({ id: addresses.id, number: addresses.number, rep: addresses.rep, streetName: addresses.streetName, lat: addresses.lat, lon: addresses.lon })
      .from(addresses)
      .where(inArray(addresses.id, [...ids]))
      .all()
      .map((a) => [a.id, { id: a.id, lat: a.lat, lon: a.lon, label: addressLabel(a) }]),
  )
}

/** Numbered, non-retired addresses of the zone. */
function zoneAddressIds(ctx: AppContext, zone: Zone): string[] {
  const numbered = and(eq(addresses.kind, "number"), isNull(addresses.retiredAt))
  if (zone.type === "polygon") {
    return ctx.db
      .select({ id: addresses.id, lat: addresses.lat, lon: addresses.lon })
      .from(addresses)
      .where(numbered)
      .all()
      .filter((a) => pointInPolygon(a, zone.points))
      .map((a) => a.id)
  }
  const importId = currentRepImportId(ctx.db)
  if (importId === null) return []
  return ctx.db
    .selectDistinct({ id: addresses.id })
    .from(registrations)
    .innerJoin(addresses, eq(addresses.id, registrations.addressId))
    .where(and(eq(registrations.importId, importId), eq(registrations.bureau, zone.bureau), isNotNull(registrations.addressId), numbered))
    .all()
    .map((a) => a.id)
}

/**
 * Doors softly reserved by a field link (KTD11): in an itinerary whose live link was issued less than 24 h ago,
 * and without any feedback recorded since that issue. A revoked link reserves nothing.
 */
function reservedAddressIds(ctx: AppContext): Set<string> {
  const since = ctx.now().getTime() - RESERVATION_MS
  const fedSinceIssue = ctx.db
    .select({ id: visits.id })
    .from(visits)
    .where(and(eq(visits.addressId, itineraryDoors.addressId), gte(visits.recordedAt, fieldLinks.issuedAt)))
  const doors = ctx.db
    .select({ addressId: itineraryDoors.addressId })
    .from(fieldLinks)
    .innerJoin(itineraryDoors, eq(itineraryDoors.itineraryId, fieldLinks.itineraryId))
    // A link closed by the end or the archiving of its session reserves nothing any more.
    .where(
      and(
        isNull(fieldLinks.revokedAt),
        or(isNull(fieldLinks.expiresAt), gt(fieldLinks.expiresAt, ctx.now().getTime())),
        gt(fieldLinks.issuedAt, since),
        notExists(fedSinceIssue),
      ),
    )
    .all()
  return new Set(doors.map((d) => d.addressId))
}

function toCandidate(status: AddressStatus, place: Place, params: PriorityParameters): Candidate {
  return {
    addressId: status.addressId,
    label: place.label,
    category: status.category,
    priority: priority(status, params),
    lat: place.lat,
    lon: place.lon,
    serviceSeconds: serviceSeconds(status, params),
  }
}

const summary = (c: Candidate): DoorSummary => ({ addressId: c.addressId, label: c.label, category: c.category, priority: c.priority })

/** The `quota` best "sans inscrit" candidates stay, the others are returned as dropped. Order is kept. */
function capNoVoter(sorted: readonly Candidate[], quota: number): { kept: Candidate[]; dropped: Candidate[] } {
  const kept: Candidate[] = []
  const dropped: Candidate[] = []
  let noVoter = 0
  for (const c of sorted) {
    if (c.category !== "sans_inscrit") kept.push(c)
    else if (noVoter < quota) {
      kept.push(c)
      noVoter += 1
    } else dropped.push(c)
  }
  return { kept, dropped }
}

/** Jobs of `candidates`; candidate k of `all` is matrix index k + 1 and job id k + 1. */
function jobsOf(candidates: readonly Candidate[], indexOf: Map<string, number>): RoutingJob[] {
  return candidates.map((c) => {
    const index = indexOf.get(c.addressId) ?? 0
    return { id: index, locationIndex: index, serviceSeconds: c.serviceSeconds, priority: c.priority }
  })
}

export async function generateItinerary(ctx: AppContext, input: GenerateInput, deps: RouteDeps): Promise<GenerateResult> {
  const params = loadParameters(ctx.db)
  const reserved = reservedAddressIds(ctx)
  const ids = zoneAddressIds(ctx, input.zone).filter((id) => !reserved.has(id))
  const places = placesOf(ctx, ids)
  const all = computeAddressStatuses(ctx, { addressIds: ids, params }).flatMap((s) => {
    const place = places.get(s.addressId)
    if (!place || s.kind !== "number") return []
    const c = toCandidate(s, place, params)
    return c.priority > 0 ? [c] : []
  })
  if (all.length === 0) throw new NoCandidateError()

  const start =
    input.start ?? (input.zone.type === "polygon" ? polygonCentroid(input.zone.points) : meanPoint(all))
  all.sort((a, b) => b.priority - a.priority || closeness(a, start) - closeness(b, start) || a.addressId.localeCompare(b.addressId))
  const limited = all.slice(0, MAX_CANDIDATES)
  const durationSeconds = input.durationMinutes * 60

  // KTD8 cap before solving: no-voter candidates within the share cap of the doors the session should hold.
  const meanService = limited.reduce((s, c) => s + c.serviceSeconds, 0) / limited.length
  const estimate = estimateDoorCount(durationSeconds, meanService)
  const before = capNoVoter(limited, noVoterQuota(estimate, params.noVoterShareCap))
  if (before.kept.length === 0) throw new NoCandidateError()
  const droppedByCap = [...before.dropped]

  const indexOf = new Map(before.kept.map((c, k) => [c.addressId, k + 1]))
  const byIndex = new Map(before.kept.map((c, k) => [k + 1, c]))
  const durations = await deps.matrix([start, ...before.kept.map((c) => ({ lat: c.lat, lon: c.lon }))])
  const solve = async (set: readonly Candidate[]) => {
    const problem: RoutingProblem = { durations, jobs: jobsOf(set, indexOf), maxDurationSeconds: durationSeconds }
    const solution = await deps.solver.solve(problem)
    return solution.orderedJobIds.flatMap((id) => {
      const c = byIndex.get(id)
      return c ? [c] : []
    })
  }

  let pool = before.kept
  let route = await solve(pool)
  const noVoterCount = (r: readonly Candidate[]) => r.filter((c) => c.category === "sans_inscrit").length
  if (noVoterCount(route) > noVoterQuota(route.length, params.noVoterShareCap)) {
    // KTD8 check after solving, one relaunch only: keep the best no-voter candidates within the share cap of the kept doors.
    const after = capNoVoter(pool, noVoterQuota(route.length, params.noVoterShareCap))
    droppedByCap.push(...after.dropped)
    pool = after.kept
    // A zone of "sans inscrit" doors only: the cap of a short loop leaves nothing to solve.
    if (pool.length === 0) throw new NoCandidateError()
    route = await solve(pool)
    // Still above after the relaunch: the lowest-ranked no-voter doors leave the loop, which only shortens it.
    const allowed = noVoterQuota(route.length, params.noVoterShareCap)
    if (noVoterCount(route) > allowed) {
      const keep = new Set(capNoVoter(pool.filter((c) => route.includes(c)), allowed).kept)
      for (const c of route) if (!keep.has(c)) droppedByCap.push(c)
      route = route.filter((c) => keep.has(c))
    }
  }

  // Never save an empty itinerary: the client gets the explicit no_candidate answer instead.
  if (route.length === 0) throw new NoCandidateError()

  const inRoute = new Set(route.map((c) => c.addressId))
  // A door trimmed by the cap after the relaunch is reported once, in droppedByCap, with that reason.
  const capped = new Set(droppedByCap.map((c) => c.addressId))
  const leftOut = pool.filter((c) => !inRoute.has(c.addressId) && !capped.has(c.addressId)).map(summary)
  const id = crypto.randomUUID()
  saveItinerary(ctx, {
    id,
    zone: input.zone,
    start,
    durationMinutes: input.durationMinutes,
    order: route.map((c) => ({ addressId: c.addressId, priority: c.priority, serviceSeconds: c.serviceSeconds, manual: false })),
    durations,
    indexes: route.map((c) => indexOf.get(c.addressId) ?? 0),
  })
  const itinerary = getItinerary(ctx, id)
  if (!itinerary) throw new ItineraryError("itinerary_not_found")
  const rank = (a: DoorSummary, b: DoorSummary) => b.priority - a.priority
  return {
    itinerary,
    leftOut,
    droppedByCap: droppedByCap.map(summary).sort(rank),
    candidateCount: all.length,
    truncatedCount: all.length - limited.length,
  }
}

interface StoredDoor {
  addressId: string
  priority: number
  serviceSeconds: number
  manual: boolean
}

interface SaveInput {
  id: string
  zone: Zone
  start: LatLon
  durationMinutes: number
  /** Doors in visit order. */
  order: StoredDoor[]
  durations: number[][]
  /** Matrix index of each door of `order`. */
  indexes: number[]
}

function serviceByIndex(order: readonly StoredDoor[], indexes: readonly number[], size: number): number[] {
  const service = new Array<number>(size).fill(0)
  order.forEach((d, k) => {
    const index = indexes[k]
    if (index !== undefined) service[index] = d.serviceSeconds
  })
  return service
}

/** Inserts (or rewrites the doors and total of) an itinerary, in one transaction. */
function saveItinerary(ctx: AppContext, input: SaveInput, existing = false): void {
  const t = timeline(input.indexes, input.durations, serviceByIndex(input.order, input.indexes, input.durations.length))
  ctx.db.transaction((tx) => {
    if (existing) {
      tx.update(itineraries).set({ totalSeconds: t.totalSeconds }).where(eq(itineraries.id, input.id)).run()
      tx.delete(itineraryDoors).where(eq(itineraryDoors.itineraryId, input.id)).run()
    } else {
      tx.insert(itineraries)
        .values({
          id: input.id,
          createdAt: ctx.now().getTime(),
          name: null,
          zone: JSON.stringify(input.zone),
          startLat: input.start.lat,
          startLon: input.start.lon,
          durationMinutes: input.durationMinutes,
          totalSeconds: t.totalSeconds,
        })
        .run()
    }
    input.order.forEach((d, position) => {
      tx.insert(itineraryDoors)
        .values({
          itineraryId: input.id,
          addressId: d.addressId,
          position,
          serviceSeconds: d.serviceSeconds,
          walkSecondsFromPrevious: t.walkFromPrevious[position] ?? 0,
          priority: d.priority,
          manual: d.manual,
        })
        .run()
    })
  })
}

export function parseZone(raw: string): Zone {
  const value: unknown = JSON.parse(raw)
  if (typeof value === "object" && value !== null && "type" in value) {
    if (value.type === "bureau" && "bureau" in value && typeof value.bureau === "string") return { type: "bureau", bureau: value.bureau }
    if (value.type === "polygon" && "points" in value && Array.isArray(value.points)) {
      const points = value.points.flatMap((p: unknown): [number, number][] =>
        Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" ? [[p[0], p[1]]] : [],
      )
      return { type: "polygon", points }
    }
  }
  return { type: "polygon", points: [] }
}

export function getItinerary(ctx: AppContext, id: string): ItineraryDetail | null {
  const row = ctx.db.select().from(itineraries).where(eq(itineraries.id, id)).get()
  if (!row) return null
  const doors = ctx.db
    .select()
    .from(itineraryDoors)
    .where(eq(itineraryDoors.itineraryId, id))
    .orderBy(asc(itineraryDoors.position))
    .all()
  const ids = doors.map((d) => d.addressId)
  const places = placesOf(ctx, ids)
  const statuses = new Map(computeAddressStatuses(ctx, { addressIds: ids }).map((s) => [s.addressId, s]))
  let clock = 0
  let walk = 0
  let service = 0
  const views = doors.flatMap((d): ItineraryDoorView[] => {
    clock += d.walkSecondsFromPrevious
    walk += d.walkSecondsFromPrevious
    const arrivalSeconds = clock
    clock += d.serviceSeconds
    service += d.serviceSeconds
    const place = places.get(d.addressId)
    const status = statuses.get(d.addressId)
    if (!place || !status) return []
    return [
      {
        addressId: d.addressId,
        label: place.label,
        category: status.category,
        priority: d.priority,
        position: d.position,
        lat: place.lat,
        lon: place.lon,
        followUp: status.followUp,
        registeredCount: status.registeredCount,
        serviceSeconds: d.serviceSeconds,
        walkSecondsFromPrevious: d.walkSecondsFromPrevious,
        arrivalSeconds,
        manual: d.manual,
      },
    ]
  })
  const zone = parseZone(row.zone)
  return {
    id: row.id,
    createdAt: row.createdAt,
    zone,
    zoneLabel: zoneLabel(zone),
    start: { lat: row.startLat, lon: row.startLon },
    durationMinutes: row.durationMinutes,
    totalSeconds: row.totalSeconds,
    walkSeconds: walk,
    serviceSeconds: service,
    returnWalkSeconds: Math.max(0, row.totalSeconds - walk - service),
    doors: views,
  }
}


/** Window large enough for any fixed set of doors, below UNREACHABLE_SECONDS so an unreachable door stays out. */
const FIXED_SET_HORIZON_SECONDS = 10 * 24 * 3600
const FIXED_SET_PRIORITY = 100

/** Orders a fixed set of doors with the solver (every door forced in), then stores the new order and total. */
async function reorder(ctx: AppContext, id: string, start: LatLon, doors: StoredDoor[], deps: RouteDeps): Promise<ItineraryDetail> {
  const places = placesOf(ctx, doors.map((d) => d.addressId))
  const located = doors.filter((d) => places.has(d.addressId))
  const durations =
    located.length === 0
      ? [[0]]
      : await deps.matrix([start, ...located.map((d) => places.get(d.addressId) ?? start)])
  let orderIdx: number[] = []
  if (located.length > 0) {
    const solution = await deps.solver.solve({
      durations,
      jobs: located.map((d, k) => ({ id: k + 1, locationIndex: k + 1, serviceSeconds: d.serviceSeconds, priority: FIXED_SET_PRIORITY })),
      maxDurationSeconds: FIXED_SET_HORIZON_SECONDS,
    })
    // A door the solver could not place has no walking route: keeping it would add UNREACHABLE_SECONDS legs to
    // the total. Refused before anything is stored (generation only stores placed doors, so only an added door
    // can be in that case).
    if (solution.orderedJobIds.length < located.length) throw new ItineraryError("door_unreachable")
    orderIdx = [...solution.orderedJobIds]
  }
  const order = orderIdx.flatMap((k) => {
    const d = located[k - 1]
    return d ? [d] : []
  })
  const row = ctx.db.select().from(itineraries).where(eq(itineraries.id, id)).get()
  if (!row) throw new ItineraryError("itinerary_not_found")
  saveItinerary(
    ctx,
    { id, zone: parseZone(row.zone), start, durationMinutes: row.durationMinutes, order, durations, indexes: orderIdx },
    true,
  )
  const detail = getItinerary(ctx, id)
  if (!detail) throw new ItineraryError("itinerary_not_found")
  return detail
}

function storedDoors(ctx: AppContext, id: string): { start: LatLon; doors: StoredDoor[] } {
  const row = ctx.db.select().from(itineraries).where(eq(itineraries.id, id)).get()
  if (!row) throw new ItineraryError("itinerary_not_found")
  const doors = ctx.db
    .select({
      addressId: itineraryDoors.addressId,
      priority: itineraryDoors.priority,
      serviceSeconds: itineraryDoors.serviceSeconds,
      manual: itineraryDoors.manual,
    })
    .from(itineraryDoors)
    .where(eq(itineraryDoors.itineraryId, id))
    .orderBy(asc(itineraryDoors.position))
    .all()
  return { start: { lat: row.startLat, lon: row.startLon }, doors }
}

export async function removeDoor(ctx: AppContext, id: string, addressId: string, deps: RouteDeps): Promise<ItineraryDetail> {
  const { start, doors } = storedDoors(ctx, id)
  if (!doors.some((d) => d.addressId === addressId)) throw new ItineraryError("door_not_found")
  return reorder(ctx, id, start, doors.filter((d) => d.addressId !== addressId), deps)
}

/** Adds any numbered address by hand, outside the selection rules, flagged manual. */
export async function addDoor(ctx: AppContext, id: string, addressId: string, deps: RouteDeps): Promise<ItineraryDetail> {
  const { start, doors } = storedDoors(ctx, id)
  if (doors.some((d) => d.addressId === addressId)) throw new ItineraryError("door_already_present")
  const address = ctx.db
    .select({ id: addresses.id })
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.kind, "number")))
    .get()
  if (!address) throw new ItineraryError("address_not_found")
  const params = loadParameters(ctx.db)
  const status = computeAddressStatuses(ctx, { addressIds: [addressId], params })[0]
  if (!status) throw new ItineraryError("address_not_found")
  const door: StoredDoor = { addressId, priority: priority(status, params), serviceSeconds: serviceSeconds(status, params), manual: true }
  return reorder(ctx, id, start, [...doors, door], deps)
}
