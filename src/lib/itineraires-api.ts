import { fetchJSON } from "./api-client"
import type { AgeBand, Category, FollowUp, SheetUnit, SheetVisit } from "./carte-api"
import type { FeedbackEntry } from "./feedback-queue"

// Itineraries (U11): generation from a zone and a duration, list, detail and door adjustments.

export const DURATIONS = [60, 90, 120] as const
export type DurationMinutes = (typeof DURATIONS)[number]

export const DURATION_LABELS: Record<DurationMinutes, string> = { 60: "1 h", 90: "1 h 30", 120: "2 h" }

export interface LatLon {
  lat: number
  lon: number
}

/** Polygon vertices are [lat, lon]. */
export type Zone = { type: "polygon"; points: [number, number][] } | { type: "bureau"; bureau: string }

export interface DoorSummary {
  addressId: string
  label: string
  category: Category
  priority: number
}

export interface ItineraryDoor extends DoorSummary {
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
  doors: ItineraryDoor[]
}

/** A session TocToc as the list shows it (15/10/2026). */
export interface SessionSummary {
  id: string
  name: string | null
  createdAt: number
  zoneLabel: string
  durationMinutes: number
  totalSeconds: number
  doorCount: number
  doorsDone: number
  feedbackCount: number
  link: { state: FieldLinkState } | null
  updatedAt: number
  archivedAt: number | null
  /** Ended: link closed, itinerary frozen, feedback still entered and corrected. */
  endedAt: number | null
}

export type SessionEventKind =
  | "created"
  | "renamed"
  | "door_added"
  | "door_removed"
  | "link_issued"
  | "link_revoked"
  | "names_shown"
  | "names_hidden"
  | "feedback_recorded"
  | "feedback_corrected"
  | "feedback_deleted"
  | "archived"
  | "restored"
  | "ended"
  | "reopened"

export interface SessionEvent {
  id: number
  at: number
  kind: SessionEventKind
  source: "admin" | "lien" | "feuille"
  detail: string | null
}

export interface GenerateResult {
  itinerary: ItineraryDetail
  leftOut: DoorSummary[]
  droppedByCap: DoorSummary[]
  candidateCount: number
  truncatedCount: number
}

export interface GenerateInput {
  zone: Zone
  start: LatLon | null
  durationMinutes: DurationMinutes
}

export const itinerariesKey = ["itineraires"] as const
export const itineraryKey = (id: string) => ["itineraires", id] as const
/** Selection report of a generation (left-out doors), kept in the client cache only: it is not stored. */
export const generationKey = (id: string) => ["itineraires", id, "generation"] as const

export const sessionsKey = (archived: boolean) => ["itineraires", archived ? "archives" : "actives"] as const
export const sessionSummaryKey = (id: string) => ["itineraires", id, "resume"] as const
export const sessionHistoryKey = (id: string) => ["itineraires", id, "historique"] as const

export const fetchSessions = (archived: boolean) =>
  fetchJSON<{ itineraries: SessionSummary[] }>(`/itineraires${archived ? "?archives=1" : ""}`)

export const fetchSessionSummary = (id: string) => fetchJSON<SessionSummary>(`/itineraires/${encodeURIComponent(id)}/resume`)

export const fetchSessionHistory = (id: string) =>
  fetchJSON<{ events: SessionEvent[] }>(`/itineraires/${encodeURIComponent(id)}/historique`)

export const updateSession = (id: string, patch: { name?: string | null; archived?: boolean; ended?: boolean }) =>
  fetchJSON<SessionSummary>(`/itineraires/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })

export const deleteSession = (id: string, withFeedback: boolean) =>
  fetchJSON<{ feedbackDeleted: number; feedbackKept: number }>(
    `/itineraires/${encodeURIComponent(id)}${withFeedback ? "" : "?retours=0"}`,
    { method: "DELETE" },
  )

/** Name of a session, or its creation date when it has none. */
export function sessionTitle(s: { name: string | null; createdAt: number }): string {
  return s.name ?? `Session du ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(s.createdAt))}`
}

export const fetchItinerary = (id: string) => fetchJSON<ItineraryDetail>(`/itineraires/${encodeURIComponent(id)}`)

export const generateItinerary = (input: GenerateInput) =>
  fetchJSON<GenerateResult>("/itineraires", { method: "POST", body: JSON.stringify(input) })

export const addItineraryDoor = (id: string, addressId: string) =>
  fetchJSON<ItineraryDetail>(`/itineraires/${encodeURIComponent(id)}/portes`, {
    method: "POST",
    body: JSON.stringify({ addressId }),
  })

export const removeItineraryDoor = (id: string, addressId: string) =>
  fetchJSON<ItineraryDetail>(`/itineraires/${encodeURIComponent(id)}/portes/${encodeURIComponent(addressId)}`, {
    method: "DELETE",
  })

/** Field link of an itinerary (U12, KTD6): its state only, the token is shown once at creation. */
export type FieldLinkState = "actif" | "grace" | "expire" | "revoque"

export interface FieldLinkView {
  link: {
    issuedAt: number
    /** When the end or the archiving of the session closed it; null while it runs (no time limit). */
    expiresAt: number | null
    revokedAt: number | null
    state: FieldLinkState
    /** Address of the link while it serves; null once closed or revoked, or for a link issued before 16/10/2026. */
    url: string | null
  } | null
  showNames: boolean
  /** The global switch is on "nominatif". */
  namesAvailable: boolean
}

export const fieldLinkKey = (id: string) => ["itineraires", id, "lien"] as const

export const fetchFieldLink = (id: string) => fetchJSON<FieldLinkView>(`/itineraires/${encodeURIComponent(id)}/lien`)

/** Issues a new link, which replaces the previous one; the URL in the answer is never retrievable again. */
export const createFieldLink = (id: string) =>
  fetchJSON<FieldLinkView & { url: string }>(`/itineraires/${encodeURIComponent(id)}/lien`, { method: "POST", body: "{}" })

export const revokeFieldLink = (id: string) =>
  fetchJSON<FieldLinkView>(`/itineraires/${encodeURIComponent(id)}/lien`, { method: "DELETE" })

export const setItineraryShowNames = (id: string, showNames: boolean) =>
  fetchJSON<FieldLinkView>(`/itineraires/${encodeURIComponent(id)}/noms`, {
    method: "PUT",
    body: JSON.stringify({ showNames }),
  })

/** French message for an API error code of this module. */
export function itineraryErrorMessage(code: string): string {
  switch (code) {
    case "routing_unavailable":
      return "Le service d'itinéraire est arrêté."
    case "no_candidate":
      return "Aucune porte à visiter dans cette zone : élargissez la zone ou choisissez un autre bureau."
    case "door_already_present":
      return "Cette porte est déjà dans l'itinéraire."
    case "door_unreachable":
      return "Cette adresse n'est pas joignable à pied depuis l'itinéraire : elle n'a pas été ajoutée."
    case "address_not_found":
      return "Adresse introuvable."
    case "itinerary_not_found":
      return "Session introuvable."
    case "session_archived":
      return "Cette session est archivée : restaurez-la pour la modifier."
    case "session_ended":
      return "Cette session est terminée : rouvrez-la pour modifier son itinéraire ou son lien."
    default:
      return "Le calcul de l'itinéraire a échoué."
  }
}

/** "1 h 05", "45 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`
}

/** Printable sheet of an itinerary (U13, R16): names per KTD7 at print time, never the birthplace. */
export interface PrintedVoter {
  birthName: string | null
  usageName: string | null
  firstNames: string | null
}

export interface SheetPassage {
  visitDate: string
  contact: "obtenu" | "absent" | null
  toRevisit: boolean
  toAccompany: boolean
  qualification: "non_habitation" | "logement_vide" | "residence_secondaire" | null
}

export interface SheetDoor {
  number: number
  addressId: string
  label: string
  lat: number
  lon: number
  dwellings: number | null
  ageBands: AgeBand[]
  lastPassage: SheetPassage | null
  /** Dwellings of the building, printed as lines to tick. */
  units: SheetUnit[]
  voters: PrintedVoter[]
}

export interface SheetCheatsheetGroup {
  ageBand: AgeBand | "generale"
  sheets: { id: string; title: string; body: string }[]
}

export interface ItinerarySheet {
  id: string
  name: string | null
  createdAt: number
  zoneLabel: string
  durationMinutes: number
  totalSeconds: number
  start: LatLon
  namesShown: boolean
  doors: SheetDoor[]
  cheatsheetGroups: SheetCheatsheetGroup[]
}

export const sheetKey = (id: string) => ["itineraires", id, "feuille"] as const

export const fetchItinerarySheet = (id: string) => fetchJSON<ItinerarySheet>(`/itineraires/${encodeURIComponent(id)}/feuille`)

/** Feedbacks already recorded through an itinerary (field link and paper sheet), for their correction. */
export interface ItineraryVisits {
  /** False in anonymous mode: dwelling and remarks are then null and must not be sent back. */
  namesShown: boolean
  visits: SheetVisit[]
}

export const itineraryVisitsKey = (id: string) => ["itineraires", id, "retours"] as const

export const fetchItineraryVisits = (id: string) => fetchJSON<ItineraryVisits>(`/itineraires/${encodeURIComponent(id)}/retours`)

/** A paper row: the session date is sent once for the whole batch, not per row. */
export type PaperFeedback = Omit<FeedbackEntry, "visitDate">

export interface ReentryResult {
  id: string
  created: boolean
  /** A feedback from the phone link exists for the same door and date; both are kept. */
  possibleDuplicate: boolean
}

/** Records feedback noted on the sheet, dated the session date, with source "feuille". */
export const reenterSheet = (id: string, visitDate: string, feedbacks: PaperFeedback[]) =>
  fetchJSON<{ results: ReentryResult[] }>(`/itineraires/${encodeURIComponent(id)}/ressaisie`, {
    method: "POST",
    body: JSON.stringify({ visitDate, feedbacks }),
    keepalive: true,
  })
