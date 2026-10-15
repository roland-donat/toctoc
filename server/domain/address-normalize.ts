// Shared address normalization (KTD3): the BAN loader (U3) and the electoral-list matching (U4)
// must compute exactly the same keys, so both go through these pure functions.

/** Lowercase, no accents, hyphens/apostrophes/dots as spaces, single spaces, trimmed. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[-'’.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Street type abbreviations, expanded only when they are the first word of the street. */
const STREET_TYPE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  r: "rue",
  av: "avenue",
  bd: "boulevard",
  imp: "impasse",
  chem: "chemin",
  ch: "chemin",
  all: "allee",
  pl: "place",
  rte: "route",
  res: "residence",
  sq: "square",
  lot: "lotissement",
  ld: "lieu dit",
  lieudit: "lieu dit",
}

/** Normalized street (or lieu-dit) name: normalizeText plus expansion of a leading street type abbreviation. */
export function normalizeStreet(street: string): string {
  const text = normalizeText(street)
  const space = text.indexOf(" ")
  const first = space === -1 ? text : text.slice(0, space)
  const expanded = STREET_TYPE_ABBREVIATIONS[first]
  if (expanded === undefined) return text
  return space === -1 ? expanded : `${expanded}${text.slice(space)}`
}

const REP_LETTERS: Readonly<Record<string, string>> = { b: "bis", t: "ter", q: "quater" }
const REP_WORDS = new Set(["bis", "ter", "quater", "quinquies"])

/**
 * Normalized repetition index: "bis", "ter", "quater", or a single letter.
 * Single letters b, t, q stand for bis, ter, quater (electoral list habit); other letters are kept.
 */
export function normalizeRep(rep: string | null | undefined): string | null {
  if (rep === null || rep === undefined) return null
  const value = normalizeText(rep).replace(/\s/g, "")
  if (value === "") return null
  if (REP_WORDS.has(value)) return value
  if (/^[a-z]$/.test(value)) return REP_LETTERS[value] ?? value
  return value
}

export interface SplitNumber {
  number: number | null
  rep: string | null
}

/** Splits "13Bis", "12 bis", "12B", "12 ter"... into a house number and a normalized repetition index. */
export function splitNumber(raw: string): SplitNumber {
  const match = /^\s*(\d+)\s*([a-zA-Z]*)\s*$/.exec(raw)
  if (!match) return { number: null, rep: null }
  return { number: Number.parseInt(match[1] ?? "", 10), rep: normalizeRep(match[2]) }
}

/** Key shared by every address of a street (or lieu-dit). */
export function streetKey(street: string): string {
  return normalizeStreet(street)
}

/** Local matching key: `${number}|${rep}|${normalized street}`, empty slots when absent. */
export function matchKey(number: number | null, rep: string | null, street: string): string {
  return `${number ?? ""}|${normalizeRep(rep) ?? ""}|${normalizeStreet(street)}`
}
