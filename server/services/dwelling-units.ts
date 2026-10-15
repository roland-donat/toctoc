// Dwellings of a building (15/10/2026): the list read from the address complements of the electoral list,
// completed on the field and by the administrator, and what each one has had as feedback.
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm"
import type { AppContext } from "../context.ts"
import { dwellingUnits, registrations, visits } from "../db/schema/index.ts"
import { cleanUnitLabel, listUnitId, unitLabelFromComplements, unitLabelKey } from "../domain/dwelling-units.ts"
import { currentRepImportId } from "./current-list.ts"

export type DwellingUnitSource = (typeof dwellingUnits.$inferSelect)["source"]

export type UnitErrorCode = "unit_not_found" | "unit_other_address" | "unit_label_required"

export class UnitError extends Error {
  readonly code: UnitErrorCode
  constructor(code: UnitErrorCode) {
    super(code)
    this.name = "UnitError"
    this.code = code
  }
}

/** A dwelling as the field link, the printed sheet and the address sheet show it. Never a name. */
export interface UnitView {
  id: string
  label: string
  /** Electors of the current list registered at this dwelling. */
  registered: number
  /** Latest feedback on this dwelling (cancellations aside), null when none. */
  lastVisit: { visitDate: string; contact: "obtenu" | "absent" | null; toRevisit: boolean; nonRegistered: boolean } | null
}

/**
 * The unit a feedback points to: an existing one of the address, or a new one created with the id the client chose
 * (offline on a phone) and its label. A label already known at the address gives back the existing unit, so two
 * volunteers adding "2e gauche" make one dwelling.
 */
export function resolveUnit(
  ctx: AppContext,
  addressId: string,
  id: string | null | undefined,
  label: string | null | undefined,
  source: DwellingUnitSource,
): string | null {
  if (!id && !label) return null
  if (id) {
    const known = ctx.db.select({ addressId: dwellingUnits.addressId }).from(dwellingUnits).where(eq(dwellingUnits.id, id)).get()
    if (known) {
      if (known.addressId !== addressId) throw new UnitError("unit_other_address")
      return id
    }
  }
  const cleaned = label ? cleanUnitLabel(label) : null
  if (cleaned === null) throw new UnitError(id ? "unit_not_found" : "unit_label_required")
  return addUnit(ctx, { id: id ?? crypto.randomUUID(), addressId, label: cleaned, source })
}

/** Adds a unit, or returns the one of the address with the same label (revived when it had been removed). */
export function addUnit(ctx: AppContext, unit: { id: string; addressId: string; label: string; source: DwellingUnitSource }): string {
  const labelKey = unitLabelKey(unit.label)
  const same = ctx.db
    .select({ id: dwellingUnits.id, retiredAt: dwellingUnits.retiredAt })
    .from(dwellingUnits)
    .where(and(eq(dwellingUnits.addressId, unit.addressId), eq(dwellingUnits.labelKey, labelKey)))
    .get()
  if (same) {
    if (same.retiredAt !== null) ctx.db.update(dwellingUnits).set({ retiredAt: null }).where(eq(dwellingUnits.id, same.id)).run()
    return same.id
  }
  ctx.db
    .insert(dwellingUnits)
    .values({ ...unit, labelKey, createdAt: ctx.now().getTime() })
    .run()
  return unit.id
}

/** Renames or removes a unit of an address (administrator). */
export function updateUnit(ctx: AppContext, addressId: string, id: string, patch: { label?: string; retired?: boolean }): void {
  const unit = ctx.db.select().from(dwellingUnits).where(eq(dwellingUnits.id, id)).get()
  if (!unit) throw new UnitError("unit_not_found")
  if (unit.addressId !== addressId) throw new UnitError("unit_other_address")
  const label = patch.label === undefined ? undefined : cleanUnitLabel(patch.label)
  if (label === null) throw new UnitError("unit_label_required")
  ctx.db
    .update(dwellingUnits)
    .set({
      ...(label !== undefined ? { label, labelKey: unitLabelKey(label) } : {}),
      ...(patch.retired !== undefined ? { retiredAt: patch.retired ? ctx.now().getTime() : null } : {}),
    })
    .where(eq(dwellingUnits.id, id))
    .run()
}

/**
 * Units of the current electoral list: each registration whose complements locate a dwelling points to the unit of
 * that label, created when missing. Idempotent; run after every import and at start-up.
 */
export function syncListUnits(ctx: AppContext): { units: number; registrations: number } {
  const importId = currentRepImportId(ctx.db)
  if (importId === null) return { units: 0, registrations: 0 }
  const rows = ctx.db
    .select({
      id: registrations.id,
      addressId: registrations.addressId,
      c1: registrations.rawComplement1,
      c2: registrations.rawComplement2,
      unitId: registrations.dwellingUnitId,
    })
    .from(registrations)
    .where(and(eq(registrations.importId, importId), isNotNull(registrations.addressId)))
    .all()
  const units = new Set<string>()
  let linked = 0
  ctx.db.transaction(() => {
    for (const r of rows) {
      if (r.addressId === null) continue
      const label = unitLabelFromComplements(r.c1, r.c2)
      if (label === null) continue
      const unitId = addUnit(ctx, { id: listUnitId(r.addressId, unitLabelKey(label)), addressId: r.addressId, label, source: "liste" })
      units.add(unitId)
      if (r.unitId !== unitId) {
        ctx.db.update(registrations).set({ dwellingUnitId: unitId }).where(eq(registrations.id, r.id)).run()
      }
      linked++
    }
  })
  return { units: units.size, registrations: linked }
}

/** Units of the addresses (removed ones aside), with their registered electors and latest feedback. */
export function unitsByAddress(ctx: AppContext, addressIds: readonly string[]): Map<string, UnitView[]> {
  const out = new Map<string, UnitView[]>()
  if (addressIds.length === 0) return out
  const units = ctx.db
    .select({ id: dwellingUnits.id, addressId: dwellingUnits.addressId, label: dwellingUnits.label })
    .from(dwellingUnits)
    .where(and(inArray(dwellingUnits.addressId, [...addressIds]), isNull(dwellingUnits.retiredAt)))
    .all()
  if (units.length === 0) return out
  const ids = units.map((u) => u.id)
  const registered = new Map<string, Set<string>>()
  const importId = currentRepImportId(ctx.db)
  if (importId !== null) {
    const regs = ctx.db
      .select({ unitId: registrations.dwellingUnitId, electorId: registrations.electorId })
      .from(registrations)
      .where(and(eq(registrations.importId, importId), inArray(registrations.dwellingUnitId, ids)))
      .all()
    for (const r of regs) {
      if (r.unitId === null) continue
      const set = registered.get(r.unitId) ?? new Set()
      set.add(r.electorId)
      registered.set(r.unitId, set)
    }
  }
  const latest = new Map<string, UnitView["lastVisit"] & { recordedAt: number }>()
  const unitVisits = ctx.db
    .select({
      unitId: visits.dwellingUnitId,
      visitDate: visits.visitDate,
      recordedAt: visits.recordedAt,
      contact: visits.contact,
      toRevisit: visits.toRevisit,
      nonRegistered: visits.nonRegistered,
    })
    .from(visits)
    // In SQL a null qualification is not "different from annulation": both cases are spelled out.
    .where(and(inArray(visits.dwellingUnitId, ids), or(isNull(visits.qualification), ne(visits.qualification, "annulation"))))
    .all()
  for (const v of unitVisits) {
    if (v.unitId === null) continue
    const prev = latest.get(v.unitId)
    if (!prev || v.visitDate > prev.visitDate || (v.visitDate === prev.visitDate && v.recordedAt > prev.recordedAt)) {
      latest.set(v.unitId, { visitDate: v.visitDate, contact: v.contact, toRevisit: v.toRevisit, nonRegistered: v.nonRegistered, recordedAt: v.recordedAt })
    }
  }
  const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" })
  for (const u of units.sort((a, b) => collator.compare(a.label, b.label))) {
    const last = latest.get(u.id)
    const list = out.get(u.addressId) ?? []
    list.push({
      id: u.id,
      label: u.label,
      registered: registered.get(u.id)?.size ?? 0,
      lastVisit: last ? { visitDate: last.visitDate, contact: last.contact, toRevisit: last.toRevisit, nonRegistered: last.nonRegistered } : null,
    })
    out.set(u.addressId, list)
  }
  return out
}
