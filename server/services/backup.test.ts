// Encrypted database backup and 30-day rotation (U14 for the purge, U15 daily task, KTD15, KTD16).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { getSetting, setSetting } from "../db/settings.ts"
import { BackupError, LAST_BACKUP_KEY, runBackup } from "./backup.ts"

const NOW = new Date("2027-01-15T10:00:00Z")

let identity: string
let recipient: string

beforeEach(async () => {
  identity = await generateIdentity()
  recipient = await identityToRecipient(identity)
})

function setup(backupRecipient: string | null) {
  const t = createTestContext({ now: NOW, config: { backupRecipient } })
  setSetting(t.ctx.db, "marker", "fictional-marker")
  return t
}

async function decrypt(file: string): Promise<Uint8Array> {
  const d = new Decrypter()
  d.addIdentity(identity)
  return d.decrypt(readFileSync(file))
}

function files(ctx: AppContext): string[] {
  return readdirSync(ctx.config.backupDir).sort()
}

describe("runBackup", () => {
  it("writes a dated age file that decrypts to a valid SQLite database", async () => {
    const { ctx, sqlite } = setup(recipient)

    const result = await runBackup(ctx, sqlite)

    expect(files(ctx)).toEqual(["toctoc-20270115-100000.db.age"])
    expect(result.file).toBe(join(ctx.config.backupDir, "toctoc-20270115-100000.db.age"))
    const raw = readFileSync(result.file)
    expect(raw.subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3")
    const restored = new Database(Buffer.from(await decrypt(result.file)))
    const row = restored.prepare("select value from settings where key = 'marker'").get() as { value: string }
    expect(JSON.parse(row.value)).toBe("fictional-marker")
    restored.close()
  })

  it("records the date of the last successful backup", async () => {
    const { ctx, sqlite } = setup(recipient)
    await runBackup(ctx, sqlite)
    expect(getSetting<string | null>(ctx.db, LAST_BACKUP_KEY, null)).toBe(NOW.toISOString())
  })

  it("refuses to write a plain copy without --allow-plain", async () => {
    const { ctx, sqlite } = setup(null)
    await expect(runBackup(ctx, sqlite)).rejects.toBeInstanceOf(BackupError)
    expect(existsSync(ctx.config.backupDir) ? files(ctx) : []).toEqual([])
    expect(getSetting<string | null>(ctx.db, LAST_BACKUP_KEY, null)).toBeNull()
  })

  it("writes a plain .db copy with --allow-plain (development only)", async () => {
    const { ctx, sqlite } = setup(null)
    const result = await runBackup(ctx, sqlite, { allowPlain: true })
    expect(files(ctx)).toEqual(["toctoc-20270115-100000.db"])
    expect(readFileSync(result.file).subarray(0, 15).toString("latin1")).toBe("SQLite format 3")
  })

  it("deletes regular and pre-purge backups older than 30 days, keeps the recent ones and other files", async () => {
    const { ctx, sqlite } = setup(recipient)
    mkdirSync(ctx.config.backupDir, { recursive: true })
    const old = [
      "toctoc-20261216-095959.db.age", // 30 days and a second
      "toctoc-pre-purge-20261215-090000.db.age", // 31 days and an hour
      "toctoc-20261201-000000.db",
    ]
    const recent = ["toctoc-20261216-100001.db.age", "toctoc-pre-purge-20261217-000000.db.age"]
    for (const name of [...old, ...recent, "notes.txt"]) writeFileSync(join(ctx.config.backupDir, name), "x")

    const result = await runBackup(ctx, sqlite)

    expect(result.deleted.sort()).toEqual([...old].sort())
    expect(files(ctx)).toEqual([...recent, "notes.txt", "toctoc-20270115-100000.db.age"].sort())
  })
})
