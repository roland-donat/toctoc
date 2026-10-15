import type { SheetVisit, VisitPatch } from "./carte-api"
import type { Contact, Qualification, Quality, Scope } from "./feedback-options"
import type { PaperFeedback } from "./itineraires-api"

// Rows of the re-entry grid (U13, R19, F3): a new paper feedback, or a feedback already recorded through the
// itinerary (field link or sheet) that the administrator corrects or removes. Pure logic, kept apart from the screen.

export interface RowOrigin {
  source: SheetVisit["source"]
  visitDate: string
  correctedAt: number | null
}

export interface PaperRowState {
  id: string
  addressId: string
  contact: Contact | null
  quality: Quality | null
  toAccompany: boolean
  toRevisit: boolean
  qualification: Qualification | null
  scope: Scope
  dwelling: string
  remarks: string
  /** Fields as last stored on the server; null until the first save. Later edits are sent as corrections. */
  stored: PaperFeedback | null
  /** Set for a feedback loaded from the server. */
  origin: RowOrigin | null
  /** Dwelling and remarks hidden by the anonymous mode: shown empty, never sent back. */
  textsMasked: boolean
  status: "idle" | "saving" | "error"
  possibleDuplicate: boolean
  /** Bumped on each edit, so the pending save restarts. */
  version: number
  /** Version last stored on the server (-1: never). */
  savedVersion: number
}

export function newRow(addressId: string): PaperRowState {
  return {
    id: crypto.randomUUID(),
    addressId,
    contact: null,
    quality: null,
    toAccompany: false,
    toRevisit: false,
    qualification: null,
    scope: "logement",
    dwelling: "",
    remarks: "",
    stored: null,
    origin: null,
    textsMasked: false,
    status: "idle",
    possibleDuplicate: false,
    version: 0,
    savedVersion: -1,
  }
}

/** Complete as soon as the contact or the address qualification is known, as on the field form. */
export function isComplete(r: PaperRowState): boolean {
  return r.contact !== null || r.qualification !== null
}

/** Something typed since the last save is still to be sent. */
export function isDirty(r: PaperRowState): boolean {
  return r.version !== r.savedVersion
}

export function toFeedback(r: PaperRowState): PaperFeedback {
  return {
    id: r.id,
    addressId: r.addressId,
    dwelling: r.dwelling.trim() === "" ? null : r.dwelling.trim(),
    contact: r.contact,
    contactQuality: r.contact === "obtenu" ? r.quality : null,
    toAccompany: r.toAccompany,
    toRevisit: r.toRevisit,
    qualification: r.qualification,
    qualificationScope: r.qualification ? r.scope : null,
    remarks: r.remarks.trim() === "" ? null : r.remarks.trim(),
  }
}

const PATCH_FIELDS = [
  "dwelling",
  "contact",
  "contactQuality",
  "toAccompany",
  "toRevisit",
  "qualification",
  "qualificationScope",
  "remarks",
] as const satisfies readonly (keyof PaperFeedback & keyof VisitPatch)[]

/** Fields that changed since the stored version; masked texts are never part of it. */
export function patchOf(stored: PaperFeedback, current: PaperFeedback, textsMasked: boolean): VisitPatch {
  const patch: Record<string, unknown> = {}
  for (const field of PATCH_FIELDS) {
    if (textsMasked && (field === "dwelling" || field === "remarks")) continue
    if (stored[field] !== current[field]) patch[field] = current[field]
  }
  return patch as VisitPatch
}

/** Row of a feedback already on the server. A cancellation row is not a feedback of the sheet: callers skip it. */
export function rowFromVisit(v: SheetVisit, namesShown: boolean): PaperRowState {
  const qualification = v.qualification === "annulation" ? null : v.qualification
  const row: PaperRowState = {
    ...newRow(v.addressId),
    id: v.id,
    contact: v.contact,
    quality: v.contactQuality,
    toAccompany: v.toAccompany,
    toRevisit: v.toRevisit,
    qualification,
    scope: v.qualificationScope ?? "logement",
    dwelling: v.dwelling ?? "",
    remarks: v.remarks ?? "",
    origin: { source: v.source, visitDate: v.visitDate, correctedAt: v.correctedAt },
    textsMasked: !namesShown,
    savedVersion: 0,
  }
  return { ...row, stored: toFeedback(row) }
}

/**
 * Initial rows of the grid: the feedbacks already recorded on each door, in entry order, and a blank line on the
 * doors that have none. A paper feedback and a phone feedback on the same door and date are flagged as possible
 * duplicates.
 */
export function initialRows(doorIds: readonly string[], visits: readonly SheetVisit[], namesShown: boolean): PaperRowState[] {
  const kept = visits.filter((v) => v.qualification !== "annulation")
  const phoneDays = new Set(kept.filter((v) => v.source === "lien").map((v) => `${v.addressId}|${v.visitDate}`))
  const paperDays = new Set(kept.filter((v) => v.source === "feuille").map((v) => `${v.addressId}|${v.visitDate}`))
  return doorIds.flatMap((addressId) => {
    const rows = kept
      .filter((v) => v.addressId === addressId)
      .map((v) => {
        const day = `${v.addressId}|${v.visitDate}`
        const other = v.source === "lien" ? paperDays : v.source === "feuille" ? phoneDays : null
        return { ...rowFromVisit(v, namesShown), possibleDuplicate: other?.has(day) ?? false }
      })
    return rows.length > 0 ? rows : [newRow(addressId)]
  })
}
