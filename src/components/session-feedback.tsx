import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { PaperEntryGrid } from "@/components/paper-entry-grid"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError } from "@/lib/api-client"
import type { SheetVisit } from "@/lib/carte-api"
import { QUALIFICATION_LABELS } from "@/lib/feedback-options"
import { parisToday } from "@/lib/format"
import { formatDate } from "@/lib/utils"
import { fetchItinerarySheet, fetchItineraryVisits, itineraryErrorMessage, itineraryVisitsKey, sheetKey } from "@/lib/itineraires-api"

/** Feedback of a session: those already recorded (phone, sheet), corrected or removed, and the re-entry of the paper sheet. */
export function SessionFeedback({ id, readOnly }: { id: string; readOnly: boolean }) {
  const queryClient = useQueryClient()
  const sheet = useQuery({ queryKey: sheetKey(id), queryFn: () => fetchItinerarySheet(id) })
  // Read once per opening and never from the cache: the grid starts from it and then keeps its own state.
  const existing = useQuery({ queryKey: itineraryVisitsKey(id), queryFn: () => fetchItineraryVisits(id), gcTime: 0 })
  const [visitDate, setVisitDate] = useState(parisToday)
  // The session date is fixed by the first saved row, so all rows of the sheet share it.
  const [dateLocked, setDateLocked] = useState(false)

  const failure = sheet.error ?? existing.error
  if (failure) {
    const code = failure instanceof ApiError ? failure.code : "error"
    return <p className="px-4 py-8 text-sm text-destructive">{itineraryErrorMessage(code)}</p>
  }
  const data = sheet.data
  const recorded = existing.data
  if (!data || !recorded) return <p className="px-4 py-8 text-sm text-muted-foreground">Chargement…</p>

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(visitDate)
  return (
    <section aria-label="Retours de la session" className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Chaque ligne s'enregistre dès que le contact ou la qualification est choisi. Les retours déjà enregistrés pour cette
        session, par le lien terrain comme par la feuille, sont repris en tête de chaque porte : toute modification est
        enregistrée comme une correction, et « Supprimer le retour » efface celui saisi par erreur.
      </p>
      {readOnly && (
        <>
          <p className="rounded-md border p-2 text-sm">Session archivée : consultation seule. Restaurez-la pour saisir ou corriger.</p>
          <RecordedList doors={data.doors} visits={recorded.visits} />
        </>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="session-date">Date de la session</Label>
          <Input
            id="session-date"
            type="date"
            className="w-44"
            value={visitDate}
            disabled={dateLocked}
            onChange={(e) => setVisitDate(e.currentTarget.value)}
          />
        </div>
        {dateLocked && <p className="pb-2 text-xs text-muted-foreground">La date est fixée par le premier retour enregistré.</p>}
      </div>
      {readOnly ? null : validDate ? (
        <PaperEntryGrid
          itineraryId={id}
          sheet={data}
          existing={recorded}
          visitDate={visitDate}
          onFirstSave={() => setDateLocked(true)}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ["carte"] })
            // Progress and history of the session change with its feedback.
            void queryClient.invalidateQueries({ queryKey: ["itineraires", id, "resume"] })
            void queryClient.invalidateQueries({ queryKey: ["itineraires", id, "historique"] })
            void queryClient.invalidateQueries({ queryKey: ["adresses"] })
          }}
        />
      ) : (
        <p className="text-sm text-destructive">Saisissez la date de la session.</p>
      )}
    </section>
  )
}

/** Read-only list of the feedback of an archived session, door by door. */
function RecordedList({ doors, visits }: { doors: { addressId: string; number: number; label: string }[]; visits: SheetVisit[] }) {
  const kept = visits.filter((v) => v.qualification !== "annulation")
  if (kept.length === 0) return <p className="text-sm text-muted-foreground">Aucun retour pour cette session.</p>
  return (
    <ol className="space-y-1 text-sm" data-testid="session-recorded">
      {doors.flatMap((d) =>
        kept
          .filter((v) => v.addressId === d.addressId)
          .map((v) => (
            <li key={v.id} className="flex flex-wrap gap-x-2 border-b py-1 last:border-0">
              <span className="tabular-nums text-muted-foreground">{formatDate(v.visitDate)}</span>
              <span className="font-medium">
                {d.number}. {d.label}
              </span>
              <span>
                {[
                  v.contact === "obtenu" ? "contact obtenu" : v.contact === "absent" ? "absent" : null,
                  v.toRevisit ? "à revenir" : null,
                  v.toAccompany ? "à accompagner" : null,
                  v.nonRegistered ? "foyer non inscrit" : null,
                  v.qualification && v.qualification !== "annulation" ? QUALIFICATION_LABELS[v.qualification].toLowerCase() : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </li>
          )),
      )}
    </ol>
  )
}
