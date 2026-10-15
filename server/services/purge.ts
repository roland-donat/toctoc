// Purge of every nominative data after the 2027 presidential election (R26, KTD16). Order matters:
// (1) encrypted safety backup in backup_dir; (2) snapshot of the aggregated statistics in the settings;
// (3) deletion of electors, registrations, vote history and import exceptions, free text of the feedbacks
// cleared; (4) uploaded import files and every other backup deleted; (5) VACUUM and WAL truncation so
// no free page keeps erased data. Addresses, their qualifications (the visit rows), itineraries, field
// links, cheat sheets and settings stay. The server must be stopped: a live connection would block (5).
//
// Rerun after a late failure (VACUUM or the final checkpoint, once (3) has committed): the electors table is
// already empty, so (1) and (2) are skipped (a new backup or snapshot would only hold the purged database),
// and (4) keeps every pre-purge safety backup, which expires through the 30-day rotation of the daily backup.
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { count } from "drizzle-orm"
import type Database from "better-sqlite3"
import type { AppContext } from "../context.ts"
import { electors, importExceptions, registrations, visits, voteHistory } from "../db/schema/index.ts"
import { setSetting } from "../db/settings.ts"
import { campaignActivity, campaignCoverage, computeStats, type CampaignActivity, type CampaignCoverage, type StatsReport } from "../domain/stats.ts"
import { logInfo } from "../lib/log.ts"
import { loadCampaignDates, loadElectorFacts, type CampaignDates } from "./stats-data.ts"
import { computeAddressStatuses } from "./address-status.ts"
import { isPrePurgeBackupName, writeBackup } from "./backup.ts"

/** Phrase the administrator types to confirm the purge. */
export const PURGE_CONFIRMATION = "SUPPRIMER LES DONNÉES NOMINATIVES"

/** Setting holding the aggregated statistics taken just before the purge. */
export const STATS_SNAPSHOT_KEY = "stats_snapshot"

export interface StatsSnapshot {
  /** ISO instant of the snapshot. */
  takenAt: string
  stats: StatsReport
  campaign: CampaignDates & { activity: CampaignActivity; coverage: CampaignCoverage }
}

/** compaction_failed: VACUUM or the final WAL truncation failed after the nominative rows were deleted. */
export type PurgeErrorCode = "not_confirmed" | "no_recipient" | "checkpoint_busy" | "compaction_failed"

export class PurgeError extends Error {
  override name = "PurgeError"
  readonly code: PurgeErrorCode
  constructor(code: PurgeErrorCode) {
    super(`Purge refused: ${code}`)
    this.code = code
  }
}

export interface PurgeResult {
  /** Null on a rerun after a late failure: the nominative rows were already gone, the first backup is kept. */
  safetyBackup: string | null
  electors: number
  registrations: number
  voteHistory: number
  importExceptions: number
  /** Feedbacks whose dwelling and remarks were cleared (all of them). */
  visitsCleared: number
  importFiles: number
  backupsDeleted: number
}

/** True when the typed phrase is the confirmation, whatever the Unicode form the terminal sent. */
export function isPurgeConfirmed(value: string | null): boolean {
  return value !== null && value.normalize("NFC").trim() === PURGE_CONFIRMATION
}

async function statsSnapshot(ctx: AppContext): Promise<StatsSnapshot> {
  // Same computation as the Statistics tab (U8).
  const stats = computeStats(loadElectorFacts(ctx.db))
  const dates = loadCampaignDates(ctx.db)
  const visitRows = ctx.db
    .select({ addressId: visits.addressId, visitDate: visits.visitDate, qualification: visits.qualification })
    .from(visits)
    .all()
  return {
    takenAt: ctx.now().toISOString(),
    stats,
    campaign: {
      ...dates,
      activity: campaignActivity(visitRows, dates.startDate),
      coverage: campaignCoverage(computeAddressStatuses(ctx), dates.startDate),
    },
  }
}

/** Deletes every entry of `dir` except those `keep` accepts; a missing directory counts as empty. */
async function emptyDirectory(dir: string, keep: (name: string) => boolean = () => false): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let deleted = 0
  for (const name of names) {
    if (keep(name)) continue
    await rm(join(dir, name), { recursive: true, force: true })
    deleted++
  }
  return deleted
}

function rowCount(ctx: AppContext, table: typeof electors | typeof registrations | typeof voteHistory | typeof importExceptions | typeof visits): number {
  return ctx.db.select({ n: count() }).from(table).get()?.n ?? 0
}

/** Copies the WAL into the database and truncates it; false when another connection prevented it. */
function checkpointTruncate(sqlite: Database.Database): boolean {
  const [checkpoint] = sqlite.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[]
  return checkpoint === undefined || checkpoint.busy === 0
}

export async function runPurge(
  ctx: AppContext,
  sqlite: Database.Database,
  options: { confirmation: string | null },
): Promise<PurgeResult> {
  if (!isPurgeConfirmed(options.confirmation)) throw new PurgeError("not_confirmed")
  const recipient = ctx.config.backupRecipient
  if (recipient === null) throw new PurgeError("no_recipient")
  // A connection in use (the server still running) would make the final compaction fail after the deletion,
  // and a second run would then replace the real safety backup: refuse before touching anything.
  if (!checkpointTruncate(sqlite)) throw new PurgeError("checkpoint_busy")

  // A rerun after a late failure: the rows are already deleted, the existing backup and snapshot are the real ones.
  const alreadyPurged = rowCount(ctx, electors) === 0

  // (1) Safety backup, kept 30 days (deleted by the daily `bin/toctoc backup`).
  const safetyBackup = alreadyPurged
    ? null
    : await writeBackup(sqlite, { backupDir: ctx.config.backupDir, recipient, kind: "pre-purge", now: ctx.now() })

  // (2) Aggregated statistics, kept after the purge.
  if (!alreadyPurged) setSetting(ctx.db, STATS_SNAPSHOT_KEY, await statsSnapshot(ctx))

  // (3) Nominative rows: children first (foreign keys).
  const counts = ctx.db.transaction((tx) => {
    const before = {
      electors: rowCount(ctx, electors),
      registrations: rowCount(ctx, registrations),
      voteHistory: rowCount(ctx, voteHistory),
      importExceptions: rowCount(ctx, importExceptions),
      visitsCleared: rowCount(ctx, visits),
    }
    tx.delete(importExceptions).run()
    tx.delete(voteHistory).run()
    tx.delete(registrations).run()
    tx.delete(electors).run()
    tx.update(visits).set({ dwelling: null, remarks: null }).run()
    return before
  })

  // (4) Uploaded REP and emargement files, and every other copy of the database. Every safety backup stays,
  // the one just written and any left by an earlier run: they expire through the daily rotation.
  const importFiles = await emptyDirectory(join(ctx.config.dataDir, "imports"))
  const backupsDeleted = await emptyDirectory(ctx.config.backupDir, isPrePurgeBackupName)

  // (5) Rebuild the file without the freed pages, then empty the WAL.
  try {
    sqlite.exec("VACUUM")
  } catch {
    throw new PurgeError("compaction_failed")
  }
  if (!checkpointTruncate(sqlite)) throw new PurgeError("compaction_failed")

  const result: PurgeResult = { safetyBackup, ...counts, importFiles, backupsDeleted }
  logInfo("purge_done", {
    electors: result.electors,
    registrations: result.registrations,
    voteHistory: result.voteHistory,
    importExceptions: result.importExceptions,
    visitsCleared: result.visitsCleared,
    importFiles,
    backupsDeleted,
  })
  return result
}
