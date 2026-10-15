import { useEffect, useMemo } from "react"
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet"
import L from "leaflet"
import { Button } from "@/components/ui/button"
import { CATEGORY_COLORS, CATEGORY_LABELS, type MapAddress } from "@/lib/carte-api"
import type { ItineraryDetail } from "@/lib/itineraires-api"
import { startIcon } from "./zone-draw"
import "./door-map.css"

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>'

function numberIcon(n: number, color: string, manual: boolean): L.DivIcon {
  return L.divIcon({
    className: "door-square-icon",
    html: `<span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:${color};color:#fff;font:600 11px/1 sans-serif;border:2px ${manual ? "dashed" : "solid"} #fff;box-shadow:0 0 0 1px rgba(17,24,39,.6)">${n}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function FitToLoop({ points, fitKey }: { points: L.LatLngTuple[]; fitKey: string }) {
  const map = useMap()
  useEffect(() => {
    if (points.length === 0) return
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 18 })
    // Once per itinerary, not after each adjustment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map])
  return null
}

interface RouteMapProps {
  itinerary: ItineraryDetail
  /** Other numbered doors, which can be added by hand. */
  others: MapAddress[]
  busy: boolean
  onRemove: (addressId: string) => void
  onAdd: (addressId: string) => void
}

/** The loop in visit order: start point, numbered doors and straight segments between consecutive stops. */
export function RouteMap({ itinerary, others, busy, onRemove, onAdd }: RouteMapProps) {
  const start: L.LatLngTuple = [itinerary.start.lat, itinerary.start.lon]
  const loop = useMemo<L.LatLngTuple[]>(
    () => [start, ...itinerary.doors.map((d): L.LatLngTuple => [d.lat, d.lon]), start],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itinerary],
  )
  const inLoop = new Set(itinerary.doors.map((d) => d.addressId))
  return (
    <MapContainer center={start} zoom={16} preferCanvas className="door-map" scrollWheelZoom>
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={OSM_ATTRIBUTION} maxZoom={19} referrerPolicy="strict-origin" />
      <FitToLoop points={loop} fitKey={itinerary.id} />
      {others
        .filter((o) => !inLoop.has(o.id))
        .map((o) => (
          <CircleMarker key={o.id} center={[o.lat, o.lon]} radius={3.5} pathOptions={{ stroke: false, fillColor: CATEGORY_COLORS[o.category], fillOpacity: 0.5 }}>
            <Popup>
              <p className="font-medium">{o.label}</p>
              <p className="text-xs text-muted-foreground">{CATEGORY_LABELS[o.category]}</p>
              <Button size="sm" className="mt-2" disabled={busy} onClick={() => onAdd(o.id)}>
                Ajouter à l'itinéraire
              </Button>
            </Popup>
          </CircleMarker>
        ))}
      <Polyline positions={loop} pathOptions={{ color: "#4c0297", weight: 3, opacity: 0.7 }} />
      <Marker position={start} icon={startIcon} title="Point de départ et d'arrivée" />
      {itinerary.doors.map((d, i) => (
        <Marker key={d.addressId} position={[d.lat, d.lon]} icon={numberIcon(i + 1, CATEGORY_COLORS[d.category], d.manual)} title={`${i + 1}. ${d.label}`}>
          <Popup>
            <p className="font-medium">
              {i + 1}. {d.label}
            </p>
            <p className="text-xs text-muted-foreground">{CATEGORY_LABELS[d.category]}</p>
            <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => onRemove(d.addressId)}>
              Retirer de l'itinéraire
            </Button>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  )
}
