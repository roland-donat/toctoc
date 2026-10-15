import { fetchJSON } from "./api-client"
import { QUALIFICATION_LABELS as FIELD_QUALIFICATION_LABELS, type Qualification as FieldQualification } from "./feedback-options"
import type { ListType, VoteValue, VoterLevel } from "./imports-api"

// Map, address sheet and Paramètres (U7). The server filters and anonymizes; this module only carries the data.

export const CATEGORIES = [
  "abstention_forte",
  "abstention_moyenne",
  "votants",
  "sans_inscrit",
  "non_localise",
  "exclue",
] as const
export type Category = (typeof CATEGORIES)[number]

export const FOLLOW_UPS = ["jamais_visitee", "a_revoir", "visitee_recemment", "visitee"] as const
export type FollowUp = (typeof FOLLOW_UPS)[number]

export const AGE_BANDS = ["18-25", "26-40", "41-60", "61+"] as const
export type AgeBand = (typeof AGE_BANDS)[number]

export const BIRTH_PLACE_GROUPS = ["sene", "morbihan", "bretagne", "france", "etranger", "inconnu"] as const
export type BirthPlaceGroup = (typeof BIRTH_PLACE_GROUPS)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  abstention_forte: "Abstention forte",
  abstention_moyenne: "Abstention moyenne",
  votants: "Votants",
  sans_inscrit: "Sans inscrit",
  non_localise: "Inscrits non localisés",
  exclue: "Exclue",
}

export const FOLLOW_UP_LABELS: Record<FollowUp, string> = {
  jamais_visitee: "Jamais visitée",
  a_revoir: "À revoir",
  visitee_recemment: "Visitée récemment",
  visitee: "Visitée il y a longtemps",
}

export const BIRTH_PLACE_LABELS: Record<BirthPlaceGroup, string> = {
  sene: "Séné",
  morbihan: "Reste du Morbihan",
  bretagne: "Reste de la Bretagne",
  france: "Reste de la France",
  etranger: "Étranger",
  inconnu: "Non renseigné",
}

/** Filters of R8, carried in the URL. Never a name. */
export interface MapFilters {
  bureau?: string
  category?: Category[]
  ageBand?: AgeBand[]
  sex?: "F" | "M"
  birthPlace?: BirthPlaceGroup
  street?: string
  followUp?: FollowUp[]
}

export interface MapAddress {
  id: string
  lat: number
  lon: number
  label: string
  category: Category
  followUp: FollowUp
  registeredCount: number
  counts: Record<VoterLevel, number>
  ageBands: AgeBand[]
}

export interface MapResponse {
  addresses: MapAddress[]
  totals: { doors: number; electors: number }
}

export interface MapOptions {
  setup: { ban: boolean; liste: boolean; emargement: boolean }
  bureaus: string[]
  streets: { key: string; name: string }[]
}

export type Qualification = FieldQualification | "annulation"

export const QUALIFICATION_LABELS: Record<Qualification, string> = {
  ...FIELD_QUALIFICATION_LABELS,
  annulation: "Qualification annulée",
}

export interface SheetVoter {
  electorId: string
  /** Null when names are masked (switch on "anonyme"). */
  birthName: string | null
  usageName: string | null
  firstNames: string | null
  age: number | null
  ageBand: AgeBand | null
  sex: "F" | "M" | null
  level: VoterLevel
  bureau: string
  listTypes: ListType[]
  votes: { t1: VoteValue | null; t2: VoteValue | null }
}

export interface SheetVisit {
  id: string
  addressId: string
  /** Null when names are masked: free text that may carry a name. */
  dwelling: string | null
  visitDate: string
  recordedAt: number
  source: "lien" | "feuille" | "admin"
  contact: "obtenu" | "absent" | null
  contactQuality: "chaleureux" | "poli" | "ferme" | null
  toAccompany: boolean
  toRevisit: boolean
  qualification: Qualification | null
  qualificationScope: "logement" | "immeuble" | null
  remarks: string | null
  itineraryId: string | null
  /** Last correction by the administrator (ms since epoch), null when the feedback is as entered. */
  correctedAt: number | null
}

export interface AddressSheet {
  id: string
  label: string
  kind: "number" | "street"
  category: Category
  followUp: FollowUp
  lastVisit: string | null
  dwellings: number | null
  exclusion: Exclude<Qualification, "annulation"> | null
  voters: SheetVoter[]
  visits: SheetVisit[]
}

export type AnonymizationMode = "anonyme" | "nominatif"

export interface PriorityParameters {
  weights: { fort: number; moyen: number; sansInscrit: number; aRevoir: number; nouvelInscrit: number }
  cap: number
  recentDays: number
  recentPriority: number
  noVoterShareCap: number
  doorTime: { baseMinutes: number; perExtraMinutes: number; capMinutes: number }
}

export interface Settings {
  anonymization: AnonymizationMode
  parameters: PriorityParameters
  /** ISO instant of the last successful daily backup, null when none ran yet. */
  lastBackupAt: string | null
}

/** Repeated keys (`category=a&category=b`), the format the server reads. */
export function mapQuery(filters: MapFilters): string {
  const params = new URLSearchParams()
  if (filters.bureau) params.append("bureau", filters.bureau)
  for (const c of filters.category ?? []) params.append("category", c)
  for (const b of filters.ageBand ?? []) params.append("ageBand", b)
  if (filters.sex) params.append("sex", filters.sex)
  if (filters.birthPlace) params.append("birthPlace", filters.birthPlace)
  if (filters.street) params.append("street", filters.street)
  for (const f of filters.followUp ?? []) params.append("followUp", f)
  const text = params.toString()
  return text === "" ? "" : `?${text}`
}

export const mapKey = (filters: MapFilters) => ["carte", mapQuery(filters)] as const
export const mapOptionsKey = ["carte", "options"] as const
export const sheetKey = (id: string) => ["adresses", id] as const
export const settingsKey = ["parametres"] as const

export const fetchMap = (filters: MapFilters) => fetchJSON<MapResponse>(`/carte${mapQuery(filters)}`)

export const fetchMapOptions = () => fetchJSON<MapOptions>("/carte/options")

export const fetchSheet = (id: string) => fetchJSON<AddressSheet>(`/adresses/${encodeURIComponent(id)}`)

export const updateDwellings = (id: string, dwellings: number | null) =>
  fetchJSON<{ id: string; dwellings: number | null }>(`/adresses/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ dwellings }),
    keepalive: true,
  })

export const cancelQualification = (addressId: string) =>
  fetchJSON<SheetVisit>("/retours/annulation", {
    method: "POST",
    body: JSON.stringify({ addressId, id: crypto.randomUUID() }),
  })

/** Correction of a feedback: only the fields sent change (texts hidden in anonymous mode are left out). */
export type VisitPatch = Partial<
  Pick<SheetVisit, "dwelling" | "contact" | "contactQuality" | "toAccompany" | "toRevisit" | "qualificationScope" | "remarks"> & {
    qualification: FieldQualification | null
  }
>

export const updateVisit = (id: string, patch: VisitPatch) =>
  fetchJSON<SheetVisit>(`/retours/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch), keepalive: true })

export const deleteVisit = (id: string) =>
  fetchJSON<{ id: string; addressId: string }>(`/retours/${encodeURIComponent(id)}`, { method: "DELETE" })

export const fetchSettings = () => fetchJSON<Settings>("/parametres")

export const updateAnonymization = (mode: AnonymizationMode) =>
  fetchJSON<{ anonymization: AnonymizationMode }>("/parametres/anonymisation", {
    method: "PUT",
    body: JSON.stringify({ mode }),
  })

export const updatePriorityParameters = (parameters: PriorityParameters) =>
  fetchJSON<{ parameters: PriorityParameters }>("/parametres/priorite", {
    method: "PUT",
    body: JSON.stringify(parameters),
    keepalive: true,
  })

/** Marker colors per category; the follow-up state is carried by the shape, so the map reads without color. */
export const CATEGORY_COLORS: Record<Category, string> = {
  abstention_forte: "#d1271c",
  abstention_moyenne: "#e39a12",
  votants: "#3885f4",
  sans_inscrit: "#ed5fb1",
  non_localise: "#8b9099",
  exclue: "#3d3f45",
}
