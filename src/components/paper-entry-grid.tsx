import { Check, Plus, Trash2 } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { CONTACTS, QUALIFICATIONS, QUALITIES, SCOPES, type Option } from "@/lib/feedback-options"
import { createDebouncedSaver, type DebouncedSaver } from "@/hooks/use-debounced-save"
import { deleteVisit, updateVisit, type SheetUnit } from "@/lib/carte-api"
import { reenterSheet, type ItinerarySheet, type ItineraryVisits } from "@/lib/itineraires-api"
import { formatDate } from "@/lib/utils"
import {
  initialRows,
  isComplete,
  isDirty,
  newRow,
  patchOf,
  toFeedback,
  type PaperRowState as Row,
} from "@/lib/paper-rows"

// Paper re-entry grid (U13, R19, F3): the doors in the order of the printed sheet, one row per feedback with the R18
// choices as quick toggles. The feedbacks already recorded through the itinerary (field link or an earlier
// re-entry) come first and stay editable: a change is sent as a correction, "Supprimer" removes one entered by
// mistake. Each row is saved on its own as soon as it is complete (no save button), with an id generated here so
// a resend never duplicates.

const SAVE_DELAY_MS = 1200

const SOURCE_LABELS: Record<NonNullable<Row["origin"]>["source"], string> = {
  lien: "Lien terrain",
  feuille: "Feuille",
  admin: "Saisie directe",
}

function Toggle({ pressed, disabled, onClick, children }: { pressed: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-default",
        pressed ? "border-foreground bg-foreground text-background" : "border-input bg-background hover:bg-muted",
        disabled && !pressed && "opacity-50",
      )}
    >
      {children}
    </button>
  )
}

function Choices<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string
  options: Option<T>[]
  value: T | null
  disabled: boolean
  onChange: (v: T | null) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <Toggle key={o.value} pressed={value === o.value} disabled={disabled} onClick={() => onChange(value === o.value ? null : o.value)}>
          {o.label}
        </Toggle>
      ))}
    </div>
  )
}

interface PaperEntryGridProps {
  itineraryId: string
  sheet: ItinerarySheet
  /** Feedbacks already recorded through the itinerary, loaded once when the screen opens. */
  existing: ItineraryVisits
  /** Session date (ISO), entered once at the top, for the new rows. */
  visitDate: string
  /** Called once a first new row is saved, so the date can no longer drift between rows. */
  onFirstSave?: () => void
  /** Called after any change on the server, so the map and the sheets refresh. */
  onChanged?: () => void
}

export function PaperEntryGrid({ itineraryId, sheet, existing, visitDate, onFirstSave, onChanged }: PaperEntryGridProps) {
  const [rows, setRows] = useState<Row[]>(() =>
    initialRows(
      sheet.doors.map((d) => d.addressId),
      existing.visits,
      existing.namesShown,
    ),
  )
  // One debounced saver per row waiting to be sent, with the row version it last scheduled.
  const savers = useRef(new Map<string, { version: number; saver: DebouncedSaver<Row> }>())
  const dateRef = useRef(visitDate)
  useEffect(() => {
    dateRef.current = visitDate
  }, [visitDate])

  const update = (id: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch, version: r.version + 1 } : r)))

  async function save(row: Row) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "saving" } : r)))
    const feedback = toFeedback(row)
    try {
      let possibleDuplicate = row.possibleDuplicate
      if (row.stored === null) {
        const { results } = await reenterSheet(itineraryId, dateRef.current, [feedback])
        possibleDuplicate = results.find((x) => x.id === row.id)?.possibleDuplicate ?? false
        onFirstSave?.()
      } else {
        const patch = patchOf(row.stored, feedback, row.textsMasked)
        if (Object.keys(patch).length > 0) {
          const saved = await updateVisit(row.id, patch)
          row = { ...row, origin: row.origin && { ...row.origin, correctedAt: saved.correctedAt } }
        }
      }
      // A later edit keeps its own version, so the row is sent again (as a correction) once this save is done.
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? { ...r, status: "idle", stored: feedback, savedVersion: row.version, possibleDuplicate, origin: row.origin ?? r.origin }
            : r,
        ),
      )
      onChanged?.()
    } catch {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "error" } : r)))
    }
  }
  // The savers call the latest save (it reads the latest date through a ref).
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  async function remove(row: Row) {
    savers.current.get(row.id)?.saver.cancel()
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "saving" } : r)))
    try {
      await deleteVisit(row.id)
      setRows((prev) => {
        const next = prev.filter((r) => r.id !== row.id)
        // The door goes back to a blank line, as on a sheet not yet re-entered.
        if (next.some((r) => r.addressId === row.addressId)) return next
        const at = prev.findIndex((r) => r.id === row.id)
        next.splice(at, 0, newRow(row.addressId))
        return next
      })
      onChanged?.()
    } catch {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "error" } : r)))
    }
  }

  // Debounced save of each complete row with unsent edits: an edit restarts the delay of that row only.
  useEffect(() => {
    const pending = savers.current
    const live = new Set<string>()
    for (const row of rows) {
      if (row.status === "saving" || !isDirty(row) || !isComplete(row)) continue
      live.add(row.id)
      let entry = pending.get(row.id)
      if (entry?.version === row.version) continue
      if (!entry) {
        entry = { version: row.version, saver: createDebouncedSaver<Row>({ delayMs: SAVE_DELAY_MS, save: (r) => saveRef.current(r) }) }
        pending.set(row.id, entry)
      }
      entry.version = row.version
      entry.saver.schedule(row)
    }
    // A row no longer complete, or being sent: nothing waits for it any more.
    for (const [id, entry] of pending) {
      if (live.has(id)) continue
      if (rows.find((r) => r.id === id)?.status !== "saving") entry.saver.cancel()
      pending.delete(id)
    }
  }, [rows])

  // Leaving the screen or the page sends the rows still waiting (saves are idempotent by row id).
  useEffect(() => {
    const pending = savers.current
    const flushAll = () => {
      for (const entry of pending.values()) entry.saver.flush()
    }
    window.addEventListener("pagehide", flushAll)
    return () => {
      window.removeEventListener("pagehide", flushAll)
      flushAll()
      pending.clear()
    }
  }, [])

  function addLine(addressId: string) {
    setRows((prev) => {
      const last = prev.map((r) => r.addressId).lastIndexOf(addressId)
      const next = [...prev]
      next.splice(last + 1, 0, newRow(addressId))
      return next
    })
  }

  return (
    <ol className="space-y-3" aria-label="Portes de la feuille">
      {sheet.doors.map((door) => (
        <li key={door.addressId} className="rounded-md border p-3" data-testid="paper-door">
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-semibold tabular-nums">{door.number}.</span>
            <span className="text-sm font-medium">{door.label}</span>
            {door.dwellings !== null && (
              <span className="text-xs text-muted-foreground">
                {door.dwellings} {door.dwellings > 1 ? "logements" : "logement"}
              </span>
            )}
          </div>
          <div className="space-y-2">
            {rows
              .filter((r) => r.addressId === door.addressId)
              .map((r) => (
                <PaperRow
                  key={r.id}
                  row={r}
                  units={door.units}
                  onChange={(patch) => update(r.id, patch)}
                  onRetry={() => void save(r)}
                  onDelete={() => void remove(r)}
                />
              ))}
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-1 gap-1" onClick={() => addLine(door.addressId)}>
            <Plus className="h-4 w-4" />
            Ajouter une ligne
          </Button>
        </li>
      ))}
    </ol>
  )
}

function PaperRow({
  row,
  units,
  onChange,
  onRetry,
  onDelete,
}: {
  row: Row
  units: SheetUnit[]
  onChange: (patch: Partial<Row>) => void
  onRetry: () => void
  onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const busy = row.status === "saving"
  const persisted = row.stored !== null
  const textsLocked = busy || row.textsMasked
  const textPlaceholder = (label: string) => (row.textsMasked ? `${label} : masqué (mode anonyme)` : `${label} (facultatif)`)
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2" data-testid="paper-row">
      {row.origin && (
        <p className="text-xs text-muted-foreground" data-testid="paper-row-origin">
          {SOURCE_LABELS[row.origin.source]}, visite du {formatDate(row.origin.visitDate)}
          {row.origin.correctedAt !== null && ", corrigé"}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Choices label="Contact" options={CONTACTS} value={row.contact} disabled={busy} onChange={(contact) => onChange({ contact })} />
        <Choices
          label="Qualité du contact"
          options={QUALITIES}
          value={row.quality}
          disabled={busy || row.contact !== "obtenu"}
          onChange={(quality) => onChange({ quality })}
        />
        <div role="group" aria-label="Suivi" className="flex flex-wrap gap-1">
          <Toggle pressed={row.toAccompany} disabled={busy} onClick={() => onChange({ toAccompany: !row.toAccompany })}>
            À accompagner
          </Toggle>
          <Toggle pressed={row.toRevisit} disabled={busy} onClick={() => onChange({ toRevisit: !row.toRevisit })}>
            À revenir
          </Toggle>
          <Toggle pressed={row.nonRegistered} disabled={busy} onClick={() => onChange({ nonRegistered: !row.nonRegistered })}>
            Foyer non inscrit
          </Toggle>
        </div>
        <Choices
          label="Qualification de l'adresse"
          options={QUALIFICATIONS}
          value={row.qualification}
          disabled={busy}
          onChange={(qualification) => onChange({ qualification })}
        />
        {row.qualification && (
          <Choices label="Portée" options={SCOPES} value={row.scope} disabled={busy} onChange={(scope) => onChange({ scope: scope ?? "logement" })} />
        )}
      </div>
      {units.length > 0 && (
        <select
          aria-label="Logement de l'immeuble"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm sm:w-80"
          value={row.unitId ?? ""}
          disabled={busy}
          onChange={(e) => onChange({ unitId: e.currentTarget.value === "" ? null : e.currentTarget.value })}
        >
          <option value="">Toute l'adresse, sans logement précis</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
      )}
      <div className="grid gap-2 sm:grid-cols-[14rem_1fr]">
        <Input
          aria-label="Logement"
          placeholder={textPlaceholder("Logement")}
          value={row.dwelling}
          disabled={textsLocked}
          maxLength={200}
          onChange={(e) => onChange({ dwelling: e.currentTarget.value })}
        />
        <Input
          aria-label="Remarques"
          placeholder={textPlaceholder("Remarques")}
          value={row.remarks}
          disabled={textsLocked}
          maxLength={2000}
          onChange={(e) => onChange({ remarks: e.currentTarget.value })}
        />
      </div>
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs">
        <div aria-live="polite">
          {row.status === "error" ? (
            <span className="text-destructive">
              L'enregistrement a échoué.{" "}
              <button type="button" className="underline" onClick={onRetry}>
                Réessayer
              </button>
            </span>
          ) : !isComplete(row) ? (
            <span className="text-muted-foreground">
              {persisted ? "Choisissez le contact ou la qualification, ou supprimez ce retour." : "Choisissez le contact ou la qualification."}
            </span>
          ) : busy || isDirty(row) ? (
            <span className="text-muted-foreground">Enregistrement…</span>
          ) : (
            <span className="inline-flex items-center gap-1 font-medium" data-testid="paper-row-saved">
              <Check className="h-3.5 w-3.5" />
              Enregistré
            </span>
          )}
          {persisted && row.possibleDuplicate && (
            <span className="ml-2 text-amber-700" data-testid="paper-row-duplicate">
              Doublon possible : un retour du téléphone et un de la feuille portent sur la même porte le même jour.
            </span>
          )}
        </div>
        {persisted &&
          (confirming ? (
            <span className="inline-flex items-center gap-2">
              <span>Supprimer ce retour ?</span>
              <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onDelete}>
                Supprimer
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Garder
              </Button>
            </span>
          ) : (
            <Button type="button" size="sm" variant="ghost" className="gap-1" disabled={busy} onClick={() => setConfirming(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Supprimer le retour
            </Button>
          ))}
      </div>
    </div>
  )
}
