// `bin/toctoc purge`: deletes every nominative data after the presidential election (R26, KTD16).
// Stop the server first.
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { openDatabase } from "../db/index.ts"
import { ConfigError, loadConfig } from "../lib/config.ts"
import { logError } from "../lib/log.ts"
import { isPurgeConfirmed, PURGE_CONFIRMATION, PurgeError, runPurge, type PurgeErrorCode } from "../services/purge.ts"

const HELP = `Usage: bin/toctoc purge [--confirm "${PURGE_CONFIRMATION}"]

Stop the TOCTOC server before running this command (systemctl stop toctoc).

Deletes every nominative data of <data_dir>/toctoc.db, irreversibly:
  1. writes the encrypted safety backup toctoc-pre-purge-YYYYMMDD-HHMMSS.db.age in backup_dir (kept 30 days,
     then deleted by the daily bin/toctoc backup); backup_recipient is required;
  2. stores a snapshot of the aggregated statistics;
  3. deletes electors, registrations, vote history and import exceptions, clears dwelling and remarks of the
     feedbacks; addresses, their qualifications, itineraries and cheat sheets are kept;
  4. deletes the uploaded import files and every other file of backup_dir, except the toctoc-pre-purge-* safety
     backups;
  5. compacts the database (VACUUM, WAL truncation).

Without --confirm, the phrase is asked on the terminal; anything else leaves the data untouched.`

const ERRORS: Record<PurgeErrorCode, string> = {
  not_confirmed: "confirmation phrase not given; nothing was deleted.",
  no_recipient: "backup_recipient is not configured: the encrypted safety backup is mandatory; nothing was deleted.",
  checkpoint_busy: "the database is in use by another process; nothing was deleted. Stop the server and run the purge again.",
  compaction_failed:
    "the nominative data is ALREADY DELETED, but the final compaction (VACUUM, WAL truncation) failed, so free pages " +
    "may still hold erased data. Do NOT delete the safety backup toctoc-pre-purge-*.db.age in backup_dir. Stop the " +
    "server (systemctl stop toctoc), check the free disk space (VACUUM needs room for a full copy of the database), " +
    "then run the purge again: the rerun keeps the existing safety backup and statistics snapshot.",
}

function confirmArgument(args: string[]): string | null {
  const i = args.indexOf("--confirm")
  if (i >= 0) return args[i + 1] ?? ""
  const inline = args.find((a) => a.startsWith("--confirm="))
  return inline === undefined ? null : inline.slice("--confirm=".length)
}

async function askConfirmation(): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(`Type "${PURGE_CONFIRMATION}" to delete every nominative data: `)
  } finally {
    rl.close()
  }
}

export async function purgeCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.error(HELP)
    return 0
  }
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`purge: ${err.message}`)
      return 1
    }
    throw err
  }

  console.error("The TOCTOC server must be stopped before the purge (systemctl stop toctoc).")
  const confirmation = confirmArgument(args) ?? (await askConfirmation())
  if (!isPurgeConfirmed(confirmation)) {
    console.error(`purge: ${ERRORS.not_confirmed}`)
    return 1
  }

  const { db, sqlite } = openDatabase(resolve(config.dataDir, "toctoc.db"))
  try {
    const r = await runPurge({ db, config, now: () => new Date() }, sqlite, { confirmation })
    console.error(
      [
        "Purge done.",
        r.safetyBackup === null
          ? "  safety backup: none written (rerun: the data was already deleted; the earlier toctoc-pre-purge-* file is kept)"
          : `  safety backup: ${r.safetyBackup} (deleted after 30 days by bin/toctoc backup)`,
        `  electors deleted: ${r.electors}`,
        `  registrations deleted: ${r.registrations}`,
        `  vote history rows deleted: ${r.voteHistory}`,
        `  import exceptions deleted: ${r.importExceptions}`,
        `  feedbacks cleared (dwelling, remarks): ${r.visitsCleared}`,
        `  uploaded import files deleted: ${r.importFiles}`,
        `  other backups deleted: ${r.backupsDeleted}`,
      ].join("\n"),
    )
    return 0
  } catch (err) {
    if (err instanceof PurgeError) {
      console.error(`purge: ${ERRORS[err.code]}`)
      return 1
    }
    logError("purge_failed", err)
    return 1
  } finally {
    sqlite.close()
  }
}
