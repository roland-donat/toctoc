import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import * as schema from "./schema/index.ts"

export type Db = BetterSQLite3Database<typeof schema>

export interface DatabaseHandle {
  db: Db
  sqlite: Database.Database
}

const MIGRATIONS_DIR = new URL("./migrations", import.meta.url).pathname

/** Opens (and migrates) the database. Pass ":memory:" for tests. */
export function openDatabase(file: string): DatabaseHandle {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  return { db, sqlite }
}
