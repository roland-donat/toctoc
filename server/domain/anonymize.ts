// Name display evaluated at each request (KTD7, R24, R25). The global switch lives in the settings table;
// `anonymize` is applied to every response that carries persons or feedback.
import type { AppContext } from "../context.ts"
import type { Db } from "../db/index.ts"
import { getSetting, setSetting } from "../db/settings.ts"

export const ANONYMIZATION_KEY = "anonymization_mode"
export const ANONYMIZATION_MODES = ["anonyme", "nominatif"] as const
export type AnonymizationMode = (typeof ANONYMIZATION_MODES)[number]

/**
 * Fields removed when names are not allowed: person names, and the free texts of feedback, which may carry
 * a name read on a mailbox (KTD7).
 */
const NOMINATIVE_FIELDS: ReadonlySet<string> = new Set(["birthName", "usageName", "firstNames", "dwelling", "remarks"])

/** Stored mode; anything unreadable counts as "anonyme", the default. */
export function anonymizationMode(db: Db): AnonymizationMode {
  const stored = getSetting<unknown>(db, ANONYMIZATION_KEY, "anonyme")
  return stored === "nominatif" ? "nominatif" : "anonyme"
}

export function setAnonymizationMode(db: Db, mode: AnonymizationMode): void {
  setSetting(db, ANONYMIZATION_KEY, mode)
}

/**
 * Whether a response may carry names: the global switch is "nominatif" and, for a field response
 * (U12, U13), the itinerary allows names too.
 */
export function namesAllowed(ctx: AppContext, options: { itineraryShowNames?: boolean } = {}): boolean {
  if (anonymizationMode(ctx.db) !== "nominatif") return false
  return options.itineraryShowNames ?? true
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) out[key] = NOMINATIVE_FIELDS.has(key) ? null : strip(v)
    return out
  }
  return value
}

/**
 * Copy of `value` where every nominative field, at any depth, is null unless names are allowed.
 * Response types must declare those fields nullable.
 */
export function anonymize<T>(value: T, allowed: boolean): T {
  if (allowed) return value
  return strip(value) as T
}
