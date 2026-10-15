// Statistics of the "Statistiques" tab (R10, R11, KTD9) and campaign indicators (Success Criteria). Pure:
// the loader that gathers the facts of every elector of the current list lives in server/routes/stats.ts.
import { AGE_BANDS, type AgeBand } from "../db/schema/cheatsheets.ts"
import { BIRTH_PLACE_GROUPS, BIRTH_PLACE_LABELS, type BirthPlaceGroup } from "./birth-place.ts"
import type { AddressKind, Category, Qualification } from "./qualification.ts"
import type { VoteValue, VoterLevel } from "./voter-level.ts"

/** KTD9: any cell computed on fewer than this many persons is never returned as a number. */
const SMALL_COUNT_THRESHOLD = 5
export const SMALL_COUNT = "< 5"
export type Masked = number | typeof SMALL_COUNT

/** Ages are taken on the first round of the 2026 municipal elections, the vote the history comes from. */
export const AGE_REFERENCE_DATE = new Date("2026-03-15T00:00:00Z")

const PROXY_NOTE = "Indicatif : l'annotation des procurations varie selon les registres."
const UNATTACHED_STREET_LABEL = "Adresse à rattacher"

export function maskCount(n: number): Masked {
  return n < SMALL_COUNT_THRESHOLD ? SMALL_COUNT : n
}

export interface RoundFact {
  value: VoteValue
  /** The emargement marks this round as voted by proxy (indicative only). */
  proxy: boolean
}

/** What the statistics need about one elector of the current list. */
export interface ElectorFacts {
  level: VoterLevel
  sex: "F" | "M" | null
  ageBand: AgeBand | null
  bureau: string
  /** Street of the registration address; null while the registration waits in the matching queue. */
  streetKey: string | null
  streetName: string | null
  birthPlace: BirthPlaceGroup
  /** Null when the history has no row for that round. */
  t1: RoundFact | null
  t2: RoundFact | null
}

/**
 * Turnout of one group for one round, on the electors whose round is readable. When the group has fewer than 5
 * persons everything is masked; when its voters or its abstainers are fewer than 5, both counts and the rate are
 * masked (either one would give the other away by subtraction from `eligible`).
 */
export interface TurnoutCell {
  eligible: Masked
  voters: Masked
  abstainers: Masked
  /** Between 0 and 1. */
  rate: Masked
}

export interface ShareCell {
  count: Masked
  /** Share of all voters (or all abstainers), between 0 and 1. */
  share: Masked
}

const DIMENSIONS = ["age", "sexe", "bureau", "rue", "naissance"] as const
export type Dimension = (typeof DIMENSIONS)[number]

export interface DimensionRow {
  key: string
  label: string
  t1: TurnoutCell
  t2: TurnoutCell
  /** Profile comparison (R11): this group's share among voters and among abstainers (fort and moyen). */
  profile: { voters: ShareCell; abstainers: ShareCell }
}

export interface Flows {
  /** Targeted electors with both rounds readable. */
  total: Masked
  both: Masked
  t1Only: Masked
  t2Only: Masked
  neither: Masked
}

export interface StatsReport {
  population: {
    /** Electors of the principal list with a known 2026 level. */
    targeted: Masked
    /** Level "inconnu": on the reference list without any readable round. */
    unknown: Masked
    /** Registered after the March 2026 list. */
    newRegistrants: Masked
  }
  overall: { t1: TurnoutCell; t2: TurnoutCell }
  dimensions: Record<Dimension, DimensionRow[]>
  flows: Flows
  profileTotals: { voters: Masked; abstainers: Masked }
  proxies: { t1: Masked; t2: Masked; note: string }
}

const TARGET_LEVELS: ReadonlySet<VoterLevel> = new Set(["votant", "moyen", "fort"])

function isTargeted(f: ElectorFacts): boolean {
  return TARGET_LEVELS.has(f.level)
}

function readable(r: RoundFact | null): r is RoundFact & { value: "oui" | "non" } {
  return r !== null && r.value !== "illisible"
}

function turnout(facts: readonly ElectorFacts[], round: "t1" | "t2"): TurnoutCell {
  let eligible = 0
  let voters = 0
  for (const f of facts) {
    const r = f[round]
    if (!readable(r)) continue
    eligible += 1
    if (r.value === "oui") voters += 1
  }
  const abstainers = eligible - voters
  if (eligible < SMALL_COUNT_THRESHOLD) {
    return { eligible: SMALL_COUNT, voters: SMALL_COUNT, abstainers: SMALL_COUNT, rate: SMALL_COUNT }
  }
  if (voters < SMALL_COUNT_THRESHOLD || abstainers < SMALL_COUNT_THRESHOLD) {
    return { eligible, voters: SMALL_COUNT, abstainers: SMALL_COUNT, rate: SMALL_COUNT }
  }
  return { eligible, voters, abstainers, rate: voters / eligible }
}

function share(count: number, total: number): ShareCell {
  if (count < SMALL_COUNT_THRESHOLD) return { count: SMALL_COUNT, share: SMALL_COUNT }
  return { count, share: count / total }
}

interface GroupSpec {
  key: string
  label: string
}

const SEX_GROUPS: readonly GroupSpec[] = [
  { key: "F", label: "Femmes" },
  { key: "M", label: "Hommes" },
  { key: "inconnu", label: "Non renseigné" },
]

const AGE_LABELS: Record<AgeBand, string> = { "18-25": "18-25 ans", "26-40": "26-40 ans", "41-60": "41-60 ans", "61+": "61 ans et plus" }
const UNKNOWN_KEY = "inconnu"
const UNATTACHED_KEY = "a_rattacher"

function groupOf(f: ElectorFacts, dimension: Dimension): GroupSpec {
  switch (dimension) {
    case "age":
      return f.ageBand === null ? { key: UNKNOWN_KEY, label: "Non renseigné" } : { key: f.ageBand, label: AGE_LABELS[f.ageBand] }
    case "sexe":
      return SEX_GROUPS.find((g) => g.key === (f.sex ?? UNKNOWN_KEY)) ?? { key: UNKNOWN_KEY, label: "Non renseigné" }
    case "bureau":
      return { key: f.bureau, label: `Bureau ${f.bureau}` }
    case "rue":
      return f.streetKey === null
        ? { key: UNATTACHED_KEY, label: UNATTACHED_STREET_LABEL }
        : { key: f.streetKey, label: f.streetName ?? f.streetKey }
    case "naissance":
      return { key: f.birthPlace, label: BIRTH_PLACE_LABELS[f.birthPlace] }
  }
}

const FR = new Intl.Collator("fr", { sensitivity: "base", numeric: true })

/** Fixed orders where the dimension has one; streets alphabetically with the queue last; bureaus by code. */
function compareGroups(dimension: Dimension, a: GroupSpec, b: GroupSpec): number {
  const rank = (order: readonly string[], key: string) => {
    const i = order.indexOf(key)
    return i === -1 ? order.length : i
  }
  switch (dimension) {
    case "age":
      return rank([...AGE_BANDS, UNKNOWN_KEY], a.key) - rank([...AGE_BANDS, UNKNOWN_KEY], b.key)
    case "sexe":
      return rank(SEX_GROUPS.map((g) => g.key), a.key) - rank(SEX_GROUPS.map((g) => g.key), b.key)
    case "naissance":
      return rank(BIRTH_PLACE_GROUPS, a.key) - rank(BIRTH_PLACE_GROUPS, b.key)
    case "bureau":
      return FR.compare(a.key, b.key)
    case "rue":
      if (a.key === UNATTACHED_KEY || b.key === UNATTACHED_KEY) return (a.key === UNATTACHED_KEY ? 1 : 0) - (b.key === UNATTACHED_KEY ? 1 : 0)
      return FR.compare(a.label, b.label)
  }
}

function dimensionRows(targeted: readonly ElectorFacts[], dimension: Dimension, totals: { voters: number; abstainers: number }): DimensionRow[] {
  const groups = new Map<string, { spec: GroupSpec; facts: ElectorFacts[] }>()
  for (const f of targeted) {
    const spec = groupOf(f, dimension)
    const g = groups.get(spec.key)
    if (g) g.facts.push(f)
    else groups.set(spec.key, { spec, facts: [f] })
  }
  return [...groups.values()]
    .sort((a, b) => compareGroups(dimension, a.spec, b.spec))
    .map(({ spec, facts }) => ({
      key: spec.key,
      label: spec.label,
      t1: turnout(facts, "t1"),
      t2: turnout(facts, "t2"),
      profile: {
        voters: share(facts.filter((f) => f.level === "votant").length, totals.voters),
        abstainers: share(facts.filter((f) => f.level !== "votant").length, totals.abstainers),
      },
    }))
}

function flows(targeted: readonly ElectorFacts[]): Flows {
  let both = 0
  let t1Only = 0
  let t2Only = 0
  let neither = 0
  for (const f of targeted) {
    if (!readable(f.t1) || !readable(f.t2)) continue
    const v1 = f.t1.value === "oui"
    const v2 = f.t2.value === "oui"
    if (v1 && v2) both += 1
    else if (v1) t1Only += 1
    else if (v2) t2Only += 1
    else neither += 1
  }
  return {
    total: maskCount(both + t1Only + t2Only + neither),
    both: maskCount(both),
    t1Only: maskCount(t1Only),
    t2Only: maskCount(t2Only),
    neither: maskCount(neither),
  }
}

export function computeStats(facts: readonly ElectorFacts[]): StatsReport {
  const targeted = facts.filter(isTargeted)
  const totals = {
    voters: targeted.filter((f) => f.level === "votant").length,
    abstainers: targeted.filter((f) => f.level !== "votant").length,
  }
  const proxies = (round: "t1" | "t2") => targeted.filter((f) => readable(f[round]) && f[round]?.value === "oui" && f[round]?.proxy).length
  return {
    population: {
      targeted: maskCount(targeted.length),
      unknown: maskCount(facts.filter((f) => f.level === "inconnu").length),
      newRegistrants: maskCount(facts.filter((f) => f.level === "nouvel_inscrit").length),
    },
    overall: { t1: turnout(targeted, "t1"), t2: turnout(targeted, "t2") },
    dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, dimensionRows(targeted, d, totals)])) as Record<Dimension, DimensionRow[]>,
    flows: flows(targeted),
    profileTotals: { voters: maskCount(totals.voters), abstainers: maskCount(totals.abstainers) },
    proxies: { t1: maskCount(proxies("t1")), t2: maskCount(proxies("t2")), note: PROXY_NOTE },
  }
}

// Campaign indicators (Success Criteria). Counts of doors and dates, not of persons: never masked.

export interface CampaignVisitFacts {
  addressId: string
  /** ISO date. */
  visitDate: string
  qualification: Qualification | null
}

export interface CampaignActivity {
  /** Distinct addresses with at least one visit on or after the start date (cancellations excluded). */
  doorsVisited: number
  /** Distinct visit dates carrying at least one visit since the start date. */
  sessions: number
}

export function campaignActivity(visits: readonly CampaignVisitFacts[], startDate: string): CampaignActivity {
  const doors = new Set<string>()
  const dates = new Set<string>()
  for (const v of visits) {
    if (v.qualification === "annulation" || v.visitDate < startDate) continue
    doors.add(v.addressId)
    dates.add(v.visitDate)
  }
  return { doorsVisited: doors.size, sessions: dates.size }
}

export interface CoverageCell {
  total: number
  covered: number
  /** Between 0 and 1, 0 when there is no such door. */
  share: number
}

export interface CampaignCoverage {
  /** Doors whose category is "abstention forte". */
  highPotential: CoverageCell
  /** Addresses without any registered voter. */
  noVoter: CoverageCell
}

export interface CoverageInput {
  kind: AddressKind
  category: Category
  /** Latest visit, cancellations excluded. */
  lastVisit: string | null
}

/** A door is covered when it was visited at least once since the start date; street-level entries are not doors. */
export function campaignCoverage(statuses: readonly CoverageInput[], startDate: string): CampaignCoverage {
  const cell = (category: Category): CoverageCell => {
    const doors = statuses.filter((s) => s.kind === "number" && s.category === category)
    const covered = doors.filter((s) => s.lastVisit !== null && s.lastVisit >= startDate).length
    return { total: doors.length, covered, share: doors.length === 0 ? 0 : covered / doors.length }
  }
  return { highPotential: cell("abstention_forte"), noVoter: cell("sans_inscrit") }
}
