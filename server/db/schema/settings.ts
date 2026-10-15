import { sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Application settings editable without code (KTD8 weights, anonymization switch, deadlines). Values are JSON. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})
