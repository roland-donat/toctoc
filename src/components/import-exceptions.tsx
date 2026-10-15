// Exceptions screen of the imports (U5): three work lists, each correction saved at once.
// Admin-only: shows bureau, order number and names as listed on the documents, never the birth place.
import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { errorLabel, numberFormat } from "@/lib/format"
import {
  addressSearchKey,
  attachRegistration,
  decideRowException,
  emargementStatusKey,
  fetchQueue,
  fetchRowExceptions,
  fetchUnknownElectors,
  queueKey,
  repStatusKey,
  rowExceptionsKey,
  searchAddresses,
  setRoundValue,
  unknownElectorsKey,
  VOTE_LABELS,
  VOTER_LEVEL_LABELS,
  type QueueItem,
  type RowExceptionItem,
  type UnknownElectorItem,
  type VoteValue,
  type VoterLevel,
} from "@/lib/imports-api"

const SEARCH_DELAY_MS = 300

const ERROR_LABELS: Record<string, string> = {
  exception_already_resolved: "Cette ligne a déjà été traitée.",
  unknown_address: "Cette adresse n'existe plus dans la BAN.",
}

function Remaining({ count, done }: { count: number; done: string }) {
  if (count === 0) return <Badge variant="secondary">{done}</Badge>
  return <Badge>{numberFormat.format(count)} restant{count > 1 ? "s" : ""}</Badge>
}

function names(p: { birthName: string; usageName: string | null; firstNames: string }): string {
  const usage = p.usageName !== null && p.usageName !== p.birthName ? ` (usage : ${p.usageName})` : ""
  return `${p.birthName}${usage}, ${p.firstNames}`
}

function place(bureau: string | null, orderNumber: number | null): string {
  return `Bureau ${bureau ?? "?"}, n° ${orderNumber ?? "?"}`
}

export function ImportExceptions() {
  return (
    <div className="space-y-10">
      <QueueList />
      <RowExceptionsList />
      <UnknownElectorsList />
    </div>
  )
}

// 1. Addresses to attach (U4 queue).

function rawAddress(item: QueueItem): string {
  return [item.rawNumber, item.rawStreet, item.rawLieuDit, item.rawComplement1, item.rawComplement2, item.rawPostalCode]
    .filter((p): p is string => p !== null && p !== "")
    .join(" ")
}

function QueueList() {
  const queue = useQuery({ queryKey: queueKey, queryFn: fetchQueue })
  const items = queue.data?.items ?? []
  return (
    <section aria-labelledby="queue-title" className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 id="queue-title" className="text-lg font-medium">
          Adresses à rattacher
        </h2>
        {queue.data && <Remaining count={items.length} done="Tout est rattaché" />}
      </div>
      <p className="text-sm text-muted-foreground">
        Inscriptions dont l'adresse n'a pas été trouvée dans la BAN. Choisissez l'adresse dans la liste de la voie.
      </p>
      <ul className="space-y-3">
        {items.map((item) => (
          <QueueEntry key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function QueueEntry({ item }: { item: QueueItem }) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState(item.rawStreet ?? item.rawLieuDit ?? "")
  const [debounced, setDebounced] = useState(query)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query])
  const results = useQuery({
    queryKey: addressSearchKey(debounced),
    queryFn: () => searchAddresses(debounced),
    enabled: debounced !== "",
  })
  const attach = useMutation({
    mutationFn: (addressId: string) => attachRegistration(item.id, addressId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queueKey })
      void queryClient.invalidateQueries({ queryKey: repStatusKey })
    },
  })
  const inputId = `queue-search-${item.id}`

  return (
    <li className="space-y-2 rounded-md border p-3">
      <p className="text-sm">
        <span className="text-muted-foreground">{place(item.bureau, item.orderNumber)} : </span>
        {rawAddress(item) || "adresse vide"}
      </p>
      {item.proposal && (
        <Button size="sm" variant="outline" disabled={attach.isPending} onClick={() => attach.mutate(item.proposal?.id ?? "")}>
          <Check />
          Accepter la proposition : {item.proposal.label}
        </Button>
      )}
      <label htmlFor={inputId} className="sr-only">
        Rechercher une adresse
      </label>
      <Input id={inputId} value={query} placeholder="Rechercher une adresse de Séné" onChange={(e) => setQuery(e.target.value)} />
      {results.data && results.data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucune adresse ne correspond.</p>
      )}
      {results.data && results.data.items.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border text-sm">
          {results.data.items.map((a) => (
            <li key={a.id} className="border-b last:border-0">
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                disabled={attach.isPending}
                onClick={() => attach.mutate(a.id)}
              >
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {attach.error && <p className="text-sm text-destructive">{errorLabel(attach.error, ERROR_LABELS)}</p>}
    </li>
  )
}

// 2. Name mismatches and discordant duplicates.

function RowExceptionsList() {
  const exceptions = useQuery({ queryKey: rowExceptionsKey, queryFn: fetchRowExceptions })
  const items = exceptions.data?.items ?? []
  const notFound = exceptions.data?.notFound ?? 0
  return (
    <section aria-labelledby="rows-title" className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 id="rows-title" className="text-lg font-medium">
          Écarts de nom et doublons
        </h2>
        {exceptions.data && <Remaining count={items.length} done="Rien à trancher" />}
      </div>
      <p className="text-sm text-muted-foreground">
        Accepter applique les votes de la ligne d'émargement à l'électeur de la liste ; rejeter l'écarte. Pour un doublon,
        accepter une ligne écarte les autres.
      </p>
      {notFound > 0 && (
        <p className="text-sm text-muted-foreground">
          {numberFormat.format(notFound)} ligne{notFound > 1 ? "s" : ""} sans électeur à ce bureau et ce numéro : les électeurs
          concernés figurent parmi les niveaux inconnus ci-dessous.
        </p>
      )}
      <ul className="space-y-3">
        {items.map((item) => (
          <RowExceptionEntry key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function RowExceptionEntry({ item }: { item: RowExceptionItem }) {
  const queryClient = useQueryClient()
  const decide = useMutation({
    mutationFn: (decision: "accepted" | "rejected") => decideRowException(item.id, decision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rowExceptionsKey })
      void queryClient.invalidateQueries({ queryKey: unknownElectorsKey })
      void queryClient.invalidateQueries({ queryKey: emargementStatusKey })
    },
  })
  return (
    <li className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{item.kind === "name_mismatch" ? "Écart de nom" : "Doublon aux votes différents"}</Badge>
        <span className="text-muted-foreground">{place(item.bureau, item.orderNumber)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Émargement</dt>
        <dd>
          {names(item.row)} ; 1er tour : {VOTE_LABELS[item.row.t1]}, 2nd tour : {VOTE_LABELS[item.row.t2]}
        </dd>
        <dt className="text-muted-foreground">Liste électorale</dt>
        <dd>{item.candidate ? names(item.candidate) : "aucun électeur proposé"}</dd>
      </dl>
      <div className="flex gap-2">
        <Button size="sm" disabled={decide.isPending || item.candidate === null} onClick={() => decide.mutate("accepted")}>
          <Check />
          Accepter
        </Button>
        <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("rejected")}>
          <X />
          Rejeter
        </Button>
      </div>
      {decide.error && <p className="text-destructive">{errorLabel(decide.error, ERROR_LABELS)}</p>}
    </li>
  )
}

// 3. Electors at the "inconnu" level.

type UnknownEntry = UnknownElectorItem & { level?: VoterLevel }

function UnknownElectorsList() {
  const unknown = useQuery({ queryKey: unknownElectorsKey, queryFn: fetchUnknownElectors })
  const items: UnknownEntry[] = unknown.data?.items ?? []
  // Corrected electors stay listed with their new level until the page is reloaded.
  const remaining = items.filter((i) => (i.level ?? "inconnu") === "inconnu").length
  return (
    <section aria-labelledby="unknown-title" className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 id="unknown-title" className="text-lg font-medium">
          Électeurs au niveau inconnu
        </h2>
        {unknown.data && <Remaining count={remaining} done="Tous les niveaux sont connus" />}
      </div>
      <p className="text-sm text-muted-foreground">
        Électeurs sans vote lisible sur l'émargement. Saisissez la valeur de chaque tour d'après le registre papier.
      </p>
      <ul className="space-y-3">
        {items.map((item) => (
          <UnknownEntryRow key={item.electorId} item={item} />
        ))}
      </ul>
    </section>
  )
}

const ROUNDS = [1, 2] as const
const VOTE_VALUES: readonly VoteValue[] = ["oui", "non", "illisible"]

function isVoteValue(value: string): value is VoteValue {
  return VOTE_VALUES.some((v) => v === value)
}

function UnknownEntryRow({ item }: { item: UnknownEntry }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: ({ round, value }: { round: 1 | 2; value: VoteValue }) => setRoundValue(item.electorId, round, value),
    onSuccess: (res, { round, value }) => {
      queryClient.setQueryData<{ items: UnknownEntry[] }>(unknownElectorsKey, (data) =>
        data === undefined
          ? data
          : {
              items: data.items.map((i) =>
                i.electorId === res.electorId ? { ...i, level: res.level, rounds: { ...i.rounds, [round]: value } } : i,
              ),
            },
      )
      void queryClient.invalidateQueries({ queryKey: emargementStatusKey })
    },
  })
  const level = item.level ?? "inconnu"
  return (
    <li className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{place(item.bureau, item.orderNumber)}</span>
        <span>{names(item)}</span>
        <Badge variant={level === "inconnu" ? "outline" : "secondary"}>{VOTER_LEVEL_LABELS[level]}</Badge>
      </div>
      <div className="flex flex-wrap gap-4">
        {ROUNDS.map((round) => {
          const id = `round-${item.electorId}-${round}`
          return (
            <div key={round} className="flex items-center gap-2">
              <label htmlFor={id}>{round === 1 ? "1er tour" : "2nd tour"}</label>
              <select
                id={id}
                className="h-8 rounded-md border bg-background px-2"
                value={item.rounds[round] ?? ""}
                disabled={save.isPending}
                onChange={(e) => {
                  const value = e.target.value
                  if (isVoteValue(value)) save.mutate({ round, value })
                }}
              >
                <option value="" disabled>
                  Non renseigné
                </option>
                {VOTE_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {VOTE_LABELS[v]}
                  </option>
                ))}
              </select>
            </div>
          )
        })}
      </div>
      {save.error && <p className="text-destructive">{errorLabel(save.error, ERROR_LABELS)}</p>}
    </li>
  )
}
