import type { AgeBand } from "../db/schema/cheatsheets.ts"
import { AGE_BANDS } from "../db/schema/cheatsheets.ts"

export interface BandedSheet {
  ageBand: AgeBand | "generale"
}

/**
 * Cheat sheets shown at a door (R21): those of the distinct age bands present among its
 * targeted voters, in band order; the "generale" ones when there is no such voter.
 * Keeps the order of `sheets` within a band.
 */
export function cheatsheetsForDoor<T extends BandedSheet>(bands: readonly AgeBand[], sheets: readonly T[]): T[] {
  if (bands.length === 0) return sheets.filter((s) => s.ageBand === "generale")
  const present = new Set(bands)
  return AGE_BANDS.filter((b) => present.has(b)).flatMap((b) => sheets.filter((s) => s.ageBand === b))
}
