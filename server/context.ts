import type { Db } from "./db/index.ts"
import type { AppConfig } from "./lib/config.ts"

/** Everything a route needs, injected so tests can run on an in-memory database and a fixed clock. */
export interface AppContext {
  db: Db
  config: AppConfig
  now: () => Date
}
