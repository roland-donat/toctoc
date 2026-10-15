// Block "3. Émargement 2026" of the Imports screen (U5): upload, simulation, confirmation, status.
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { FilePicker } from "@/components/file-picker"
import { Button } from "@/components/ui/button"
import { errorLabel, localDateTimeFormat, numberFormat } from "@/lib/format"
import {
  confirmEmargementImport,
  emargementStatusKey,
  fetchEmargementStatus,
  fetchRepStatus,
  repStatusKey,
  rowExceptionsKey,
  simulateEmargementImport,
  unknownElectorsKey,
  type EmargementImportResult,
  type EmargementSimulation,
} from "@/lib/imports-api"

const ERROR_LABELS: Record<string, string> = {
  file_required: "Aucun fichier sélectionné.",
  emargement_invalid_header: "Ce fichier n'a pas les colonnes attendues de l'émargement agrégé.",
  emargement_empty: "Le fichier ne contient aucune ligne.",
  no_current_list: "Importez d'abord la liste électorale.",
  reference_list_replaced:
    "Une liste électorale plus récente a remplacé celle de mars 2026 : l'émargement 2026 ne peut plus être apparié par bureau et numéro d'ordre. Import refusé, rien n'a été modifié.",
  pending_import_not_found: "Cette simulation n'est plus disponible : chargez de nouveau le fichier.",
}


export function EmargementBlock() {
  const queryClient = useQueryClient()
  const rep = useQuery({ queryKey: repStatusKey, queryFn: fetchRepStatus })
  const status = useQuery({ queryKey: emargementStatusKey, queryFn: fetchEmargementStatus })
  const [simulation, setSimulation] = useState<EmargementSimulation | null>(null)
  const [result, setResult] = useState<EmargementImportResult | null>(null)

  const simulate = useMutation({
    mutationFn: simulateEmargementImport,
    onMutate: () => {
      setSimulation(null)
      setResult(null)
    },
    onSuccess: setSimulation,
  })
  const confirm = useMutation({
    mutationFn: (pendingId: string) => confirmEmargementImport(pendingId),
    onSuccess: (res) => {
      setResult(res)
      setSimulation(null)
      void queryClient.invalidateQueries({ queryKey: emargementStatusKey })
      void queryClient.invalidateQueries({ queryKey: rowExceptionsKey })
      void queryClient.invalidateQueries({ queryKey: unknownElectorsKey })
    },
  })
  const noList = rep.data !== undefined && rep.data.current === null
  const error = simulate.error ?? confirm.error
  const current = status.data?.current ?? null

  return (
    <section aria-labelledby="emargement-title" className="space-y-3">
      <h2 id="emargement-title" className="text-lg font-medium">
        3. Émargement 2026
      </h2>
      {current && !result && (
        <p className="text-sm">
          Émargement importé le {localDateTimeFormat.format(current.importedAt)} : {numberFormat.format(current.votersT1)} votants
          au premier tour, {numberFormat.format(current.votersT2)} au second. Restent{" "}
          {numberFormat.format(current.openRowExceptions)} écarts à trancher et {numberFormat.format(current.unknownLevel)}{" "}
          électeurs au niveau inconnu.
        </p>
      )}
      {noList && <p className="text-sm text-muted-foreground">Disponible après l'import de la liste.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <FilePicker
          label="Charger l'émargement 2026"
          accept=".csv,text/csv"
          disabled={noList || simulate.isPending || confirm.isPending}
          onFile={(f) => simulate.mutate(f)}
        />
        {!noList && (
          <Link to="/imports/exceptions" className="text-sm underline underline-offset-4">
            Traiter les exceptions
          </Link>
        )}
      </div>
      {simulate.isPending && <p className="text-sm text-muted-foreground">Analyse du fichier et appariement des électeurs…</p>}
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
        <p className="rounded-md border p-3 text-sm" role="status">
          Import terminé : {numberFormat.format(result.matched)} électeurs appariés, {numberFormat.format(result.votersT1)}{" "}
          votants au premier tour, {numberFormat.format(result.votersT2)} au second, {numberFormat.format(result.exceptions)}{" "}
          lignes à examiner dans les exceptions.
        </p>
      )}
    </section>
  )
}

function SimulationTable({ simulation: s }: { simulation: EmargementSimulation }) {
  const rows: Array<[string, number]> = [
    ["Lignes lues", s.rows],
    ["Électeurs appariés", s.matched],
    ["Électeurs scannés deux fois (lignes fusionnées)", s.merged],
    ["Écarts de nom (non appliqués)", s.nameMismatches],
    ["Doublons aux votes différents (non appliqués)", s.discordantDuplicates],
    ["Lignes introuvables dans la liste", s.notFound],
    ["Cases de vote illisibles", s.unreadableCells],
    ["Électeurs au niveau inconnu", s.unknownLevel],
  ]
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Simulation de l'import de l'émargement</caption>
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
  )
}
