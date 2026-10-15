// Statistics tab (R10, R11, KTD9) and campaign indicators (Success Criteria). Mounted at /api/stats, admin only.
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import { visits } from "../db/schema/index.ts"
import { anonymize, namesAllowed } from "../domain/anonymize.ts"
import { computeStats } from "../domain/stats.ts"
import { accompanyItems, campaignReport, loadElectorFacts } from "../services/stats-data.ts"

export { CAMPAIGN_DATES_KEY, DEFAULT_CAMPAIGN_DATES, loadCampaignDates, saveCampaignDates } from "../services/stats-data.ts"
export type { AccompanyItem, CampaignDates, CampaignReport } from "../services/stats-data.ts"

const accompanySchema = z.object({ done: z.boolean() }).strict()

export function statsRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  app.get("/", (c) => c.json(computeStats(loadElectorFacts(ctx.db))))

  // The accompany work list carries the dwelling free text: treated as a name (KTD7).
  app.get("/campagne", (c) => c.json(anonymize(campaignReport(ctx), namesAllowed(ctx))))

  // Work-list status of an "à accompagner pour inscription" feedback.
  app.patch("/accompagnement/:visitId", async (c) => {
    const parsed = accompanySchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const visitId = c.req.param("visitId")
    const updated = ctx.db
      .update(visits)
      .set({ accompanyDone: parsed.data.done })
      .where(and(eq(visits.id, visitId), eq(visits.toAccompany, true)))
      .returning({ id: visits.id })
      .all()
    if (updated.length === 0) return c.json({ error: "not_found" }, 404)
    const item = accompanyItems(ctx.db).find((i) => i.visitId === visitId)
    return c.json(anonymize(item, namesAllowed(ctx)))
  })

  return app
}
