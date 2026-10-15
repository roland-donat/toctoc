import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { AddressSheet } from "@/components/address-sheet"
import { DoorMap } from "@/components/door-map"
import { MapFiltersPanel } from "@/components/map-filters"
import {
  AGE_BANDS,
  CATEGORIES,
  FOLLOW_UPS,
  fetchMap,
  fetchMapOptions,
  mapKey,
  mapOptionsKey,
  mapQuery,
  type MapFilters,
  type MapOptions,
} from "@/lib/carte-api"

interface CarteSearch extends MapFilters {
  /** Address whose sheet is open. */
  adresse?: string
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" && v.length <= 200 ? v : undefined
}

function pickOne<T extends string>(allowed: readonly T[], v: unknown): T | undefined {
  return allowed.find((a) => a === v)
}

function pickMany<T extends string>(allowed: readonly T[], v: unknown): T[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? [v] : []
  const out = allowed.filter((a) => raw.includes(a))
  return out.length === 0 ? undefined : out
}

export const Route = createFileRoute("/_admin/carte")({
  validateSearch: (search: Record<string, unknown>): CarteSearch => ({
    bureau: pickString(search.bureau),
    category: pickMany(CATEGORIES, search.category),
    ageBand: pickMany(AGE_BANDS, search.ageBand),
    sex: pickOne(["F", "M"] as const, search.sex),
    street: pickString(search.street),
    followUp: pickMany(FOLLOW_UPS, search.followUp),
    adresse: pickString(search.adresse),
  }),
  component: CartePage,
})

function CartePage() {
  const { adresse, ...filters } = Route.useSearch()
  const navigate = useNavigate({ from: "/carte" })
  const options = useQuery({ queryKey: mapOptionsKey, queryFn: fetchMapOptions })
  const ready = options.data?.setup.ban === true && options.data.setup.liste
  const map = useQuery({
    queryKey: mapKey(filters),
    queryFn: () => fetchMap(filters),
    placeholderData: keepPreviousData,
    enabled: ready,
  })

  if (options.isError) {
    return <p className="px-4 py-8 text-sm text-destructive">Impossible de charger la carte.</p>
  }
  if (options.data && !ready) return <SetupSteps setup={options.data.setup} />

  const setFilters = (update: (previous: MapFilters) => MapFilters) =>
    navigate({
      search: (prev) => {
        const { adresse: openSheet, ...previous } = prev
        return { ...update(previous), adresse: openSheet }
      },
      replace: true,
    })
  const select = (id: string | undefined) => navigate({ search: (prev) => ({ ...prev, adresse: id }) })

  return (
    <main className="flex h-[calc(100vh-57px)] min-h-[480px] flex-col md:flex-row">
      <section aria-label="Filtres de la carte" className="w-full shrink-0 overflow-y-auto border-b p-4 md:w-72 md:border-r md:border-b-0">
        {options.data && !options.data.setup.emargement && (
          <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs">
            L'émargement 2026 n'est pas encore importé : les niveaux d'abstention sont inconnus.{" "}
            <a href="/imports" className="underline">
              Importer l'émargement
            </a>
          </p>
        )}
        <MapFiltersPanel filters={filters} options={options.data} totals={map.data?.totals} onChange={setFilters} />
      </section>
      <div className="relative min-h-[360px] flex-1" data-testid="door-map">
        {map.isError && (
          <p className="absolute inset-x-0 top-2 z-[1000] mx-auto w-fit rounded bg-background px-3 py-1 text-sm text-destructive shadow">
            Impossible de charger les portes.
          </p>
        )}
        <DoorMap
          addresses={map.data?.addresses ?? []}
          fitKey={map.isPlaceholderData ? "pending" : mapQuery(filters)}
          selectedId={adresse ?? null}
          onSelect={(id) => select(id)}
        />
      </div>
      {adresse && (
        <div className="w-full shrink-0 border-t bg-background md:w-[26rem] md:border-t-0 md:border-l">
          <AddressSheet addressId={adresse} onClose={() => select(undefined)} />
        </div>
      )}
    </main>
  )
}

const STEPS = [
  { key: "ban", title: "Charger le référentiel d'adresses (BAN)", detail: "Les portes de la commune, sans aucune donnée personnelle." },
  { key: "liste", title: "Importer la liste électorale", detail: "Les inscrits rattachés à leur adresse." },
  { key: "emargement", title: "Importer l'émargement 2026", detail: "La participation aux deux tours des municipales." },
] as const

function SetupSteps({ setup }: { setup: MapOptions["setup"] }) {
  const next = STEPS.find((s) => !setup[s.key])
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="page-title">Carte des portes</h1>
      <p className="mt-2 text-muted-foreground">La carte s'affiche une fois les imports faits, dans cet ordre.</p>
      <ol className="mt-6 space-y-3">
        {STEPS.map((s, i) => {
          const done = setup[s.key]
          const current = s.key === next?.key
          return (
            <li key={s.key} className={`flex gap-3 rounded-lg border p-3 ${current ? "border-foreground" : ""}`}>
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  done ? "bg-foreground text-background" : "border"
                }`}
                aria-hidden="true"
              >
                {done ? "✓" : i + 1}
              </span>
              <div>
                <p className="font-medium">
                  {s.title}
                  {done && <span className="ml-2 text-sm font-normal text-muted-foreground">fait</span>}
                </p>
                <p className="text-sm text-muted-foreground">{s.detail}</p>
                {current && (
                  <a href="/imports" className="mt-1 inline-block text-sm underline">
                    Aller aux imports
                  </a>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </main>
  )
}
