import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Download } from "lucide-react"
import { FilePicker } from "@/components/file-picker"
import { EmargementBlock } from "@/components/import-emargement-dialog"
import { Button } from "@/components/ui/button"
import { errorLabel, localDateTimeFormat, numberFormat, percentFormat } from "@/lib/format"
import {
  banStatusKey,
  confirmRepImport,
  downloadBan,
  fetchBanStatus,
  fetchRepStatus,
  LIST_TYPE_LABELS,
  queueKey,
  repStatusKey,
  simulateRepImport,
  uploadBan,
  type ListType,
  type ReimportReport,
  type RepImportResult,
  type RepSimulation,
} from "@/lib/imports-api"

export const Route = createFileRoute("/_admin/imports")({
  component: ImportsPage,
})

const ERROR_LABELS: Record<string, string> = {
  file_required: "Aucun fichier sélectionné.",
  ban_invalid_header: "Ce fichier n'a pas les colonnes attendues de la BAN.",
  ban_download_failed: "Le téléchargement de la BAN a échoué. Réessayez plus tard ou chargez le fichier à la main.",
  rep_invalid_header: "Ce fichier n'a pas les colonnes attendues d'une liste électorale au format REP.",
  rep_empty: "Le fichier ne contient aucune ligne.",
  rep_unknown_list_type: "Une ligne porte un type de liste inconnu.",
  rep_missing_identity: "Une ligne n'a ni nom de naissance ni prénoms.",
  pending_import_not_found: "Cette simulation n'est plus disponible : chargez de nouveau le fichier.",
}


function ImportsPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-10 px-4 py-8">
      <header>
        <h1 className="page-title">Imports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          À faire dans l'ordre : les adresses de Séné, puis la liste électorale, puis l'émargement.
        </p>
      </header>
      <BanBlock />
      <RepBlock />
      <EmargementBlock />
    </main>
  )
}

function BanBlock() {
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: banStatusKey, queryFn: fetchBanStatus })
  const refresh = () => queryClient.invalidateQueries({ queryKey: banStatusKey })
  const download = useMutation({ mutationFn: downloadBan, onSuccess: refresh })
  const upload = useMutation({ mutationFn: uploadBan, onSuccess: refresh })
  const busy = download.isPending || upload.isPending
  const error = download.error ?? upload.error

  return (
    <section aria-labelledby="ban-title" className="space-y-3">
      <h2 id="ban-title" className="text-lg font-extrabold">
        1. Adresses (BAN)
      </h2>
      {status.data && (
        <p className="text-sm">
          {status.data.lastImportedAt === null
            ? "Aucune adresse chargée."
            : `${numberFormat.format(status.data.total)} adresses de Séné, chargées le ${localDateTimeFormat.format(status.data.lastImportedAt)}.`}
          {status.data.retired > 0 && ` ${numberFormat.format(status.data.retired)} adresses retirées de la BAN.`}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => download.mutate()}>
          <Download />
          {download.isPending ? "Téléchargement en cours…" : "Télécharger la BAN"}
        </Button>
        <FilePicker label="Charger un fichier BAN" accept=".csv,.gz,text/csv" disabled={busy} onFile={(f) => upload.mutate(f)} />
      </div>
      {error && <p className="text-sm text-destructive">{errorLabel(error, ERROR_LABELS)}</p>}
    </section>
  )
}

function RepBlock() {
  const queryClient = useQueryClient()
  const ban = useQuery({ queryKey: banStatusKey, queryFn: fetchBanStatus })
  const current = useQuery({ queryKey: repStatusKey, queryFn: fetchRepStatus })
  const [simulation, setSimulation] = useState<RepSimulation | null>(null)
  const [result, setResult] = useState<RepImportResult | null>(null)

  const simulate = useMutation({
    mutationFn: simulateRepImport,
    onMutate: () => {
      setSimulation(null)
      setResult(null)
    },
    onSuccess: setSimulation,
  })
  const confirm = useMutation({
    mutationFn: (pendingId: string) => confirmRepImport(pendingId),
    onSuccess: (res) => {
      setResult(res)
      setSimulation(null)
      void queryClient.invalidateQueries({ queryKey: repStatusKey })
      void queryClient.invalidateQueries({ queryKey: queueKey })
    },
  })
  const noBan = ban.data !== undefined && ban.data.total === 0
  const error = simulate.error ?? confirm.error
  const summary = current.data?.current ?? null

  return (
    <section aria-labelledby="rep-title" className="space-y-3">
      <h2 id="rep-title" className="text-lg font-extrabold">
        2. Liste électorale
      </h2>
      {summary && !result && (
        <p className="text-sm">
          Liste en vigueur importée le {localDateTimeFormat.format(summary.importedAt)} : {numberFormat.format(summary.rows)} lignes,
          taux d'appariement {percentFormat.format(summary.matchRate)}, {numberFormat.format(summary.queueSize)} adresses à
          rattacher.
        </p>
      )}
      {noBan && <p className="text-sm text-muted-foreground">Chargez d'abord les adresses de la BAN.</p>}
      <FilePicker
        label="Charger la liste électorale (REP)"
        accept=".csv,.gz,text/csv"
        disabled={noBan || simulate.isPending || confirm.isPending}
        onFile={(f) => simulate.mutate(f)}
      />
      {simulate.isPending && <p className="text-sm text-muted-foreground">Analyse du fichier et appariement des adresses…</p>}
      {error && <p className="text-sm text-destructive">{errorLabel(error, ERROR_LABELS)}</p>}
      {simulation && (
        <div className="space-y-3">
          <SimulationTable simulation={simulation} />
          <Button disabled={confirm.isPending} onClick={() => confirm.mutate(simulation.pendingId)}>
            {confirm.isPending ? "Import en cours…" : "Confirmer l'import"}
          </Button>
        </div>
      )}
      {result && (
        <div className="space-y-3 rounded-md border p-3 text-sm" role="status">
          <p>
            Import terminé : {numberFormat.format(result.electors)} électeurs, taux d'appariement{" "}
            {percentFormat.format(result.matchRate)}, {numberFormat.format(result.queueSize)} inscriptions dans
            la file des adresses à rattacher.
          </p>
          {result.reimport && <ReimportTable report={result.reimport} />}
        </div>
      )}
    </section>
  )
}

function ReimportTable({ report: r }: { report: ReimportReport }) {
  const rows: Array<[string, string]> = [
    ["Nouveaux inscrits", numberFormat.format(r.newRegistrants)],
    ["Radiés (absents de la nouvelle liste, historique conservé)", numberFormat.format(r.removed)],
    ["Déménagés (adresse changée)", numberFormat.format(r.moved)],
    [
      "Adresses sans inscrit",
      `${numberFormat.format(r.sansInscritBefore)} avant, ${numberFormat.format(r.sansInscritAfter)} après`,
    ],
    ["Rattachements manuels repris de la liste précédente", numberFormat.format(r.manualCarriedOver)],
  ]
  return (
    <div className="space-y-1">
      <p className="font-medium">Changements par rapport à la liste précédente</p>
      <table className="w-full">
        <caption className="sr-only">Changements par rapport à la liste précédente</caption>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b last:border-0">
              <th scope="row" className="py-1.5 text-left font-normal">
                {label}
              </th>
              <td className="py-1.5 text-right tabular-nums">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted-foreground">Les retours de visite restent rattachés à leurs adresses.</p>
    </div>
  )
}

function SimulationTable({ simulation: s }: { simulation: RepSimulation }) {
  const rows: Array<[string, number]> = [
    ["Lignes lues", s.rows],
    ["Électeurs distincts", s.electors],
    ...(Object.keys(LIST_TYPE_LABELS) as ListType[]).map((t): [string, number] => [LIST_TYPE_LABELS[t], s.listTypes[t]]),
    ["Électeurs inscrits sur plusieurs listes", s.duplicatesAcrossLists],
    ["Adresses appariées à la BAN", s.matchedBan],
    ["Adresses appariées par la Géoplateforme", s.matchedFallback],
    ["Rattachées à la voie ou au lieu-dit (sans numéro)", s.matchedStreet],
    ["Adresses à rattacher à la main", s.toAttach],
    ["Dates de naissance illisibles", s.unreadableDates],
  ]
  return (
    <div className="space-y-2">
      <table className="w-full text-sm">
        <caption className="sr-only">Simulation de l'import</caption>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b last:border-0">
              <th scope="row" className="py-1.5 text-left font-normal">
                {label}
              </th>
              <td className="py-1.5 text-right tabular-nums">{numberFormat.format(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!s.fallbackAvailable && (
        <p className="text-sm text-muted-foreground">
          La Géoplateforme n'a pas répondu : les adresses non trouvées dans la BAN iront toutes dans la file à rattacher.
          L'import reste possible.
        </p>
      )}
    </div>
  )
}
