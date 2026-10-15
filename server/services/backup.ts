// Database backups (KTD15, KTD16, U15): an online snapshot of the live database, encrypted with age to the
// public key of the configuration, written to backup_dir only. The snapshot is taken in memory
// (sqlite3_serialize, a consistent read while the server keeps running), so no plain copy ever touches the disk
// unless --allow-plain is given in development.
//
// File names carry their UTC date: toctoc-YYYYMMDD-HHMMSS.db.age for the daily backup, and
// toctoc-pre-purge-YYYYMMDD-HHMMSS.db.age for the safety backup taken just before the purge. Both are deleted
// once older than 30 days by the daily run.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Encrypter } from "age-encryption"
import type Database from "better-sqlite3"
import type { AppContext } from "../context.ts"
import { setSetting } from "../db/settings.ts"

/** Setting holding the ISO instant of the last successful daily backup (shown by U15). */
export const LAST_BACKUP_KEY = "last_backup_at"
const BACKUP_RETENTION_DAYS = 30

export type BackupKind = "daily" | "pre-purge"

export type BackupErrorCode = "no_recipient"

export class BackupError extends Error {
  override name = "BackupError"
  readonly code: BackupErrorCode
  constructor(code: BackupErrorCode) {
    super(`Backup refused: ${code}`)
    this.code = code
  }
}

const BACKUP_NAME = /^toctoc-(?:pre-purge-)?(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db(?:\.age)?$/

function stamp(now: Date): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`
}

/** Name of a safety backup taken by the purge (toctoc-pre-purge-YYYYMMDD-HHMMSS.db[.age]). */
export function isPrePurgeBackupName(name: string): boolean {
  return name.startsWith("toctoc-pre-purge-") && BACKUP_NAME.test(name)
}

function backupFileName(kind: BackupKind, now: Date, encrypted: boolean): string {
  const prefix = kind === "pre-purge" ? "toctoc-pre-purge-" : "toctoc-"
  return `${prefix}${stamp(now)}.db${encrypted ? ".age" : ""}`
}

/** Instant encoded in a backup file name, null for any other file. */
function backupDate(name: string): Date | null {
  const m = BACKUP_NAME.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
}

export interface WriteBackupOptions {
  backupDir: string
  /** age public key; null writes a plain copy (development only, the caller decides). */
  recipient: string | null
  kind: BackupKind
  now: Date
}

/** Writes one snapshot of the database and returns its path. Never overwrites an existing file. */
export async function writeBackup(sqlite: Database.Database, options: WriteBackupOptions): Promise<string> {
  const image = sqlite.serialize()
  let content: Uint8Array = image
  if (options.recipient !== null) {
    const encrypter = new Encrypter()
    encrypter.addRecipient(options.recipient)
    content = await encrypter.encrypt(image)
  }
  await mkdir(options.backupDir, { recursive: true, mode: 0o700 })
  const file = join(options.backupDir, backupFileName(options.kind, options.now, options.recipient !== null))
  await writeFile(file, content, { mode: 0o600, flag: "wx" })
  return file
}

/** Deletes the backups (daily and pre-purge) older than 30 days; returns the deleted file names. */
async function rotateBackups(backupDir: string, now: Date): Promise<string[]> {
  const limit = now.getTime() - BACKUP_RETENTION_DAYS * 24 * 3600 * 1000
  const deleted: string[] = []
  for (const name of await readdir(backupDir)) {
    const date = backupDate(name)
    if (date === null || date.getTime() >= limit) continue
    await rm(join(backupDir, name), { force: true })
    deleted.push(name)
  }
  return deleted
}

export interface BackupResult {
  file: string
  deleted: string[]
}

/** `bin/toctoc backup`: daily encrypted backup, rotation, then records the date of success. */
export async function runBackup(
  ctx: AppContext,
  sqlite: Database.Database,
  options: { allowPlain?: boolean } = {},
): Promise<BackupResult> {
  const recipient = ctx.config.backupRecipient
  if (recipient === null && options.allowPlain !== true) throw new BackupError("no_recipient")
  const now = ctx.now()
  const file = await writeBackup(sqlite, { backupDir: ctx.config.backupDir, recipient, kind: "daily", now })
  const deleted = await rotateBackups(ctx.config.backupDir, now)
  setSetting(ctx.db, LAST_BACKUP_KEY, now.toISOString())
  return { file, deleted }
}
