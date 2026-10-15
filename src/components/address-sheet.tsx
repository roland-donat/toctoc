import { useId, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DoorSymbol } from "@/components/door-map"
import {
  CATEGORY_LABELS,
  commerceLabel,
  setCommerceDismissed,
  FOLLOW_UP_LABELS,
  QUALIFICATION_LABELS,
  cancelQualification,
  deleteVisit,
  fetchSheet,
  sheetKey,
  updateDwellings,
  type AddressSheet as Sheet,
  type SheetVisit,
  type SheetVoter,
} from "@/lib/carte-api"
import { LIST_TYPE_LABELS, VOTER_LEVEL_LABELS, type VoteValue } from "@/lib/imports-api"
import { formatDate } from "@/lib/utils"
import { useDebouncedSave } from "@/hooks/use-debounced-save"

const SAVE_DELAY_MS = 600

interface AddressSheetProps {
  addressId: string
  onClose: () => void
}

export function AddressSheet({ addressId, onClose }: AddressSheetProps) {
  const sheet = useQuery({ queryKey: sheetKey(addressId), queryFn: () => fetchSheet(addressId) })

  return (
    <aside role="complementary" aria-label="Fiche adresse" className="flex h-full flex-col">
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-tight">{sheet.data?.label ?? "Fiche adresse"}</h2>
          {sheet.data && (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <DoorSymbol category={sheet.data.category} />
                {CATEGORY_LABELS[sheet.data.category]}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <DoorSymbol followUp={sheet.data.followUp} />
                {FOLLOW_UP_LABELS[sheet.data.followUp]}
                {sheet.data.lastVisit && `, dernier passage le ${formatDate(sheet.data.lastVisit)}`}
              </span>
            </p>
          )}
        </div>
        <Button size="icon" variant="ghost" aria-label="Fermer la fiche" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {sheet.isPending && <p className="text-sm text-muted-foreground">Chargement de la fiche…</p>}
        {sheet.isError && <p className="text-sm text-destructive">Impossible de charger la fiche de cette adresse.</p>}
        {sheet.data && <SheetBody sheet={sheet.data} />}
      </div>
    </aside>
  )
}

function SheetBody({ sheet }: { sheet: Sheet }) {
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => cancelQualification(sheet.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["carte"] }).then(() =>
      queryClient.invalidateQueries({ queryKey: sheetKey(sheet.id) }),
    ),
  })

  return (
    <>
      {sheet.exclusion && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>
            Adresse exclue des itinéraires : <strong className="font-medium">{QUALIFICATION_LABELS[sheet.exclusion]}</strong>.
          </p>
          <Button size="sm" variant="outline" className="mt-2" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Annuler la qualification
          </Button>
          {cancel.isError && <p className="mt-1 text-destructive">L'annulation a échoué.</p>}
        </div>
      )}

      {sheet.commerce && <CommerceNotice sheet={sheet} commerce={sheet.commerce} />}

      <DwellingsField key={sheet.id} addressId={sheet.id} initial={sheet.dwellings} />

      <section aria-labelledby="sheet-voters" className="space-y-2">
        <h3 id="sheet-voters" className="text-sm font-medium">
          Inscrits ({sheet.voters.length})
        </h3>
        {sheet.voters.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun inscrit de la liste en vigueur à cette adresse.</p>
        ) : (
          <VotersTable voters={sheet.voters} />
        )}
      </section>

      <section aria-labelledby="sheet-visits" className="space-y-2">
        <h3 id="sheet-visits" className="text-sm font-medium">
          Retours de visite ({sheet.visits.length})
        </h3>
        {sheet.visits.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun passage enregistré.</p>
        ) : (
          <ol className="space-y-2">
            {sheet.visits.map((v) => (
              <VisitItem key={v.id} visit={v} addressId={sheet.id} />
            ))}
          </ol>
        )}
      </section>
    </>
  )
}

/** OpenStreetMap lists a shop front here: say which, and let the administrator say the address is lived in. */
function CommerceNotice({ sheet, commerce }: { sheet: Sheet; commerce: { kinds: string[]; dismissed: boolean } }) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (dismissed: boolean) => setCommerceDismissed(sheet.id, dismissed),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["carte"] }).then(() => queryClient.invalidateQueries({ queryKey: sheetKey(sheet.id) })),
  })
  const kinds = commerce.kinds.map(commerceLabel).join(", ")
  return (
    <div className="rounded-md border border-[#a0785a]/40 bg-[#a0785a]/10 p-3 text-sm">
      {commerce.dismissed ? (
        <p>OpenStreetMap recense ici : {kinds}. Vous avez indiqué que l'adresse est habitée.</p>
      ) : sheet.category === "commerce_probable" ? (
        <p>Commerce probable, hors des itinéraires. OpenStreetMap recense ici : {kinds}. Aucun inscrit n'y habite.</p>
      ) : (
        <p>OpenStreetMap recense aussi ici : {kinds}.</p>
      )}
      {(commerce.dismissed || sheet.category === "commerce_probable") && (
        <Button size="sm" variant="outline" className="mt-2" disabled={toggle.isPending} onClick={() => toggle.mutate(!commerce.dismissed)}>
          {commerce.dismissed ? "Revenir au commerce probable" : "L'adresse est habitée"}
        </Button>
      )}
      {toggle.isError && <p className="mt-1 text-destructive">La modification a échoué.</p>}
    </div>
  )
}

/** Number of dwellings typed, null when empty, undefined when not a valid count. */
function parseDwellings(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === "") return null
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 0 && value <= 999 ? value : undefined
}

function DwellingsField({ addressId, initial }: { addressId: string; initial: number | null }) {
  const id = useId()
  const queryClient = useQueryClient()
  const [text, setText] = useState(initial === null ? "" : String(initial))
  const autosave = useDebouncedSave(async (dwellings: number | null) => {
    await updateDwellings(addressId, dwellings)
    void queryClient.invalidateQueries({ queryKey: sheetKey(addressId) })
  }, SAVE_DELAY_MS)
  const valid = parseDwellings(text) !== undefined

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor={id} className="text-sm font-medium">
        Logements
      </label>
      <input
        id={id}
        inputMode="numeric"
        className="h-8 w-20 rounded-md border border-input bg-transparent px-2 text-sm tabular-nums shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
        aria-invalid={!valid}
        placeholder="?"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const dwellings = parseDwellings(e.target.value)
          if (dwellings === undefined) autosave.cancel()
          else autosave.schedule(dwellings)
        }}
      />
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {!valid
          ? "Nombre entier entre 0 et 999"
          : autosave.state === "error"
            ? "Échec de l'enregistrement"
            : autosave.state === "saved"
              ? "Enregistré"
              : "Nombre de logements de l'adresse, s'il est connu"}
      </span>
    </div>
  )
}

const VOTE_SHORT: Record<VoteValue, string> = { oui: "a voté", non: "abstention", illisible: "illisible" }

function voteCell(v: VoteValue | null) {
  if (v === null) return <span className="text-muted-foreground">-</span>
  return <span className={v === "non" ? "font-medium text-[color:var(--color-not-voted)]" : undefined}>{VOTE_SHORT[v]}</span>
}

function VotersTable({ voters }: { voters: SheetVoter[] }) {
  const withNames = voters.some((v) => v.birthName !== null)
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
          <tr>
            {withNames && <th className="px-2 py-1.5 font-medium">Nom</th>}
            <th className="px-2 py-1.5 font-medium">Âge</th>
            <th className="px-2 py-1.5 font-medium">Sexe</th>
            <th className="px-2 py-1.5 font-medium">Niveau</th>
            <th className="px-2 py-1.5 font-medium">T1 2026</th>
            <th className="px-2 py-1.5 font-medium">T2 2026</th>
            <th className="px-2 py-1.5 font-medium">Bureau</th>
          </tr>
        </thead>
        <tbody>
          {voters.map((v) => (
            <tr key={v.electorId} className="border-t align-top" data-testid="sheet-voter">
              {withNames && (
                <td className="px-2 py-1.5">
                  <span className="font-medium">{v.usageName ?? v.birthName}</span> {v.firstNames}
                  {v.usageName && <span className="block text-xs text-muted-foreground">née {v.birthName}</span>}
                </td>
              )}
              <td className="px-2 py-1.5 tabular-nums">{v.age ?? "?"}</td>
              <td className="px-2 py-1.5">{v.sex ?? "?"}</td>
              <td className="px-2 py-1.5">
                {VOTER_LEVEL_LABELS[v.level]}
                {!v.listTypes.includes("principale") && (
                  <span className="block text-xs text-muted-foreground">{v.listTypes.map((t) => LIST_TYPE_LABELS[t]).join(", ")}</span>
                )}
              </td>
              <td className="px-2 py-1.5">{voteCell(v.votes.t1)}</td>
              <td className="px-2 py-1.5">{voteCell(v.votes.t2)}</td>
              <td className="px-2 py-1.5 tabular-nums">{v.bureau}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const SOURCE_LABELS: Record<SheetVisit["source"], string> = { lien: "lien terrain", feuille: "feuille", admin: "saisie directe" }
const QUALITY_LABELS: Record<NonNullable<SheetVisit["contactQuality"]>, string> = {
  chaleureux: "chaleureux",
  poli: "poli",
  ferme: "fermé",
}

function VisitItem({ visit: v, addressId }: { visit: SheetVisit; addressId: string }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () => deleteVisit(v.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["carte"] }).then(() => queryClient.invalidateQueries({ queryKey: sheetKey(addressId) })),
  })
  const facts: string[] = []
  if (v.contact === "obtenu") facts.push(v.contactQuality ? `contact ${QUALITY_LABELS[v.contactQuality]}` : "contact obtenu")
  if (v.contact === "absent") facts.push("absent")
  if (v.toRevisit) facts.push("à revoir")
  if (v.toAccompany) facts.push("à accompagner")
  if (v.qualification) {
    const scope = v.qualification !== "annulation" && v.qualificationScope === "logement" ? " (un logement)" : ""
    facts.push(`${QUALIFICATION_LABELS[v.qualification]}${scope}`)
  }
  // A cancellation is the trace of a lifted qualification: it stays.
  const editable = v.qualification !== "annulation"
  return (
    <li className="rounded-md border px-3 py-2 text-sm" data-testid="sheet-visit">
      <p className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="font-medium tabular-nums">{formatDate(v.visitDate)}</span>
        <span className="text-xs text-muted-foreground">
          {SOURCE_LABELS[v.source]}
          {v.correctedAt !== null && ", corrigé"}
        </span>
      </p>
      {v.dwelling && <p className="text-muted-foreground">{v.dwelling}</p>}
      {facts.length > 0 && <p>{facts.join(", ")}</p>}
      {v.remarks && <p className="mt-1 whitespace-pre-line text-muted-foreground">{v.remarks}</p>}
      {editable && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          {v.itineraryId && (
            <Link to="/suivi" search={{ itineraire: v.itineraryId }} className="underline underline-offset-2">
              Corriger dans l'itinéraire
            </Link>
          )}
          {confirming ? (
            <>
              <span>Supprimer ce retour ?</span>
              <Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Supprimer
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Garder
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={() => setConfirming(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Supprimer
            </Button>
          )}
          {remove.isError && <span className="text-destructive">La suppression a échoué.</span>}
        </div>
      )}
    </li>
  )
}
