// Helpers on the electoral list currently in force (latest confirmed REP import), shared with the
// units that read registrations (emargement, qualification, map, statistics).
import { and, asc, count, desc, eq, isNotNull, isNull } from "drizzle-orm"
import type { Db } from "../db/index.ts"
import { addresses, imports, registrations } from "../db/schema/index.ts"

export type ImportRow = typeof imports.$inferSelect

/** Latest confirmed import of a kind, null before the first one. */
function currentImport(db: Db, kind: ImportRow["kind"]): ImportRow | null {
  return (
    db
      .select()
      .from(imports)
      .where(and(eq(imports.kind, kind), eq(imports.isCurrent, true)))
      .orderBy(desc(imports.importedAt))
      .limit(1)
      .get() ?? null
  )
}

/** Id of the current REP import, null before the first confirmed import. */
export function currentRepImportId(db: Db): string | null {
  return currentImport(db, "rep")?.id ?? null
}

/**
 * Id of the first REP import ever confirmed (the list in force at the March 2026 election), null
 * before the first import. The 2026 emargement belongs to that list.
 */
export function earliestRepImportId(db: Db): string | null {
  return (
    db
      .select({ id: imports.id })
      .from(imports)
      .where(eq(imports.kind, "rep"))
      .orderBy(asc(imports.importedAt))
      .limit(1)
      .get()?.id ?? null
  )
}

/** Latest confirmed emargement import, null before the first one. */
export function currentEmargementImport(db: Db): ImportRow | null {
  return currentImport(db, "emargement")
}

/** Human label of an address: "13 bis Rue de Limur", or the street name for a street-level address. */
export function addressLabel(a: { number: number | null; rep: string | null; streetName: string }): string {
  if (a.number === null) return a.streetName
  return [String(a.number), a.rep, a.streetName].filter((p) => p !== null && p !== "").join(" ")
}

export interface QueueItem {
  id: string
  bureau: string
  orderNumber: number | null
  rawNumber: string | null
  rawStreet: string | null
  rawComplement1: string | null
  rawComplement2: string | null
  rawLieuDit: string | null
  rawPostalCode: string | null
  /** BAN address proposed by the fallback and refused by the KTD3 checks. */
  proposal: { id: string; label: string; lat: number; lon: number } | null
}

/** Registrations of the current list still waiting for an address (manual matching queue). */
export function currentQueue(db: Db): QueueItem[] {
  const importId = currentRepImportId(db)
  if (importId === null) return []
  return db
    .select({
      id: registrations.id,
      bureau: registrations.bureau,
      orderNumber: registrations.orderNumber,
      rawNumber: registrations.rawNumber,
      rawStreet: registrations.rawStreet,
      rawComplement1: registrations.rawComplement1,
      rawComplement2: registrations.rawComplement2,
      rawLieuDit: registrations.rawLieuDit,
      rawPostalCode: registrations.rawPostalCode,
      proposalId: addresses.id,
      proposalNumber: addresses.number,
      proposalRep: addresses.rep,
      proposalStreet: addresses.streetName,
      proposalLat: addresses.lat,
      proposalLon: addresses.lon,
    })
    .from(registrations)
    .leftJoin(addresses, eq(addresses.id, registrations.fallbackProposalId))
    .where(and(eq(registrations.importId, importId), isNull(registrations.addressId)))
    .orderBy(registrations.bureau, registrations.orderNumber)
    .all()
    .map((r) => ({
      id: r.id,
      bureau: r.bureau,
      orderNumber: r.orderNumber,
      rawNumber: r.rawNumber,
      rawStreet: r.rawStreet,
      rawComplement1: r.rawComplement1,
      rawComplement2: r.rawComplement2,
      rawLieuDit: r.rawLieuDit,
      rawPostalCode: r.rawPostalCode,
      proposal:
        r.proposalId === null || r.proposalStreet === null || r.proposalLat === null || r.proposalLon === null
          ? null
          : {
              id: r.proposalId,
              label: addressLabel({ number: r.proposalNumber, rep: r.proposalRep, streetName: r.proposalStreet }),
              lat: r.proposalLat,
              lon: r.proposalLon,
            },
    }))
}

export interface CurrentListSummary {
  importId: string
  importedAt: number
  rows: number
  registrations: number
  matched: number
  queueSize: number
  matchRate: number
}

export function currentListSummary(db: Db): CurrentListSummary | null {
  const current = currentImport(db, "rep")
  if (!current) return null
  const total =
    db.select({ n: count() }).from(registrations).where(eq(registrations.importId, current.id)).get()?.n ?? 0
  const matched =
    db
      .select({ n: count() })
      .from(registrations)
      .where(and(eq(registrations.importId, current.id), isNotNull(registrations.addressId)))
      .get()?.n ?? 0
  return {
    importId: current.id,
    importedAt: current.importedAt,
    rows: current.rowCount,
    registrations: total,
    matched,
    queueSize: total - matched,
    matchRate: total === 0 ? 0 : matched / total,
  }
}
