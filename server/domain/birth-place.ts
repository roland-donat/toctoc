import { SENE_INSEE } from "./commune.ts"

/** Birthplace groups of KTD9: the only granularity used by filters and statistics, never shown on the field side. */
export const BIRTH_PLACE_GROUPS = ["sene", "morbihan", "bretagne", "france", "etranger", "inconnu"] as const
export type BirthPlaceGroup = (typeof BIRTH_PLACE_GROUPS)[number]

export const BIRTH_PLACE_LABELS: Record<BirthPlaceGroup, string> = {
  sene: "Séné",
  morbihan: "Reste du Morbihan",
  bretagne: "Reste de la Bretagne",
  france: "Reste de la France",
  etranger: "Étranger",
  inconnu: "Non renseigné",
}

const BRITTANY_DEPARTMENTS = new Set(["22", "29", "35", "56"])

export interface BirthPlace {
  birthCommuneCode: string | null
  birthDepartment: string | null
  birthCountry: string | null
}

export function birthPlaceGroup(p: BirthPlace): BirthPlaceGroup {
  const country = p.birthCountry?.trim().toLowerCase() ?? ""
  const dept = p.birthDepartment?.trim() ?? ""
  if (dept === "99" || (country !== "" && country !== "france")) return "etranger"
  if (p.birthCommuneCode === SENE_INSEE) return "sene"
  if (dept === "56") return "morbihan"
  if (BRITTANY_DEPARTMENTS.has(dept)) return "bretagne"
  if (dept !== "" || country === "france") return "france"
  return "inconnu"
}
