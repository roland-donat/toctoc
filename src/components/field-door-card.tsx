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
import type { FieldDoor } from "@/lib/terrain-api"

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

function feedbackSummary(e: FeedbackEntry): string {
  const parts = [
    e.contact ? CONTACT_LABELS[e.contact].toLowerCase() : null,
    e.contactQuality ? QUALITY_LABELS[e.contactQuality].toLowerCase() : null,
    e.toAccompany ? "à accompagner" : null,
    e.toRevisit ? "à revenir" : null,
    e.qualification ? QUALIFICATION_LABELS[e.qualification].toLowerCase() : null,
  ].filter((p): p is string => p !== null)
  return `${e.dwelling ? `${e.dwelling} : ` : ""}${parts.join(", ") || "retour"}`
}

interface FeedbackFormProps {
  addressId: string
  /** Feedback being corrected: the form starts from it and keeps its id and visit date. */
  initial?: FeedbackEntry
  onSubmit: (entry: FeedbackEntry) => void
  onCancel?: () => void
}

function FeedbackForm({ addressId, initial, onSubmit, onCancel }: FeedbackFormProps) {
  const [contact, setContact] = useState<Contact | null>(initial?.contact ?? null)
  const [quality, setQuality] = useState<Quality | null>(initial?.contactQuality ?? null)
  const [toAccompany, setToAccompany] = useState(initial?.toAccompany ?? false)
  const [toRevisit, setToRevisit] = useState(initial?.toRevisit ?? false)
  const [qualification, setQualification] = useState<Qualification | null>(initial?.qualification ?? null)
  const [scope, setScope] = useState<Scope>(initial?.qualificationScope ?? "logement")
  const [dwelling, setDwelling] = useState(initial?.dwelling ?? "")
  const [remarks, setRemarks] = useState(initial?.remarks ?? "")
  const ready = contact !== null || qualification !== null

  function submit() {
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      addressId,
      dwelling: dwelling.trim() === "" ? null : dwelling.trim(),
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
        <span className="text-sm font-semibold text-slate-700">Logement (facultatif)</span>
        <input
          value={dwelling}
          onChange={(e) => setDwelling(e.currentTarget.value)}
          placeholder="Appartement, étage, nom sur la boîte"
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
      {!ready && <p className="text-sm text-slate-600">Choisissez au moins le contact ou une qualification.</p>}
    </form>
  )
}

function voterName(v: FieldDoor["voters"][number]): string {
  return [v.usageName ?? v.birthName, v.firstNames].filter((p): p is string => typeof p === "string" && p !== "").join(" ")
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
  const editedEntry = entered.find((e) => e.id === editing)
  const showForm = canEnter && !editedEntry && (formOpen || entered.length === 0)

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

      {entered.length > 0 && (
        <ul className="space-y-1" aria-label="Retours saisis">
          {entered.map((e) => {
            const status = queueState.get(e.id) ?? "acknowledged"
            const changeable = canEnter && status !== "refused" && editing === null
            return (
              <li key={e.id} className="space-y-2 rounded-md bg-muted px-3 py-2 text-sm" data-testid="field-entered">
                <div className="flex flex-wrap justify-between gap-2">
                  <span>{feedbackSummary(e)}</span>
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
          key={entered.length}
          addressId={door.addressId}
          onSubmit={(entry) => {
            onSubmit(entry)
            setFormOpen(false)
          }}
          onCancel={entered.length > 0 ? () => setFormOpen(false) : undefined}
        />
      ) : (
        canEnter &&
        !editedEntry && (
          <Button type="button" variant="outline" className="min-h-12 w-full gap-2 text-base" onClick={() => setFormOpen(true)}>
            <Plus className="size-5" />
            Ajouter un retour
          </Button>
        )
      )}
    </article>
  )
}
