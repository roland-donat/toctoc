import { useId, useState, type ReactNode } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DoorPointsLegend, DoorSymbol } from "@/components/door-map"
import {
  AGE_BANDS,
  CATEGORIES,
  CATEGORY_LABELS,
  FOLLOW_UPS,
  FOLLOW_UP_LABELS,
  type MapFilters,
  type MapOptions,
} from "@/lib/carte-api"

interface MapFiltersProps {
  filters: MapFilters
  options: MapOptions | undefined
  totals: { doors: number; electors: number } | undefined
  /** Receives an updater so successive quick changes compose on the latest URL state, never on a stale render. */
  onChange: (update: (previous: MapFilters) => MapFilters) => void
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("fr-FR")} ${n > 1 ? many : one}`
}

function toggle<T>(list: readonly T[] | undefined, value: T): T[] | undefined {
  const current = list ?? []
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  return next.length === 0 ? undefined : next
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      {children}
    </fieldset>
  )
}

function CheckRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted">
      <input type="checkbox" className="size-4 accent-foreground" checked={checked} onChange={onToggle} />
      {children}
    </label>
  )
}

function StreetPicker({
  value,
  streets,
  onChange,
}: {
  value: string | undefined
  streets: MapOptions["streets"]
  onChange: (key: string | undefined) => void
}) {
  const id = useId()
  const currentName = streets.find((s) => s.key === value)?.name ?? ""
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? currentName
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Rue ou lieu-dit
      </label>
      <input
        id={id}
        list={`${id}-streets`}
        className={selectClass}
        placeholder="Toutes les rues"
        value={shown}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          if (next.trim() === "") {
            onChange(undefined)
            return
          }
          const match = streets.find((s) => s.name.toLowerCase() === next.trim().toLowerCase())
          if (match) onChange(match.key)
        }}
        onBlur={() => setText(null)}
      />
      <datalist id={`${id}-streets`}>
        {streets.map((s) => (
          <option key={s.key} value={s.name} />
        ))}
      </datalist>
    </div>
  )
}

export function MapFiltersPanel({ filters, options, totals, onChange }: MapFiltersProps) {
  const set = (patch: (previous: MapFilters) => Partial<MapFilters>) => onChange((prev) => ({ ...prev, ...patch(prev) }))
  const active = Object.values(filters).some((v) => v !== undefined)

  return (
    <div className="space-y-5">
      <div aria-live="polite" data-testid="map-counters">
        {totals ? (
          <p className="text-lg font-semibold tabular-nums tracking-tight">
            {plural(totals.doors, "porte", "portes")}, {plural(totals.electors, "électeur", "électeurs")}
          </p>
        ) : (
          <p className="text-lg font-semibold text-muted-foreground">Chargement…</p>
        )}
        <p className="text-xs text-muted-foreground">
          Les filtres aident à repérer une zone. Ils ne limitent pas la génération des itinéraires.
        </p>
        {active && (
          <Button variant="ghost" size="sm" className="mt-1 -ml-2 gap-1" onClick={() => onChange(() => ({}))}>
            <X className="size-4" />
            Effacer les filtres
          </Button>
        )}
      </div>

      <Fieldset legend="Catégorie">
        {CATEGORIES.map((c) => (
          <CheckRow key={c} checked={filters.category?.includes(c) ?? false} onToggle={() => set((p) => ({ category: toggle(p.category, c) }))}>
            <DoorSymbol category={c} />
            {CATEGORY_LABELS[c]}
          </CheckRow>
        ))}
        <DoorPointsLegend />
      </Fieldset>

      <Fieldset legend="Suivi des visites">
        {FOLLOW_UPS.map((f) => (
          <CheckRow key={f} checked={filters.followUp?.includes(f) ?? false} onToggle={() => set((p) => ({ followUp: toggle(p.followUp, f) }))}>
            <DoorSymbol followUp={f} />
            {FOLLOW_UP_LABELS[f]}
          </CheckRow>
        ))}
      </Fieldset>

      <Fieldset legend="Tranche d'âge">
        <div className="flex flex-wrap gap-1.5">
          {AGE_BANDS.map((b) => {
            const on = filters.ageBand?.includes(b) ?? false
            return (
              <button
                key={b}
                type="button"
                aria-pressed={on}
                onClick={() => set((p) => ({ ageBand: toggle(p.ageBand, b) }))}
                className={`rounded-md border px-2.5 py-1 text-sm tabular-nums transition-colors ${
                  on ? "border-foreground bg-foreground text-background" : "hover:bg-muted"
                }`}
              >
                {b === "61+" ? "61 ans et +" : `${b} ans`}
              </button>
            )
          })}
        </div>
      </Fieldset>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5 text-sm font-medium">
          <span>Bureau</span>
          <select className={selectClass} value={filters.bureau ?? ""} onChange={(e) => set(() => ({ bureau: e.target.value || undefined }))}>
            <option value="">Tous</option>
            {(options?.bureaus ?? []).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>Sexe</span>
          <select
            className={selectClass}
            value={filters.sex ?? ""}
            onChange={(e) => set(() => ({ sex: e.target.value === "F" || e.target.value === "M" ? e.target.value : undefined }))}
          >
            <option value="">Tous</option>
            <option value="F">Femmes</option>
            <option value="M">Hommes</option>
          </select>
        </label>
      </div>

      <StreetPicker value={filters.street} streets={options?.streets ?? []} onChange={(street) => set(() => ({ street }))} />
    </div>
  )
}
