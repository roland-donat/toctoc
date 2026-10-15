import { AGE_BANDS, type AgeBand } from "../db/schema/cheatsheets.ts"

/** Age in whole years at `reference`, or null when the birth date is unknown. */
export function ageAt(birthDate: string | null, reference: Date): number | null {
  if (!birthDate) return null
  const [y, m, d] = birthDate.split("-").map(Number)
  if (!y || !m || !d) return null
  let age = reference.getUTCFullYear() - y
  const monthDiff = reference.getUTCMonth() + 1 - m
  if (monthDiff < 0 || (monthDiff === 0 && reference.getUTCDate() < d)) age--
  return age
}

/** Age bands shared by the map, statistics and cheat sheets (18-25, 26-40, 41-60, 61+). */
export function ageBand(age: number | null): AgeBand | null {
  if (age === null || age < 18) return null
  if (age <= 25) return AGE_BANDS[0]
  if (age <= 40) return AGE_BANDS[1]
  if (age <= 60) return AGE_BANDS[2]
  return AGE_BANDS[3]
}
