import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import L from "leaflet"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet"
import { LaitFraise, Tortue, Wordmark } from "@/components/brand"
import { FieldDoorCard } from "@/components/field-door-card"
import { InstallHint } from "@/components/install-hint"
import { startIcon } from "@/components/zone-draw"
import "@/components/door-map.css"
import { createFeedbackQueue, feedbackQueueKey, itemKey, type FeedbackEntry, type QueueItem, type QueueStorage } from "@/lib/feedback-queue"
import { forgetFieldToken, resolveFieldToken } from "@/lib/field-link"
import { createFeedbackSender, fetchLoop, LinkOverError, type FieldLoop } from "@/lib/terrain-api"

// Field page (U12, F2): opened from the private link on a phone, without an account, outside the admin layout.
// The token lives in the URL fragment and is sent in a header only. Nothing is cached in the browser except the
// local queue of feedback not yet acknowledged (KTD10) and the token of the round in progress, for the page
// installed on the home screen (src/lib/field-link.ts).

export const Route = createFileRoute("/terrain")({
  component: FieldPage,
})

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>'
const READ_REFRESH_MS = 5 * 60 * 1000
const RETRY_MS = 30 * 1000

function safeLocalStorage(): QueueStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function numberIcon(n: number, done: boolean): L.DivIcon {
  return L.divIcon({
    className: "door-square-icon",
    html: `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:${done ? "#047857" : "#4c0297"};color:#fff;font:700 14px/1 sans-serif;border:2px solid #fff;box-shadow:0 0 0 1px rgba(15,23,42,.7)">${n}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
}

function FitOnce({ points }: { points: L.LatLngTuple[] }) {
  const map = useMap()
  useEffect(() => {
    if (points.length > 0) map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 18 })
    // Once, when the loop is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])
  return null
}

/** The loop, read-only: start point, numbered doors (green once done), straight segments in visit order. */
function FieldMap({ loop, isDone }: { loop: FieldLoop; isDone: (addressId: string) => boolean }) {
  const start: L.LatLngTuple = [loop.start.lat, loop.start.lon]
  const line = useMemo<L.LatLngTuple[]>(
    () => [start, ...loop.doors.map((d): L.LatLngTuple => [d.lat, d.lon]), start],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loop],
  )
  return (
    <MapContainer center={start} zoom={16} className="door-map" scrollWheelZoom={false}>
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={OSM_ATTRIBUTION} maxZoom={19} referrerPolicy="strict-origin" />
      <FitOnce points={line} />
      <Polyline positions={line} pathOptions={{ color: "#4c0297", weight: 4, opacity: 0.75 }} />
      <Marker position={start} icon={startIcon} title="Point de départ et d'arrivée" />
      {loop.doors.map((d, i) => (
        <Marker
          key={d.addressId}
          position={[d.lat, d.lon]}
          icon={numberIcon(i + 1, isDone(d.addressId))}
          title={`${i + 1}. ${d.label}`}
          eventHandlers={{
            click: () => document.getElementById(`porte-${d.addressId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
          }}
        />
      ))}
    </MapContainer>
  )
}

const REFUSED_LABELS: Record<NonNullable<QueueItem["op"]> | "create", string> = {
  create: "",
  update: "correction : ",
  delete: "suppression : ",
}

function Ended({ noRound = false }: { noRound?: boolean }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-white px-6 text-center text-foreground">
      <Tortue className="h-12 w-auto text-primary" />
      {noRound ? (
        <>
          <h1 className="text-2xl font-bold">Aucune tournée en cours.</h1>
          <p className="text-base text-slate-700">Ouvrez le lien de tournée reçu de l'organisateur.</p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold">Lien terminé, contactez l'organisateur.</h1>
          <p className="text-base text-slate-700">Notez vos retours sur la feuille de secours.</p>
        </>
      )}
    </main>
  )
}

/** Makes the field page installable on the home screen, and only it: the admin screens keep no manifest. */
function useFieldManifest() {
  useEffect(() => {
    const link = document.createElement("link")
    link.rel = "manifest"
    link.href = "/terrain.webmanifest"
    document.head.appendChild(link)
    return () => link.remove()
  }, [])
}

function FieldPage() {
  useFieldManifest()
  // Read once: the fragment never leaves the browser.
  const [token] = useState(() => (typeof window === "undefined" ? null : resolveFieldToken(window.location.hash, safeLocalStorage())))
  if (!token) return <Ended noRound />
  return <FieldSession token={token} />
}

function FieldSession({ token }: { token: string }) {
  // The queue of this link lives under its own storage key (hash of the token), computed once.
  const [storageKey, setStorageKey] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void feedbackQueueKey(token).then((key) => {
      if (live) setStorageKey(key)
    })
    return () => {
      live = false
    }
  }, [token])
  if (storageKey === null) return <p className="px-4 py-8 text-base text-slate-700">Chargement des portes…</p>
  return <FieldQueueSession token={token} storageKey={storageKey} />
}

function FieldQueueSession({ token, storageKey }: { token: string; storageKey: string }) {
  // One queue for the page.
  const [queue] = useState(() =>
    createFeedbackQueue({ storage: safeLocalStorage(), storageKey, send: createFeedbackSender(token) }),
  )
  const queueItems = useSyncExternalStore(queue.subscribe, queue.items)
  // Feedback entered on this page, by door (memory only, gone on reload).
  const [entered, setEntered] = useState<Map<string, FeedbackEntry[]>>(new Map())

  useEffect(() => {
    void queue.flush()
    const retry = () => void queue.flush()
    window.addEventListener("online", retry)
    const timer = window.setInterval(retry, RETRY_MS)
    return () => {
      window.removeEventListener("online", retry)
      window.clearInterval(timer)
    }
  }, [queue])

  const loop = useQuery({
    queryKey: ["terrain", "itineraire"],
    queryFn: () => fetchLoop(token),
    retry: (count, err) => !(err instanceof LinkOverError) && count < 2,
    refetchInterval: READ_REFRESH_MS,
    staleTime: 0,
  })

  const linkOver = !loop.data && loop.error instanceof LinkOverError
  useEffect(() => {
    if (linkOver) forgetFieldToken(token, safeLocalStorage())
  }, [linkOver, token])

  const queueState = useMemo(() => new Map(queueItems.map((i) => [i.entry.id, i.status])), [queueItems])
  const pending = queueItems.filter((i) => i.status === "pending").length
  const refused = queueItems.filter((i) => i.status === "refused")

  const data = loop.data
  if (!data) {
    if (loop.error instanceof LinkOverError) return <Ended />
    if (loop.isError) {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center text-foreground">
          <h1 className="text-xl font-bold">Impossible de charger les portes.</h1>
          <p className="text-base">Vérifiez le réseau puis réessayez.</p>
          <button type="button" className="min-h-12 rounded-lg bg-primary px-6 text-base font-semibold text-white" onClick={() => void loop.refetch()}>
            Réessayer
          </button>
        </main>
      )
    }
    return <p className="px-4 py-8 text-base text-slate-700">Chargement des portes…</p>
  }

  // A read refused after the doors were loaded: grace period, entry only (lifecycle of the design).
  const readOver = loop.error instanceof LinkOverError
  // A feedback refused by the server while the link was over: nothing more can be sent.
  const writeOver = readOver && refused.length > 0
  const isDone = (addressId: string) =>
    (entered.get(addressId)?.length ?? 0) > 0 || data.doors.some((d) => d.addressId === addressId && d.done)
  const doneCount = data.doors.filter((d) => isDone(d.addressId)).length

  function submit(entry: FeedbackEntry) {
    setEntered((prev) => {
      const next = new Map(prev)
      next.set(entry.addressId, [...(next.get(entry.addressId) ?? []), entry])
      return next
    })
    void queue.add(entry)
  }

  function correct(entry: FeedbackEntry) {
    setEntered((prev) => {
      const next = new Map(prev)
      next.set(entry.addressId, (next.get(entry.addressId) ?? []).map((e) => (e.id === entry.id ? entry : e)))
      return next
    })
    void queue.correct(entry)
  }

  function remove(entry: FeedbackEntry) {
    setEntered((prev) => {
      const next = new Map(prev)
      next.set(entry.addressId, (next.get(entry.addressId) ?? []).filter((e) => e.id !== entry.id))
      return next
    })
    // The door may no longer be done for the server either: read the loop again once the removal is through.
    void queue.remove(entry).then(() => loop.refetch())
  }

  return (
    <main className="mx-auto max-w-xl space-y-4 bg-muted px-3 pb-24 pt-4 text-foreground">
      <header className="space-y-1">
        <div className="-mx-3 -mt-4 mb-3 flex items-center justify-between bg-primary px-3 py-2.5 text-primary-foreground [--tortue-hole:var(--color-primary)]">
          <Wordmark className="text-lg" />
          <span className="text-sm font-semibold">Porte-à-porte</span>
        </div>
        <h1 className="sr-only">Porte-à-porte</h1>
        <p className="text-lg font-semibold" data-testid="field-progress">
          {doneCount} {doneCount > 1 ? "portes faites" : "porte faite"} sur {data.doors.length}
        </p>
        {pending > 0 && (
          <p className="text-base font-semibold text-amber-800" data-testid="field-pending">
            {pending} {pending > 1 ? "retours en attente" : "retour en attente"} d'envoi
          </p>
        )}
      </header>

      <InstallHint />

      {doneCount === data.doors.length && data.doors.length > 0 && (
        <p role="status" className="flex items-center gap-3 rounded-lg border-2 border-brand-rose bg-white p-3 text-base font-semibold">
          <LaitFraise className="h-10 w-auto shrink-0" />
          <span>
            Tournée bouclée, bravo ! Le lait fraise est mérité.
            <span className="block font-serif text-sm font-normal text-slate-700">Lentement mais sûrement, comme la tortue.</span>
          </span>
        </p>
      )}

      {writeOver ? (
        <p role="alert" className="rounded-lg border-2 border-red-700 bg-white p-3 text-base font-semibold text-red-800">
          Lien terminé, contactez l'organisateur. Reportez sur la feuille les retours non transmis.
        </p>
      ) : (
        readOver && (
          <p role="status" className="rounded-lg border-2 border-amber-700 bg-white p-3 text-base font-semibold text-amber-900">
            Saisie seule : la session est terminée, vos retours sont encore acceptés pendant quelques heures.
          </p>
        )
      )}

      {refused.length > 0 && (
        <section aria-label="Retours non transmis" className="space-y-2 rounded-lg border-2 border-red-700 bg-white p-3">
          <h2 className="text-base font-bold text-red-800">Non transmis, à reporter sur la feuille</h2>
          <ul className="space-y-2">
            {refused.map((i) => (
              <li key={itemKey(i)} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {REFUSED_LABELS[i.op ?? "create"]}
                  {data.doors.find((d) => d.addressId === i.entry.addressId)?.label ?? "Adresse"}
                  {i.entry.dwelling ? `, ${i.entry.dwelling}` : ""}
                </span>
                <button
                  type="button"
                  className="min-h-11 rounded-md border-2 border-slate-400 px-3 font-semibold"
                  onClick={() => queue.dismiss(itemKey(i))}
                >
                  Reporté
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="h-[45vh] min-h-[280px] overflow-hidden rounded-xl border-2 border-slate-300" data-testid="field-map">
        <FieldMap loop={data} isDone={isDone} />
      </div>

      <ol className="space-y-3" aria-label="Portes dans l'ordre de visite">
        {data.doors.map((d, i) => (
          <li key={d.addressId}>
            <FieldDoorCard
              door={d}
              index={i}
              entered={entered.get(d.addressId) ?? []}
              queueState={queueState}
              canEnter={!writeOver}
              onSubmit={submit}
              onCorrect={correct}
              onRemove={remove}
            />
          </li>
        ))}
      </ol>
    </main>
  )
}
