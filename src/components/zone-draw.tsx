import { useEffect } from "react"
import { CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, useMap, useMapEvents } from "react-leaflet"
import L from "leaflet"
import { Button } from "@/components/ui/button"
import { CATEGORY_COLORS, type MapAddress } from "@/lib/carte-api"
import type { LatLon } from "@/lib/itineraires-api"
import "./door-map.css"

const SENE_CENTER: L.LatLngTuple = [47.6195, -2.7375]
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>'

/** Clicks closer than this to the previous vertex are the two clicks of a double click, not new vertices. */
const DUPLICATE_PX = 8

export interface ZoneDrawValue {
  /** [lat, lon] vertices. */
  points: [number, number][]
  closed: boolean
  start: LatLon | null
}

export const EMPTY_ZONE: ZoneDrawValue = { points: [], closed: false, start: null }

export const startIcon = L.divIcon({
  className: "door-square-icon",
  html: '<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#4c0297;color:#fff;font:600 12px/1 sans-serif;border:2px solid #fff;box-shadow:0 0 0 1px #4c0297">D</span>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
})

interface DrawEventsProps {
  value: ZoneDrawValue
  /** False when the zone is a bureau: every click then places the start point. */
  drawPolygon: boolean
  onChange: (value: ZoneDrawValue) => void
}

function DrawEvents({ value, drawPolygon, onChange }: DrawEventsProps) {
  const map = useMapEvents({
    click(e) {
      const point: [number, number] = [e.latlng.lat, e.latlng.lng]
      if (drawPolygon && !value.closed) {
        const last = value.points.at(-1)
        if (last && map.latLngToContainerPoint(last).distanceTo(e.containerPoint) < DUPLICATE_PX) return
        onChange({ ...value, points: [...value.points, point] })
      } else {
        onChange({ ...value, start: { lat: point[0], lon: point[1] } })
      }
    },
    dblclick() {
      if (drawPolygon && !value.closed && value.points.length >= 3) onChange({ ...value, closed: true })
    },
  })
  return null
}

function FitTo({ points }: { points: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (points.length === 0) return
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 17 })
    // Only when the background doors first arrive, not on every redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.length === 0, map])
  return null
}

interface ZoneDrawMapProps {
  value: ZoneDrawValue
  onChange: (value: ZoneDrawValue) => void
  drawPolygon: boolean
  /** Doors drawn faintly behind the zone, to choose where to go. */
  doors: MapAddress[]
  /** Doors of the chosen bureau, highlighted. */
  highlighted?: ReadonlySet<string>
}

/**
 * Map to draw the zone of a new itinerary: click to add vertices, double-click or "Fermer la zone" to close it,
 * then click to place the start point (by default the centre of the zone).
 */
export function ZoneDrawMap({ value, onChange, drawPolygon, doors, highlighted }: ZoneDrawMapProps) {
  const fitPoints = highlighted && highlighted.size > 0
    ? doors.filter((d) => highlighted.has(d.id)).map((d): [number, number] => [d.lat, d.lon])
    : []
  return (
    <div className="relative h-full w-full">
      <MapContainer center={SENE_CENTER} zoom={15} preferCanvas doubleClickZoom={false} className="door-map" scrollWheelZoom>
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution={OSM_ATTRIBUTION}
          maxZoom={19}
          referrerPolicy="strict-origin"
        />
        <FitTo key={fitPoints.length === 0 ? "none" : "bureau"} points={fitPoints} />
        {doors.map((d) => {
          const on = highlighted?.has(d.id) ?? false
          return (
            <CircleMarker
              key={d.id}
              center={[d.lat, d.lon]}
              radius={on ? 4 : 2.5}
              interactive={false}
              pathOptions={{ stroke: false, fillColor: CATEGORY_COLORS[d.category], fillOpacity: on ? 0.9 : 0.45 }}
            />
          )
        })}
        {drawPolygon && value.closed && <Polygon positions={value.points} pathOptions={{ color: "#4c0297", weight: 2, fillOpacity: 0.08 }} />}
        {drawPolygon && !value.closed && value.points.length > 1 && (
          <Polyline positions={value.points} pathOptions={{ color: "#4c0297", weight: 2, dashArray: "6 4" }} />
        )}
        {drawPolygon &&
          !value.closed &&
          value.points.map((p, i) => (
            <CircleMarker key={i} center={p} radius={4} interactive={false} pathOptions={{ color: "#4c0297", fillColor: "#fff", fillOpacity: 1, weight: 2 }} />
          ))}
        {value.start && <Marker position={[value.start.lat, value.start.lon]} icon={startIcon} interactive={false} />}
        <DrawEvents value={value} drawPolygon={drawPolygon} onChange={onChange} />
      </MapContainer>
      {drawPolygon && (
        <div className="absolute top-2 right-2 z-[1000] flex gap-2">
          {!value.closed && (
            <Button size="sm" variant="secondary" disabled={value.points.length < 3} onClick={() => onChange({ ...value, closed: true })}>
              Fermer la zone
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={value.points.length === 0 && value.start === null} onClick={() => onChange(EMPTY_ZONE)}>
            Effacer
          </Button>
        </div>
      )}
    </div>
  )
}
