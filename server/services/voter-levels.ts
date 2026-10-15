// Loader of the abstention levels (R3, KTD13) of the current list, from the frozen 2026 voting history.
// The rule itself is pure and lives in server/domain/voter-level.ts.
import { sql } from "drizzle-orm"
import type { Db } from "../db/index.ts"
import { asVote, EMARGEMENT_ELECTION, LIST_TYPES, voterLevel, type VoterLevel } from "../domain/voter-level.ts"
import { currentEmargementImport, currentRepImportId } from "./current-list.ts"

interface LevelRow {
  elector_id: string
  lists: string
  on_reference: number
  votes: string | null
}

function queryLevels(db: Db, electorId: string | null): Map<string, VoterLevel> {
  const levels = new Map<string, VoterLevel>()
  const currentId = currentRepImportId(db)
  if (currentId === null) return levels
  // Before any emargement import there is no reference list: nobody is a new registrant yet.
  const referenceId = currentEmargementImport(db)?.referenceImportId ?? null
  const onlyOne = electorId === null ? sql`` : sql` and r.elector_id = ${electorId}`
  const rows = db.all<LevelRow>(sql`
    select r.elector_id as elector_id,
      group_concat(distinct r.list_type) as lists,
      ${referenceId === null ? sql`1` : sql`exists (select 1 from registrations ref where ref.import_id = ${referenceId} and ref.elector_id = r.elector_id)`} as on_reference,
      (select group_concat(v.value) from vote_history v where v.elector_id = r.elector_id and v.election = ${EMARGEMENT_ELECTION}) as votes
    from registrations r
    where r.import_id = ${currentId}${onlyOne}
    group by r.elector_id`)
  for (const row of rows) {
    const listTypes = row.lists.split(",").flatMap((t) => LIST_TYPES.filter((l) => l === t))
    const rounds = row.votes === null ? [] : row.votes.split(",").map(asVote)
    levels.set(row.elector_id, voterLevel({ listTypes, onReferenceList: row.on_reference === 1, rounds }))
  }
  return levels
}

/** Level of every elector of the current list, in one query (map, statistics, routing weights). */
export function loadCurrentVoterLevels(db: Db): Map<string, VoterLevel> {
  return queryLevels(db, null)
}

/** Level of one elector of the current list; undefined when the elector is not on it. */
export function electorVoterLevel(db: Db, electorId: string): VoterLevel | undefined {
  return queryLevels(db, electorId).get(electorId)
}
