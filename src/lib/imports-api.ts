import { fetchJSON } from "./api-client"

export interface BanStatus {
  total: number
  retired: number
  lastImportedAt: number | null
}

export interface BanLoadResult {
  loaded: number
  created: number
  updated: number
  retired: number
  total: number
}

export type ListType = "principale" | "complementaire_ue" | "complementaire_municipale"

export interface RepSimulation {
  pendingId: string
  rows: number
  electors: number
  listTypes: Record<ListType, number>
  matchedBan: number
  matchedFallback: number
  matchedStreet: number
  toAttach: number
  unreadableDates: number
  duplicatesAcrossLists: number
  fallbackAvailable: boolean
}

/** Comparison with the list previously in force, in electors (U14). */
export interface ReimportReport {
  newRegistrants: number
  removed: number
  moved: number
  sansInscritBefore: number
  sansInscritAfter: number
  manualCarriedOver: number
}

export interface RepImportResult {
  importId: string
  rows: number
  electors: number
  electorsCreated: number
  registrations: number
  matched: number
  queueSize: number
  matchRate: number
  /** Null on the first import. */
  reimport: ReimportReport | null
}

export interface CurrentListSummary {
  importId: string
  importedAt: number
  rows: number
  registrations: number
  matched: number
  queueSize: number
  matchRate: number
}

export interface QueueItem {
  id: string
  bureau: string
  orderNumber: number | null
  rawNumber: string | null
  rawStreet: string | null
  rawComplement1: string | null
  rawComplement2: string | null
  rawLieuDit: string | null
  rawPostalCode: string | null
  proposal: { id: string; label: string; lat: number; lon: number } | null
}

export const LIST_TYPE_LABELS: Record<ListType, string> = {
  principale: "Liste principale",
  complementaire_ue: "Liste complémentaire européenne",
  complementaire_municipale: "Liste complémentaire municipale",
}

export const banStatusKey = ["imports", "ban", "status"] as const
export const repStatusKey = ["imports", "rep", "status"] as const
export const queueKey = ["imports", "queue"] as const

function fileForm(file: File): FormData {
  const form = new FormData()
  form.append("file", file)
  return form
}

export const fetchBanStatus = () => fetchJSON<BanStatus>("/imports/ban/status")

export const downloadBan = () => fetchJSON<BanLoadResult>("/imports/ban/download", { method: "POST" })

export const uploadBan = (file: File) =>
  fetchJSON<BanLoadResult>("/imports/ban", { method: "POST", body: fileForm(file) })

export const simulateRepImport = (file: File) =>
  fetchJSON<RepSimulation>("/imports/rep", { method: "POST", body: fileForm(file) })

export const confirmRepImport = (pendingId: string) =>
  fetchJSON<RepImportResult>(`/imports/rep/${encodeURIComponent(pendingId)}/confirm`, { method: "POST" })

export const fetchRepStatus = () => fetchJSON<{ current: CurrentListSummary | null }>("/imports/rep/status")

export const fetchQueue = () => fetchJSON<{ items: QueueItem[] }>("/imports/queue")

export const attachRegistration = (registrationId: string, addressId: string) =>
  fetchJSON<{ id: string; addressId: string; matchStatus: "manual" }>(
    `/imports/queue/${encodeURIComponent(registrationId)}`,
    { method: "PATCH", body: JSON.stringify({ addressId }) },
  )

// Emargement 2026 and exceptions (U5).

export type VoteValue = "oui" | "non" | "illisible"
export type VoterLevel = "fort" | "moyen" | "votant" | "hors_cible" | "inconnu" | "nouvel_inscrit"

export const VOTE_LABELS: Record<VoteValue, string> = { oui: "A voté", non: "N'a pas voté", illisible: "Illisible" }

export const VOTER_LEVEL_LABELS: Record<VoterLevel, string> = {
  fort: "Abstention forte",
  moyen: "Abstention moyenne",
  votant: "Votant",
  hors_cible: "Hors cible",
  inconnu: "Inconnu",
  nouvel_inscrit: "Nouvel inscrit",
}

export interface EmargementSimulation {
  pendingId: string
  rows: number
  matched: number
  merged: number
  nameMismatches: number
  notFound: number
  discordantDuplicates: number
  unreadableCells: number
  unknownLevel: number
}

export interface EmargementImportResult {
  importId: string
  rows: number
  matched: number
  exceptions: number
  votersT1: number
  votersT2: number
}

export interface EmargementStatus {
  importId: string
  importedAt: number
  rows: number
  votersT1: number
  votersT2: number
  openRowExceptions: number
  notFound: number
  unknownLevel: number
}

export interface RowExceptionItem {
  id: string
  kind: "name_mismatch" | "discordant_duplicate"
  bureau: string | null
  orderNumber: number | null
  row: { birthName: string; usageName: string | null; firstNames: string; t1: VoteValue; t2: VoteValue }
  candidate: { electorId: string; birthName: string; usageName: string | null; firstNames: string } | null
}

export interface UnknownElectorItem {
  electorId: string
  bureau: string
  orderNumber: number | null
  birthName: string
  usageName: string | null
  firstNames: string
  rounds: { 1: VoteValue | null; 2: VoteValue | null }
}

export interface AddressOption {
  id: string
  label: string
}

export const emargementStatusKey = ["imports", "emargement", "status"] as const
export const rowExceptionsKey = ["imports", "exceptions", "rows"] as const
export const unknownElectorsKey = ["imports", "exceptions", "unknown"] as const
export const addressSearchKey = (q: string) => ["imports", "addresses", q] as const

export const simulateEmargementImport = (file: File) =>
  fetchJSON<EmargementSimulation>("/imports/emargement", { method: "POST", body: fileForm(file) })

export const confirmEmargementImport = (pendingId: string) =>
  fetchJSON<EmargementImportResult>(`/imports/emargement/${encodeURIComponent(pendingId)}/confirm`, { method: "POST" })

export const fetchEmargementStatus = () => fetchJSON<{ current: EmargementStatus | null }>("/imports/emargement/status")

export const fetchRowExceptions = () => fetchJSON<{ items: RowExceptionItem[]; notFound: number }>("/imports/exceptions/rows")

export const decideRowException = (id: string, decision: "accepted" | "rejected") =>
  fetchJSON<{ id: string; status: "accepted" | "rejected"; electorId: string | null; level: VoterLevel | null }>(
    `/imports/exceptions/rows/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ decision }) },
  )

export const fetchUnknownElectors = () => fetchJSON<{ items: UnknownElectorItem[] }>("/imports/exceptions/unknown")

export const setRoundValue = (electorId: string, round: 1 | 2, value: VoteValue) =>
  fetchJSON<{ electorId: string; level: VoterLevel }>(
    `/imports/exceptions/unknown/${encodeURIComponent(electorId)}/rounds/${round}`,
    { method: "PUT", body: JSON.stringify({ value }) },
  )

export const searchAddresses = (q: string) =>
  fetchJSON<{ items: AddressOption[] }>(`/imports/addresses?q=${encodeURIComponent(q)}`)
