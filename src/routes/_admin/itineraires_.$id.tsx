import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeft, ClipboardPen, Copy, Printer, X } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { RouteMap } from "@/components/route-map"
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
  setItineraryShowNames,
  type FieldLinkView,
  fetchItinerary,
  formatDuration,
  generationKey,
  itinerariesKey,
  itineraryErrorMessage,
  itineraryKey,
  removeItineraryDoor,
  type DoorSummary,
  type GenerateResult,
  type ItineraryDetail,
} from "@/lib/itineraires-api"

// Not nested under /itineraires (the trailing underscore): the list screen has no outlet.
export const Route = createFileRoute("/_admin/itineraires_/$id")({
  component: ItineraryPage,
})

const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" })

function ItineraryPage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const itinerary = useQuery({ queryKey: itineraryKey(id), queryFn: () => fetchItinerary(id) })
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
    void queryClient.invalidateQueries({ queryKey: itinerariesKey, exact: true })
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
  if (!it) return <p className="px-4 py-8 text-sm text-muted-foreground">Chargement…</p>

  const durationSeconds = it.durationMinutes * 60
  const over = it.totalSeconds > durationSeconds
  const numberedOthers = (others.data?.addresses ?? []).filter((a) => !a.id.startsWith("street:"))

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <Link to="/itineraires" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Itinéraires
        </Link>
        <h1 className="page-title">Itinéraire du {DATE_FORMAT.format(new Date(it.createdAt))}</h1>
        <p className="text-sm text-muted-foreground">
          {it.zoneLabel} · {it.doors.length} {it.doors.length > 1 ? "portes" : "porte"}
        </p>
        <p className={`text-sm ${over ? "text-destructive" : ""}`} data-testid="itinerary-total">
          Temps total {formatDuration(it.totalSeconds)} sur {formatDuration(durationSeconds)} (marche{" "}
          {formatDuration(it.walkSeconds + it.returnWalkSeconds)}, portes {formatDuration(it.serviceSeconds)})
          {over && " : la durée prévue est dépassée."}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button asChild variant="outline" size="sm" className="gap-1">
            <Link to="/itineraires/$id/feuille" params={{ id }}>
              <Printer className="h-4 w-4" />
              Imprimer la feuille
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="gap-1">
            <Link to="/suivi" search={{ itineraire: id }}>
              <ClipboardPen className="h-4 w-4" />
              Ressaisir ou corriger les retours
            </Link>
          </Button>
        </div>
      </header>

      <FieldLinkPanel id={id} />

      {errorCode && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {itineraryErrorMessage(errorCode)}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <div className="h-[60vh] min-h-[360px] overflow-hidden rounded-md border" data-testid="route-map">
          <RouteMap itinerary={it} others={numberedOthers} busy={busy} onRemove={(a) => remove.mutate(a)} onAdd={(a) => add.mutate(a)} />
        </div>
        <section aria-label="Portes dans l'ordre de visite" className="space-y-2">
          <h2 className="font-medium">Ordre de visite</h2>
          <p className="text-xs text-muted-foreground">
            Départ et retour au point D. Pour ajouter une porte, cliquez sur un point de la carte.
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
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Retirer ${d.label}`}
                  disabled={busy}
                  onClick={() => remove.mutate(d.addressId)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">Retour au départ : {formatDuration(it.returnWalkSeconds)} de marche.</p>
        </section>
      </div>

      {generation.data && <SelectionReport result={generation.data} />}
    </main>
  )
}

const DAY_FORMAT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" })
const GRACE_MS = 12 * 3600 * 1000

function linkStateText(link: NonNullable<FieldLinkView["link"]>): string {
  switch (link.state) {
    case "actif":
      return `Lien actif jusqu'au ${DAY_FORMAT.format(new Date(link.expiresAt))}.`
    case "grace":
      return `Lien expiré, en délai de grâce : les retours sont encore acceptés jusqu'au ${DAY_FORMAT.format(new Date(link.expiresAt + GRACE_MS))}.`
    case "expire":
      return "Lien expiré."
    case "revoque":
      return "Lien révoqué."
  }
}

/** Field link of the itinerary (U12): issue, copy once, revoke, names toggle. Each action is saved at once. */
function FieldLinkPanel({ id }: { id: string }) {
  const queryClient = useQueryClient()
  const info = useQuery({ queryKey: fieldLinkKey(id), queryFn: () => fetchFieldLink(id) })
  // The URL holds the token: kept in this component only, gone once the page is left.
  const [url, setUrl] = useState<string | null>(null)
  const onSaved = (view: FieldLinkView) => queryClient.setQueryData(fieldLinkKey(id), view)
  const create = useMutation({
    mutationFn: () => createFieldLink(id),
    onSuccess: ({ url: issued, ...view }) => {
      setUrl(issued)
      onSaved(view)
    },
  })
  const revoke = useMutation({
    mutationFn: () => revokeFieldLink(id),
    onSuccess: (view) => {
      setUrl(null)
      onSaved(view)
    },
  })
  const names = useMutation({ mutationFn: (show: boolean) => setItineraryShowNames(id, show), onSuccess: onSaved })
  const busy = create.isPending || revoke.isPending || names.isPending
  const view = info.data
  const live = view?.link && (view.link.state === "actif" || view.link.state === "grace")

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
          {view.link ? linkStateText(view.link) : "Aucun lien n'a encore été créé pour cet itinéraire."}
        </p>
      )}
      {url && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Copiez ce lien maintenant et envoyez-le au binôme : il ne sera plus affiché ensuite.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label="Lien terrain" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" className="gap-1" onClick={() => void copy(url)}>
              <Copy className="h-4 w-4" />
              Copier
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
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
              disabled={busy || !view.namesAvailable}
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
