// Electoral-list address matching (KTD3, plan Assumptions on electors without house number).
// Order: (1) local match on the BAN key; (2) no usable house number: street-level address of the
// street or lieu-dit; (3) Géoplateforme fallback, accepted only under the KTD3 checks; (4) queue.
import { and, asc, eq, isNull } from "drizzle-orm"
import type { Db } from "../db/index.ts"
import { addresses } from "../db/schema/index.ts"
import { matchKey, normalizeStreet, splitNumber, streetKey, type SplitNumber } from "../domain/address-normalize.ts"
import {
  geocodeFallback,
  fallbackQueryKey,
  type FallbackQuery,
  type FallbackResult,
  type GeocodeOptions,
} from "./geocode-fallback.ts"

/** Address fields of a REP line usable for matching. The complements are deliberately absent. */
export interface RepAddress {
  rawNumber: string | null
  rawStreet: string | null
  rawLieuDit: string | null
  rawPostalCode: string | null
  rawCommune: string | null
}

export type AddressMatch =
  | { status: "ban"; addressId: string }
  | { status: "fallback"; addressId: string }
  | { status: "street"; addressId: string }
  /** Waits in the manual queue; `proposalId` is the local BAN id of a refused fallback result. */
  | { status: "pending"; proposalId: string | null }

/** Street-level address (kind "street") to create or refresh, centred on the BAN addresses of the street. */
export interface StreetAddressPlan {
  id: string
  streetKey: string
  streetName: string
  postalCode: string | null
  lat: number
  lon: number
}

export interface MatchReport {
  matches: AddressMatch[]
  streets: Map<string, StreetAddressPlan>
  /** Distinct addresses sent to the Géoplateforme. */
  fallbackRequested: number
  fallbackAvailable: boolean
}

interface IndexedAddress {
  id: string
  number: number | null
  rep: string | null
  streetName: string
}

export interface AddressIndex {
  byMatchKey: Map<string, string>
  byId: Map<string, IndexedAddress>
  /** Street-level plans by street key, built from the non-retired BAN numbers. */
  streets: Map<string, StreetAddressPlan>
}

function streetAddressId(key: string): string {
  return `street:${key}`
}

/** Loads the non-retired BAN numbers into memory (a few thousand rows for a commune). */
export function loadAddressIndex(db: Db): AddressIndex {
  const rows = db
    .select({
      id: addresses.id,
      number: addresses.number,
      rep: addresses.rep,
      streetName: addresses.streetName,
      streetKey: addresses.streetKey,
      postalCode: addresses.postalCode,
      matchKey: addresses.matchKey,
      lat: addresses.lat,
      lon: addresses.lon,
    })
    .from(addresses)
    .where(and(eq(addresses.kind, "number"), isNull(addresses.retiredAt)))
    .orderBy(asc(addresses.id))
    .all()

  const byMatchKey = new Map<string, string>()
  const byId = new Map<string, IndexedAddress>()
  const sums = new Map<string, { name: string; postalCode: string | null; lat: number; lon: number; n: number }>()
  for (const row of rows) {
    if (!byMatchKey.has(row.matchKey)) byMatchKey.set(row.matchKey, row.id)
    byId.set(row.id, { id: row.id, number: row.number, rep: row.rep, streetName: row.streetName })
    const sum = sums.get(row.streetKey) ?? { name: row.streetName, postalCode: row.postalCode, lat: 0, lon: 0, n: 0 }
    sum.lat += row.lat
    sum.lon += row.lon
    sum.n += 1
    sums.set(row.streetKey, sum)
  }
  const streets = new Map<string, StreetAddressPlan>()
  for (const [key, s] of sums) {
    streets.set(key, {
      id: streetAddressId(key),
      streetKey: key,
      streetName: s.name,
      postalCode: s.postalCode,
      lat: s.lat / s.n,
      lon: s.lon / s.n,
    })
  }
  return { byMatchKey, byId, streets }
}

/** Street types recognized at the start of a normalized street name (after abbreviation expansion). */
const STREET_TYPES = [
  "lieu dit",
  "rond point",
  "rue",
  "impasse",
  "allee",
  "chemin",
  "route",
  "place",
  "avenue",
  "boulevard",
  "residence",
  "square",
  "lotissement",
  "venelle",
  "passage",
  "quai",
  "sentier",
  "voie",
  "cours",
  "clos",
  "cite",
  "hameau",
  "parc",
  "domaine",
]
const ARTICLES = new Set(["de", "du", "des", "la", "le", "les", "l", "d"])

function splitStreetType(street: string): { type: string | null; rest: string } {
  const text = normalizeStreet(street)
  for (const type of STREET_TYPES) {
    if (text === type) return { type, rest: "" }
    if (text.startsWith(`${type} `)) return { type, rest: text.slice(type.length + 1) }
  }
  return { type: null, rest: text }
}

/**
 * "Mot directeur" of a street: the last significant word once the street type and the articles
 * or prepositions are removed (AFNOR habit: "Rue du Général de Gaulle" gives "gaulle").
 */
export function streetMainWord(street: string): string {
  const { rest } = splitStreetType(street)
  const words = rest.split(" ").filter((w) => w !== "" && !ARTICLES.has(w))
  if (words.length > 0) return words[words.length - 1] ?? ""
  const all = normalizeStreet(street).split(" ").filter((w) => w !== "")
  return all[all.length - 1] ?? ""
}

/** Words of a street name once its leading articles are dropped ("du clos du poulfanc" gives "clos du poulfanc"). */
function withoutLeadingArticles(text: string): string {
  const words = text.split(" ").filter((w) => w !== "")
  while (words.length > 1 && ARTICLES.has(words[0] ?? "")) words.shift()
  return words.join(" ")
}

/**
 * One name is the whole other one behind a street type: "Clos du Poulfanc" in the list for "Rue du Clos du
 * Poulfanc" in the BAN. The first word looks like a street type but is part of the name (15/10/2026).
 */
function nameBehindType(a: string, b: string): boolean {
  const { type, rest } = splitStreetType(b)
  return type !== null && rest !== "" && withoutLeadingArticles(rest) === withoutLeadingArticles(normalizeStreet(a))
}

/**
 * Same street for the KTD3 fallback check: same main word, and the same street type when both
 * names carry one ("12 impasse de X" is not "12 rue de X"), unless one name is the whole other one behind its
 * type ("Clos du Poulfanc" and "Rue du Clos du Poulfanc").
 */
export function sameStreet(a: string, b: string): boolean {
  if (nameBehindType(a, b) || nameBehindType(b, a)) return true
  const ta = splitStreetType(a).type
  const tb = splitStreetType(b).type
  if (ta !== null && tb !== null && ta !== tb) return false
  const ma = streetMainWord(a)
  return ma !== "" && ma === streetMainWord(b)
}

function clean(value: string | null): string {
  return value?.trim() ?? ""
}

type LocalOutcome = AddressMatch | { status: "unmatched"; query: FallbackQuery; parsed: SplitNumber; streetName: string }

function matchLocally(index: AddressIndex, address: RepAddress, streets: Map<string, StreetAddressPlan>): LocalOutcome {
  const { number, rep } = splitNumber(clean(address.rawNumber))
  const street = clean(address.rawStreet)
  const lieuDit = clean(address.rawLieuDit)
  const candidates = [street, lieuDit].filter((s) => s !== "")

  if (number !== null) {
    for (const name of candidates) {
      const id = index.byMatchKey.get(matchKey(number, rep, name))
      if (id !== undefined) return { status: "ban", addressId: id }
    }
  } else {
    for (const name of candidates) {
      const plan = index.streets.get(streetKey(name))
      if (plan !== undefined) {
        streets.set(plan.id, plan)
        return { status: "street", addressId: plan.id }
      }
    }
  }
  return {
    status: "unmatched",
    parsed: { number, rep },
    streetName: candidates[0] ?? "",
    query: {
      number: number === null ? "" : String(number),
      rep: rep ?? "",
      street,
      lieuDit,
      postalCode: clean(address.rawPostalCode),
      commune: clean(address.rawCommune),
    },
  }
}

function judgeFallback(
  index: AddressIndex,
  outcome: { parsed: SplitNumber; streetName: string },
  result: FallbackResult | null | undefined,
): AddressMatch {
  if (!result) return { status: "pending", proposalId: null }
  const local = index.byId.get(result.banId)
  if (local === undefined) return { status: "pending", proposalId: null }
  const { number, rep } = outcome.parsed
  const accepted =
    result.type === "housenumber" &&
    number !== null &&
    local.number === number &&
    local.rep === rep &&
    sameStreet(outcome.streetName, local.streetName)
  return accepted ? { status: "fallback", addressId: local.id } : { status: "pending", proposalId: local.id }
}

/** Matches every address, calling the Géoplateforme once per distinct unmatched address. */
export async function matchAddresses(
  index: AddressIndex,
  list: readonly RepAddress[],
  options: GeocodeOptions = {},
): Promise<MatchReport> {
  const streets = new Map<string, StreetAddressPlan>()
  const local = list.map((a) => matchLocally(index, a, streets))
  const queries = local.flatMap((o) => (o.status === "unmatched" ? [o.query] : []))
  const outcome = queries.length > 0 ? await geocodeFallback(queries, options) : { results: new Map<string, FallbackResult | null>(), available: true }

  const matches = local.map((o): AddressMatch => {
    if (o.status !== "unmatched") return o
    return judgeFallback(index, o, outcome.results.get(fallbackQueryKey(o.query)))
  })
  return {
    matches,
    streets,
    fallbackRequested: new Set(queries.map(fallbackQueryKey)).size,
    fallbackAvailable: outcome.available,
  }
}
