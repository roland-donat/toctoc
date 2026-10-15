// Purge of every nominative data after the presidential election (U14, R26, KTD16), on a file database
// loaded with the fictional fixtures, so the compaction can be checked on the raw bytes.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption"
import Database from "better-sqlite3"
import { count } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import { beforeEach, describe, expect, it } from "vitest"
import { testConfig } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { openDatabase } from "../db/index.ts"
import {
  addresses,
  cheatsheets,
  electors,
  importExceptions,
  itineraries,
  itineraryDoors,
  registrations,
  visits,
  voteHistory,
} from "../db/schema/index.ts"
import { getSetting } from "../db/settings.ts"
import { runBackup } from "./backup.ts"
import { loadBanFile } from "./ban-loader.ts"
import { commitEmargementImport, prepareEmargementImport } from "./emargement-import.ts"
import type { GeocodeFetch } from "./geocode-fallback.ts"
import { PURGE_CONFIRMATION, PurgeError, runPurge, STATS_SNAPSHOT_KEY, type StatsSnapshot } from "./purge.ts"
import { commitRepImport, prepareRepImport } from "./rep-import.ts"
import { recordVisit } from "./visits.ts"

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const NOW = new Date("2027-05-10T08:00:00Z")
const BUILDING = "56243_0110_00022"

/** Surnames, first names and identity-key fragments of the fictional fixtures. */
const FIXTURE_PERSON_TEXT = [
  "ALPHA", "BRAVO", "CHARLIE", "DURAND", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL", "INDIA", "JULIETT", "KILO",
  "LIMA", "MIKE", "NOVEMBER", "OSCAR", "QUEBEC", "ROMEO", "ROMERO", "SIERRA", "TANGO", "UNIFORM", "VICTOR",
  "Fanny", "Gaston", "Quentin", "Ursule", "foxtrot|fanny", "golf|gaston",
]
const BIRTH_TEXT = ["1999-01-30", "1945-09-09", "30/01/1999", "Lisbonne", "Portugaise"]
const VISIT_TEXT = ["apt 4 boite FOXTROT", "remarque fictive confidentielle"]

const unreachable: GeocodeFetch = async () => {
  throw new Error("offline")
}
const geocode = { fetch: unreachable, sleep: async (): Promise<void> => {} }

let identity: string
let ctx: AppContext
let sqlite: Database.Database
let dbFile: string
let setNow: (d: Date) => void

beforeEach(async () => {
  identity = await generateIdentity()
  const config = testConfig({ backupRecipient: await identityToRecipient(identity) })
  dbFile = join(config.dataDir, "toctoc.db")
  const handle = openDatabase(dbFile)
  sqlite = handle.sqlite
  let current = NOW
  setNow = (d) => {
    current = d
  }
  ctx = { db: handle.db, config, now: () => current }

  await loadBanFile(ctx, join(FIXTURES, "ban-sample.csv"))
  const rep = await prepareRepImport(ctx, readFileSync(join(FIXTURES, "rep-2026.csv")), geocode)
  commitRepImport(ctx, rep)
  const em = await prepareEmargementImport(ctx, readFileSync(join(FIXTURES, "emargement-2026.csv")))
  commitEmargementImport(ctx, em)

  recordVisit(ctx, {
    id: "11111111-1111-4111-8111-111111111111",
    addressId: BUILDING,
    source: "admin",
    visitDate: "2027-02-01",
    dwelling: VISIT_TEXT[0],
    remarks: VISIT_TEXT[1],
    contact: "obtenu",
  })
  recordVisit(ctx, {
    id: "22222222-2222-4222-8222-222222222222",
    addressId: "56243_0110_00025",
    source: "lien",
    visitDate: "2027-02-01",
    qualification: "logement_vide",
    qualificationScope: "immeuble",
  })
  ctx.db
    .insert(itineraries)
    .values({ id: "it1", createdAt: 0, zone: '{"type":"bureau","bureau":"0001"}', startLat: 47.6, startLon: -2.7, durationMinutes: 60, totalSeconds: 600 })
    .run()
  ctx.db
    .insert(itineraryDoors)
    .values({ itineraryId: "it1", addressId: BUILDING, position: 0, serviceSeconds: 60, walkSecondsFromPrevious: 0, priority: 3 })
    .run()
  ctx.db.insert(cheatsheets).values({ id: "cs1", ageBand: "18-25", title: "Logement", body: "Argument", updatedAt: 0 }).run()

  mkdirSync(ctx.config.backupDir, { recursive: true })
  writeFileSync(join(ctx.config.backupDir, "toctoc-20270509-020000.db.age"), "older daily backup")
  writeFileSync(join(ctx.config.backupDir, "copie-manuelle.db"), "stray copy")
})

function rows(table: SQLiteTable): number {
  return ctx.db.select({ n: count() }).from(table).get()?.n ?? 0
}

/** Every value of every table, as text. */
function dumpAllTables(): string {
  const tables = sqlite.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
  return tables.map((t) => JSON.stringify(sqlite.prepare(`select * from "${t.name}"`).all())).join("\n")
}

function rawBytes(): string {
  const parts = [dbFile, `${dbFile}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f).toString("latin1"))
  return parts.join("\n")
}

function importFiles(): string[] {
  const dir = join(ctx.config.dataDir, "imports")
  return existsSync(dir) ? readdirSync(dir) : []
}

describe("runPurge", () => {
  it("does nothing without the explicit confirmation", async () => {
    const before = { electors: rows(electors), visits: dumpAllTables(), files: importFiles(), backups: readdirSync(ctx.config.backupDir) }
    expect(before.electors).toBe(21)
    expect(before.files).toHaveLength(2)

    await expect(runPurge(ctx, sqlite, { confirmation: null })).rejects.toBeInstanceOf(PurgeError)
    await expect(runPurge(ctx, sqlite, { confirmation: "supprimer" })).rejects.toBeInstanceOf(PurgeError)

    expect(dumpAllTables()).toBe(before.visits)
    expect(importFiles()).toEqual(before.files)
    expect(readdirSync(ctx.config.backupDir).sort()).toEqual([...before.backups].sort())
  })

  it("refuses without an age recipient, there is no plain safety backup", async () => {
    ctx = { ...ctx, config: { ...ctx.config, backupRecipient: null } }
    await expect(runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })).rejects.toBeInstanceOf(PurgeError)
    expect(rows(electors)).toBe(21)
  })

  it("refuses before deleting anything while another connection reads the database", async () => {
    const other = new Database(dbFile, { timeout: 0 })
    sqlite.pragma("busy_timeout = 0")
    other.exec("BEGIN")
    other.prepare("select count(*) from electors").get()
    try {
      await expect(runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })).rejects.toMatchObject({ code: "checkpoint_busy" })
    } finally {
      other.exec("COMMIT")
      other.close()
    }
    expect(rows(electors)).toBe(21)
    expect(readdirSync(ctx.config.backupDir)).not.toContain("toctoc-pre-purge-20270510-080000.db.age")
  })

  it("deletes every elector, registration, vote history and exception row and clears free text", async () => {
    const before = { addresses: rows(addresses), visits: rows(visits) }
    expect(rows(registrations)).toBe(22)
    expect(rows(voteHistory)).toBeGreaterThan(0)
    expect(rows(importExceptions)).toBeGreaterThan(0)

    const result = await runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })

    expect(result).toMatchObject({ electors: 21, registrations: 22, importFiles: 2, backupsDeleted: 2 })
    for (const table of [electors, registrations, voteHistory, importExceptions]) expect(rows(table)).toBe(0)
    expect(ctx.db.select({ dwelling: visits.dwelling, remarks: visits.remarks }).from(visits).all()).toEqual([
      { dwelling: null, remarks: null },
      { dwelling: null, remarks: null },
    ])
    const dump = dumpAllTables()
    for (const text of [...FIXTURE_PERSON_TEXT, ...BIRTH_TEXT, ...VISIT_TEXT]) expect(dump).not.toContain(text)
    expect(rows(addresses)).toBe(before.addresses)
    expect(rows(visits)).toBe(before.visits)
  })

  it("compacts the database: the raw file and its WAL contain no fixture name", async () => {
    expect(rawBytes()).toContain("FOXTROT")
    await runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })
    const raw = rawBytes()
    for (const text of [...FIXTURE_PERSON_TEXT, ...BIRTH_TEXT, ...VISIT_TEXT]) expect(raw).not.toContain(text)
  })

  it("keeps address qualifications, itineraries, cheat sheets and a readable statistics snapshot", async () => {
    await runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })

    const qualified = ctx.db.select().from(visits).all().find((v) => v.addressId === "56243_0110_00025")
    expect(qualified).toMatchObject({ qualification: "logement_vide", qualificationScope: "immeuble", visitDate: "2027-02-01" })
    expect(rows(itineraries)).toBe(1)
    expect(rows(itineraryDoors)).toBe(1)
    expect(rows(cheatsheets)).toBe(1)

    const snapshot = getSetting<StatsSnapshot | null>(ctx.db, STATS_SNAPSHOT_KEY, null)
    expect(snapshot?.takenAt).toBe(NOW.toISOString())
    // 21 electors: LIMA (EU lists only) is out of target; QUEBEC (no line), ROMEO (name mismatch) and BRAVO
    // (discordant duplicate) are unknown until corrected; the 17 others are targeted.
    expect(snapshot?.stats.population).toEqual({ targeted: 17, unknown: "< 5", newRegistrants: "< 5" })
    expect(snapshot?.campaign.activity).toEqual({ doorsVisited: 2, sessions: 1 })
  })

  it("removes the uploaded files and every backup but the dated safety backup, which the daily run deletes after 30 days", async () => {
    const result = await runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })

    expect(importFiles()).toEqual([])
    expect(readdirSync(ctx.config.backupDir)).toEqual(["toctoc-pre-purge-20270510-080000.db.age"])
    expect(result.safetyBackup).toBe(join(ctx.config.backupDir, "toctoc-pre-purge-20270510-080000.db.age"))

    setNow(new Date(NOW.getTime() + 31 * 24 * 3600 * 1000))
    const backup = await runBackup(ctx, sqlite)
    expect(backup.deleted).toEqual(["toctoc-pre-purge-20270510-080000.db.age"])
    expect(readdirSync(ctx.config.backupDir)).toEqual(["toctoc-20270610-080000.db.age"])
  })

  it("the safety backup decrypts with the matching identity to the database before the purge", async () => {
    const result = await runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })

    const decrypter = new Decrypter()
    decrypter.addIdentity(identity)
    // Restored as an operator would: decrypted to a file, then opened.
    const restoredFile = join(ctx.config.dataDir, "restored.db")
    writeFileSync(restoredFile, await decrypter.decrypt(readFileSync(result.safetyBackup ?? "")))
    const restored = new Database(restoredFile, { readonly: true })
    const names = (restored.prepare("select birth_name from electors").all() as { birth_name: string }[]).map((r) => r.birth_name)
    expect(names).toHaveLength(21)
    expect(names).toContain("FOXTROT")
    restored.close()
  })

  it("a purge failing after the deletion, then run again, keeps the first safety backup and the statistics snapshot", async () => {
    // VACUUM fails once (disk full, for instance) after the nominative rows are already deleted.
    const failingVacuum = new Proxy(sqlite, {
      get(target, prop, receiver) {
        if (prop === "exec") {
          return (source: string) => {
            if (source === "VACUUM") throw new Error("database or disk is full")
            return target.exec(source)
          }
        }
        const value: unknown = Reflect.get(target, prop, receiver)
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
    await expect(runPurge(ctx, failingVacuum, { confirmation: PURGE_CONFIRMATION })).rejects.toMatchObject({ code: "compaction_failed" })
    expect(rows(electors)).toBe(0)
    const first = "toctoc-pre-purge-20270510-080000.db.age"
    expect(readdirSync(ctx.config.backupDir)).toContain(first)
    const snapshot = getSetting<StatsSnapshot | null>(ctx.db, STATS_SNAPSHOT_KEY, null)
    expect(snapshot?.stats.population.targeted).toBe(17)

    setNow(new Date(NOW.getTime() + 10 * 60 * 1000))
    const rerun = await runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })

    expect(rerun.safetyBackup).toBeNull()
    expect(readdirSync(ctx.config.backupDir)).toEqual([first])
    expect(getSetting<StatsSnapshot | null>(ctx.db, STATS_SNAPSHOT_KEY, null)).toEqual(snapshot)
    const decrypter = new Decrypter()
    decrypter.addIdentity(identity)
    const restoredFile = join(ctx.config.dataDir, "restored-first.db")
    writeFileSync(restoredFile, await decrypter.decrypt(readFileSync(join(ctx.config.backupDir, first))))
    const restored = new Database(restoredFile, { readonly: true })
    expect((restored.prepare("select count(*) as n from electors").get() as { n: number }).n).toBe(21)
    restored.close()
  })

  it("keeps an earlier safety backup found in backup_dir and deletes only the other files", async () => {
    writeFileSync(join(ctx.config.backupDir, "toctoc-pre-purge-20270501-080000.db.age"), "earlier safety backup")
    await runPurge(ctx, sqlite, { confirmation: PURGE_CONFIRMATION })
    expect(readdirSync(ctx.config.backupDir).sort()).toEqual([
      "toctoc-pre-purge-20270501-080000.db.age",
      "toctoc-pre-purge-20270510-080000.db.age",
    ])
  })
})
