// Paramètres screen (U7): anonymization switch (KTD7, R24) and the KTD8 potential and door-time model.
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import { ANONYMIZATION_MODES, anonymizationMode, setAnonymizationMode } from "../domain/anonymize.ts"
import { loadParameters, parametersSchema, saveParameters } from "../domain/parameters.ts"
import { getSetting } from "../db/settings.ts"
import { LAST_BACKUP_KEY } from "../services/backup.ts"

const modeSchema = z.object({ mode: z.enum(ANONYMIZATION_MODES) }).strict()

/** Mounted at /api/parametres. */
export function parametresRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  app.get("/", (c) =>
    c.json({
      anonymization: anonymizationMode(ctx.db),
      parameters: loadParameters(ctx.db),
      lastBackupAt: getSetting<string | null>(ctx.db, LAST_BACKUP_KEY, null),
    }),
  )

  app.put("/anonymisation", async (c) => {
    const parsed = modeSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    setAnonymizationMode(ctx.db, parsed.data.mode)
    return c.json({ anonymization: anonymizationMode(ctx.db) })
  })

  app.put("/priorite", async (c) => {
    const parsed = parametersSchema.strict().safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    return c.json({ parameters: saveParameters(ctx.db, parsed.data) })
  })

  return app
}
