import { CATEGORY_COLORS, type MapAddress } from "./carte-api"
import type { VoterLevel } from "./imports-api"

// Map symbols of a door (R7): one point per voting behavior present at the address, its area proportional to the
// number of electors behind it. A building with voters and abstainers thus shows several points side by side.

export const VOTER_GROUPS = ["abstention_forte", "abstention_moyenne", "votants", "autres"] as const
export type VoterGroup = (typeof VOTER_GROUPS)[number]

export const VOTER_GROUP_LABELS: Record<VoterGroup, string> = {
  abstention_forte: "Abstention forte",
  abstention_moyenne: "Abstention moyenne",
  votants: "Votants",
  autres: "Autres inscrits",
}

/** Same colors as the address categories, so the legend and the statistics read alike. */
export const VOTER_GROUP_COLORS: Record<VoterGroup, string> = {
  abstention_forte: CATEGORY_COLORS.abstention_forte,
  abstention_moyenne: CATEGORY_COLORS.abstention_moyenne,
  votants: CATEGORY_COLORS.votants,
  autres: CATEGORY_COLORS.non_localise,
}

/** A 2027 new registrant counts as a strong-potential target, as in the address category (decided 13/10/2026). */
const LEVEL_GROUP: Record<VoterLevel, VoterGroup> = {
  fort: "abstention_forte",
  nouvel_inscrit: "abstention_forte",
  moyen: "abstention_moyenne",
  votant: "votants",
  inconnu: "autres",
  hors_cible: "autres",
}

/** Radius of a point standing for one elector, or for a door without any. */
export const BASE_RADIUS = 4.5
/** Beyond this the area stops growing, so a large building does not hide its street. */
export const MAX_RADIUS = 20

/** Radius whose area is proportional to the count (a door without elector keeps the base size). */
export function radiusFor(count: number): number {
  return Math.min(MAX_RADIUS, BASE_RADIUS * Math.sqrt(Math.max(1, count)))
}

export interface DoorPoint {
  /** Stable within the door: the group, or "door" for a single point in the category color. */
  key: string
  color: string
  count: number
  radius: number
  /** Screen offset from the address, in pixels (y downwards). */
  offset: readonly [number, number]
}

/** Angles (degrees, y downwards) of the points around the address, by number of points. */
const ANGLES: Record<number, readonly number[]> = {
  2: [180, 0],
  3: [-90, 30, 150],
  4: [-135, -45, 45, 135],
}
/** Distance factor from the center so that neighboring points of equal size do not overlap. */
const SPREAD: Record<number, number> = { 2: 1, 3: 1.16, 4: 1.42 }

/** Electors of the door per voting behavior, in the fixed legend order, empty groups left out. */
export function groupCounts(counts: MapAddress["counts"]): { group: VoterGroup; count: number }[] {
  const totals = new Map<VoterGroup, number>()
  for (const [level, n] of Object.entries(counts) as [VoterLevel, number][]) {
    if (n <= 0) continue
    const group = LEVEL_GROUP[level]
    totals.set(group, (totals.get(group) ?? 0) + n)
  }
  return VOTER_GROUPS.flatMap((group) => {
    const count = totals.get(group) ?? 0
    return count > 0 ? [{ group, count }] : []
  })
}

/**
 * Points drawn for a door. An excluded door, or one without a located elector, keeps a single point in its category
 * color; otherwise one point per voting behavior present, spread around the address when there are several.
 */
export function doorPoints(address: Pick<MapAddress, "category" | "counts">): DoorPoint[] {
  const groups = address.category === "exclue" ? [] : groupCounts(address.counts)
  if (groups.length === 0) {
    return [{ key: "door", color: CATEGORY_COLORS[address.category], count: 0, radius: BASE_RADIUS, offset: [0, 0] }]
  }
  const angles = ANGLES[groups.length]
  const spread = SPREAD[groups.length] ?? 0
  const largest = Math.max(...groups.map((g) => radiusFor(g.count)))
  return groups.map(({ group, count }, i) => {
    const radius = radiusFor(count)
    const angle = ((angles?.[i] ?? 0) * Math.PI) / 180
    // Two points touch at the address; three or four sit on a ring wide enough for the largest of them.
    const distance = groups.length === 1 ? 0 : groups.length === 2 ? radius : largest * spread + 0.5
    return {
      key: group,
      color: VOTER_GROUP_COLORS[group],
      count,
      radius,
      offset: [Math.round(Math.cos(angle) * distance * 10) / 10, Math.round(Math.sin(angle) * distance * 10) / 10],
    }
  })
}
