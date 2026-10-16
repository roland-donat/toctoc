import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { EMPTY_ZONE, ZoneDrawMap, type ZoneDrawValue } from "@/components/zone-draw"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api-client"
import { fetchMap, fetchMapOptions, mapKey, mapOptionsKey } from "@/lib/carte-api"
import {
  DURATION_LABELS,
  DURATIONS,
  generateItinerary,
  generationKey,
  itineraryErrorMessage,
  itineraryKey,
  type DurationMinutes,
  type GenerateInput,
} from "@/lib/itineraires-api"

type ZoneMode = "polygon" | "bureau"

/** Creation of a session: zone (drawn or bureau), start point, duration; the itinerary is computed on the server. */
export function NewSession({ onCancel }: { onCancel: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [mode, setMode] = useState<ZoneMode>("polygon")
  const [bureau, setBureau] = useState("")
  const [draw, setDraw] = useState<ZoneDrawValue>(EMPTY_ZONE)
  const [duration, setDuration] = useState<DurationMinutes>(60)
  const options = useQuery({ queryKey: mapOptionsKey, queryFn: fetchMapOptions })
  const doors = useQuery({ queryKey: mapKey({}), queryFn: () => fetchMap({}) })
  const bureauDoors = useQuery({
    queryKey: mapKey({ bureau }),
    queryFn: () => fetchMap({ bureau }),
    enabled: mode === "bureau" && bureau !== "",
  })
  const highlighted = useMemo(
    () => (mode === "bureau" && bureauDoors.data ? new Set(bureauDoors.data.addresses.map((a) => a.id)) : undefined),
    [mode, bureauDoors.data],
  )

  const generate = useMutation({
    mutationFn: (input: GenerateInput) => generateItinerary(input),
    onSuccess: (result) => {
      queryClient.setQueryData(itineraryKey(result.itinerary.id), result.itinerary)
      queryClient.setQueryData(generationKey(result.itinerary.id), result)
      void queryClient.invalidateQueries({ queryKey: ["itineraires"] })
      void navigate({ to: "/sessions/$id", params: { id: result.itinerary.id } })
    },
  })

  const zoneReady = mode === "polygon" ? draw.closed : bureau !== ""
  const calculate = () => {
    if (!zoneReady) return
    generate.mutate({
      zone: mode === "polygon" ? { type: "polygon", points: draw.points } : { type: "bureau", bureau },
      start: draw.start,
      durationMinutes: duration,
    })
  }
  const errorCode = generate.error instanceof ApiError ? generate.error.code : generate.error ? "error" : null

  const instruction =
    mode === "polygon"
      ? !draw.closed
        ? "Cliquez sur la carte pour placer les sommets de la zone, puis double-cliquez ou utilisez « Fermer la zone »."
        : "Cliquez sur la carte pour placer le point de départ (par défaut, le centre de la zone)."
      : "Cliquez sur la carte pour placer le point de départ (par défaut, le centre des portes du bureau)."

  return (
    <section aria-label="Nouvelle session" className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-4">
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Zone</legend>
          <div className="flex gap-1">
            <Button size="sm" variant={mode === "polygon" ? "default" : "outline"} aria-pressed={mode === "polygon"} onClick={() => setMode("polygon")}>
              Tracer une zone
            </Button>
            <Button size="sm" variant={mode === "bureau" ? "default" : "outline"} aria-pressed={mode === "bureau"} onClick={() => setMode("bureau")}>
              Choisir un bureau
            </Button>
          </div>
        </fieldset>
        {mode === "bureau" && (
          <label className="space-y-1 text-sm">
            <span className="block font-medium">Bureau</span>
            <select
              className="h-8 rounded-md border bg-background px-2"
              value={bureau}
              onChange={(e) => setBureau(e.target.value)}
            >
              <option value="">Choisir…</option>
              {(options.data?.bureaus ?? []).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Durée</legend>
          <div className="flex gap-1">
            {DURATIONS.map((d) => (
              <Button key={d} size="sm" variant={duration === d ? "default" : "outline"} aria-pressed={duration === d} onClick={() => setDuration(d)}>
                {DURATION_LABELS[d]}
              </Button>
            ))}
          </div>
        </fieldset>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Annuler
          </Button>
          <Button disabled={!zoneReady || generate.isPending} onClick={calculate}>
            {generate.isPending ? "Calcul en cours…" : "Calculer"}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{instruction}</p>
      {errorCode && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {itineraryErrorMessage(errorCode)}
        </p>
      )}
      <div className="h-[60vh] min-h-[360px] overflow-hidden rounded-md border" data-testid="zone-map">
        <ZoneDrawMap
          value={draw}
          onChange={setDraw}
          drawPolygon={mode === "polygon"}
          doors={doors.data?.addresses ?? []}
          highlighted={highlighted}
        />
      </div>
    </section>
  )
}
