// Dwellings of a building (15/10/2026). Pure: labels and their keys; the store lives in services/dwelling-units.ts.
import { createHash } from "node:crypto"
import { normalizeText } from "./address-normalize.ts"

export const UNIT_LABEL_MAX = 60

/** Words that locate a dwelling inside a building: building, staircase, floor, apartment, door. */
const LOCATING = /\b(bat|batiment|bloc|esc|escalier|entree|hall|tour|apt|appt|appart|appartement|logt|logement|porte|etg|etage|rdc|\d+\s*(e|eme|er))\b/
/** A complement naming a person ("chez Dupont", "c/o"): never a unit label, it would carry a name. */
const NAMING = /\b(chez|c\/o|aupres)\b/

/** Label key: two labels with the same key are the same dwelling of the address. */
export function unitLabelKey(label: string): string {
  // Punctuation aside: "Bât. B, 2e gauche" and "BAT B 2E GAUCHE" are the same dwelling.
  return normalizeText(label)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** Cleans a label typed on the field or by the administrator; null when nothing is left. */
export function cleanUnitLabel(label: string): string | null {
  const cleaned = label.replace(/\s+/g, " ").trim().slice(0, UNIT_LABEL_MAX)
  return cleaned === "" ? null : cleaned
}

/**
 * Unit label from the address complements of the electoral list, when they locate a dwelling (building, floor,
 * apartment). Null for a residence name alone, an unknown shape, or a complement naming someone.
 */
export function unitLabelFromComplements(complement1: string | null, complement2: string | null): string | null {
  const parts = [complement1, complement2].map((c) => c?.trim() ?? "").filter((c) => c !== "")
  if (parts.length === 0) return null
  const normalized = parts.map((p) => normalizeText(p).replace(/\//g, " / "))
  if (normalized.some((p) => NAMING.test(p))) return null
  const locating = parts.filter((_, i) => LOCATING.test(normalized[i] ?? ""))
  return locating.length === 0 ? null : cleanUnitLabel(locating.join(", "))
}

/** Stable id of a unit read from the electoral list, so a reimport finds the same unit. */
export function listUnitId(addressId: string, labelKey: string): string {
  return `liste-${createHash("sha256").update(`${addressId}\n${labelKey}`).digest("hex").slice(0, 24)}`
}
