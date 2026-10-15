import { fetchJSON } from "./api-client"
import { numberFormat, percentFormat } from "./format"

/** Mirrors server/domain/stats.ts: a count or a rate computed on fewer than 5 persons comes back as "< 5". */
export const SMALL_COUNT = "< 5"
export type Masked = number | typeof SMALL_COUNT

export interface TurnoutCell {
  eligible: Masked
  voters: Masked
  abstainers: Masked
  rate: Masked
}

export interface ShareCell {
  count: Masked
  share: Masked
}

export type Dimension = "age" | "sexe" | "bureau" | "rue" | "naissance"

export const DIMENSION_LABELS: { key: Dimension; label: string }[] = [
  { key: "age", label: "Tranche d'âge" },
  { key: "sexe", label: "Sexe" },
  { key: "bureau", label: "Bureau" },
  { key: "rue", label: "Rue" },
  { key: "naissance", label: "Lieu de naissance" },
]

export interface DimensionRow {
  key: string
  label: string
  t1: TurnoutCell
  t2: TurnoutCell
  profile: { voters: ShareCell; abstainers: ShareCell }
}

export interface StatsReport {
  population: { targeted: Masked; unknown: Masked; newRegistrants: Masked }
  overall: { t1: TurnoutCell; t2: TurnoutCell }
  dimensions: Record<Dimension, DimensionRow[]>
  flows: { total: Masked; both: Masked; t1Only: Masked; t2Only: Masked; neither: Masked }
  profileTotals: { voters: Masked; abstainers: Masked }
  proxies: { t1: Masked; t2: Masked; note: string }
}

export interface AccompanyItem {
  visitId: string
  addressId: string
  addressLabel: string
  visitDate: string
  dwelling: string | null
  done: boolean
}

export interface CoverageCell {
  total: number
  covered: number
  share: number
}

export interface CampaignReport {
  startDate: string
  registrationDeadline: string
  daysToDeadline: number
  activity: { doorsVisited: number; sessions: number }
  coverage: { highPotential: CoverageCell; noVoter: CoverageCell }
  accompany: { todo: AccompanyItem[]; done: AccompanyItem[] }
}

export const statsKey = ["stats"] as const
export const campaignKey = ["stats", "campagne"] as const

export const fetchStats = () => fetchJSON<StatsReport>("/stats")
export const fetchCampaign = () => fetchJSON<CampaignReport>("/stats/campagne")

export const setAccompanyDone = (visitId: string, done: boolean) =>
  fetchJSON<AccompanyItem>(`/stats/accompagnement/${encodeURIComponent(visitId)}`, {
    method: "PATCH",
    body: JSON.stringify({ done }),
  })

/** "< 5" is rendered as is, never replaced by a number. */
export function formatCount(value: Masked): string {
  return value === SMALL_COUNT ? SMALL_COUNT : numberFormat.format(value)
}

export function formatRate(value: Masked): string {
  return value === SMALL_COUNT ? SMALL_COUNT : percentFormat.format(value)
}
