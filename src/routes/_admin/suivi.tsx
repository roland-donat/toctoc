import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { useState } from "react"
import { PaperEntryGrid } from "@/components/paper-entry-grid"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError } from "@/lib/api-client"
import { parisDateTimeFormat, parisToday } from "@/lib/format"
import {
  fetchItineraries,
  fetchItinerarySheet,
  fetchItineraryVisits,
  itineraryVisitsKey,
  formatDuration,
  itinerariesKey,
  itineraryErrorMessage,
  sheetKey,
} from "@/lib/itineraires-api"

// Visit follow-up (U13, R19, F3): the itineraries, and the re-entry of the feedback noted on a printed sheet.
export const Route = createFileRoute("/_admin/suivi")({
  validateSearch: (search: Record<string, unknown>): { itineraire?: string } =>
    typeof search.itineraire === "string" && search.itineraire !== "" ? { itineraire: search.itineraire } : {},
  component: SuiviPage,
})

function SuiviPage() {
  const { itineraire } = Route.useSearch()
  return itineraire ? <Reentry id={itineraire} /> : <ItineraryList />
}

function ItineraryList() {
  const list = useQuery({ queryKey: itinerariesKey, queryFn: fetchItineraries })
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <h1 className="page-title">Suivi des visites</h1>
      <p className="text-sm text-muted-foreground">
        Ressaisissez ici les retours notés sur une feuille imprimée, à la date de la session, et corrigez ou supprimez les
        retours déjà enregistrés pour un itinéraire, par le lien terrain comme par la feuille.
      </p>
      {list.isError && <p className="text-sm text-destructive">Impossible de charger les itinéraires.</p>}
      {list.data && list.data.itineraries.length === 0 && <p className="text-sm text-muted-foreground">Aucun itinéraire pour l'instant.</p>}
      {list.data && list.data.itineraries.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 font-medium">Date</th>
              <th className="py-2 font-medium">Zone</th>
              <th className="py-2 font-medium">Durée</th>
              <th className="py-2 text-right font-medium">Portes</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {list.data.itineraries.map((it) => (
              <tr key={it.id} className="border-b last:border-0" data-testid="suivi-itinerary">
                <td className="py-2">
                  <Link to="/itineraires/$id" params={{ id: it.id }} className="underline-offset-4 hover:underline">
                    {parisDateTimeFormat.format(new Date(it.createdAt))}
                  </Link>
                </td>
                <td className="py-2">{it.zoneLabel}</td>
                <td className="py-2">{formatDuration(it.durationMinutes * 60)}</td>
                <td className="py-2 text-right tabular-nums">{it.doorCount}</td>
                <td className="py-2 text-right">
                  <Button asChild size="sm" variant="outline">
                    <Link to="/suivi" search={{ itineraire: it.id }}>
                      Ressaisir ou corriger
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

function Reentry({ id }: { id: string }) {
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
    <main className="mx-auto max-w-6xl space-y-4 px-4 py-8">
      <header className="space-y-2">
        <Link to="/suivi" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Suivi
        </Link>
        <h1 className="page-title">Retours de l'itinéraire</h1>
        <p className="text-sm text-muted-foreground">
          Itinéraire du {parisDateTimeFormat.format(new Date(data.createdAt))} · {data.zoneLabel} · {data.doors.length}{" "}
          {data.doors.length > 1 ? "portes" : "porte"}. Chaque ligne s'enregistre dès que le contact ou la qualification est choisi.
          Les retours déjà enregistrés pour cet itinéraire sont repris en tête de chaque porte : toute modification est
          enregistrée comme une correction, et « Supprimer le retour » efface celui saisi par erreur.
        </p>
      </header>
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
      {validDate ? (
        <PaperEntryGrid
          itineraryId={id}
          sheet={data}
          existing={recorded}
          visitDate={visitDate}
          onFirstSave={() => setDateLocked(true)}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ["carte"] })
            void queryClient.invalidateQueries({ queryKey: ["adresses"] })
          }}
        />
      ) : (
        <p className="text-sm text-destructive">Saisissez la date de la session.</p>
      )}
    </main>
  )
}
