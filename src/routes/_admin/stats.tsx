import { useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { StatsBars } from "@/components/stats-bars"
import { StatsTable } from "@/components/stats-table"
import { formatDate } from "@/lib/utils"
import { CATEGORY_COLORS } from "@/lib/carte-api"
import {
  campaignKey,
  DIMENSION_LABELS,
  fetchCampaign,
  fetchStats,
  formatCount,
  formatRate,
  setAccompanyDone,
  statsKey,
  type AccompanyItem,
  type CampaignReport,
  type CoverageCell,
  type Dimension,
  type StatsReport,
  type TurnoutCell,
} from "@/lib/stats-api"

/** The two rounds are one measure taken twice: two shades of a hue the map never uses. */
const ROUND_COLORS = ["#4c0297", "#b48ae8"] as const
/** Same colors as the map, so a voter or an abstainer reads the same everywhere. */
const PROFILE_COLORS = [CATEGORY_COLORS.votants, CATEGORY_COLORS.abstention_forte] as const

export const Route = createFileRoute("/_admin/stats")({
  component: StatsPage,
})

function StatsPage() {
  const stats = useQuery({ queryKey: statsKey, queryFn: fetchStats })
  const campaign = useQuery({ queryKey: campaignKey, queryFn: fetchCampaign })

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-4 py-8">
      <header>
        <h1 className="page-title">Statistiques</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Municipales 2026, liste principale en vigueur. Les électeurs des listes complémentaires ne sont pas comptés. Toute
          case calculée sur moins de 5 personnes est affichée « &lt; 5 ».
        </p>
      </header>
      {stats.isError && <p className="text-sm text-destructive">Impossible de charger les statistiques.</p>}
      {stats.data && (
        <>
          <Participation report={stats.data} />
          <FlowsSection report={stats.data} />
          <Profile report={stats.data} />
        </>
      )}
      {campaign.isError && <p className="text-sm text-destructive">Impossible de charger les indicateurs de campagne.</p>}
      {campaign.data && <Campaign report={campaign.data} />}
    </main>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h2 id={id} className="text-lg font-extrabold">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  )
}

function turnoutDetail(cell: TurnoutCell): string {
  return `${formatCount(cell.voters)} votants sur ${formatCount(cell.eligible)} inscrits lisibles`
}

function DimensionPicker({ value, onChange, label }: { value: Dimension; onChange: (d: Dimension) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {DIMENSION_LABELS.map((d) => (
        <Button
          key={d.key}
          size="sm"
          variant={d.key === value ? "default" : "outline"}
          aria-pressed={d.key === value}
          onClick={() => onChange(d.key)}
        >
          {d.label}
        </Button>
      ))}
    </div>
  )
}

function dimensionLabel(d: Dimension): string {
  return DIMENSION_LABELS.find((x) => x.key === d)?.label ?? d
}

function Participation({ report }: { report: StatsReport }) {
  const [dimension, setDimension] = useState<Dimension>("age")
  const rows = report.dimensions[dimension]
  const { population } = report
  return (
    <Section id="participation" title="Participation">
      <div className="grid gap-3 sm:grid-cols-2">
        <Tile label="Participation au 1er tour" value={formatRate(report.overall.t1.rate)} detail={turnoutDetail(report.overall.t1)} />
        <Tile label="Participation au 2d tour" value={formatRate(report.overall.t2.rate)} detail={turnoutDetail(report.overall.t2)} />
      </div>
      <p className="text-sm text-muted-foreground">
        {formatCount(population.targeted)} électeurs pris en compte. Hors calcul : {formatCount(population.unknown)} au niveau
        inconnu (aucun tour lisible), {formatCount(population.newRegistrants)} nouveaux inscrits depuis mars 2026. Un tour illisible
        est écarté du calcul de ce tour pour l'électeur concerné.
      </p>
      <DimensionPicker value={dimension} onChange={setDimension} label="Dimension de la participation" />
      <StatsBars
        title={`Participation par ${dimensionLabel(dimension).toLowerCase()}`}
        series={["1er tour", "2d tour"]}
        colors={ROUND_COLORS}
        rows={rows.map((r) => ({ key: r.key, label: r.label, values: [r.t1.rate, r.t2.rate] }))}
        max={1}
      />
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">Tableau des effectifs</summary>
        <div className="mt-2">
          <StatsTable rows={rows} mode="participation" caption={`Participation par ${dimensionLabel(dimension).toLowerCase()}`} />
        </div>
      </details>
    </Section>
  )
}

function FlowsSection({ report }: { report: StatsReport }) {
  const f = report.flows
  const cell = "rounded-md border p-3 text-center"
  return (
    <Section id="flux" title="Flux entre les tours">
      <p className="text-sm text-muted-foreground">Électeurs dont les deux tours sont lisibles : {formatCount(f.total)}.</p>
      <div className="grid max-w-xl grid-cols-[auto_1fr_1fr] gap-2 text-sm">
        <div />
        <div className="text-center font-medium">A voté au 2d tour</div>
        <div className="text-center font-medium">N'a pas voté au 2d tour</div>
        <div className="self-center font-medium">A voté au 1er tour</div>
        <div className={cell}>
          <div className="text-xl font-semibold tabular-nums">{formatCount(f.both)}</div>
          <div className="text-xs text-muted-foreground">aux deux tours</div>
        </div>
        <div className={cell}>
          <div className="text-xl font-semibold tabular-nums">{formatCount(f.t1Only)}</div>
          <div className="text-xs text-muted-foreground">au 1er tour seulement</div>
        </div>
        <div className="self-center font-medium">N'a pas voté au 1er tour</div>
        <div className={cell}>
          <div className="text-xl font-semibold tabular-nums">{formatCount(f.t2Only)}</div>
          <div className="text-xs text-muted-foreground">au 2d tour seulement</div>
        </div>
        <div className={cell}>
          <div className="text-xl font-semibold tabular-nums">{formatCount(f.neither)}</div>
          <div className="text-xs text-muted-foreground">à aucun tour</div>
        </div>
      </div>
    </Section>
  )
}

function Profile({ report }: { report: StatsReport }) {
  const [dimension, setDimension] = useState<Dimension>("age")
  const rows = report.dimensions[dimension]
  return (
    <Section id="profil" title="Profil votants / abstentionnistes">
      <p className="text-sm text-muted-foreground">
        Répartition de {formatCount(report.profileTotals.voters)} votants (à chaque tour lisible) et de{" "}
        {formatCount(report.profileTotals.abstainers)} abstentionnistes (abstention forte ou moyenne).
      </p>
      <DimensionPicker value={dimension} onChange={setDimension} label="Dimension du profil" />
      <StatsBars
        title={`Profil par ${dimensionLabel(dimension).toLowerCase()}`}
        series={["Votants", "Abstentionnistes"]}
        colors={PROFILE_COLORS}
        rows={rows.map((r) => ({ key: r.key, label: r.label, values: [r.profile.voters.share, r.profile.abstainers.share] }))}
      />
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">Tableau des effectifs</summary>
        <div className="mt-2">
          <StatsTable rows={rows} mode="profil" caption={`Profil par ${dimensionLabel(dimension).toLowerCase()}`} />
        </div>
      </details>
      <div className="rounded-md bg-muted/50 p-3 text-sm">
        <div>
          Votes par procuration : {formatCount(report.proxies.t1)} au 1er tour, {formatCount(report.proxies.t2)} au 2d tour.
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{report.proxies.note}</div>
      </div>
    </Section>
  )
}

function coverageDetail(c: CoverageCell): string {
  return `${c.covered} sur ${c.total}`
}

function countdown(days: number): string {
  if (days < 0) return "Clôturées"
  if (days === 0) return "Aujourd'hui"
  return days === 1 ? "1 jour" : `${days} jours`
}

function Campaign({ report }: { report: CampaignReport }) {
  const since = formatDate(report.startDate)
  return (
    <Section id="campagne" title="Campagne">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile label={`Portes visitées depuis le ${since}`} value={String(report.activity.doorsVisited)} />
        <Tile label={`Sessions depuis le ${since}`} value={String(report.activity.sessions)} />
        <Tile
          label="Clôture des inscriptions"
          value={countdown(report.daysToDeadline)}
          detail={`Le ${formatDate(report.registrationDeadline)}`}
        />
        <Tile
          label="Portes à potentiel fort couvertes"
          value={formatRate(report.coverage.highPotential.share)}
          detail={coverageDetail(report.coverage.highPotential)}
        />
        <Tile
          label="Adresses sans inscrit couvertes"
          value={formatRate(report.coverage.noVoter.share)}
          detail={coverageDetail(report.coverage.noVoter)}
        />
        <Tile label="À accompagner pour inscription" value={String(report.accompany.todo.length)} detail={`Fait : ${report.accompany.done.length}`} />
      </div>
      <AccompanyList report={report} />
    </Section>
  )
}

function AccompanyList({ report }: { report: CampaignReport }) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: ({ visitId, done }: { visitId: string; done: boolean }) => setAccompanyDone(visitId, done),
    onSettled: () => queryClient.invalidateQueries({ queryKey: campaignKey }),
  })
  const item = (i: AccompanyItem) => (
    <li key={i.visitId} className="flex items-start gap-3 py-2">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={i.done}
        disabled={toggle.isPending}
        aria-label={`Marquer ${i.addressLabel} comme ${i.done ? "à faire" : "fait"}`}
        onChange={() => toggle.mutate({ visitId: i.visitId, done: !i.done })}
      />
      <div className="text-sm">
        <div className="font-medium">{i.addressLabel}</div>
        <div className="text-muted-foreground">
          Visite du {formatDate(i.visitDate)}
          {i.dwelling ? ` · ${i.dwelling}` : ""}
        </div>
      </div>
    </li>
  )
  return (
    <div className="space-y-2" data-testid="accompany-list">
      <h3 className="font-medium">Personnes à accompagner pour inscription</h3>
      {toggle.isError && <p className="text-sm text-destructive">Échec de l'enregistrement</p>}
      {report.accompany.todo.length === 0 ? (
        <p className="text-sm text-muted-foreground">Rien à faire pour le moment.</p>
      ) : (
        <ul className="divide-y rounded-md border px-3">{report.accompany.todo.map(item)}</ul>
      )}
      {report.accompany.done.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">Fait ({report.accompany.done.length})</summary>
          <ul className="mt-2 divide-y rounded-md border px-3">{report.accompany.done.map(item)}</ul>
        </details>
      )}
    </div>
  )
}
