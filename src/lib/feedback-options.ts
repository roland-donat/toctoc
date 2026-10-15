import type { FeedbackEntry } from "./feedback-queue"

// The R18 choices of a feedback, shared by the field form, the paper re-entry grid and the printable sheet.
// Each screen keeps its own look; only the values and their French labels live here.

export type Contact = NonNullable<FeedbackEntry["contact"]>
export type Quality = NonNullable<FeedbackEntry["contactQuality"]>
/** Field qualification of an address; the administrator's "annulation" is not one of them. */
export type Qualification = NonNullable<FeedbackEntry["qualification"]>
export type Scope = NonNullable<FeedbackEntry["qualificationScope"]>

export interface Option<T extends string> {
  value: T
  label: string
}

export const CONTACT_LABELS: Record<Contact, string> = { obtenu: "Contact obtenu", absent: "Absent" }
export const QUALITY_LABELS: Record<Quality, string> = { chaleureux: "Chaleureux", poli: "Poli", ferme: "Fermé" }
export const QUALIFICATION_LABELS: Record<Qualification, string> = {
  non_habitation: "Pas une habitation",
  logement_vide: "Logement vide",
  residence_secondaire: "Résidence secondaire",
}
const SCOPE_LABELS: Record<Scope, string> = { logement: "Ce logement", immeuble: "Tout l'immeuble" }

const options = <T extends string>(values: readonly T[], labels: Record<T, string>): Option<T>[] =>
  values.map((value) => ({ value, label: labels[value] }))

export const CONTACTS = options<Contact>(["obtenu", "absent"], CONTACT_LABELS)
export const QUALITIES = options<Quality>(["chaleureux", "poli", "ferme"], QUALITY_LABELS)
export const QUALIFICATIONS = options<Qualification>(["non_habitation", "logement_vide", "residence_secondaire"], QUALIFICATION_LABELS)
export const SCOPES = options<Scope>(["logement", "immeuble"], SCOPE_LABELS)
