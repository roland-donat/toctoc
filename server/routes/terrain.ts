// Field space (U12, R15, R17 to R19, R21, R25): what a canvassing pair sees and enters from its link, without an
// account. Every request is scoped to the itinerary of the token (KTD6) and anonymized at each request (KTD7).
import { and, eq } from "drizzle-orm"
import { Hono, type Context } from "hono"
import { doorLabel, recordSessionEvent } from "../services/sessions.ts"
import type { UnitView } from "../services/dwelling-units.ts"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import type { AgeBand } from "../db/schema/cheatsheets.ts"
import { itineraries, itineraryDoors, visits } from "../db/schema/index.ts"
import { anonymize, namesAllowed } from "../domain/anonymize.ts"
import { parisDate } from "../domain/qualification.ts"
import { FIELD_TOKEN_HEADER, resolveFieldToken, type FieldLink, type FieldLinkState } from "../lib/tokens.ts"
import { canvassDoors, type DoorCheatsheet, type DoorPassage, type DoorVoter } from "../services/field-doors.ts"
import { deleteVisit, recordVisit, updateVisit, VisitError, visitInputSchema, visitPatchSchema, type Visit } from "../services/visits.ts"

export type FieldVoter = DoorVoter
export type FieldCheatsheet = DoorCheatsheet
/** Last passage at a door: date and outcome only, never the dwelling nor the remarks (KTD7). */
export type FieldPassage = Omit<DoorPassage, "qualification">

export interface FieldDoor {
  addressId: string
  position: number
  label: string
  lat: number
  lon: number
  dwellings: number | null
  /** Age bands of the targeted voters (hors cible excluded). */
  ageBands: AgeBand[]
  cheatsheets: FieldCheatsheet[]
  lastPassage: FieldPassage | null
  /** Dwellings of the building with their latest feedback; labels carry no name. */
  units: UnitView[]
  /** A feedback was recorded on this door since the link was issued, from any phone. */
  done: boolean
  /** Empty unless names are allowed for this link. */
  voters: FieldVoter[]
}

export interface FieldLoop {
  /** Null while the session runs: a link has no time limit. */
  expiresAt: number | null
  start: { lat: number; lon: number }
  namesShown: boolean
  doors: FieldDoor[]
}

/** Feedback from the link: the R18 fields, the dwelling and the client id; source and itinerary come from the token. */
const fieldVisitSchema = visitInputSchema.omit({ source: true, itineraryId: true }).strict()

const notFound = (c: Context) => c.json({ error: "not_found" }, 404)

function isDoorOf(ctx: AppContext, itineraryId: string, addressId: string): boolean {
  const door = ctx.db
    .select({ addressId: itineraryDoors.addressId })
    .from(itineraryDoors)
    .where(and(eq(itineraryDoors.itineraryId, itineraryId), eq(itineraryDoors.addressId, addressId)))
    .limit(1)
    .get()
  return door !== undefined
}

/**
 * A feedback the link may correct or remove: sent through this very link (field source, same itinerary, recorded
 * since the link was issued). A feedback of an earlier link, of the paper sheet or of the administrator never is.
 */
function ownVisit(ctx: AppContext, link: FieldLink, id: string): Visit | null {
  const visit = ctx.db.select().from(visits).where(eq(visits.id, id)).get()
  if (!visit || visit.source !== "lien" || visit.itineraryId !== link.itineraryId || visit.recordedAt < link.issuedAt) return null
  return visit
}

function buildLoop(ctx: AppContext, link: FieldLink): FieldLoop | null {
  const it = ctx.db.select().from(itineraries).where(eq(itineraries.id, link.itineraryId)).get()
  if (!it) return null
  const allowed = namesAllowed(ctx, { itineraryShowNames: it.showNames })
  const loop: FieldLoop = {
    expiresAt: link.expiresAt,
    start: { lat: it.startLat, lon: it.startLon },
    namesShown: allowed,
    doors: canvassDoors(ctx, it.id, { namesAllowed: allowed }).map((d) => ({
      addressId: d.addressId,
      position: d.position,
      label: d.label,
      lat: d.lat,
      lon: d.lon,
      dwellings: d.dwellings,
      ageBands: d.ageBands,
      cheatsheets: d.cheatsheets,
      // Copied field by field so the qualification never reaches the link.
      lastPassage: d.lastPassage
        ? {
            visitDate: d.lastPassage.visitDate,
            contact: d.lastPassage.contact,
            toRevisit: d.lastPassage.toRevisit,
            toAccompany: d.lastPassage.toAccompany,
          }
        : null,
      units: d.units,
      done: d.lastRecordedAt !== null && d.lastRecordedAt >= link.issuedAt,
      voters: d.voters,
    })),
  }
  // Second guard on the names, evaluated now (KTD7).
  return anonymize(loop, allowed)
}

function linkOf(ctx: AppContext, c: Context): { link: FieldLink; state: FieldLinkState } | null {
  const token = c.req.header(FIELD_TOKEN_HEADER)
  const resolved = token ? resolveFieldToken(ctx, token) : null
  if (!resolved || resolved.state === "expire" || resolved.state === "revoque") return null
  return resolved
}

/** Mounted at /api/terrain. Exempt from the session check; mutations still need the right Origin and JSON (KTD5). */
export function terrainRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  // Reads only while the link is active; during grace a page already open keeps the doors it loaded.
  app.get("/itineraire", (c) => {
    const resolved = linkOf(ctx, c)
    if (!resolved || resolved.state !== "actif") return notFound(c)
    const loop = buildLoop(ctx, resolved.link)
    return loop ? c.json(loop) : notFound(c)
  })

  // Writes while active and during grace.
  app.post("/retours", async (c) => {
    const resolved = linkOf(ctx, c)
    if (!resolved) return notFound(c)
    const parsed = fieldVisitSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const { itineraryId, issuedAt } = resolved.link
    if (!isDoorOf(ctx, itineraryId, parsed.data.addressId)) return notFound(c)
    // A queued feedback keeps the date it was entered (KTD10). A wrong phone clock must not lose the feedback,
    // so the date is clamped to [link issue date, today in Paris] rather than refused. ISO dates compare as strings.
    const earliest = parisDate(new Date(issuedAt))
    const today = parisDate(ctx.now())
    const entered = parsed.data.visitDate
    const visitDate = entered === undefined ? undefined : entered < earliest ? earliest : entered > today ? today : entered
    try {
      const { visit, created } = recordVisit(ctx, { ...parsed.data, visitDate, source: "lien", itineraryId })
      if (created) recordSessionEvent(ctx, itineraryId, "feedback_recorded", "lien", doorLabel(ctx, visit.addressId))
      return c.json({ id: visit.id, created }, created ? 201 : 200)
    } catch (err) {
      if (err instanceof VisitError) return notFound(c)
      throw err
    }
  })

  // Correction of a feedback sent from this link, while active and during grace (the phone queue may hold it).
  app.patch("/retours/:id", async (c) => {
    const resolved = linkOf(ctx, c)
    if (!resolved) return notFound(c)
    const parsed = visitPatchSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const visit = ownVisit(ctx, resolved.link, c.req.param("id"))
    if (!visit) return notFound(c)
    try {
      updateVisit(ctx, visit.id, parsed.data, { fromField: true })
      recordSessionEvent(ctx, visit.itineraryId, "feedback_corrected", "lien", doorLabel(ctx, visit.addressId))
      return c.json({ id: visit.id })
    } catch (err) {
      if (err instanceof VisitError) return err.code === "empty_feedback" ? c.json({ error: err.code }, 422) : notFound(c)
      throw err
    }
  })

  // Removal of a feedback sent from this link by mistake; same scope as the correction.
  app.delete("/retours/:id", (c) => {
    const resolved = linkOf(ctx, c)
    if (!resolved) return notFound(c)
    const visit = ownVisit(ctx, resolved.link, c.req.param("id"))
    if (!visit) return notFound(c)
    try {
      deleteVisit(ctx, visit.id)
      recordSessionEvent(ctx, visit.itineraryId, "feedback_deleted", "lien", doorLabel(ctx, visit.addressId))
      return c.json({ id: visit.id })
    } catch (err) {
      if (err instanceof VisitError) return notFound(c)
      throw err
    }
  })

  // Any other path under the field space: the same answer, token or not.
  app.all("*", notFound)

  return app
}
