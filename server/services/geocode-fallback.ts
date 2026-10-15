// Géoplateforme address fallback (KTD3), server side. Only structured address fields leave the
// server: house number, repetition index, street, lieu-dit, postal code and commune. Never a name,
// a first name or the "complément" columns of the REP file (they may hold "chez" followed by a name).
// Pattern: VOTER src/lib/geocode.ts (chunks of 500, exponential retry on 429), moved server side.
import Papa from "papaparse"
import { logError, logInfo } from "../lib/log.ts"

export const GEOCODE_URL = "https://data.geopf.fr/geocodage/search/csv"
const CHUNK_SIZE = 500
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
/** Deadline of one attempt (one chunk of 500 addresses): a hung call becomes a retry, then the degraded path. */
const ATTEMPT_TIMEOUT_MS = 30_000

/** The only fields ever sent. Empty strings for absent values. */
export interface FallbackQuery {
  number: string
  rep: string
  street: string
  lieuDit: string
  postalCode: string
  commune: string
}

export interface FallbackResult {
  /** Géoplateforme result type: housenumber, street, locality, municipality. */
  type: string
  /** BAN id of the result (`result_id`). */
  banId: string
  housenumber: string
  street: string
  label: string
  lat: number | null
  lon: number | null
}

export type GeocodeFetch = (url: string, init: RequestInit) => Promise<Response>

export interface GeocodeOptions {
  fetch?: GeocodeFetch
  /** Injected in tests to skip the retry delays. */
  sleep?: (ms: number) => Promise<void>
  /** Deadline of each attempt; injected in tests. Default 30 s. */
  timeoutMs?: number
}

export interface GeocodeOutcome {
  /** Keyed by fallbackQueryKey; null when the service found nothing. Missing when the call failed. */
  results: Map<string, FallbackResult | null>
  /** False when the service could not be reached: the remaining addresses were not looked up. */
  available: boolean
}

class GeocodeHttpError extends Error {
  override name = "GeocodeHttpError"
}

const CSV_COLUMNS = ["qid", "numero", "indice", "voie", "lieu_dit", "code_postal", "commune"] as const
/** Columns the service concatenates into the search text; the postal code is a filter. */
const QUERY_COLUMNS = ["numero", "indice", "voie", "lieu_dit", "commune"] as const

export function fallbackQueryKey(q: FallbackQuery): string {
  return [q.number, q.rep, q.street, q.lieuDit, q.postalCode, q.commune].join("|")
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function buildCsv(queries: readonly FallbackQuery[]): string {
  const rows = queries.map((q, i) => [`q${i}`, q.number, q.rep, q.street, q.lieuDit, q.postalCode, q.commune])
  return Papa.unparse({ fields: [...CSV_COLUMNS], data: rows }, { newline: "\n" })
}

function parseFloatOrNull(value: string | undefined): number | null {
  const n = Number.parseFloat(value ?? "")
  return Number.isFinite(n) ? n : null
}

async function geocodeChunk(
  queries: readonly FallbackQuery[],
  fetchFn: GeocodeFetch,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<Array<FallbackResult | null>> {
  const csv = buildCsv(queries)
  for (let attempt = 0; ; attempt++) {
    const form = new FormData()
    form.append("data", new Blob([csv], { type: "text/csv" }), "addresses.csv")
    for (const column of QUERY_COLUMNS) form.append("columns", column)
    form.append("postcode", "code_postal")
    try {
      // The deadline covers the body too: a service that sends headers then stalls is cut as well.
      const signal = AbortSignal.timeout(timeoutMs)
      const response = await fetchFn(GEOCODE_URL, { method: "POST", body: form, signal })
      if (!response.ok) throw new GeocodeHttpError(`Géoplateforme answered ${response.status}`)
      const parsed = Papa.parse<Record<string, string>>(await response.text(), { header: true, skipEmptyLines: true })
      const byQid = new Map(parsed.data.map((row) => [row["qid"] ?? "", row]))
      return queries.map((_, i) => {
        const row = byQid.get(`q${i}`)
        if (!row || row["result_status"] !== "ok" || !row["result_id"]) return null
        return {
          type: row["result_type"] ?? "",
          banId: row["result_id"] ?? "",
          housenumber: row["result_housenumber"] ?? "",
          street: row["result_street"] || row["result_name"] || "",
          label: row["result_label"] ?? "",
          lat: parseFloatOrNull(row["latitude"]),
          lon: parseFloatOrNull(row["longitude"]),
        }
      })
    } catch (err) {
      if (attempt >= MAX_RETRIES - 1) throw err
      await sleep(BASE_DELAY_MS * 2 ** attempt)
    }
  }
}

/**
 * Looks up each distinct address once, by chunks of 500. Never throws: when the service cannot be
 * reached, `available` is false and the addresses not looked up are absent from the results.
 */
export async function geocodeFallback(
  queries: readonly FallbackQuery[],
  options: GeocodeOptions = {},
): Promise<GeocodeOutcome> {
  const fetchFn = options.fetch ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  const unique = new Map<string, FallbackQuery>()
  for (const q of queries) unique.set(fallbackQueryKey(q), q)
  const list = [...unique.values()]
  const results = new Map<string, FallbackResult | null>()

  for (let i = 0; i < list.length; i += CHUNK_SIZE) {
    const chunk = list.slice(i, i + CHUNK_SIZE)
    try {
      const answers = await geocodeChunk(chunk, fetchFn, sleep, timeoutMs)
      chunk.forEach((q, j) => results.set(fallbackQueryKey(q), answers[j] ?? null))
    } catch (err) {
      logError("geocode_fallback_unavailable", err, { looked_up: results.size, remaining: list.length - i })
      return { results, available: false }
    }
  }
  logInfo("geocode_fallback_done", { addresses: list.length, found: [...results.values()].filter(Boolean).length })
  return { results, available: true }
}
