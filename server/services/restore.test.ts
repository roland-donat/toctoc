import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { generateIdentity, identityToRecipient } from "age-encryption"
import { describe, expect, it } from "vitest"
import { openDatabase } from "../db/index.ts"
import { setSetting } from "../db/settings.ts"
import { writeBackup } from "./backup.ts"
import { RestoreError, restoreBackup } from "./restore.ts"

async function encryptedBackupOf(marker: string) {
  const identity = await generateIdentity()
  const { db, sqlite } = openDatabase(":memory:")
  setSetting(db, "restore_marker", marker)
  const dir = mkdtempSync(join(tmpdir(), "toctoc-restore-"))
  const file = await writeBackup(sqlite, {
    backupDir: join(dir, "backups"),
    recipient: await identityToRecipient(identity),
    kind: "daily",
    now: new Date("2027-02-01T10:00:00Z"),
  })
  const identityFile = join(dir, "key.txt")
  writeFileSync(identityFile, `# fictional test key\n${identity}\n`)
  return { file, identityFile, dataDir: join(dir, "data") }
}

describe("restoreBackup", () => {
  it("restores an encrypted backup into an empty data directory", async () => {
    const { file, identityFile, dataDir } = await encryptedBackupOf("fictional-marker-42")
    const target = await restoreBackup({ backupFile: file, identityFile, dataDir })
    expect(readdirSync(dataDir).sort()).toEqual(["toctoc.db"])
    const restored = new Database(target, { readonly: true })
    const row = restored.prepare("select value from settings where key = 'restore_marker'").get() as { value: string }
    expect(JSON.parse(row.value)).toBe("fictional-marker-42")
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok")
    restored.close()
  })

  it("refuses to overwrite an existing database unless forced", async () => {
    const { file, identityFile, dataDir } = await encryptedBackupOf("second")
    await restoreBackup({ backupFile: file, identityFile, dataDir })
    await expect(restoreBackup({ backupFile: file, identityFile, dataDir })).rejects.toThrowError(RestoreError)
    await restoreBackup({ backupFile: file, identityFile, dataDir, force: true })
    expect(existsSync(join(dataDir, "toctoc.db"))).toBe(true)
  })

  it("fails without writing anything when the identity does not match", async () => {
    const { file, dataDir } = await encryptedBackupOf("third")
    const other = await encryptedBackupOf("other")
    await expect(restoreBackup({ backupFile: file, identityFile: other.identityFile, dataDir })).rejects.toThrowError(
      RestoreError,
    )
    expect(existsSync(join(dataDir, "toctoc.db"))).toBe(false)
    expect(readFileSync(other.identityFile, "utf-8")).toContain("AGE-SECRET-KEY-")
  })
})
