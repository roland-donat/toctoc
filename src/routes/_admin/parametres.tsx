import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import {
  fetchSettings,
  settingsKey,
  updateAnonymization,
  updatePriorityParameters,
  type AnonymizationMode,
  type PriorityParameters,
} from "@/lib/carte-api"
import { useDebouncedSave } from "@/hooks/use-debounced-save"

export const Route = createFileRoute("/_admin/parametres")({
  component: ParametresPage,
})

const SAVE_DELAY_MS = 600

function ParametresPage() {
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings })
  return (
    <main className="mx-auto max-w-3xl space-y-10 px-4 py-8">
      <header>
        <h1 className="page-title">Paramètres</h1>
        <p className="mt-1 text-sm text-muted-foreground">Chaque modification est enregistrée automatiquement.</p>
      </header>
      {settings.isError && <p className="text-sm text-destructive">Impossible de charger les paramètres.</p>}
      {settings.data && (
        <>
          <AnonymizationSwitch mode={settings.data.anonymization} />
          <PriorityForm key="priority" initial={settings.data.parameters} />
          <BackupStatus lastBackupAt={settings.data.lastBackupAt} />
        </>
      )}
    </main>
  )
}

const MODES: { mode: AnonymizationMode; label: string; detail: string }[] = [
  { mode: "anonyme", label: "Anonyme", detail: "Aucun nom ni prénom, nulle part." },
  { mode: "nominatif", label: "Nominatif", detail: "Noms visibles dans les fiches de l'administrateur." },
]

function AnonymizationSwitch({ mode }: { mode: AnonymizationMode }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: updateAnonymization,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: settingsKey })
      // Every cached screen that may show persons is reloaded under the new rule.
      await queryClient.invalidateQueries({ queryKey: ["adresses"] })
    },
  })
  const shown = save.isPending && save.variables ? save.variables : mode

  return (
    <section aria-labelledby="anonymization" className="space-y-3">
      <h2 id="anonymization" className="text-lg font-extrabold">
        Affichage des noms
      </h2>
      <div role="radiogroup" aria-labelledby="anonymization" className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <label
            key={m.mode}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${shown === m.mode ? "border-foreground ring-1 ring-foreground" : ""}`}
          >
            <input
              type="radio"
              name="anonymization"
              className="mt-1 accent-foreground"
              checked={shown === m.mode}
              disabled={save.isPending}
              onChange={() => save.mutate(m.mode)}
            />
            <span>
              <span className="block font-medium">{m.label}</span>
              <span className="block text-sm text-muted-foreground">{m.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {save.isError ? <span className="text-destructive">Échec de l'enregistrement</span> : save.isSuccess ? "Enregistré" : ""}
      </p>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          En mode anonyme, le serveur retire les noms et prénoms de toutes ses réponses : carte, fiches, statistiques, liens
          d'itinéraire et feuilles. Les textes libres des retours (logement, remarques) sont masqués aussi, car ils peuvent
          porter un nom lu sur une boîte aux lettres.
        </p>
        <p>
          Le réglage s'applique à chaque affichage, y compris aux liens déjà envoyés. Une feuille déjà imprimée ne peut pas
          être rappelée. Le lieu de naissance n'est jamais montré aux militants.
        </p>
      </div>
    </section>
  )
}

interface NumberField {
  label: string
  hint?: string
  get: (p: PriorityParameters) => number
  set: (p: PriorityParameters, v: number) => PriorityParameters
  /** Shown value = stored value * scale (the share is entered as a percentage). */
  scale?: number
}

const POTENTIAL_FIELDS: NumberField[] = [
  {
    label: "Électeur en abstention forte",
    get: (p) => p.weights.fort,
    set: (p, v) => ({ ...p, weights: { ...p.weights, fort: v } }),
  },
  {
    label: "Électeur en abstention moyenne",
    get: (p) => p.weights.moyen,
    set: (p, v) => ({ ...p, weights: { ...p.weights, moyen: v } }),
  },
  {
    label: "Nouvel inscrit 2027",
    hint: "absent de la liste de mars 2026",
    get: (p) => p.weights.nouvelInscrit,
    set: (p, v) => ({ ...p, weights: { ...p.weights, nouvelInscrit: v } }),
  },
  {
    label: "Adresse sans inscrit",
    get: (p) => p.weights.sansInscrit,
    set: (p, v) => ({ ...p, weights: { ...p.weights, sansInscrit: v } }),
  },
  {
    label: "Adresse à revoir",
    get: (p) => p.weights.aRevoir,
    set: (p, v) => ({ ...p, weights: { ...p.weights, aRevoir: v } }),
  },
  { label: "Plafond de priorité", hint: "de 1 à 100", get: (p) => p.cap, set: (p, v) => ({ ...p, cap: v }) },
  {
    label: "Visite récente (jours)",
    hint: "une adresse visitée depuis moins longtemps passe en priorité basse",
    get: (p) => p.recentDays,
    set: (p, v) => ({ ...p, recentDays: v }),
  },
  {
    label: "Priorité d'une adresse visitée récemment",
    get: (p) => p.recentPriority,
    set: (p, v) => ({ ...p, recentPriority: v }),
  },
  {
    label: "Part maximale de portes sans inscrit (%)",
    get: (p) => p.noVoterShareCap,
    set: (p, v) => ({ ...p, noVoterShareCap: v }),
    scale: 100,
  },
]

const DOOR_TIME_FIELDS: NumberField[] = [
  {
    label: "Temps de base par porte (min)",
    get: (p) => p.doorTime.baseMinutes,
    set: (p, v) => ({ ...p, doorTime: { ...p.doorTime, baseMinutes: v } }),
  },
  {
    label: "Par logement ou inscrit supplémentaire (min)",
    get: (p) => p.doorTime.perExtraMinutes,
    set: (p, v) => ({ ...p, doorTime: { ...p.doorTime, perExtraMinutes: v } }),
  },
  {
    label: "Temps maximal par porte (min)",
    get: (p) => p.doorTime.capMinutes,
    set: (p, v) => ({ ...p, doorTime: { ...p.doorTime, capMinutes: v } }),
  },
]

const ALL_FIELDS = [...POTENTIAL_FIELDS, ...DOOR_TIME_FIELDS]

function toText(field: NumberField, p: PriorityParameters): string {
  return String(Math.round(field.get(p) * (field.scale ?? 1) * 100) / 100)
}

/** Parameters built from the fields, or null while one field is not a number. */
function candidateOf(texts: readonly string[], initial: PriorityParameters): PriorityParameters | null {
  let candidate: PriorityParameters = initial
  for (const [i, f] of ALL_FIELDS.entries()) {
    const raw = (texts[i] ?? "").trim().replace(",", ".")
    const n = raw === "" ? Number.NaN : Number(raw)
    if (!Number.isFinite(n)) return null
    candidate = f.set(candidate, n / (f.scale ?? 1))
  }
  return candidate
}

function PriorityForm({ initial }: { initial: PriorityParameters }) {
  const queryClient = useQueryClient()
  const [texts, setTexts] = useState<string[]>(() => ALL_FIELDS.map((f) => toText(f, initial)))
  const autosave = useDebouncedSave(async (parameters: PriorityParameters) => {
    const res = await updatePriorityParameters(parameters)
    queryClient.setQueryData(settingsKey, (old: { anonymization: AnonymizationMode } | undefined) =>
      old ? { ...old, parameters: res.parameters } : old,
    )
  }, SAVE_DELAY_MS)

  const candidate = candidateOf(texts, initial)
  const refused = autosave.state === "error"
  const status =
    candidate === null
      ? "Chaque champ attend un nombre."
      : refused
        ? "Valeur refusée : vérifier les bornes (poids de 0 à 1000, plafond de 1 à 100, part de 0 à 100 %, temps de 0 à 120 min)."
        : autosave.state === "saved"
          ? "Enregistré"
          : ""

  const renderField = (f: NumberField) => {
    const i = ALL_FIELDS.indexOf(f)
    return (
      <label key={f.label} className="grid grid-cols-[1fr_6rem] items-center gap-3 text-sm">
        <span>
          {f.label}
          {f.hint && <span className="block text-xs text-muted-foreground">{f.hint}</span>}
        </span>
        <input
          inputMode="decimal"
          className="h-8 rounded-md border border-input bg-transparent px-2 text-right tabular-nums shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={texts[i] ?? ""}
          onChange={(e) => {
            const next = [...texts]
            next[i] = e.target.value
            setTexts(next)
            // A field that is not a number yet: nothing to send until it is.
            const parameters = candidateOf(next, initial)
            if (parameters === null) autosave.cancel()
            else autosave.schedule(parameters)
          }}
        />
      </label>
    )
  }

  return (
    <section aria-labelledby="priority" className="space-y-6">
      <div>
        <h2 id="priority" className="text-lg font-extrabold">
          Choix des portes et temps à la porte
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ces réglages servent à la génération des itinéraires. La priorité d'une porte est la somme des poids qui la
          concernent, bornée par le plafond. Le temps passé à une porte croît avec le nombre de logements ou d'inscrits.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Poids et priorités</legend>
        {POTENTIAL_FIELDS.map(renderField)}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Temps à la porte</legend>
        {DOOR_TIME_FIELDS.map(renderField)}
      </fieldset>
      <p className={`min-h-4 text-xs ${candidate === null || refused ? "text-destructive" : "text-muted-foreground"}`} aria-live="polite">
        {status}
      </p>
    </section>
  )
}

function BackupStatus({ lastBackupAt }: { lastBackupAt: string | null }) {
  const label = lastBackupAt
    ? new Date(lastBackupAt).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" })
    : "aucune sauvegarde réussie pour l'instant"
  return (
    <section aria-labelledby="backup" className="space-y-2">
      <h2 id="backup" className="text-lg font-extrabold">
        Sauvegarde
      </h2>
      <p className="text-sm">
        Dernière sauvegarde chiffrée réussie : <span data-testid="last-backup">{label}</span>
      </p>
      <p className="text-sm text-muted-foreground">
        Une sauvegarde chiffrée est prise chaque nuit sur le serveur. Si cette date ne bouge plus, la tâche de sauvegarde
        a échoué (voir la procédure de déploiement).
      </p>
    </section>
  )
}
