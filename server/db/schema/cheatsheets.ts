import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const AGE_BANDS = ["18-25", "26-40", "41-60", "61+"] as const
export type AgeBand = (typeof AGE_BANDS)[number]

/** Bands a cheat sheet can belong to: an age band, or "generale". */
export const CHEATSHEET_BANDS = [...AGE_BANDS, "generale"] as const
export type CheatsheetBand = (typeof CHEATSHEET_BANDS)[number]

/** Talking points per age band, or "generale" for addresses without a registered voter (R21, R22). */
export const cheatsheets = sqliteTable("cheatsheets", {
  id: text("id").primaryKey(),
  ageBand: text("age_band", { enum: CHEATSHEET_BANDS }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  position: integer("position").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
})
