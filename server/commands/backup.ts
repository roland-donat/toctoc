// `bin/toctoc backup [--allow-plain]`: encrypted backup of the live database into backup_dir, rotation at
// 30 days (the purge safety backup included), date of success recorded for the settings page. Run daily
// in production (U15); the server may keep running.
import { basename, resolve } from "node:path"
import { openDatabase } from "../db/index.ts"
import { ConfigError, loadConfig } from "../lib/config.ts"
import { logError, logInfo } from "../lib/log.ts"
import { BackupError, runBackup } from "../services/backup.ts"

const HELP = `Usage: bin/toctoc backup [--allow-plain]

Writes an age-encrypted copy of <data_dir>/toctoc.db to backup_dir (toctoc-YYYYMMDD-HHMMSS.db.age, UTC),
encrypted to backup_recipient, then deletes the backups older than 30 days, including the purge safety
backup (toctoc-pre-purge-*.db.age). The server may keep running.

  --allow-plain  development only: write an unencrypted .db copy when backup_recipient is not configured`

export async function backupCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.error(HELP)
    return 0
  }
  const unknown = args.filter((a) => a !== "--allow-plain")
  if (unknown.length > 0) {
    console.error(HELP)
    return 2
  }
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`backup: ${err.message}`)
      return 1
    }
    throw err
  }

  const { db, sqlite } = openDatabase(resolve(config.dataDir, "toctoc.db"))
  try {
    const result = await runBackup({ db, config, now: () => new Date() }, sqlite, { allowPlain: args.includes("--allow-plain") })
    logInfo("backup_done", { file: basename(result.file), deleted: result.deleted.length })
    console.error(`Backup written: ${result.file}; ${result.deleted.length} backup(s) older than 30 days deleted.`)
    return 0
  } catch (err) {
    if (err instanceof BackupError) {
      console.error("backup: backup_recipient is not configured; set it, or pass --allow-plain in development.")
      return 1
    }
    logError("backup_failed", err)
    return 1
  } finally {
    sqlite.close()
  }
}
