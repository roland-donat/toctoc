// Field space (U12): the loop of a link and the feedback sent from the phone. The token comes from the URL
// fragment and goes to the API in a header only, never in an API URL (KTD6).
import type { AgeBand } from "./carte-api"
import type { QueueItem, SendFeedback } from "./feedback-queue"

export const FIELD_TOKEN_HEADER = "X-Toctoc-Token"

export interface FieldVoter {
  birthName: string | null
  usageName: string | null
  firstNames: string | null
}

export interface FieldCheatsheet {
  id: string
  ageBand: AgeBand | "generale"
  title: string
  body: string
}

export interface FieldPassage {
  visitDate: string
  contact: "obtenu" | "absent" | null
  toRevisit: boolean
  toAccompany: boolean
}

export interface FieldDoor {
  addressId: string
  position: number
  label: string
  lat: number
  lon: number
  dwellings: number | null
  ageBands: AgeBand[]
  cheatsheets: FieldCheatsheet[]
  lastPassage: FieldPassage | null
  /** Dwellings of the building with their latest feedback; labels carry no name. */
  units: FieldUnit[]
  done: boolean
  voters: FieldVoter[]
}

export interface FieldUnit {
  id: string
  label: string
  /** Electors of the list registered at this dwelling. */
  registered: number
  lastVisit: { visitDate: string; contact: "obtenu" | "absent" | null; toRevisit: boolean; nonRegistered: boolean } | null
}

export interface FieldLoop {
  expiresAt: number
  start: { lat: number; lon: number }
  namesShown: boolean
  doors: FieldDoor[]
}

/** The link no longer serves this request: unknown, revoked, expired, or a read during grace. */
export class LinkOverError extends Error {
  override name = "LinkOverError"
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Reads the token from a URL fragment ("#abc" gives "abc"), null when there is none. */
export function tokenFromHash(hash: string): string | null {
  const token = hash.startsWith("#") ? hash.slice(1) : hash
  return /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null
}

export async function fetchLoop(token: string, fetchImpl: FetchLike = fetch): Promise<FieldLoop> {
  const res = await fetchImpl("/api/terrain/itineraire", {
    headers: { [FIELD_TOKEN_HEADER]: token },
    cache: "no-store",
    credentials: "omit",
  })
  if (res.status === 404) throw new LinkOverError("link over")
  if (!res.ok) throw new Error(`field read failed: ${res.status}`)
  return (await res.json()) as FieldLoop
}

/** Request of a queue item: the creation, the correction (R18 fields and texts only) or the removal of a feedback. */
function requestOf(item: QueueItem): { url: string; method: "POST" | "PATCH" | "DELETE"; body?: unknown } {
  const { entry } = item
  if (item.op === undefined) return { url: "/api/terrain/retours", method: "POST", body: entry }
  const url = `/api/terrain/retours/${encodeURIComponent(entry.id)}`
  if (item.op === "delete") return { url, method: "DELETE" }
  const fields = {
    dwelling: entry.dwelling,
    dwellingUnitId: entry.dwellingUnitId ?? null,
    nonRegistered: entry.nonRegistered ?? false,
    contact: entry.contact,
    contactQuality: entry.contactQuality,
    toAccompany: entry.toAccompany,
    toRevisit: entry.toRevisit,
    qualification: entry.qualification,
    qualificationScope: entry.qualificationScope,
    remarks: entry.remarks,
  }
  return { url, method: "PATCH", body: fields }
}

/**
 * Sender for the feedback queue: "acknowledged" once the server applied the change (or already had the feedback),
 * "refused" when the server will never take it (link over, invalid body); throws on a network failure or a server
 * error, to retry.
 */
export function createFeedbackSender(token: string, fetchImpl: FetchLike = fetch): SendFeedback {
  return async (item: QueueItem) => {
    const { url, method, body } = requestOf(item)
    const res = await fetchImpl(url, {
      method,
      headers: { "Content-Type": "application/json", [FIELD_TOKEN_HEADER]: token },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
    })
    if (res.ok) return "acknowledged"
    if (res.status >= 400 && res.status < 500) return "refused"
    throw new Error(`field write failed: ${res.status}`)
  }
}
