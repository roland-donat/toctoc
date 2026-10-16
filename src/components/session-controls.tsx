import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Flag, History, RotateCcw, Trash2 } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { parisDateTimeFormat } from "@/lib/format"
import {
  deleteSession,
  fetchSessionHistory,
  sessionHistoryKey,
  sessionTitle,
  updateSession,
  type SessionEvent,
  type SessionSummary,
} from "@/lib/itineraires-api"

// Shared pieces of the Sessions TocToc screens (15/10/2026): progress, link state, history, archive and deletion.

/** Doors done over the doors of the session, as a bar and a count. */
export function SessionProgress({ done, total }: { done: number; total: number }) {
  const ratio = total === 0 ? 0 : Math.min(1, done / total)
  return (
    <div className="flex min-w-36 items-center gap-2" data-testid="session-progress">
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label="Portes faites"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums">
        {done}/{total} portes
      </span>
    </div>
  )
}

export function linkStateShort(link: SessionSummary["link"]): string {
  if (!link) return "Aucun lien"
  switch (link.state) {
    case "actif":
      return "Lien actif"
    case "grace":
      return "Lien fermé, derniers envois acceptés"
    case "expire":
      return "Lien fermé"
    case "revoque":
      return "Lien révoqué"
  }
}

const SOURCE_LABELS: Record<SessionEvent["source"], string> = {
  admin: "administration",
  lien: "lien terrain",
  feuille: "feuille papier",
}

/** One line of history, in French: what happened, and to which door or under which name. */
export function eventText(e: SessionEvent): string {
  const door = e.detail ? ` : ${e.detail}` : ""
  switch (e.kind) {
    case "created":
      return `Session créée${e.detail ? ` (${e.detail})` : ""}`
    case "renamed":
      return e.detail ? `Renommée « ${e.detail} »` : "Nom retiré"
    case "door_added":
      return `Porte ajoutée${door}`
    case "door_removed":
      return `Porte retirée${door}`
    case "link_issued":
      return "Lien terrain créé"
    case "link_revoked":
      return "Lien terrain révoqué"
    case "names_shown":
      return "Noms affichés sur le lien"
    case "names_hidden":
      return "Noms masqués sur le lien"
    case "feedback_recorded":
      return `Retour saisi${door}`
    case "feedback_corrected":
      return `Retour corrigé${door}`
    case "feedback_deleted":
      return `Retour supprimé${door}`
    case "archived":
      return "Session archivée"
    case "restored":
      return "Session restaurée"
    case "ended":
      return "Session terminée, lien fermé"
    case "reopened":
      return "Session rouverte"
  }
}

/** History icon: opens the dated list of what changed in the session. */
export function SessionHistoryButton({ session }: { session: Pick<SessionSummary, "id" | "name" | "createdAt"> }) {
  const [open, setOpen] = useState(false)
  const history = useQuery({ queryKey: sessionHistoryKey(session.id), queryFn: () => fetchSessionHistory(session.id), enabled: open })
  return (
    <>
      <Button size="icon" variant="ghost" title="Historique" aria-label={`Historique de ${sessionTitle(session)}`} onClick={() => setOpen(true)}>
        <History className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Historique</DialogTitle>
            <DialogDescription>{sessionTitle(session)}</DialogDescription>
          </DialogHeader>
          {history.isPending && <p className="text-sm text-muted-foreground">Chargement…</p>}
          {history.isError && <p className="text-sm text-destructive">Impossible de charger l'historique.</p>}
          {history.data && history.data.events.length === 0 && (
            <p className="text-sm text-muted-foreground">Aucune modification depuis la création.</p>
          )}
          {history.data && history.data.events.length > 0 && (
            <ol className="space-y-1 text-sm" data-testid="session-history">
              {history.data.events.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-2 border-b py-1 last:border-0">
                  <span className="tabular-nums text-muted-foreground">{parisDateTimeFormat.format(new Date(e.at))}</span>
                  <span>{eventText(e)}</span>
                  <span className="text-xs text-muted-foreground">({SOURCE_LABELS[e.source]})</span>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** End (link closed, itinerary frozen) or reopen a session. */
export function EndSessionButton({ session }: { session: Pick<SessionSummary, "id" | "endedAt" | "archivedAt"> }) {
  const queryClient = useQueryClient()
  const ended = session.endedAt !== null
  const toggle = useMutation({
    mutationFn: () => updateSession(session.id, { ended: !ended }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["itineraires"] }),
  })
  if (session.archivedAt !== null) return null
  return (
    <Button size="sm" variant="outline" className="gap-1" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
      {ended ? <RotateCcw className="h-4 w-4" /> : <Flag className="h-4 w-4" />}
      {ended ? "Rouvrir" : "Terminer la session"}
    </Button>
  )
}

/** Archive or restore; the lists and the session read again. */
export function ArchiveSessionButton({ session, onDone }: { session: Pick<SessionSummary, "id" | "archivedAt">; onDone?: () => void }) {
  const queryClient = useQueryClient()
  const archived = session.archivedAt !== null
  const toggle = useMutation({
    mutationFn: () => updateSession(session.id, { archived: !archived }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["itineraires"] }).then(() => onDone?.()),
  })
  return (
    <Button size="sm" variant="outline" className="gap-1" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
      {archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
      {archived ? "Restaurer" : "Archiver"}
    </Button>
  )
}

/** Deletion after confirmation; deleting the feedback of the session too is ticked by default. */
export function DeleteSessionButton({
  session,
  onDeleted,
}: {
  session: Pick<SessionSummary, "id" | "name" | "createdAt" | "feedbackCount">
  onDeleted?: () => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [withFeedback, setWithFeedback] = useState(true)
  const remove = useMutation({
    mutationFn: () => deleteSession(session.id, withFeedback),
    onSuccess: () => {
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["itineraires"] })
      void queryClient.invalidateQueries({ queryKey: ["carte"] })
      void queryClient.invalidateQueries({ queryKey: ["adresses"] })
      onDeleted?.()
    },
  })
  return (
    <>
      <Button size="sm" variant="outline" className="gap-1 text-destructive" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" />
        Supprimer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer la session ?</DialogTitle>
            <DialogDescription>
              {sessionTitle(session)} : son itinéraire, son lien terrain et son historique seront supprimés. Cette action est
              définitive.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={withFeedback} onChange={(e) => setWithFeedback(e.currentTarget.checked)} />
            <span>
              Supprimer aussi les retours de la session ({session.feedbackCount}).
              <span className="block text-xs text-muted-foreground">
                Décoché, les retours restent sur les adresses : la carte garde les portes faites.
              </span>
            </span>
          </label>
          {remove.isError && <p className="text-sm text-destructive">La suppression a échoué.</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Supprimer la session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
