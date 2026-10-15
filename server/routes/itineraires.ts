// Itineraries (U11, R12 to R14): generation from a zone and a duration, list, detail, door adjustments; printable
// sheet and paper re-entry (U13, R16, R19, F3).
import { and, eq, ne } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { UnitView } from "../services/dwelling-units.ts"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import type { AgeBand } from "../db/schema/cheatsheets.ts"
import { itineraries, itineraryDoors, visits } from "../db/schema/index.ts"
import { anonymizationMode, anonymize, namesAllowed } from "../domain/anonymize.ts"
import { isoDateSchema, listItineraryVisits, recordVisit, visitInputSchema } from "../services/visits.ts"
import { fieldLinkState, issueFieldLink, latestFieldLink, revokeFieldLinks, type FieldLinkState } from "../lib/tokens.ts"
import {
  addDoor,
  defaultRouteDeps,
  DURATIONS,
  generateItinerary,
  getItinerary,
  ItineraryError,
  listItineraries,
  NoCandidateError,
  removeDoor,
  type ItineraryErrorCode,
  type RouteDeps,
} from "../services/route-builder.ts"
import { RoutingUnavailableError } from "../services/routing-client.ts"
import { canvassDoors, orderedCheatsheets, type DoorPassage, type DoorVoter } from "../services/field-doors.ts"

const latLon = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
const vertex = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])

const generateSchema = z.object({
  zone: z.discriminatedUnion("type", [
    z.object({ type: z.literal("polygon"), points: z.array(vertex).min(3).max(200) }),
    z.object({ type: z.literal("bureau"), bureau: z.string().min(1).max(10) }),
  ]),
  start: latLon.nullish(),
  durationMinutes: z.union([z.literal(DURATIONS[0]), z.literal(DURATIONS[1]), z.literal(DURATIONS[2])]),
})

const addDoorSchema = z.object({ addressId: z.string().min(1).max(100) })

const showNamesSchema = z.object({ showNames: z.boolean() }).strict()

/** State of the current field link of an itinerary; the token itself is never readable back (KTD6). */
export interface FieldLinkView {
  link: { issuedAt: number; expiresAt: number; revokedAt: number | null; state: FieldLinkState } | null
  /** Per-itinerary permission (R25), off by default. */
  showNames: boolean
  /** The global switch is on "nominatif": without it the permission has no effect (KTD7). */
  namesAvailable: boolean
}

function linkView(ctx: AppContext, id: string): FieldLinkView | null {
  const it = ctx.db.select({ showNames: itineraries.showNames }).from(itineraries).where(eq(itineraries.id, id)).get()
  if (!it) return null
  const link = latestFieldLink(ctx, id)
  return {
    link: link
      ? { issuedAt: link.issuedAt, expiresAt: link.expiresAt, revokedAt: link.revokedAt, state: fieldLinkState(link, ctx.now()) }
      : null,
    showNames: it.showNames,
    namesAvailable: anonymizationMode(ctx.db) === "nominatif",
  }
}

/** Names of a targeted voter on the sheet; never the birthplace (R25). */
export type SheetVoter = DoorVoter
export type SheetPassage = DoorPassage

export interface SheetDoor {
  /** Number printed on the map and in the table, 1 for the first door of the loop. */
  number: number
  addressId: string
  label: string
  lat: number
  lon: number
  dwellings: number | null
  /** Age bands of the targeted voters (hors cible excluded). */
  ageBands: AgeBand[]
  lastPassage: SheetPassage | null
  /** Dwellings of the building, printed as lines to tick (15/10/2026). */
  units: UnitView[]
  /** Empty unless names are allowed for this itinerary at print time (KTD7). */
  voters: SheetVoter[]
}

export interface SheetCheatsheetGroup {
  ageBand: AgeBand | "generale"
  sheets: { id: string; title: string; body: string }[]
}

/** Print payload of an itinerary (R16): the loop, the ordered doors and the cheat sheets once, by age band. */
export interface ItinerarySheet {
  id: string
  name: string | null
  createdAt: number
  zoneLabel: string
  durationMinutes: number
  totalSeconds: number
  start: { lat: number; lon: number }
  namesShown: boolean
  doors: SheetDoor[]
  cheatsheetGroups: SheetCheatsheetGroup[]
}

function buildSheet(ctx: AppContext, id: string): ItinerarySheet | null {
  const it = ctx.db.select().from(itineraries).where(eq(itineraries.id, id)).get()
  const detail = it ? getItinerary(ctx, id) : null
  if (!it || !detail) return null
  // Evaluated now, at print time: a printed sheet cannot be recalled (KTD7).
  const allowed = namesAllowed(ctx, { itineraryShowNames: it.showNames })
  const doors = canvassDoors(ctx, id, { namesAllowed: allowed })
  // The cheat sheets of every door (R21), each printed once in its age band group.
  const used = new Set(doors.flatMap((d) => d.cheatsheets.map((s) => s.id)))
  const groups: SheetCheatsheetGroup[] = []
  for (const s of orderedCheatsheets(ctx)) {
    if (!used.has(s.id)) continue
    const group = groups.at(-1)?.ageBand === s.ageBand ? groups.at(-1) : undefined
    const entry = { id: s.id, title: s.title, body: s.body }
    if (group) group.sheets.push(entry)
    else groups.push({ ageBand: s.ageBand, sheets: [entry] })
  }
  const sheet: ItinerarySheet = {
    id: it.id,
    name: it.name,
    createdAt: it.createdAt,
    zoneLabel: detail.zoneLabel,
    durationMinutes: it.durationMinutes,
    totalSeconds: it.totalSeconds,
    start: { lat: it.startLat, lon: it.startLon },
    namesShown: allowed,
    doors: doors.map((d, i) => ({
      number: i + 1,
      addressId: d.addressId,
      label: d.label,
      lat: d.lat,
      lon: d.lon,
      dwellings: d.dwellings,
      ageBands: d.ageBands,
      lastPassage: d.lastPassage,
      units: d.units,
      voters: d.voters,
    })),
    cheatsheetGroups: groups,
  }
  // Second guard on the names, evaluated now (KTD7).
  return anonymize(sheet, allowed)
}

/** One feedback noted on the paper sheet; the date is the session's, the source and the itinerary are implied. */
const paperFeedbackSchema = visitInputSchema.omit({ source: true, itineraryId: true, visitDate: true }).strict()

const reentrySchema = z
  .object({
    /** Date of the session, entered once for the whole sheet (F3). */
    visitDate: isoDateSchema,
    feedbacks: z.array(paperFeedbackSchema).min(1).max(500),
  })
  .strict()

export interface ReentryResult {
  id: string
  /** False when this id was already recorded: a resend never duplicates (KTD10). */
  created: boolean
  /** A feedback from the phone link exists for the same door and the same date; both are kept. */
  possibleDuplicate: boolean
}

const STATUS: Record<ItineraryErrorCode, 404 | 409 | 422> = {
  itinerary_not_found: 404,
  address_not_found: 404,
  door_not_found: 404,
  door_already_present: 409,
  door_unreachable: 422,
}

/** Mounted at /api/itineraires. */
export function itinerairesRoutes(ctx: AppContext, deps: RouteDeps = defaultRouteDeps(ctx)): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof RoutingUnavailableError) return c.json({ error: "routing_unavailable" }, 503)
    if (err instanceof NoCandidateError) return c.json({ error: "no_candidate" }, 422)
    if (err instanceof ItineraryError) return c.json({ error: err.code }, STATUS[err.code])
    throw err
  })

  app.get("/", (c) => c.json({ itineraries: listItineraries(ctx) }))

  app.post("/", async (c) => {
    const parsed = generateSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    return c.json(await generateItinerary(ctx, parsed.data, deps), 201)
  })

  app.get("/:id", (c) => {
    const detail = getItinerary(ctx, c.req.param("id"))
    if (!detail) return c.json({ error: "itinerary_not_found" }, 404)
    return c.json(detail)
  })

  app.get("/:id/feuille", (c) => {
    const sheet = buildSheet(ctx, c.req.param("id"))
    return sheet ? c.json(sheet) : c.json({ error: "itinerary_not_found" }, 404)
  })

  // Feedbacks already recorded through this itinerary, for their correction on the re-entry screen.
  app.get("/:id/retours", (c) => {
    const id = c.req.param("id")
    const it = ctx.db.select({ id: itineraries.id }).from(itineraries).where(eq(itineraries.id, id)).get()
    if (!it) return c.json({ error: "itinerary_not_found" }, 404)
    const allowed = namesAllowed(ctx)
    return c.json({ namesShown: allowed, visits: anonymize(listItineraryVisits(ctx.db, id), allowed) })
  })

  // Paper re-entry (R19, F3): each feedback recorded with source "feuille" and the session date.
  app.post("/:id/ressaisie", async (c) => {
    const parsed = reentrySchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const id = c.req.param("id")
    const it = ctx.db.select({ id: itineraries.id }).from(itineraries).where(eq(itineraries.id, id)).get()
    if (!it) return c.json({ error: "itinerary_not_found" }, 404)
    const doors = new Set(
      ctx.db
        .select({ addressId: itineraryDoors.addressId })
        .from(itineraryDoors)
        .where(eq(itineraryDoors.itineraryId, id))
        .all()
        .map((d) => d.addressId),
    )
    const { visitDate, feedbacks } = parsed.data
    // Nothing is recorded when one door is not on the sheet.
    if (feedbacks.some((f) => !doors.has(f.addressId))) return c.json({ error: "door_not_found" }, 404)
    const results: ReentryResult[] = ctx.db.transaction(() =>
      feedbacks.map((f) => {
        const { visit, created } = recordVisit(ctx, { ...f, source: "feuille", itineraryId: id, visitDate })
        const phone = ctx.db
          .select({ id: visits.id })
          .from(visits)
          .where(and(eq(visits.addressId, visit.addressId), eq(visits.visitDate, visit.visitDate), eq(visits.source, "lien"), ne(visits.id, visit.id)))
          .get()
        return { id: visit.id, created, possibleDuplicate: phone !== undefined }
      }),
    )
    return c.json({ results })
  })

  app.get("/:id/lien", (c) => {
    const view = linkView(ctx, c.req.param("id"))
    return view ? c.json(view) : c.json({ error: "itinerary_not_found" }, 404)
  })

  // Issues a new link (revoking the previous one) and returns its full URL, the only time the token is shown.
  app.post("/:id/lien", (c) => {
    const id = c.req.param("id")
    if (!linkView(ctx, id)) return c.json({ error: "itinerary_not_found" }, 404)
    const { token } = issueFieldLink(ctx, id)
    const url = `${new URL(ctx.config.publicOrigin).origin}/terrain#${token}`
    return c.json({ url, ...linkView(ctx, id) }, 201)
  })

  app.delete("/:id/lien", (c) => {
    const id = c.req.param("id")
    if (!linkView(ctx, id)) return c.json({ error: "itinerary_not_found" }, 404)
    revokeFieldLinks(ctx, id)
    return c.json(linkView(ctx, id))
  })

  app.put("/:id/noms", async (c) => {
    const parsed = showNamesSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const id = c.req.param("id")
    const updated = ctx.db.update(itineraries).set({ showNames: parsed.data.showNames }).where(eq(itineraries.id, id)).returning().all()
    if (updated.length === 0) return c.json({ error: "itinerary_not_found" }, 404)
    return c.json(linkView(ctx, id))
  })

  app.post("/:id/portes", async (c) => {
    const parsed = addDoorSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    return c.json(await addDoor(ctx, c.req.param("id"), parsed.data.addressId, deps))
  })

  app.delete("/:id/portes/:addressId", async (c) =>
    c.json(await removeDoor(ctx, c.req.param("id"), c.req.param("addressId"), deps)),
  )

  return app
}
