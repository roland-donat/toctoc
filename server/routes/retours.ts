import { Hono } from "hono"
import { z } from "zod"
import { doorLabel, recordSessionEvent } from "../services/sessions.ts"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import { anonymize, namesAllowed } from "../domain/anonymize.ts"
import {
  cancelQualification,
  deleteVisit,
  listVisits,
  recordVisit,
  updateVisit,
  VisitError,
  visitInputSchema,
  visitPatchSchema,
} from "../services/visits.ts"

/** Admin entry: live ("admin", dated today unless given) or re-entry of a paper sheet ("feuille", dated). */
const adminVisitSchema = visitInputSchema
  .extend({ source: z.enum(["admin", "feuille"]) })
  .strict()
  .refine((v) => v.source !== "feuille" || v.visitDate !== undefined, { path: ["visitDate"] })

const cancelSchema = z.object({ addressId: z.string().min(1).max(100), id: z.string().uuid().optional() }).strict()

const ERROR_STATUS = {
  address_not_found: 404,
  visit_not_found: 404,
  no_active_qualification: 409,
  cancellation_locked: 409,
  empty_feedback: 422,
  unit_not_found: 404,
  unit_other_address: 409,
  unit_label_required: 422,
} as const

/** Visit feedback of the administrator (R17 to R20, R5 cancellation). Mounted at /api/retours. */
export function retoursRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const addressId = c.req.query("addressId")
    if (!addressId) return c.json({ error: "invalid_query" }, 400)
    // Dwelling and remarks may carry a name read on a mailbox (KTD7).
    return c.json(anonymize(listVisits(ctx.db, addressId), namesAllowed(ctx)))
  })

  app.post("/", async (c) => {
    const parsed = adminVisitSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    try {
      const { visit, created } = recordVisit(ctx, parsed.data)
      return c.json(visit, created ? 201 : 200)
    } catch (err) {
      if (err instanceof VisitError) return c.json({ error: err.code }, ERROR_STATUS[err.code])
      throw err
    }
  })

  app.post("/annulation", async (c) => {
    const parsed = cancelSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    try {
      const { visit, created } = cancelQualification(ctx, parsed.data)
      return c.json(visit, created ? 201 : 200)
    } catch (err) {
      if (err instanceof VisitError) return c.json({ error: err.code }, ERROR_STATUS[err.code])
      throw err
    }
  })

  // Correction of a feedback (contact, follow-up, qualification, texts). Answers the stored row, masked as any read.
  app.patch("/:id", async (c) => {
    const parsed = visitPatchSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    try {
      const visit = updateVisit(ctx, c.req.param("id"), parsed.data)
      recordSessionEvent(ctx, visit.itineraryId, "feedback_corrected", "admin", doorLabel(ctx, visit.addressId))
      return c.json(anonymize(visit, namesAllowed(ctx)))
    } catch (err) {
      if (err instanceof VisitError) return c.json({ error: err.code }, ERROR_STATUS[err.code])
      throw err
    }
  })

  // Reset of a door: the feedback entered by mistake is removed for good.
  app.delete("/:id", (c) => {
    try {
      const visit = deleteVisit(ctx, c.req.param("id"))
      recordSessionEvent(ctx, visit.itineraryId, "feedback_deleted", "admin", doorLabel(ctx, visit.addressId))
      return c.json({ id: visit.id, addressId: visit.addressId })
    } catch (err) {
      if (err instanceof VisitError) return c.json({ error: err.code }, ERROR_STATUS[err.code])
      throw err
    }
  })

  return app
}
