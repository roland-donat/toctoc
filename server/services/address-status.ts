// Category, follow-up and voter summary of every address (or of a subset), in a handful of queries:
// addresses, registrations of the current list with birth dates, voter levels, street-level streets, visits.
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import type { AppContext } from "../context.ts"
import { AGE_BANDS, type AgeBand } from "../db/schema/cheatsheets.ts"
import { addresses, commerces, electors, registrations, visits } from "../db/schema/index.ts"
import { ageAt, ageBand } from "../domain/age.ts"
import { loadParameters, type PriorityParameters } from "../domain/parameters.ts"
import {
  activeExclusion,
  addressCategory,
  followUpState,
  latestVisitDate,
  parisDate,
  type AddressStatus,
  type VisitFacts,
} from "../domain/qualification.ts"
import { VOTER_LEVELS, type VoterLevel } from "../domain/voter-level.ts"
import { currentRepImportId } from "./current-list.ts"
import { loadCurrentVoterLevels } from "./voter-levels.ts"

export interface AddressStatusOptions {
  /** Restricts the computation to these addresses (retired ones included). Default: every non-retired address. */
  addressIds?: readonly string[]
  /** Defaults to the stored parameters (only `recentDays` is used here). */
  params?: PriorityParameters
}

interface Voter {
  level: VoterLevel
  band: AgeBand | null
}

function emptyCounts(): Record<VoterLevel, number> {
  return Object.fromEntries(VOTER_LEVELS.map((l) => [l, 0])) as Record<VoterLevel, number>
}

export function computeAddressStatuses(ctx: AppContext, options: AddressStatusOptions = {}): AddressStatus[] {
  const { db } = ctx
  const ids = options.addressIds
  if (ids !== undefined && ids.length === 0) return []
  const params = options.params ?? loadParameters(db)
  const now = ctx.now()
  const today = parisDate(now)

  const rows = db
    .select({
      id: addresses.id,
      kind: addresses.kind,
      streetKey: addresses.streetKey,
      dwellings: addresses.dwellings,
      commerceDismissedAt: addresses.commerceDismissedAt,
    })
    .from(addresses)
    .where(ids === undefined ? isNull(addresses.retiredAt) : inArray(addresses.id, [...ids]))
    .all()

  // Voters of the current list per address, one entry per distinct elector.
  const votersByAddress = new Map<string, Map<string, Voter>>()
  const streetLevelStreets = new Set<string>()
  // BAN doors proposed (and refused) for electors still in the manual queue: they are not "sans inscrit" (KTD3).
  const proposedForQueue = new Set<string>()
  const importId = currentRepImportId(db)
  if (importId !== null) {
    const levels = loadCurrentVoterLevels(db)
    const regs = db
      .select({
        electorId: registrations.electorId,
        addressId: registrations.addressId,
        birthDate: electors.birthDate,
        kind: addresses.kind,
        streetKey: addresses.streetKey,
      })
      .from(registrations)
      .innerJoin(electors, eq(electors.id, registrations.electorId))
      .innerJoin(addresses, eq(addresses.id, registrations.addressId))
      .where(and(eq(registrations.importId, importId), isNotNull(registrations.addressId)))
      .all()
    for (const r of regs) {
      if (r.addressId === null) continue
      if (r.kind === "street") streetLevelStreets.add(r.streetKey)
      let voters = votersByAddress.get(r.addressId)
      if (!voters) {
        voters = new Map()
        votersByAddress.set(r.addressId, voters)
      }
      if (voters.has(r.electorId)) continue
      const level = levels.get(r.electorId) ?? "inconnu"
      voters.set(r.electorId, { level, band: level === "hors_cible" ? null : ageBand(ageAt(r.birthDate, now)) })
    }
    const proposals = db
      .select({ addressId: registrations.fallbackProposalId })
      .from(registrations)
      .where(
        and(eq(registrations.importId, importId), isNull(registrations.addressId), isNotNull(registrations.fallbackProposalId)),
      )
      .all()
    for (const p of proposals) if (p.addressId !== null) proposedForQueue.add(p.addressId)
  }

  const withCommerce = new Set(
    db
      .select({ addressId: commerces.addressId })
      .from(commerces)
      .where(isNotNull(commerces.addressId))
      .all()
      .map((c) => c.addressId),
  )

  const visitsByAddress = new Map<string, VisitFacts[]>()
  const visitRows = db
    .select({
      addressId: visits.addressId,
      visitDate: visits.visitDate,
      recordedAt: visits.recordedAt,
      dwelling: visits.dwelling,
      toRevisit: visits.toRevisit,
      toAccompany: visits.toAccompany,
      qualification: visits.qualification,
      qualificationScope: visits.qualificationScope,
    })
    .from(visits)
    .where(ids === undefined ? undefined : inArray(visits.addressId, [...ids]))
    .all()
  for (const v of visitRows) {
    const list = visitsByAddress.get(v.addressId)
    if (list) list.push(v)
    else visitsByAddress.set(v.addressId, [v])
  }

  return rows.map((a) => {
    const voters = [...(votersByAddress.get(a.id)?.values() ?? [])]
    const history = visitsByAddress.get(a.id) ?? []
    const counts = emptyCounts()
    for (const v of voters) counts[v.level] += 1
    const bands = new Set(voters.flatMap((v) => (v.band === null ? [] : [v.band])))
    return {
      addressId: a.id,
      kind: a.kind,
      category: addressCategory({
        excluded: activeExclusion(history) !== null,
        levels: voters.map((v) => v.level),
        streetLevelElectorsOnStreet: streetLevelStreets.has(a.streetKey),
        proposedForQueuedElector: proposedForQueue.has(a.id),
        commerce: withCommerce.has(a.id) && a.commerceDismissedAt === null,
      }),
      followUp: followUpState(history, today, params.recentDays),
      lastVisit: latestVisitDate(history),
      counts,
      ageBands: AGE_BANDS.filter((b) => bands.has(b)),
      registeredCount: voters.length,
      dwellings: a.dwellings,
    }
  })
}
