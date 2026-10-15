import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import { CHEATSHEET_BANDS, cheatsheets } from "../db/schema/cheatsheets.ts"
import { compareCheatsheets } from "../services/field-doors.ts"

const createSchema = z.object({
  ageBand: z.enum(CHEATSHEET_BANDS),
  title: z.string().max(200),
  body: z.string().max(20000),
})

const patchSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(20000).optional(),
  ageBand: z.enum(CHEATSHEET_BANDS).optional(),
  position: z.number().int().optional(),
})

/** Admin CRUD for cheat sheets (R22). Content is plain text, stored verbatim. */
export function antisechesRoutes(ctx: AppContext): Hono {
  const app = new Hono()
  const { db } = ctx

  app.get("/", (c) => {
    const rows = db.select().from(cheatsheets).all()
    rows.sort(compareCheatsheets)
    return c.json(rows)
  })

  app.post("/", async (c) => {
    const parsed = createSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const siblings = db.select().from(cheatsheets).where(eq(cheatsheets.ageBand, parsed.data.ageBand)).all()
    const position = siblings.reduce((max, s) => Math.max(max, s.position + 1), 0)
    const row = {
      id: crypto.randomUUID(),
      ...parsed.data,
      position,
      updatedAt: ctx.now().getTime(),
    }
    db.insert(cheatsheets).values(row).run()
    return c.json(row, 201)
  })

  app.patch("/:id", async (c) => {
    const parsed = patchSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    const id = c.req.param("id")
    const updated = db
      .update(cheatsheets)
      .set({ ...parsed.data, updatedAt: ctx.now().getTime() })
      .where(eq(cheatsheets.id, id))
      .returning()
      .all()
    const row = updated[0]
    if (!row) return c.json({ error: "not_found" }, 404)
    return c.json(row)
  })

  app.delete("/:id", (c) => {
    const deleted = db.delete(cheatsheets).where(eq(cheatsheets.id, c.req.param("id"))).returning().all()
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404)
    return c.body(null, 204)
  })

  return app
}
