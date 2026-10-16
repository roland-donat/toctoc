import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Copy, Printer, X } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { RouteMap } from "@/components/route-map"
import {
  ArchiveSessionButton,
  DeleteSessionButton,
  EndSessionButton,
  linkStateShort,
  SessionHistoryButton,
  SessionProgress,
} from "@/components/session-controls"
import { SessionFeedback } from "@/components/session-feedback"
import { useDebouncedSave } from "@/hooks/use-debounced-save"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api-client"
import { Input } from "@/components/ui/input"
import { CATEGORY_COLORS, CATEGORY_LABELS, fetchMap, mapKey } from "@/lib/carte-api"
import {
  addItineraryDoor,
  createFieldLink,
  fetchFieldLink,
  fieldLinkKey,
  revokeFieldLink,
  fetchSessionSummary,
  sessionSummaryKey,
  sessionTitle,
  updateSession,
  type SessionSummary,
  setItineraryShowNames,
  type FieldLinkView,
  fetchItinerary,
  formatDuration,
  generationKey,
  itineraryErrorMessage,
  itineraryKey,
  removeItineraryDoor,
  type DoorSummary,
  type GenerateResult,
  type ItineraryDetail,
} from "@/lib/itineraires-api"

// Page of a session TocToc (15/10/2026): its itinerary and field link, and its feedback. Not nested under /sessions
// (the trailing underscore): the list screen has no outlet.
export const Route = createFileRoute("/_admin/sessions_/$id")({
  validateSearch: (search: Record<string, unknown>): { onglet?: "retours" } => (search.onglet === "retours" ? { onglet: "retours" } : {}),
  component: SessionPage,
})

const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" })

function SessionPage() {
  const { id } = Route.useParams()
  const { onglet } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const itinerary = useQuery({ queryKey: itineraryKey(id), queryFn: () => fetchItinerary(id) })
  const summary = useQuery({ queryKey: sessionSummaryKey(id), queryFn: () => fetchSessionSummary(id) })
  // Only present right after "Calculer": the selection report is not stored on the server.
  const generation = useQuery<GenerateResult | null>({
    queryKey: generationKey(id),
    queryFn: () => null,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const others = useQuery({ queryKey: mapKey({}), queryFn: () => fetchMap({}) })

  const onSaved = (detail: ItineraryDetail) => {
    queryClient.setQueryData(itineraryKey(id), detail)
    void queryClient.invalidateQueries({ queryKey: ["itineraires"] })
  }
  const remove = useMutation({ mutationFn: (addressId: string) => removeItineraryDoor(id, addressId), onSuccess: onSaved })
  const add = useMutation({ mutationFn: (addressId: string) => addItineraryDoor(id, addressId), onSuccess: onSaved })
  const busy = remove.isPending || add.isPending
  const failure = remove.error ?? add.error
  const errorCode = failure instanceof ApiError ? failure.code : failure ? "error" : null

  if (itinerary.isError) {
    const code = itinerary.error instanceof ApiError ? itinerary.error.code : "error"
    return <p className="px-4 py-8 text-sm text-destructive">{itineraryErrorMessage(code)}</p>
  }
  const it = itinerary.data
  const session = summary.data
  if (!it || !session) return <p className="px-4 py-8 text-sm text-muted-foreground">Chargement…</p>
  const readOnly = session.archivedAt !== null
  // An ended session keeps its feedback open, its itinerary and link frozen.
  const ended = session.endedAt !== null

  const durationSeconds = it.durationMinutes * 60
  const over = it.totalSeconds > durationSeconds
  const numberedOthers = (others.data?.addresses ?? []).filter((a) => !a.id.startsWith("street:"))

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <Link to="/sessions" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Sessions TocToc
        </Link>
        <SessionName key={session.id} session={session} readOnly={readOnly} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <SessionProgress done={session.doorsDone} total={session.doorCount} />
          <span>
            Créée le {DATE_FORMAT.format(new Date(it.createdAt))} · {it.zoneLabel} · {session.feedbackCount}{" "}
            {session.feedbackCount > 1 ? "retours" : "retour"} · {linkStateShort(session.link)}
          </span>
        </div>
        {ended && !readOnly && (
          <p className="rounded-md border p-2 text-sm" data-testid="session-ended">
            Session terminée le {DATE_FORMAT.format(new Date(session.endedAt ?? 0))} : lien fermé, itinéraire figé. La feuille papier se
            ressaisit encore dans l'onglet Retours.
          </p>
        )}
        {readOnly && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="session-archived">
            Session archivée le {DATE_FORMAT.format(new Date(session.archivedAt ?? 0))} : consultation seule, lien terrain fermé.
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button asChild variant="outline" size="sm" className="gap-1">
            <Link to="/sessions/$id/feuille" params={{ id }}>
              <Printer className="h-4 w-4" />
              Imprimer la feuille
            </Link>
          </Button>
          <EndSessionButton session={session} />
          <ArchiveSessionButton session={session} />
          <DeleteSessionButton session={session} onDeleted={() => void navigate({ to: "/sessions" })} />
          <SessionHistoryButton session={session} />
        </div>
      </header>

      <nav aria-label="Session" className="flex gap-1 border-b">
        {(
          [
            [undefined, "Itinéraire"],
            ["retours", `Retours (${session.feedbackCount})`],
          ] as const
        ).map(([tab, label]) => (
          <Link
            key={label}
            to="/sessions/$id"
            params={{ id }}
            search={tab ? { onglet: tab } : {}}
            aria-current={onglet === tab ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-semibold",
              onglet === tab ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      {onglet === "retours" ? (
        <SessionFeedback id={id} readOnly={readOnly} />
      ) : (
        <ItineraryTab
          id={id}
          it={it}
          readOnly={readOnly}
          ended={ended}
          busy={busy}
          errorCode={errorCode}
          over={over}
          durationSeconds={durationSeconds}
          others={numberedOthers}
          generation={generation.data ?? null}
          onRemove={(a) => remove.mutate(a)}
          onAdd={(a) => add.mutate(a)}
        />
      )}
    </main>
  )
}

/** Itinerary of the session: total time, field link, map and visit order, doors added or taken out by hand. */
function ItineraryTab({
  id,
  it,
  readOnly,
  ended,
  busy,
  errorCode,
  over,
  durationSeconds,
  others,
  generation,
  onRemove,
  onAdd,
}: {
  id: string
  it: ItineraryDetail
  readOnly: boolean
  ended: boolean
  busy: boolean
  errorCode: string | null
  over: boolean
  durationSeconds: number
  others: Parameters<typeof RouteMap>[0]["others"]
  generation: GenerateResult | null
  onRemove: (addressId: string) => void
  onAdd: (addressId: string) => void
}) {
  return (
    <>
      <p className={`text-sm ${over ? "text-destructive" : ""}`} data-testid="itinerary-total">
        {it.doors.length} {it.doors.length > 1 ? "portes" : "porte"} · temps total {formatDuration(it.totalSeconds)} sur{" "}
        {formatDuration(durationSeconds)} (marche {formatDuration(it.walkSeconds + it.returnWalkSeconds)}, portes{" "}
        {formatDuration(it.serviceSeconds)}){over && " : la durée prévue est dépassée."}
      </p>

      <FieldLinkPanel id={id} readOnly={readOnly} ended={ended} />

      {errorCode && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {itineraryErrorMessage(errorCode)}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <div className="h-[60vh] min-h-[360px] overflow-hidden rounded-md border" data-testid="route-map">
          <RouteMap itinerary={it} others={readOnly || ended ? [] : others} busy={busy || readOnly || ended} onRemove={onRemove} onAdd={onAdd} />
        </div>
        <section aria-label="Portes dans l'ordre de visite" className="space-y-2">
          <h2 className="font-medium">Ordre de visite</h2>
          <p className="text-xs text-muted-foreground">
            Départ et retour au point D.{!readOnly && !ended && " Pour ajouter une porte, cliquez sur un point de la carte ; l'ordre de visite est recalculé."}
          </p>
          <ol className="space-y-2">
            {it.doors.map((d, i) => (
              <li key={d.addressId} className="flex items-start gap-3 rounded-md border p-2" data-testid="itinerary-door">
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                  style={{ background: CATEGORY_COLORS[d.category] }}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">{d.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {CATEGORY_LABELS[d.category]} · {d.registeredCount} {d.registeredCount > 1 ? "inscrits" : "inscrit"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Arrivée à {formatDuration(d.arrivalSeconds)} · {formatDuration(d.walkSecondsFromPrevious)} de marche ·{" "}
                    {formatDuration(d.serviceSeconds)} sur place
                  </p>
                  {d.manual && (
                    <Badge variant="outline" className="mt-1">
                      Ajoutée à la main
                    </Badge>
                  )}
                </div>
                {!readOnly && !ended && (
                  <Button size="icon" variant="ghost" aria-label={`Retirer ${d.label}`} disabled={busy} onClick={() => onRemove(d.addressId)}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">Retour au départ : {formatDuration(it.returnWalkSeconds)} de marche.</p>
        </section>
      </div>

      {generation && <SelectionReport result={generation} />}
    </>
  )
}

/** Name of the session, saved as typed (no "Enregistrer" button); its creation date while it has none. */
function SessionName({ session, readOnly }: { session: SessionSummary; readOnly: boolean }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(session.name ?? "")
  const autosave = useDebouncedSave(async (value: string) => {
    await updateSession(session.id, { name: value.trim() === "" ? null : value })
    void queryClient.invalidateQueries({ queryKey: ["itineraires"] })
  }, 600)
  if (readOnly) return <h1 className="page-title">{sessionTitle(session)}</h1>
  return (
    <div className="space-y-1">
      <h1 className="sr-only">{sessionTitle(session)}</h1>
      <Input
        aria-label="Nom de la session"
        value={name}
        maxLength={120}
        placeholder={sessionTitle({ name: null, createdAt: session.createdAt })}
        className="h-auto max-w-2xl border-transparent bg-transparent px-1 py-1 font-display text-2xl font-black tracking-tight text-primary uppercase shadow-none placeholder:text-primary/70 hover:border-input focus-visible:border-input md:text-2xl"
        onChange={(e) => {
          setName(e.target.value)
          autosave.schedule(e.target.value)
        }}
      />
    </div>
  )
}

const DAY_FORMAT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" })
const GRACE_MS = 12 * 3600 * 1000

function linkStateText(link: NonNullable<FieldLinkView["link"]>): string {
  switch (link.state) {
    case "actif":
      return "Lien actif, sans limite de durée : il sert jusqu'à la fin de la session ou jusqu'à sa révocation."
    case "grace":
      return `Lien fermé avec la session : les retours restés en attente sur les téléphones sont encore acceptés jusqu'au ${DAY_FORMAT.format(new Date((link.expiresAt ?? 0) + GRACE_MS))}.`
    case "expire":
      return "Lien fermé avec la session."
    case "revoque":
      return "Lien révoqué."
  }
}

/** Field link of the itinerary (U12): issue, copy once, revoke, names toggle. Each action is saved at once. */
function FieldLinkPanel({ id, readOnly, ended }: { id: string; readOnly: boolean; ended: boolean }) {
  const queryClient = useQueryClient()
  const info = useQuery({ queryKey: fieldLinkKey(id), queryFn: () => fetchFieldLink(id) })
  // Address just issued, shown at once; afterwards the server gives it back while the link serves.
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null)
  const onSaved = (view: FieldLinkView) => queryClient.setQueryData(fieldLinkKey(id), view)
  const create = useMutation({
    mutationFn: () => createFieldLink(id),
    onSuccess: ({ url: issued, ...view }) => {
      setIssuedUrl(issued)
      onSaved(view)
    },
  })
  const revoke = useMutation({
    mutationFn: () => revokeFieldLink(id),
    onSuccess: (view) => {
      setIssuedUrl(null)
      onSaved(view)
    },
  })
  const names = useMutation({ mutationFn: (show: boolean) => setItineraryShowNames(id, show), onSuccess: onSaved })
  const busy = create.isPending || revoke.isPending || names.isPending
  const view = info.data
  const live = view?.link && (view.link.state === "actif" || view.link.state === "grace")
  const url = view?.link?.url ?? (live ? issuedUrl : null)
  const frozen = readOnly || ended

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Lien copié.")
    } catch {
      toast.error("Copie impossible : sélectionnez le lien et copiez-le à la main.")
    }
  }

  return (
    <section aria-labelledby="field-link" className="space-y-3 rounded-md border p-4" data-testid="field-link-panel">
      <h2 id="field-link" className="font-medium">
        Lien terrain
      </h2>
      {view && (
        <p className="text-sm" data-testid="field-link-state">
          {view.link ? linkStateText(view.link) : "Aucun lien n'a encore été créé pour cette session."}
        </p>
      )}
      {url && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Lien à envoyer au binôme. Il reste affiché ici tant qu'il sert.</p>
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label="Lien terrain" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" className="gap-1" onClick={() => void copy(url)}>
              <Copy className="h-4 w-4" />
              Copier
            </Button>
          </div>
        </div>
      )}
      {view?.link && live && !url && (
        <p className="text-sm text-muted-foreground">Ce lien a été créé avant qu'ils restent affichés : recréez-le pour pouvoir le copier.</p>
      )}
      {ended && !readOnly && <p className="text-sm text-muted-foreground">Session terminée : rouvrez-la pour créer un nouveau lien.</p>}
      <div className={cn("flex flex-wrap gap-2", frozen && "hidden")}>
        <Button type="button" disabled={busy} onClick={() => create.mutate()}>
          {view?.link ? "Créer un nouveau lien terrain" : "Créer le lien terrain"}
        </Button>
        {live && (
          <Button type="button" variant="destructive" disabled={busy} onClick={() => revoke.mutate()}>
            Révoquer
          </Button>
        )}
      </div>
      {view?.link && (
        <p className="text-xs text-muted-foreground">Un nouveau lien remplace le précédent, qui cesse aussitôt de fonctionner.</p>
      )}
      {view && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={view.showNames}
              disabled={busy || frozen || !view.namesAvailable}
              onChange={(e) => names.mutate(e.currentTarget.checked)}
            />
            Afficher les noms sur le lien
          </label>
          {!view.namesAvailable && (
            <p className="text-xs text-muted-foreground">
              L'interrupteur d'anonymisation est sur « anonyme » dans les Paramètres : aucun nom n'est affiché, sur aucun lien.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Le lieu de naissance n'apparaît jamais sur le lien.</p>
        </div>
      )}
      {(create.isError || revoke.isError || names.isError) && (
        <p role="alert" className="text-sm text-destructive">
          L'opération sur le lien a échoué.
        </p>
      )}
    </section>
  )
}

const SHOWN = 15

function DoorList({ doors }: { doors: DoorSummary[] }) {
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {doors.slice(0, SHOWN).map((d) => (
        <li key={d.addressId} className="flex justify-between gap-2">
          <span>{d.label}</span>
          <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[d.category]}</span>
        </li>
      ))}
      {doors.length > SHOWN && <li className="text-xs text-muted-foreground">et {doors.length - SHOWN} autres</li>}
    </ul>
  )
}

function SelectionReport({ result }: { result: GenerateResult }) {
  return (
    <section aria-label="Portes écartées" className="grid gap-4 md:grid-cols-2">
      {result.truncatedCount > 0 && (
        <p className="text-sm text-muted-foreground md:col-span-2">
          Zone très riche : seules les {result.candidateCount - result.truncatedCount} meilleures portes sur {result.candidateCount} ont
          été étudiées.
        </p>
      )}
      <div className="rounded-md border p-3">
        <h2 className="font-medium">Écartées faute de temps ({result.leftOut.length})</h2>
        {result.leftOut.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Toutes les portes retenues tiennent dans la durée.</p>
        ) : (
          <DoorList doors={result.leftOut} />
        )}
      </div>
      {result.droppedByCap.length > 0 && (
        <div className="rounded-md border p-3">
          <h2 className="font-medium">Sans inscrit au-delà du plafond de 30 % ({result.droppedByCap.length})</h2>
          <DoorList doors={result.droppedByCap} />
        </div>
      )}
    </section>
  )
}
