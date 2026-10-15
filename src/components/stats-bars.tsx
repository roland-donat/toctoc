import { formatRate, SMALL_COUNT, type Masked } from "@/lib/stats-api"

export interface BarRow {
  key: string
  label: string
  /** One value per series, between 0 and 1, or "< 5". */
  values: readonly [Masked, Masked]
}

interface StatsBarsProps {
  rows: readonly BarRow[]
  series: readonly [string, string]
  /** One color per series. */
  colors: readonly [string, string]
  /** Accessible name of the chart. */
  title: string
  /** Upper bound of the scale; defaults to the largest value shown (at least 1 % so empty charts keep a width). */
  max?: number
}

/**
 * Paired horizontal bars, one row per group, growing from a single baseline. A masked value draws no bar and
 * shows "< 5" in its place. The values are always written next to the bar, so color is never the only cue.
 */
export function StatsBars({ rows, series, colors, title, max }: StatsBarsProps) {
  const numbers = rows.flatMap((r) => r.values.filter((v): v is number => v !== SMALL_COUNT))
  const scale = max ?? Math.max(0.01, ...numbers)

  return (
    <figure className="space-y-3" aria-label={title}>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {series.map((name, i) => (
          <span key={name} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colors[i] }} />
            {name}
          </span>
        ))}
      </figcaption>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[minmax(6rem,11rem)_1fr] items-center gap-x-3">
            <div className="truncate text-sm" title={row.label}>
              {row.label}
            </div>
            <div className="space-y-0.5">
              {row.values.map((value, i) => (
                <Bar key={series[i]} value={value} scale={scale} color={colors[i]} label={`${row.label}, ${series[i]}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </figure>
  )
}

function Bar({ value, scale, color, label }: { value: Masked; scale: number; color: string; label: string }) {
  const text = formatRate(value)
  const width = value === SMALL_COUNT ? 0 : Math.max(0, Math.min(1, value / scale)) * 100
  return (
    <div className="group flex h-3.5 items-center gap-2" title={`${label} : ${text}`}>
      <div className="relative h-full flex-1 border-l border-foreground/30">
        {width > 0 && (
          <div
            className="h-full rounded-r-[4px] transition-opacity group-hover:opacity-80"
            style={{ width: `${width}%`, backgroundColor: color }}
          />
        )}
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{text}</span>
    </div>
  )
}
