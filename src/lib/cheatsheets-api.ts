import { fetchJSON } from "./api-client"
import type { AgeBand } from "./carte-api"

export type CheatsheetBand = AgeBand | "generale"

export interface Cheatsheet {
  id: string
  ageBand: CheatsheetBand
  title: string
  body: string
  position: number
  updatedAt: number
}

export interface CheatsheetPatch {
  title?: string
  body?: string
  ageBand?: CheatsheetBand
  position?: number
}

export const CHEATSHEET_BANDS: { band: CheatsheetBand; label: string }[] = [
  { band: "18-25", label: "18-25 ans" },
  { band: "26-40", label: "26-40 ans" },
  { band: "41-60", label: "41-60 ans" },
  { band: "61+", label: "61 ans et plus" },
  { band: "generale", label: "Générale" },
]

export const cheatsheetsKey = ["cheatsheets"] as const

export const listCheatsheets = () => fetchJSON<Cheatsheet[]>("/antiseches")

export const createCheatsheet = (input: { ageBand: CheatsheetBand; title: string; body: string }) =>
  fetchJSON<Cheatsheet>("/antiseches", { method: "POST", body: JSON.stringify(input) })

/** Browsers refuse a keepalive request whose body exceeds 64 KiB; a long cheat sheet is sent normally. */
const KEEPALIVE_MAX_BYTES = 60_000

export function updateCheatsheet(id: string, patch: CheatsheetPatch) {
  const body = JSON.stringify(patch)
  // keepalive: an auto-save flushed on pagehide still reaches the server once the page is gone.
  const keepalive = new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES
  return fetchJSON<Cheatsheet>(`/antiseches/${id}`, { method: "PATCH", body, keepalive })
}

export const deleteCheatsheet = (id: string) => fetchJSON<void>(`/antiseches/${id}`, { method: "DELETE" })
