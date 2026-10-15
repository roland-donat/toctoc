// Category and follow-up state of an address (R5, R7, U6), derived on read from its voters and visits.
// Pure: the loader that gathers voters and visits of every address lives in server/services/address-status.ts.
import type { AgeBand } from "../db/schema/cheatsheets.ts"
import type { addresses, visits } from "../db/schema/index.ts"
import type { VoterLevel } from "./voter-level.ts"

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
export type AddressKind = (typeof addresses.$inferSelect)["kind"]
export type Qualification = NonNullable<(typeof visits.$inferSelect)["qualification"]>
export type QualificationScope = NonNullable<(typeof visits.$inferSelect)["qualificationScope"]>
/** Field qualifications that take an address out of the targets (R5); "annulation" is the administrator's cancellation. */
export type ExclusionQualification = Exclude<Qualification, "annulation">

/** What the derivations need from a visit row. */
export interface VisitFacts {
  /** ISO date of the visit. */
  visitDate: string
  /** Entry time, epoch milliseconds. */
  recordedAt: number
  dwelling: string | null
  toRevisit: boolean
  toAccompany: boolean
  qualification: Qualification | null
  qualificationScope: QualificationScope | null
}

/** Everything the map, the statistics and the route generator need about one address. */
export interface AddressStatus {
  addressId: string
  kind: AddressKind
  category: Category
  followUp: FollowUp
  /** ISO date of the latest visit (cancellations excluded), null if never visited. */
  lastVisit: string | null
  /** Distinct electors of the current list registered at the address, by level. */
  counts: Record<VoterLevel, number>
  /** Distinct age bands of the voters concerned by the presidential election (hors cible excluded), in band order. */
  ageBands: AgeBand[]
  registeredCount: number
  /** Dwellings entered by the administrator, null when unknown. */
  dwellings: number | null
}

function byDate(a: VisitFacts, b: VisitFacts): number {
  if (a.visitDate !== b.visitDate) return a.visitDate < b.visitDate ? -1 : 1
  return a.recordedAt - b.recordedAt
}

/** A qualification covers the whole address when its scope is the building, or when no dwelling is named. */
function appliesToWholeAddress(v: VisitFacts): boolean {
  if (v.qualificationScope === "immeuble") return true
  return v.qualificationScope === null && (v.dwelling === null || v.dwelling.trim() === "")
}

/**
 * Exclusion in force: the latest address-wide qualification event, unless a later cancellation
 * ("annulation") lifted it. A qualification on one dwelling never excludes the address (U6 step 5).
 */
export function activeExclusion(visits: readonly VisitFacts[]): ExclusionQualification | null {
  let active: ExclusionQualification | null = null
  for (const v of [...visits].sort(byDate)) {
    if (v.qualification === "annulation") active = null
    else if (v.qualification !== null && appliesToWholeAddress(v)) active = v.qualification
  }
  return active
}

function realVisits(visits: readonly VisitFacts[]): VisitFacts[] {
  return visits.filter((v) => v.qualification !== "annulation")
}

/** ISO date of the latest visit, cancellations excluded. */
export function latestVisitDate(visits: readonly VisitFacts[]): string | null {
  let latest: string | null = null
  for (const v of realVisits(visits)) if (latest === null || v.visitDate > latest) latest = v.visitDate
  return latest
}

/** Whole days from ISO date `from` to ISO date `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Follow-up state (U6 step 3). The latest session is every feedback of the latest visit date, so that
 * "à accompagner" on one dwelling is not hidden by a remark on the hall entered after it (AE5).
 * "à revoir" holds whatever the age of that session and wins over "visitée récemment".
 */
export function followUpState(visits: readonly VisitFacts[], today: string, recentDays: number): FollowUp {
  const real = realVisits(visits)
  const last = latestVisitDate(real)
  if (last === null) return "jamais_visitee"
  if (real.some((v) => v.visitDate === last && (v.toRevisit || v.toAccompany))) return "a_revoir"
  return daysBetween(last, today) < recentDays ? "visitee_recemment" : "visitee"
}

export interface CategoryInput {
  excluded: boolean
  /** Levels of the electors of the current list registered at the address (any level, hors cible included). */
  levels: readonly VoterLevel[]
  /** The street of the address has electors attached at street level (plan Assumptions). */
  streetLevelElectorsOnStreet: boolean
  /**
   * An elector of the current list still waiting in the manual queue was proposed at this address by the
   * Géoplateforme fallback (refused by the KTD3 checks): the door likely has an elector, not "sans inscrit".
   */
  proposedForQueuedElector: boolean
}

/** Category of R7, plus "non_localise" for addresses of a street whose electors are not located at a number. */
export function addressCategory({ excluded, levels, streetLevelElectorsOnStreet, proposedForQueuedElector }: CategoryInput): Category {
  if (excluded) return "exclue"
  // A new 2027 registrant has no 2026 history; it counts as a strong-potential target (decided 13/10/2026).
  if (levels.includes("fort") || levels.includes("nouvel_inscrit")) return "abstention_forte"
  if (levels.includes("moyen")) return "abstention_moyenne"
  if (levels.length > 0) return "votants"
  return streetLevelElectorsOnStreet || proposedForQueuedElector ? "non_localise" : "sans_inscrit"
}

const PARIS_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" })

/** Calendar date (ISO) in France of an instant. */
export function parisDate(instant: Date): string {
  return PARIS_DATE.format(instant)
}
