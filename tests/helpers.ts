import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppContext } from "../server/context.ts"
import { openDatabase } from "../server/db/index.ts"
import type { AppConfig } from "../server/lib/config.ts"

export const TEST_ORIGIN = "https://toctoc.test"

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "toctoc-test-"))
  return {
    dataDir,
    backupDir: join(dataDir, "backups"),
    backupRecipient: null,
    publicOrigin: TEST_ORIGIN,
    server: { port: 0, host: "127.0.0.1" },
    routing: { osrmUrl: "http://127.0.0.1:1", vroomUrl: "http://127.0.0.1:1" },
    ...overrides,
  }
}

/** In-memory database, temporary data dir, controllable clock. */
export function createTestContext(options: { now?: Date; config?: Partial<AppConfig> } = {}) {
  let current = options.now ?? new Date("2027-01-15T10:00:00Z")
  const { db, sqlite } = openDatabase(":memory:")
  const ctx: AppContext = { db, config: testConfig(options.config), now: () => current }
  return {
    ctx,
    sqlite,
    setNow(date: Date) {
      current = date
    },
  }
}
