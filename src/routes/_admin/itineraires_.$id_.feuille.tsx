import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import L from "leaflet"
import { ArrowLeft, Printer } from "lucide-react"
import { useEffect, useMemo } from "react"
import { MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet"
import { Button } from "@/components/ui/button"
import { startIcon } from "@/components/zone-draw"
import "@/components/door-map.css"
import "@/styles/print.css"
import { ApiError } from "@/lib/api-client"
import { CONTACT_LABELS, CONTACTS, QUALIFICATION_LABELS, QUALIFICATIONS, QUALITIES, type Option } from "@/lib/feedback-options"
import { parisLongDateFormat } from "@/lib/format"
import { formatDate } from "@/lib/utils"
import {
  fetchItinerarySheet,
  formatDuration,
  itineraryErrorMessage,
  sheetKey,
  type ItinerarySheet,
  type PrintedVoter,
  type SheetCheatsheetGroup,
  type SheetDoor,
  type SheetPassage,
} from "@/lib/itineraires-api"

// Printable sheet of an itinerary (U13, R16, F3): the loop, the ordered doors with a box for each R18 field and
// lines for the dwelling and the remarks, then the cheat sheets once by age band. Names follow KTD7 at print time.
// Not nested under the detail page (trailing underscores): it has no outlet.
export const Route = createFileRoute("/_admin/itineraires_/$id_/feuille")({
  component: SheetPage,
})

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>'
const SHORT_DATE = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeZone: "Europe/Paris" })

const BAND_LABELS: Record<SheetCheatsheetGroup["ageBand"], string> = {
  "18-25": "18-25 ans",
  "26-40": "26-40 ans",
  "41-60": "41-60 ans",
  "61+": "61 ans et plus",
  generale: "Adresses sans inscrit",
}

const labels = (options: Option<string>[]): string[] => options.map((o) => o.label)

/** The R18 fields, as boxes to tick on paper. */
const BOX_GROUPS: string[][] = [
  labels(CONTACTS),
  labels(QUALITIES),
  ["À accompagner", "À revenir", "Foyer non inscrit"],
  labels(QUALIFICATIONS),
]

function numberIcon(n: number): L.DivIcon {
  return L.divIcon({
    className: "door-square-icon",
    html: `<span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#000;color:#fff;font:700 13px/1 sans-serif;border:2px solid #fff;box-shadow:0 0 0 1.5px #000">${n}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function FitOnce({ points }: { points: L.LatLngTuple[] }) {
  const map = useMap()
  useEffect(() => {
    if (points.length > 0) map.fitBounds(L.latLngBounds(points), { padding: [24, 24], maxZoom: 18 })
    // Once, when the sheet is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])
  return null
}

/** Static-looking map of the loop: numbered markers carry the order even if the tiles do not print. */
function SheetMap({ sheet }: { sheet: ItinerarySheet }) {
  const start: L.LatLngTuple = [sheet.start.lat, sheet.start.lon]
  const line = useMemo<L.LatLngTuple[]>(
    () => [start, ...sheet.doors.map((d): L.LatLngTuple => [d.lat, d.lon]), start],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet],
  )
  return (
    <MapContainer
      center={start}
      zoom={16}
      className="door-map sheet-map"
      zoomControl={false}
      attributionControl={false}
      dragging={false}
      scrollWheelZoom={false}
      doubleClickZoom={false}
      boxZoom={false}
      keyboard={false}
      touchZoom={false}
    >
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={OSM_ATTRIBUTION} maxZoom={19} referrerPolicy="strict-origin" />
      <FitOnce points={line} />
      <Polyline positions={line} pathOptions={{ color: "#000", weight: 2.5, opacity: 0.8 }} />
      <Marker position={start} icon={startIcon} interactive={false} />
      {sheet.doors.map((d) => (
        <Marker key={d.addressId} position={[d.lat, d.lon]} icon={numberIcon(d.number)} interactive={false} />
      ))}
    </MapContainer>
  )
}

function voterName(v: PrintedVoter): string {
  const surname = v.usageName ?? v.birthName ?? ""
  return [surname, v.firstNames].filter((p) => p && p.trim() !== "").join(" ")
}

function passageText(p: SheetPassage | null): string {
  if (!p) return "Jamais visitée"
  const parts = [
    p.contact ? CONTACT_LABELS[p.contact].toLowerCase() : null,
    p.toAccompany ? "à accompagner" : null,
    p.toRevisit ? "à revenir" : null,
    p.qualification ? QUALIFICATION_LABELS[p.qualification].toLowerCase() : null,
  ].filter((s): s is string => s !== null)
  const date = SHORT_DATE.format(new Date(`${p.visitDate}T12:00:00Z`))
  return parts.length > 0 ? `${date} : ${parts.join(", ")}` : date
}

/** Short state of a dwelling on paper: date and outcome of its latest feedback. */
function unitPassage(v: NonNullable<SheetDoor["units"][number]["lastVisit"]>): string {
  const outcome = v.contact === "obtenu" ? "contact" : v.contact === "absent" ? "absent" : "qualifié"
  return `${formatDate(v.visitDate)}, ${outcome}${v.toRevisit ? ", à revenir" : ""}`
}

function DoorRow({ door, namesShown }: { door: SheetDoor; namesShown: boolean }) {
  const names = namesShown ? door.voters.map(voterName).filter((n) => n !== "") : []
  return (
    <tr data-testid="sheet-door">
      <td className="num">{door.number}</td>
      <td>
        <div className="font-semibold" data-testid="sheet-door-label">
          {door.label}
        </div>
        <div className="small">
          {door.dwellings !== null ? `${door.dwellings} ${door.dwellings > 1 ? "logements" : "logement"}` : "Logements : ?"}
          {" · "}
          {door.ageBands.length > 0 ? door.ageBands.join(", ") : "sans inscrit ciblé"}
        </div>
        <div className="small">{passageText(door.lastPassage)}</div>
        {names.length > 0 && <div className="small">{names.join(" ; ")}</div>}
      </td>
      <td>
        <div className="choices">
          {BOX_GROUPS.map((group) => (
            <span key={group[0]} className="choice-group">
              {group.map((label) => (
                <span key={label} className="choice">
                  <span className="box" aria-hidden="true" />
                  {label}
                </span>
              ))}
            </span>
          ))}
        </div>
        {door.units.length > 0 && (
          <div className="units" data-testid="sheet-units">
            {door.units.map((u) => (
              <span key={u.id} className="choice">
                <span className="box" aria-hidden="true" />
                {u.label}
                {u.lastVisit && <span className="small"> ({unitPassage(u.lastVisit)})</span>}
              </span>
            ))}
          </div>
        )}
        <div className="write-lines">
          <span className="write-line dwelling">Logement :</span>
          <span className="write-line">Remarques :</span>
        </div>
      </td>
    </tr>
  )
}

function SheetPage() {
  const { id } = Route.useParams()
  // Always fetched afresh: the names rule is evaluated at print time (KTD7).
  const query = useQuery({ queryKey: sheetKey(id), queryFn: () => fetchItinerarySheet(id), staleTime: 0, gcTime: 0 })

  if (query.isError) {
    const code = query.error instanceof ApiError ? query.error.code : "error"
    return <p className="px-4 py-8 text-sm text-destructive">{itineraryErrorMessage(code)}</p>
  }
  const sheet = query.data
  if (!sheet) return <p className="px-4 py-8 text-sm text-muted-foreground">Chargement…</p>

  const title = sheet.name ?? `Itinéraire du ${parisLongDateFormat.format(new Date(sheet.createdAt))}`
  return (
    <main className="print-sheet py-4">
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <Link
          to="/itineraires/$id"
          params={{ id }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Itinéraire
        </Link>
        <Button type="button" className="ml-auto gap-2" onClick={() => window.print()}>
          <Printer className="h-4 w-4" />
          Imprimer
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          {sheet.namesShown
            ? "Les noms des inscrits figurent sur cette feuille : une feuille imprimée ne peut pas être rappelée."
            : "Feuille anonymisée : aucun nom n'y figure."}{" "}
          Le lieu de naissance n'y figure jamais.
        </p>
      </div>

      <header className="mb-2 space-y-0.5">
        <h1>{title}</h1>
        <p>
          {sheet.zoneLabel} · {sheet.doors.length} {sheet.doors.length > 1 ? "portes" : "porte"} · durée prévue{" "}
          {formatDuration(sheet.durationMinutes * 60)} (estimée {formatDuration(sheet.totalSeconds)}) · départ et retour au point D
        </p>
        <p>Date de la session : ........................ Binôme : ..................................................</p>
      </header>

      <SheetMap sheet={sheet} />

      <h2>Portes dans l'ordre de visite</h2>
      <table className="sheet-table" aria-label="Portes dans l'ordre de visite">
        <colgroup>
          <col style={{ width: "8mm" }} />
          <col style={{ width: "62mm" }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>N°</th>
            <th>Adresse, logements, âges, dernier passage</th>
            <th>Retour (cocher) et notes</th>
          </tr>
        </thead>
        <tbody>
          {sheet.doors.map((d) => (
            <DoorRow key={d.addressId} door={d} namesShown={sheet.namesShown} />
          ))}
        </tbody>
      </table>
      <p className="small mt-1">Une porte d'immeuble prend plusieurs retours : notez chaque logement au dos si besoin.</p>

      {sheet.cheatsheetGroups.length > 0 && (
        <section aria-label="Antisèches">
          <h2>Antisèches</h2>
          <div className="cheatsheets">
            {sheet.cheatsheetGroups.map((g) => (
              <div key={g.ageBand} className="cheatsheet-group">
                <h3 className="font-semibold">{BAND_LABELS[g.ageBand]}</h3>
                {g.sheets.map((s) => (
                  <div key={s.id}>
                    <p className="font-semibold">{s.title}</p>
                    <p className="cheatsheet-body">{s.body}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  )
}
