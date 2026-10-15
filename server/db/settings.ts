import { eq } from "drizzle-orm"
import type { Db } from "./index.ts"
import { settings } from "./schema/index.ts"

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  if (!row) return fallback
  return JSON.parse(row.value) as T
}

export function setSetting<T>(db: Db, key: string, value: T): void {
  const json = JSON.stringify(value)
  db.insert(settings)
    .values({ key, value: json })
    .onConflictDoUpdate({ target: settings.key, set: { value: json } })
    .run()
}
