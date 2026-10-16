import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { and, asc, eq, isNotNull } from "drizzle-orm"
import { openDatabase, type Db } from "../server/db/index.ts"
import { addresses, cheatsheets, fieldLinks, itineraries, itineraryDoors, registrations } from "../server/db/schema/index.ts"
import { FIELD_LINK_VALIDITY_MS, sha256Hex } from "../server/lib/tokens.ts"
import { currentRepImportId } from "../server/services/current-list.ts"
import { loadConfig } from "../server/lib/config.ts"
import { loadBanFile } from "../server/services/ban-loader.ts"
import { commitEmargementImport, prepareEmargementImport } from "../server/services/emargement-import.ts"
import type { GeocodeFetch } from "../server/services/geocode-fallback.ts"
import { commitRepImport, prepareRepImport } from "../server/services/rep-import.ts"

// Fresh, fictional-only data dir for every e2e run. Runs before the server starts (playwright webServer command).
export const E2E_DIR = "/tmp/toctoc-e2e"
/** Fictional admin password for the throwaway e2e instance only. */
export const E2E_PASSWORD = "e2e-mot-de-passe-fictif"

const FIXTURES = resolve(import.meta.dirname, "../tests/fixtures")

/** Fictional field token of the e2e itinerary, read by e2e/terrain.spec.ts; only its hash goes in the database. */
export const E2E_FIELD_TOKEN_FILE = `${E2E_DIR}/field-token.txt`
const E2E_FIELD_TOKEN = "e2e-jeton-terrain-fictif-0123456789abcdefABCDEF"
/** Link of a second fictional itinerary: the fixture building only, whose dwellings come from the list complements. */
export const E2E_BUILDING_TOKEN_FILE = `${E2E_DIR}/field-token-immeuble.txt`
const E2E_BUILDING_TOKEN = "e2e-jeton-immeuble-fictif-0123456789abcdefABCDEF"

/**
 * A fictional itinerary of three fixture doors with an active field link, inserted directly (no routing service in
 * the e2e run), plus one cheat sheet per age band so the field cards show some.
 */
function seedFieldLink(db: Db, now: number): void {
  const importId = currentRepImportId(db)
  if (importId === null) throw new Error("no current list")
  const doors = db
    .selectDistinct({ id: addresses.id, lat: addresses.lat, lon: addresses.lon })
    .from(registrations)
    .innerJoin(addresses, eq(addresses.id, registrations.addressId))
    .where(and(eq(registrations.importId, importId), isNotNull(registrations.addressId), eq(addresses.kind, "number")))
    .orderBy(asc(addresses.id))
    .limit(3)
    .all()
  if (doors.length < 3) throw new Error("not enough fixture doors")
  const startLat = doors.reduce((s, d) => s + d.lat, 0) / doors.length
  const startLon = doors.reduce((s, d) => s + d.lon, 0) / doors.length
  db.insert(itineraries)
    .values({ id: "e2e-itineraire", createdAt: now, name: null, zone: JSON.stringify({ type: "bureau", bureau: "0001" }), startLat, startLon, durationMinutes: 60, totalSeconds: 1800 })
    .run()
  doors.forEach((d, position) =>
    db.insert(itineraryDoors)
      .values({ itineraryId: "e2e-itineraire", addressId: d.id, position, serviceSeconds: 180, walkSecondsFromPrevious: 120, priority: 10, manual: false })
      .run(),
  )
  db.insert(fieldLinks)
    .values({ id: "e2e-lien", itineraryId: "e2e-itineraire", tokenHash: sha256Hex(E2E_FIELD_TOKEN), issuedAt: now, expiresAt: now + FIELD_LINK_VALIDITY_MS, revokedAt: null })
    .run()
  const bands = ["18-25", "26-40", "41-60", "61+"] as const
  bands.forEach((ageBand) =>
    db.insert(cheatsheets)
      .values({ id: `e2e-${ageBand}`, ageBand, title: `Arguments ${ageBand}`, body: "Argument fictif un.\nArgument fictif deux.", position: 0, updatedAt: now })
      .run(),
  )
  writeFileSync(E2E_FIELD_TOKEN_FILE, E2E_FIELD_TOKEN)

  const building = db
    .select({ id: registrations.addressId })
    .from(registrations)
    .where(and(eq(registrations.importId, importId), eq(registrations.rawComplement1, "Appartement 1")))
    .get()
  if (!building?.id) throw new Error("fixture building not found")
  db.insert(itineraries)
    .values({ id: "e2e-immeuble", createdAt: now, name: null, zone: JSON.stringify({ type: "bureau", bureau: "0001" }), startLat, startLon, durationMinutes: 30, totalSeconds: 600 })
    .run()
  db.insert(itineraryDoors)
    .values({ itineraryId: "e2e-immeuble", addressId: building.id, position: 0, serviceSeconds: 300, walkSecondsFromPrevious: 60, priority: 10, manual: false })
    .run()
  db.insert(fieldLinks)
    .values({ id: "e2e-lien-immeuble", itineraryId: "e2e-immeuble", tokenHash: sha256Hex(E2E_BUILDING_TOKEN), issuedAt: now, expiresAt: now + FIELD_LINK_VALIDITY_MS, revokedAt: null })
    .run()
  writeFileSync(E2E_BUILDING_TOKEN_FILE, E2E_BUILDING_TOKEN)

  // A third session, only for the sessions spec, which renames, archives and deletes it.
  db.insert(itineraries)
    .values({ id: "e2e-a-supprimer", createdAt: now - 3_600_000, name: null, zone: JSON.stringify({ type: "bureau", bureau: "0001" }), startLat, startLon, durationMinutes: 30, totalSeconds: 600 })
    .run()
  db.insert(itineraryDoors)
    .values({ itineraryId: "e2e-a-supprimer", addressId: building.id, position: 0, serviceSeconds: 300, walkSecondsFromPrevious: 60, priority: 10, manual: false })
    .run()
}

/** The Géoplateforme is never called by the e2e run: unmatched addresses go to the manual queue. */
const offline: GeocodeFetch = async () => {
  throw new Error("offline")
}

/** Loads the fictional BAN sample, REP 2026 list and emargement 2026 through the import services. */
async function loadFixtures(configPath: string): Promise<void> {
  const config = loadConfig({ TOCTOC_CONFIG: configPath })
  const { db, sqlite } = openDatabase(join(config.dataDir, "toctoc.db"))
  const ctx = { db, config, now: () => new Date() }
  try {
    await loadBanFile(ctx, join(FIXTURES, "ban-sample.csv"))
    const rep = await prepareRepImport(ctx, readFileSync(join(FIXTURES, "rep-2026.csv")), {
      fetch: offline,
      sleep: async () => {},
    })
    commitRepImport(ctx, rep)
    commitEmargementImport(ctx, await prepareEmargementImport(ctx, readFileSync(join(FIXTURES, "emargement-2026.csv"))))
    seedFieldLink(db, Date.now())
  } finally {
    sqlite.close()
  }
}

async function prepare() {
  rmSync(E2E_DIR, { recursive: true, force: true })
  mkdirSync(`${E2E_DIR}/data`, { recursive: true })
  const configPath = `${E2E_DIR}/config.json`
  writeFileSync(
    configPath,
    JSON.stringify({
      // The fixtures are addresses of Séné (public BAN data) with fictional people.
      commune_insee: "56243",
      data_dir: `${E2E_DIR}/data`,
      public_origin: "http://127.0.0.1:3100",
      server: { port: 3100, host: "127.0.0.1" },
    }),
  )
  execFileSync("bin/toctoc", ["set-password"], {
    input: `${E2E_PASSWORD}\n`,
    env: { ...process.env, TOCTOC_CONFIG: configPath },
  })
  await loadFixtures(configPath)
}

prepare().catch((err: unknown) => {
  // Fictional data only: the error may be printed as is.
  console.error("e2e preparation failed", err)
  process.exit(1)
})
