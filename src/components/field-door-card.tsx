import { Check, Pencil, Plus, Trash2 } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  CONTACT_LABELS,
  CONTACTS,
  QUALIFICATION_LABELS,
  QUALIFICATIONS,
  QUALITIES,
  QUALITY_LABELS,
  SCOPES,
  type Contact,
  type Option,
  type Qualification,
  type Quality,
  type Scope,
} from "@/lib/feedback-options"
import type { FeedbackEntry, QueueItem } from "@/lib/feedback-queue"
import { parisCalendarDate, parisLongDateFormat } from "@/lib/format"
import type { AgeBand } from "@/lib/carte-api"
import type { FieldDoor, FieldUnit } from "@/lib/terrain-api"

// One door of the field loop (U12): address, dwellings, age bands, cheat sheets, last passage, and the R18
// feedback form with large single-tap choices. A building door takes several feedbacks.

const BAND_LABELS: Record<AgeBand, string> = {
  "18-25": "18-25 ans",
  "26-40": "26-40 ans",
  "41-60": "41-60 ans",
  "61+": "61 ans et plus",
}

/** Queue state of an entered feedback; "acknowledged" once it has left the queue. */
const QUEUE_STATUS: Record<QueueItem["status"] | "acknowledged", { label: string; className: string }> = {
  refused: { label: "Non transmis, à reporter sur la feuille", className: "text-red-700" },
  pending: { label: "En attente", className: "text-amber-800" },
  acknowledged: { label: "Transmis", className: "text-emerald-800" },
}

/** Long French date of an ISO day, anchored at noon UTC so the Paris day never shifts. */
function formatLongDate(iso: string): string {
  return parisLongDateFormat.format(new Date(`${iso}T12:00:00Z`))
}

/** Large toggle: one tap selects, a second tap clears. At least 44 px high. */
function Choice({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "min-h-12 flex-1 rounded-lg border-2 px-3 py-2 text-base font-semibold transition-colors",
        pressed ? "border-primary bg-primary text-white" : "border-slate-400 bg-white text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function ChoiceRow<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string
  options: Option<T>[]
  value: T | null
  onChange: (v: T | null) => void
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-slate-700">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Choice key={o.value} pressed={value === o.value} onClick={() => onChange(value === o.value ? null : o.value)}>
            {o.label}
          </Choice>
        ))}
      </div>
    </fieldset>
  )
}

/** Choice of the dwelling in the form: none (the building as a whole), a known unit, or a new one. */
const NO_UNIT = ""
const NEW_UNIT = "nouveau"

/** Units of the door: those of the server, plus those added on this phone during the session. */
export function knownUnits(door: FieldDoor, entered: FeedbackEntry[]): FieldUnit[] {
  const units = [...door.units]
  for (const e of entered) {
    if (e.dwellingUnitId && e.dwellingUnitLabel && !units.some((u) => u.id === e.dwellingUnitId)) {
      units.push({ id: e.dwellingUnitId, label: e.dwellingUnitLabel, registered: 0, lastVisit: null })
    }
  }
  return units
}

/** What is known of a unit: the feedback entered this session, else the latest one on the server. */
function unitOutcome(unit: FieldUnit, entered: FeedbackEntry[]): { state: "jamais" | "fait" | "a_revoir"; text: string } {
  const mine = [...entered].reverse().find((e) => e.dwellingUnitId === unit.id)
  const last = mine
    ? { contact: mine.contact, toRevisit: mine.toRevisit, nonRegistered: mine.nonRegistered ?? false, visitDate: mine.visitDate }
    : unit.lastVisit
  if (!last) return { state: "jamais", text: unit.registered > 0 ? `${unit.registered} inscrit${unit.registered > 1 ? "s" : ""}, jamais visité` : "Jamais visité" }
  const outcome = [
    last.contact === "obtenu" ? "contact" : last.contact === "absent" ? "absent" : "qualifié",
    last.toRevisit ? "à revenir" : null,
    last.nonRegistered ? "non inscrit" : null,
  ].filter((p): p is string => p !== null)
  return { state: last.toRevisit ? "a_revoir" : "fait", text: `${mine ? "Aujourd'hui" : `Le ${formatLongDate(last.visitDate)}`} : ${outcome.join(", ")}` }
}

function feedbackSummary(e: FeedbackEntry, units: FieldUnit[]): string {
  const unit = e.dwellingUnitId ? (units.find((u) => u.id === e.dwellingUnitId)?.label ?? e.dwellingUnitLabel) : null
  const parts = [
    e.contact ? CONTACT_LABELS[e.contact].toLowerCase() : null,
    e.contactQuality ? QUALITY_LABELS[e.contactQuality].toLowerCase() : null,
    e.toAccompany ? "à accompagner" : null,
    e.toRevisit ? "à revenir" : null,
    e.qualification ? QUALIFICATION_LABELS[e.qualification].toLowerCase() : null,
    e.nonRegistered ? "foyer non inscrit" : null,
  ].filter((p): p is string => p !== null)
  const where = [unit, e.dwelling].filter((p): p is string => typeof p === "string" && p !== "").join(", ")
  return `${where ? `${where} : ` : ""}${parts.join(", ") || "retour"}`
}

interface FeedbackFormProps {
  addressId: string
  /** Dwellings to choose from. */
  units: FieldUnit[]
  /** Dwelling chosen before opening the form: a unit id, NEW_UNIT, or none. */
  presetUnit?: string
  /** Feedback being corrected: the form starts from it and keeps its id and visit date. */
  initial?: FeedbackEntry
  onSubmit: (entry: FeedbackEntry) => void
  onCancel?: () => void
}

function FeedbackForm({ addressId, units, presetUnit, initial, onSubmit, onCancel }: FeedbackFormProps) {
  const [contact, setContact] = useState<Contact | null>(initial?.contact ?? null)
  const [quality, setQuality] = useState<Quality | null>(initial?.contactQuality ?? null)
  const [toAccompany, setToAccompany] = useState(initial?.toAccompany ?? false)
  const [toRevisit, setToRevisit] = useState(initial?.toRevisit ?? false)
  const [qualification, setQualification] = useState<Qualification | null>(initial?.qualification ?? null)
  const [scope, setScope] = useState<Scope>(initial?.qualificationScope ?? "logement")
  const [dwelling, setDwelling] = useState(initial?.dwelling ?? "")
  const [unitChoice, setUnitChoice] = useState<string>(initial?.dwellingUnitId ?? presetUnit ?? NO_UNIT)
  const [newLabel, setNewLabel] = useState("")
  const [nonRegistered, setNonRegistered] = useState(initial?.nonRegistered ?? false)
  // A correction moves a feedback to another known dwelling, it never creates one.
  const canAddUnit = initial === undefined
  const [remarks, setRemarks] = useState(initial?.remarks ?? "")
  const ready = (contact !== null || qualification !== null) && (unitChoice !== NEW_UNIT || newLabel.trim() !== "")

  function submit() {
    const isNew = unitChoice === NEW_UNIT
    const unitId = isNew ? crypto.randomUUID() : unitChoice === NO_UNIT ? null : unitChoice
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      addressId,
      dwelling: dwelling.trim() === "" ? null : dwelling.trim(),
      dwellingUnitId: unitId,
      dwellingUnitLabel: isNew ? newLabel.trim().slice(0, 60) : (initial?.dwellingUnitLabel ?? null),
      nonRegistered,
      contact,
      contactQuality: contact === "obtenu" ? quality : null,
      toAccompany,
      toRevisit,
      qualification,
      qualificationScope: qualification ? scope : null,
      remarks: remarks.trim() === "" ? null : remarks.trim(),
      visitDate: initial?.visitDate ?? parisCalendarDate(new Date()),
    })
  }

  return (
    <form
      className="space-y-4 rounded-lg bg-slate-50 p-3"
      aria-label={initial ? "Corriger un retour" : "Saisir un retour"}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) submit()
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-semibold text-slate-700">Logement</span>
        <select
          value={unitChoice}
          onChange={(e) => setUnitChoice(e.currentTarget.value)}
          className="min-h-12 w-full rounded-lg border-2 border-slate-400 bg-white px-3 text-base"
        >
          <option value={NO_UNIT}>Toute l'adresse, sans logement précis</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
          {canAddUnit && <option value={NEW_UNIT}>Autre logement, à ajouter…</option>}
        </select>
      </label>
      {unitChoice === NEW_UNIT && (
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Nouveau logement</span>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.currentTarget.value)}
            placeholder="Bâtiment, étage, porte (jamais de nom)"
            maxLength={60}
            autoFocus
            className="min-h-12 w-full rounded-lg border-2 border-slate-400 bg-white px-3 text-base"
          />
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-semibold text-slate-700">Précision (facultatif)</span>
        <input
          value={dwelling}
          onChange={(e) => setDwelling(e.currentTarget.value)}
          placeholder="Nom sur la boîte, repère"
          maxLength={200}
          className="min-h-12 w-full rounded-lg border-2 border-slate-400 bg-white px-3 text-base"
        />
      </label>
      <ChoiceRow legend="Contact" options={CONTACTS} value={contact} onChange={setContact} />
      {contact === "obtenu" && <ChoiceRow legend="Qualité de l'accueil" options={QUALITIES} value={quality} onChange={setQuality} />}
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-slate-700">Suite à donner</legend>
        <div className="flex flex-wrap gap-2">
          <Choice pressed={toAccompany} onClick={() => setToAccompany(!toAccompany)}>
            Personne à accompagner vers l'inscription
          </Choice>
          <Choice pressed={toRevisit} onClick={() => setToRevisit(!toRevisit)}>
            À revenir
          </Choice>
          <Choice pressed={nonRegistered} onClick={() => setNonRegistered(!nonRegistered)}>
            Foyer non inscrit sur les listes
          </Choice>
        </div>
      </fieldset>
      <ChoiceRow legend="Qualification de l'adresse" options={QUALIFICATIONS} value={qualification} onChange={setQualification} />
      {qualification && (
        <ChoiceRow legend="Portée" options={SCOPES} value={scope} onChange={(v) => setScope(v ?? "logement")} />
      )}
      <label className="block space-y-1">
        <span className="text-sm font-semibold text-slate-700">Remarques (facultatif)</span>
        <textarea
          value={remarks}
          onChange={(e) => setRemarks(e.currentTarget.value)}
          maxLength={2000}
          rows={3}
          className="w-full rounded-lg border-2 border-slate-400 bg-white px-3 py-2 text-base"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready} className="min-h-12 flex-1 text-base">
          {initial ? "Enregistrer la correction" : "Envoyer le retour"}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" className="min-h-12 text-base" onClick={onCancel}>
            Annuler
          </Button>
        )}
      </div>
      {!ready && (
        <p className="text-sm text-slate-600">
          {unitChoice === NEW_UNIT && newLabel.trim() === ""
            ? "Indiquez le nouveau logement (bâtiment, étage, porte)."
            : "Choisissez au moins le contact ou une qualification."}
        </p>
      )}
    </form>
  )
}

function voterName(v: FieldDoor["voters"][number]): string {
  return [v.usageName ?? v.birthName, v.firstNames].filter((p): p is string => typeof p === "string" && p !== "").join(" ")
}

/** Dwellings of a building: what each has had, a feedback from one tap, and a new dwelling met on the spot. */
function UnitsPanel({
  units,
  total,
  entered,
  canEnter,
  onOpen,
}: {
  units: FieldUnit[]
  total: number
  entered: FeedbackEntry[]
  canEnter: boolean
  onOpen: (unit: string) => void
}) {
  const outcomes = units.map((u) => ({ unit: u, ...unitOutcome(u, entered) }))
  const visited = outcomes.filter((o) => o.state !== "jamais").length
  return (
    <section aria-label="Logements" className="space-y-2 rounded-lg border border-slate-300 p-3" data-testid="field-units">
      <h3 className="text-base font-semibold" data-testid="field-units-progress">
        Logements : {visited} visité{visited > 1 ? "s" : ""} sur {total}
      </h3>
      {units.length > 0 && (
        <ul className="space-y-1">
          {outcomes.map(({ unit, state, text }) => (
            <li key={unit.id} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className={cn("size-2.5 shrink-0 rounded-full", { fait: "bg-emerald-700", a_revoir: "bg-amber-600", jamais: "bg-slate-400" }[state])}
              />
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{unit.label}</span>
                <span className="block text-slate-700">{text}</span>
              </span>
              {canEnter && (
                <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => onOpen(unit.id)}>
                  Retour
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEnter && (
        <Button type="button" variant="outline" className="min-h-12 w-full gap-2 text-base" onClick={() => onOpen(NEW_UNIT)}>
          <Plus className="size-5" />
          Ajouter un logement
        </Button>
      )}
    </section>
  )
}

export interface FieldDoorCardProps {
  door: FieldDoor
  index: number
  /** Feedback entered on this door during this session, oldest first. */
  entered: FeedbackEntry[]
  /** Queue state of those feedbacks, by id (absent: acknowledged). */
  queueState: Map<string, QueueItem["status"]>
  /** False once the link is over: the form is hidden, only the paper sheet remains. */
  canEnter: boolean
  onSubmit: (entry: FeedbackEntry) => void
  /** Correction of a feedback entered on this door (same id). */
  onCorrect: (entry: FeedbackEntry) => void
  /** Removal of a feedback entered on this door by mistake. */
  onRemove: (entry: FeedbackEntry) => void
}

export function FieldDoorCard({ door, index, entered, queueState, canEnter, onSubmit, onCorrect, onRemove }: FieldDoorCardProps) {
  const done = door.done || entered.length > 0
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [presetUnit, setPresetUnit] = useState<string | undefined>(undefined)
  const editedEntry = entered.find((e) => e.id === editing)
  const units = knownUnits(door, entered)
  // A building lists its dwellings: the form opens from one of them, or from "Ajouter un logement".
  const building = units.length > 0 || (door.dwellings ?? 0) > 1
  const showForm = canEnter && !editedEntry && (formOpen || (entered.length === 0 && !building))
  const openFor = (unit: string | undefined) => {
    setPresetUnit(unit)
    setFormOpen(true)
  }

  return (
    <article
      id={`porte-${door.addressId}`}
      aria-label={`${index + 1}. ${door.label}`}
      data-testid="field-door"
      className={cn("space-y-3 rounded-xl border-2 bg-white p-4 text-foreground", done ? "border-emerald-700" : "border-slate-300")}
    >
      <header className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full text-base font-bold text-white",
            done ? "bg-emerald-700" : "bg-primary",
          )}
        >
          {done ? <Check className="size-5" aria-label="Faite" /> : index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold leading-tight">{door.label}</h2>
          <p className="text-sm text-slate-700">
            {door.dwellings !== null && `${door.dwellings} ${door.dwellings > 1 ? "logements" : "logement"} · `}
            {door.ageBands.length > 0 ? door.ageBands.map((b) => BAND_LABELS[b]).join(", ") : "Aucun inscrit"}
          </p>
          <p className="text-sm text-slate-700">
            {door.lastPassage
              ? `Dernier passage le ${formatLongDate(door.lastPassage.visitDate)}${
                  door.lastPassage.contact === "obtenu" ? " : contact obtenu" : door.lastPassage.contact === "absent" ? " : absent" : ""
                }${door.lastPassage.toRevisit ? ", à revenir" : ""}${door.lastPassage.toAccompany ? ", à accompagner" : ""}`
              : "Jamais visitée"}
          </p>
        </div>
      </header>

      {door.voters.length > 0 && (
        <p className="text-sm">
          <span className="font-semibold">Inscrits : </span>
          {door.voters.map(voterName).join(", ")}
        </p>
      )}

      {door.cheatsheets.length > 0 && (
        <details className="rounded-lg border border-slate-300 p-3">
          <summary className="min-h-11 cursor-pointer content-center text-base font-semibold">Antisèches</summary>
          <div className="mt-2 space-y-3">
            {door.cheatsheets.map((s) => (
              <section key={s.id}>
                <h3 className="font-semibold">{s.title}</h3>
                <p className="whitespace-pre-line text-base">{s.body}</p>
              </section>
            ))}
          </div>
        </details>
      )}

      {building && (
        <UnitsPanel
          units={units}
          total={Math.max(door.dwellings ?? 0, units.length)}
          entered={entered}
          canEnter={canEnter && !showForm && !editedEntry}
          onOpen={openFor}
        />
      )}

      {entered.length > 0 && (
        <ul className="space-y-1" aria-label="Retours saisis">
          {entered.map((e) => {
            const status = queueState.get(e.id) ?? "acknowledged"
            const changeable = canEnter && status !== "refused" && editing === null
            return (
              <li key={e.id} className="space-y-2 rounded-md bg-muted px-3 py-2 text-sm" data-testid="field-entered">
                <div className="flex flex-wrap justify-between gap-2">
                  <span>{feedbackSummary(e, units)}</span>
                  <span className={cn("font-semibold", QUEUE_STATUS[status].className)}>{QUEUE_STATUS[status].label}</span>
                </div>
                {changeable &&
                  (confirming === e.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">Supprimer ce retour ?</span>
                      <Button
                        type="button"
                        variant="destructive"
                        className="min-h-11"
                        onClick={() => {
                          setConfirming(null)
                          onRemove(e)
                        }}
                      >
                        Supprimer
                      </Button>
                      <Button type="button" variant="outline" className="min-h-11" onClick={() => setConfirming(null)}>
                        Garder
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" className="min-h-11 flex-1 gap-1" onClick={() => setEditing(e.id)}>
                        <Pencil className="size-4" />
                        Modifier
                      </Button>
                      <Button type="button" variant="outline" className="min-h-11 flex-1 gap-1" onClick={() => setConfirming(e.id)}>
                        <Trash2 className="size-4" />
                        Supprimer
                      </Button>
                    </div>
                  ))}
              </li>
            )
          })}
        </ul>
      )}

      {canEnter && editedEntry && (
        <FeedbackForm
          key={`edit:${editedEntry.id}`}
          addressId={door.addressId}
          units={units}
          initial={editedEntry}
          onSubmit={(entry) => {
            onCorrect(entry)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {showForm ? (
        <FeedbackForm
          key={`${entered.length}:${presetUnit ?? ""}`}
          addressId={door.addressId}
          units={units}
          presetUnit={presetUnit}
          onSubmit={(entry) => {
            onSubmit(entry)
            setFormOpen(false)
            setPresetUnit(undefined)
          }}
          onCancel={entered.length > 0 || building ? () => setFormOpen(false) : undefined}
        />
      ) : (
        canEnter &&
        !editedEntry && (
          <Button type="button" variant="outline" className="min-h-12 w-full gap-2 text-base" onClick={() => openFor(undefined)}>
            <Plus className="size-5" />
            {building ? "Retour sans logement précis" : "Ajouter un retour"}
          </Button>
        )
      )}
    </article>
  )
}
