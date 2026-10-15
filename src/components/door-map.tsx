import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { CircleMarker, MapContainer, Marker, TileLayer, useMap } from "react-leaflet"
import { createElementObject, createPathComponent, extendContext, updateCircle, type PathProps } from "@react-leaflet/core"
import L from "leaflet"
import { CATEGORY_COLORS, type Category, type FollowUp, type MapAddress } from "@/lib/carte-api"
import { doorPoints, radiusFor, VOTER_GROUP_COLORS, VOTER_GROUP_LABELS, VOTER_GROUPS, type DoorPoint } from "@/lib/door-symbols"
import "./door-map.css"

// Séné town hall area; the view fits the doors as soon as they load.
const SENE_CENTER: L.LatLngTuple = [47.6195, -2.7375]

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>'

interface DoorMapProps {
  addresses: MapAddress[]
  /** Changes when the filters change: the view then fits the matching doors. */
  fitKey: string
  selectedId: string | null
  onSelect: (id: string) => void
}

function FitToDoors({ addresses, fitKey }: { addresses: MapAddress[]; fitKey: string }) {
  const map = useMap()
  useEffect(() => {
    if (addresses.length === 0) return
    const bounds = L.latLngBounds(addresses.map((a) => [a.lat, a.lon] as L.LatLngTuple))
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 })
    // Only on a new filter set, not on every refetch of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, addresses.length === 0, map])
  return null
}

/** Leaflet 1.9 internals the offset circle relies on: the canvas renderer draws and hit-tests at `_point`. */
interface ProjectedCircle {
  _point: L.Point
  _project(): void
  _updateBounds(): void
}

/** Circle marker drawn a few pixels away from its position, so the points of one door sit side by side at any zoom. */
class OffsetCircleMarker extends L.CircleMarker {
  private readonly pixelOffset: L.Point
  constructor(latlng: L.LatLngExpression, options: L.CircleMarkerOptions & { pixelOffset: readonly [number, number] }) {
    super(latlng, options)
    this.pixelOffset = L.point(options.pixelOffset[0], options.pixelOffset[1])
  }
  _project(): void {
    const self = this as unknown as ProjectedCircle
    ;(L.CircleMarker.prototype as unknown as ProjectedCircle)._project.call(this)
    self._point = self._point.add(this.pixelOffset)
    self._updateBounds()
  }
}

interface OffsetCircleProps extends L.CircleMarkerOptions, PathProps {
  center: L.LatLngExpression
  radius: number
  /** Read at creation only: change the key to move the point. */
  offset: readonly [number, number]
}

const OffsetCircle = createPathComponent<OffsetCircleMarker, OffsetCircleProps>(function createOffsetCircle(
  { center, offset, ...options },
  ctx,
) {
  const marker = new OffsetCircleMarker(center, { ...options, pixelOffset: offset })
  return createElementObject(marker, extendContext(ctx, { overlayContainer: marker }))
}, updateCircle)

/** Square for "visitée récemment", sized like the circle it replaces and shifted by the same offset. */
function squareIcon(point: DoorPoint, selected: boolean): L.DivIcon {
  const border = selected ? 3 : 1.5
  const side = Math.round(point.radius * 1.8 + border * 2)
  return L.divIcon({
    className: "door-square-icon",
    html: `<span class="door-square${selected ? " door-square-selected" : ""}" style="background:${point.color};width:${side}px;height:${side}px"></span>`,
    iconSize: [side, side],
    iconAnchor: [side / 2 - point.offset[0], side / 2 - point.offset[1]],
  })
}

/** Circle styles: filled for "jamais visitée", ring for "à revoir", faded smaller disc for an old visit. */
function circleStyle(point: DoorPoint, followUp: Exclude<FollowUp, "visitee_recemment">, selected: boolean) {
  const outline = selected ? "#111827" : "#ffffff"
  const base = { color: outline, weight: selected ? 3 : 1.5 }
  switch (followUp) {
    case "a_revoir":
      return { radius: point.radius + 0.5, pathOptions: { color: selected ? "#111827" : point.color, weight: 3.5, fillColor: "#ffffff", fillOpacity: 1 } }
    case "visitee":
      return { radius: point.radius * 0.8, pathOptions: { ...base, fillColor: point.color, fillOpacity: 0.45 } }
    case "jamais_visitee":
      return { radius: point.radius, pathOptions: { ...base, fillColor: point.color, fillOpacity: 0.9 } }
  }
}

const ANCHOR_STYLE: L.PathOptions = { color: "#ffffff", weight: 1, fillColor: "#111827", fillOpacity: 1 }

interface DoorMarkerProps {
  address: MapAddress
  selected: boolean
  onSelect: (id: string) => void
}

/**
 * One door, as one point per voting behavior present (see door-symbols). Memoized: with thousands of doors, only the
 * markers whose props changed are touched again.
 */
const DoorMarker = memo(function DoorMarker({ address: a, selected, onSelect }: DoorMarkerProps) {
  const position = useMemo<L.LatLngTuple>(() => [a.lat, a.lon], [a.lat, a.lon])
  const eventHandlers = useMemo(() => ({ click: () => onSelect(a.id) }), [a.id, onSelect])
  const points = useMemo(() => doorPoints(a), [a])
  const title = `${a.label} : ${a.registeredCount} ${a.registeredCount > 1 ? "inscrits" : "inscrit"}`
  return (
    <>
      {points.map((p) => {
        const key = `${p.key}:${p.offset.join(",")}`
        if (a.followUp === "visitee_recemment") {
          return <Marker key={key} position={position} icon={squareIcon(p, selected)} title={title} eventHandlers={eventHandlers} />
        }
        const style = circleStyle(p, a.followUp, selected)
        return (
          <OffsetCircle
            key={key}
            center={position}
            offset={p.offset}
            radius={style.radius}
            pathOptions={style.pathOptions}
            eventHandlers={eventHandlers}
          />
        )
      })}
      {/* Spread points: a small dark dot marks the address itself, and a click on it opens the door too. */}
      {points.length > 1 && (
        <CircleMarker center={position} radius={2.5} pathOptions={ANCHOR_STYLE} eventHandlers={eventHandlers} />
      )}
    </>
  )
})

export function DoorMap({ addresses, fitKey, selectedId, onSelect }: DoorMapProps) {
  // The parent may pass a new callback on every render; the markers get a stable one so they stay memoized.
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])
  const select = useCallback((id: string) => onSelectRef.current(id), [])
  const selected = useMemo(() => addresses.find((a) => a.id === selectedId) ?? null, [addresses, selectedId])

  return (
    <MapContainer center={SENE_CENTER} zoom={14} preferCanvas className="door-map" scrollWheelZoom>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution={OSM_ATTRIBUTION}
        maxZoom={19}
        // OSM refuses tile requests without a Referer; the page itself keeps no-referrer.
        referrerPolicy="strict-origin"
      />
      <FitToDoors addresses={addresses} fitKey={fitKey} />
      {addresses.map((a) => (a.id === selectedId ? null : <DoorMarker key={a.id} address={a} selected={false} onSelect={select} />))}
      {/* Selected door drawn last, so it stays on top. */}
      {selected && <DoorMarker key={`selected:${selected.id}`} address={selected} selected onSelect={select} />}
    </MapContainer>
  )
}

/** Legend symbol, drawn like the marker: color for the category, shape for the follow-up state. */
export function DoorSymbol({ category, followUp }: { category?: Category; followUp?: FollowUp }) {
  const color = category ? CATEGORY_COLORS[category] : "#6b7280"
  const state = followUp ?? "jamais_visitee"
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      {state === "jamais_visitee" && <circle cx="8" cy="8" r="6" fill={color} stroke="#fff" strokeWidth="1.5" />}
      {state === "a_revoir" && <circle cx="8" cy="8" r="5.5" fill="#fff" stroke={color} strokeWidth="3" />}
      {state === "visitee_recemment" && <rect x="3" y="3" width="10" height="10" fill={color} stroke="#fff" strokeWidth="1.5" />}
      {state === "visitee" && <circle cx="8" cy="8" r="4.5" fill={color} fillOpacity="0.45" stroke="#fff" strokeWidth="1.5" />}
    </svg>
  )
}

/** How a door reads: one point per voting behavior, its area following the number of electors. */
export function DoorPointsLegend() {
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground" data-testid="door-points-legend">
      <div className="flex items-end gap-2" aria-hidden="true">
        {[1, 4, 16].map((n) => {
          const r = radiusFor(n)
          return (
            <svg key={n} width={2 * r + 2} height={2 * r + 2} className="shrink-0">
              <circle cx={r + 1} cy={r + 1} r={r} fill={VOTER_GROUP_COLORS.votants} fillOpacity="0.9" stroke="#fff" strokeWidth="1.5" />
            </svg>
          )
        })}
        <svg width="40" height="20" className="shrink-0">
          <circle cx="10" cy="10" r={radiusFor(2) - 0.5} fill={VOTER_GROUP_COLORS.abstention_forte} stroke="#fff" strokeWidth="1.5" />
          <circle cx="26" cy="10" r={radiusFor(3) - 1} fill={VOTER_GROUP_COLORS.votants} stroke="#fff" strokeWidth="1.5" />
        </svg>
      </div>
      <p>
        La surface d'un point suit le nombre d'inscrits (1, 4, 16). Une adresse où cohabitent plusieurs comportements de vote
        montre un point par comportement : {VOTER_GROUPS.map((g) => VOTER_GROUP_LABELS[g].toLowerCase()).join(", ")}.
      </p>
    </div>
  )
}
