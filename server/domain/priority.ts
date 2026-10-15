// Door priority and service time of KTD8, used by the route generator (U11). Pure.
import type { PriorityParameters } from "./parameters.ts"
import type { AddressStatus } from "./qualification.ts"

/**
 * Priority from 0 to `cap`; 0 means the address is not a candidate door: excluded (R5), street-level,
 * or with no potential at all: no fort/moyen voter, not "sans inscrit" and no "à revoir" follow-up
 * (R13 counts a door to revisit as potential on its own). Otherwise the summed weights, capped, then lowered to
 * `recentPriority` when visited recently without a follow-up ("à revoir" keeps its weights, AE3).
 */
export function priority(status: AddressStatus, params: PriorityParameters): number {
  if (status.kind === "street" || status.category === "exclue") return 0
  const { fort, moyen } = status.counts
  const nouveaux = status.counts.nouvel_inscrit
  const sansInscrit = status.category === "sans_inscrit"
  const aRevoir = status.followUp === "a_revoir"
  if (fort + moyen + nouveaux === 0 && !sansInscrit && !aRevoir) return 0
  const w = params.weights
  const sum =
    fort * w.fort + moyen * w.moyen + nouveaux * w.nouvelInscrit + (sansInscrit ? w.sansInscrit : 0) + (aRevoir ? w.aRevoir : 0)
  const capped = Math.min(sum, params.cap)
  if (status.followUp === "visitee_recemment") return Math.min(capped, params.recentPriority)
  return capped
}

/** Time spent at the door: base, plus one step per dwelling or registered voter beyond the first, capped. */
export function serviceSeconds(status: Pick<AddressStatus, "dwellings" | "registeredCount">, params: PriorityParameters): number {
  const t = params.doorTime
  const extra = Math.max(0, Math.max(status.dwellings ?? 1, status.registeredCount, 1) - 1)
  const minutes = Math.min(t.baseMinutes + extra * t.perExtraMinutes, t.capMinutes)
  return Math.round(minutes * 60)
}
