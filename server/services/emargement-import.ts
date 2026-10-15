// Emargement import of the 2026 municipal elections (U5, R2, R3, KTD12, KTD13). Two steps like the
// REP import: prepareEmargementImport parses the uploaded file and matches it against the current
// electoral list without writing; commitEmargementImport freezes the voting history and records the
// rows it could not apply (import_exceptions), resolved later from the Exceptions screen.
//
// Matching: key bureau + order number of the current list; the key is not unique (the EU
// complementary lists restart at 1), so the normalized birth name settles the candidates. A row
// whose name matches no candidate is a name mismatch, a key without candidate is not found; two
// rows of the same elector are merged when their votes agree and flagged when they differ.
//
// The uploaded file is stored as <dataDir>/imports/<importId>.csv (named by import id) for the purge.
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { and, count, eq, inArray } from "drizzle-orm"
import type { AppContext } from "../context.ts"
import type { Db } from "../db/index.ts"
import { electors, importExceptions, imports, registrations, voteHistory } from "../db/schema/index.ts"
import { normalizeText } from "../domain/address-normalize.ts"
import { asVote, EMARGEMENT_ELECTION, voterLevel, type ListType, type VoteValue, type VoterLevel } from "../domain/voter-level.ts"
import { logInfo } from "../lib/log.ts"
import { currentEmargementImport, currentRepImportId, earliestRepImportId } from "./current-list.ts"
import { sanitizeField } from "./sanitize.ts"
import { electorVoterLevel, loadCurrentVoterLevels } from "./voter-levels.ts"

export type Round = 1 | 2

const COLUMNS = [
  "bureau",
  "numero",
  "nom_naissance",
  "nom_usage",
  "prenoms",
  "date_naissance",
  "ville_naissance",
  "departement",
  "adresse",
  "vote_t1",
  "vote_t2",
  "procuration_t1",
  "procuration_t2",
  "scan_file",
  "remarque",
] as const

export type EmargementErrorCode =
  | "emargement_invalid_header"
  | "emargement_empty"
  | "no_current_list"
  | "reference_list_replaced"
  | "exception_not_found"
  | "exception_already_resolved"
  | "exception_without_candidate"
  | "elector_not_found"

export class EmargementImportError extends Error {
  override name = "EmargementImportError"
  readonly code: EmargementErrorCode
  readonly missingColumns: string[]
  constructor(code: EmargementErrorCode, missingColumns: string[] = []) {
    super(`Emargement import rejected: ${code}`)
    this.code = code
    this.missingColumns = missingColumns
  }
}

export interface EmargementRow {
  /** 1-based data line in the file. */
  line: number
  bureau: string
  orderNumber: number | null
  birthName: string
  usageName: string | null
  firstNames: string
  birthDate: string | null
  t1: VoteValue
  t2: VoteValue
  proxyT1: string | null
  proxyT2: string | null
}

/** "oui" and "non" only; any other cell ("??", empty, OCR noise) is unreadable, never "non" (KTD13). */
function voteValue(cell: string | null): VoteValue {
  const value = cell?.toLowerCase()
  return value === "oui" || value === "non" ? value : "illisible"
}

function padBureau(value: string | null): string {
  if (value === null) return ""
  return /^\d+$/.test(value) ? value.padStart(4, "0") : value
}

/** Parses emargement_3_aggregate.csv: ";" separated, unquoted, CRLF (LF accepted), 15 columns. */
export function parseEmargement(text: string): EmargementRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)
  const header = (lines[0] ?? "").split(";").map((h) => h.trim().toLowerCase())
  const missing = COLUMNS.filter((c) => !header.includes(c))
  if (missing.length > 0) throw new EmargementImportError("emargement_invalid_header", missing)
  const at = (name: (typeof COLUMNS)[number]): number => header.indexOf(name)

  const rows: EmargementRow[] = []
  lines.slice(1).forEach((raw, i) => {
    if (raw.trim() === "") return
    const cells = raw.split(";")
    const get = (name: (typeof COLUMNS)[number]): string | null => sanitizeField(cells[at(name)])
    const numero = get("numero")
    rows.push({
      line: i + 1,
      bureau: padBureau(get("bureau")),
      orderNumber: numero !== null && /^\d+$/.test(numero) ? Number.parseInt(numero, 10) : null,
      birthName: get("nom_naissance") ?? "",
      usageName: get("nom_usage"),
      firstNames: get("prenoms") ?? "",
      birthDate: get("date_naissance"),
      t1: voteValue(get("vote_t1")),
      t2: voteValue(get("vote_t2")),
      proxyT1: get("procuration_t1"),
      proxyT2: get("procuration_t2"),
    })
  })
  if (rows.length === 0) throw new EmargementImportError("emargement_empty")
  return rows
}

interface Candidate {
  electorId: string
  birthName: string
}

type ExceptionKind = "name_mismatch" | "discordant_duplicate" | "not_found"

interface PlannedException {
  kind: ExceptionKind
  row: EmargementRow
  electorId: string | null
}

export interface EmargementSimulation {
  pendingId: string
  rows: number
  /** Electors whose votes will be applied. */
  matched: number
  /** Electors listed on several identical rows (scanned twice), merged into one. */
  merged: number
  /** Rows whose birth name matches no elector of their bureau and number (not applied). */
  nameMismatches: number
  /** Rows whose bureau and number match no elector of the list. */
  notFound: number
  /** Electors listed on rows with different votes (none applied). */
  discordantDuplicates: number
  /** Vote cells other than "oui" or "non". */
  unreadableCells: number
  /** Electors of the list who will be at the "inconnu" level once confirmed. */
  unknownLevel: number
}

export interface PendingEmargementImport {
  id: string
  referenceImportId: string
  rows: EmargementRow[]
  /** Row applied to each elector. */
  applied: Map<string, EmargementRow>
  exceptions: PlannedException[]
  filePath: string
  simulation: EmargementSimulation
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

const keyOf = (bureau: string, orderNumber: number | null): string => `${bureau}|${orderNumber ?? ""}`

function sameVotes(a: EmargementRow, b: EmargementRow): boolean {
  return a.t1 === b.t1 && a.t2 === b.t2
}

/** Matches the rows against the list `importId`; pure apart from reading the registrations. */
function plan(db: Db, importId: string, rows: EmargementRow[]) {
  const index = new Map<string, Candidate[]>()
  const listTypes = new Map<string, ListType[]>()
  const listed = db
    .select({
      electorId: registrations.electorId,
      bureau: registrations.bureau,
      orderNumber: registrations.orderNumber,
      listType: registrations.listType,
      birthName: electors.birthName,
    })
    .from(registrations)
    .innerJoin(electors, eq(electors.id, registrations.electorId))
    .where(eq(registrations.importId, importId))
    .all()
  for (const r of listed) {
    const key = keyOf(r.bureau, r.orderNumber)
    const candidates = index.get(key) ?? []
    // An EU citizen on both complementary lists has two registrations with the same key.
    if (!candidates.some((c) => c.electorId === r.electorId)) candidates.push({ electorId: r.electorId, birthName: r.birthName })
    index.set(key, candidates)
    listTypes.set(r.electorId, [...(listTypes.get(r.electorId) ?? []), r.listType])
  }

  const exceptions: PlannedException[] = []
  const byElector = new Map<string, EmargementRow[]>()
  for (const row of rows) {
    const candidates = row.orderNumber === null ? [] : (index.get(keyOf(row.bureau, row.orderNumber)) ?? [])
    if (candidates.length === 0) {
      exceptions.push({ kind: "not_found", row, electorId: null })
      continue
    }
    const name = normalizeText(row.birthName)
    const match = candidates.find((c) => normalizeText(c.birthName) === name)
    if (match === undefined) {
      const closest = [...candidates].sort(
        (a, b) => levenshtein(normalizeText(a.birthName), name) - levenshtein(normalizeText(b.birthName), name),
      )[0]
      exceptions.push({ kind: "name_mismatch", row, electorId: closest?.electorId ?? null })
      continue
    }
    byElector.set(match.electorId, [...(byElector.get(match.electorId) ?? []), row])
  }

  const applied = new Map<string, EmargementRow>()
  let merged = 0
  let discordant = 0
  for (const [electorId, list] of byElector) {
    const first = list[0]
    if (first === undefined) continue
    if (list.every((r) => sameVotes(r, first))) {
      applied.set(electorId, first)
      if (list.length > 1) merged++
    } else {
      discordant++
      for (const row of list) exceptions.push({ kind: "discordant_duplicate", row, electorId })
    }
  }

  let unknownLevel = 0
  for (const [electorId, types] of listTypes) {
    const row = applied.get(electorId)
    const level = voterLevel({ listTypes: types, onReferenceList: true, rounds: row ? [row.t1, row.t2] : [] })
    if (level === "inconnu") unknownLevel++
  }

  return {
    applied,
    exceptions,
    counts: {
      matched: applied.size,
      merged,
      nameMismatches: exceptions.filter((e) => e.kind === "name_mismatch").length,
      notFound: exceptions.filter((e) => e.kind === "not_found").length,
      discordantDuplicates: discordant,
      unreadableCells: rows.reduce((n, r) => n + (r.t1 === "illisible" ? 1 : 0) + (r.t2 === "illisible" ? 1 : 0), 0),
      unknownLevel,
    },
  }
}

/**
 * The REP list the 2026 emargement is matched against: the reference of the current emargement
 * import when there is one, else the current list as long as it is still the first one imported.
 * Once a newer list (2027) replaced it without any emargement imported, the order numbers no longer
 * match the 2026 registers, so the import is refused rather than matched against the wrong list.
 */
function emargementReferenceImportId(db: Db): string {
  const fromEmargement = currentEmargementImport(db)?.referenceImportId ?? null
  if (fromEmargement !== null) return fromEmargement
  const current = currentRepImportId(db)
  if (current === null) throw new EmargementImportError("no_current_list")
  if (current !== earliestRepImportId(db)) throw new EmargementImportError("reference_list_replaced")
  return current
}

/** Parses, stores the file and matches it against the 2026 reference list. Writes nothing in the database. */
export async function prepareEmargementImport(ctx: AppContext, content: Buffer): Promise<PendingEmargementImport> {
  const referenceImportId = emargementReferenceImportId(ctx.db)
  const rows = parseEmargement(content.toString("utf-8"))
  const id = randomUUID()
  const dir = join(ctx.config.dataDir, "imports")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const filePath = join(dir, `${id}.csv`)
  await writeFile(filePath, content, { mode: 0o600 })

  const { applied, exceptions, counts } = plan(ctx.db, referenceImportId, rows)
  const simulation: EmargementSimulation = { pendingId: id, rows: rows.length, ...counts }
  logInfo("emargement_import_simulated", { ...counts, rows: rows.length })
  return { id, referenceImportId, rows, applied, exceptions, filePath, simulation }
}

/** Source row kept in import_exceptions.payload: names and votes, never the birth place nor the address. */
interface ExceptionPayload {
  line: number
  birthName: string
  usageName: string | null
  firstNames: string
  birthDate: string | null
  t1: VoteValue
  t2: VoteValue
  proxyT1: string | null
  proxyT2: string | null
}

function toPayload(row: EmargementRow): ExceptionPayload {
  return {
    line: row.line,
    birthName: row.birthName,
    usageName: row.usageName,
    firstNames: row.firstNames,
    birthDate: row.birthDate,
    t1: row.t1,
    t2: row.t2,
    proxyT1: row.proxyT1,
    proxyT2: row.proxyT2,
  }
}

const asText = (value: unknown): string | null => (typeof value === "string" ? value : null)

function fromPayload(json: string): ExceptionPayload {
  const raw: unknown = JSON.parse(json)
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    line: typeof o["line"] === "number" ? o["line"] : 0,
    birthName: asText(o["birthName"]) ?? "",
    usageName: asText(o["usageName"]),
    firstNames: asText(o["firstNames"]) ?? "",
    birthDate: asText(o["birthDate"]),
    t1: asVote(o["t1"]),
    t2: asVote(o["t2"]),
    proxyT1: asText(o["proxyT1"]),
    proxyT2: asText(o["proxyT2"]),
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** Writes (or replaces) one round of the frozen history. */
function upsertRound(
  tx: Db | Tx,
  electorId: string,
  round: Round,
  value: VoteValue,
  /** Undefined keeps the proxy annotation already recorded (manual corrections). */
  proxy: string | null | undefined,
  importId: string | null,
): void {
  tx.insert(voteHistory)
    .values({ id: randomUUID(), electorId, election: EMARGEMENT_ELECTION, round, value, proxy: proxy ?? null, importId })
    .onConflictDoUpdate({
      target: [voteHistory.electorId, voteHistory.election, voteHistory.round],
      set: proxy === undefined ? { value, importId } : { value, proxy, importId },
    })
    .run()
}

export interface EmargementImportResult {
  importId: string
  rows: number
  matched: number
  exceptions: number
  votersT1: number
  votersT2: number
}

/** Freezes the history in one transaction, replacing any previous emargement import. */
export function commitEmargementImport(ctx: AppContext, pending: PendingEmargementImport): EmargementImportResult {
  const now = ctx.now().getTime()
  const result = ctx.db.transaction((tx) => {
    tx.update(imports).set({ isCurrent: false }).where(eq(imports.kind, "emargement")).run()
    tx.insert(imports)
      .values({
        id: pending.id,
        kind: "emargement",
        importedAt: now,
        rowCount: pending.rows.length,
        isCurrent: true,
        referenceImportId: pending.referenceImportId,
      })
      .run()
    tx.delete(voteHistory).where(eq(voteHistory.election, EMARGEMENT_ELECTION)).run()
    for (const [electorId, row] of pending.applied) {
      upsertRound(tx, electorId, 1, row.t1, row.proxyT1, pending.id)
      upsertRound(tx, electorId, 2, row.t2, row.proxyT2, pending.id)
    }
    for (const e of pending.exceptions) {
      tx.insert(importExceptions)
        .values({
          id: randomUUID(),
          importId: pending.id,
          kind: e.kind,
          bureau: e.row.bureau,
          orderNumber: e.row.orderNumber,
          electorId: e.electorId,
          payload: JSON.stringify(toPayload(e.row)),
        })
        .run()
    }
    return {
      importId: pending.id,
      rows: pending.rows.length,
      matched: pending.applied.size,
      exceptions: pending.exceptions.length,
      votersT1: [...pending.applied.values()].filter((r) => r.t1 === "oui").length,
      votersT2: [...pending.applied.values()].filter((r) => r.t2 === "oui").length,
    }
  })
  logInfo("emargement_import_confirmed", {
    rows: result.rows,
    matched: result.matched,
    exceptions: result.exceptions,
    votersT1: result.votersT1,
    votersT2: result.votersT2,
  })
  return result
}

export interface EmargementStatus {
  importId: string
  importedAt: number
  rows: number
  votersT1: number
  votersT2: number
  /** Open name mismatches and discordant duplicates (the not-found rows have no candidate). */
  openRowExceptions: number
  notFound: number
  unknownLevel: number
}

export function emargementStatus(db: Db): EmargementStatus | null {
  const current = currentEmargementImport(db)
  if (current === null) return null
  const voters = (round: Round): number =>
    db
      .select({ n: count() })
      .from(voteHistory)
      .where(and(eq(voteHistory.election, EMARGEMENT_ELECTION), eq(voteHistory.round, round), eq(voteHistory.value, "oui")))
      .get()?.n ?? 0
  const open = (kinds: ExceptionKind[]): number =>
    db
      .select({ n: count() })
      .from(importExceptions)
      .where(
        and(eq(importExceptions.importId, current.id), eq(importExceptions.status, "open"), inArray(importExceptions.kind, kinds)),
      )
      .get()?.n ?? 0
  return {
    importId: current.id,
    importedAt: current.importedAt,
    rows: current.rowCount,
    votersT1: voters(1),
    votersT2: voters(2),
    openRowExceptions: open(["name_mismatch", "discordant_duplicate"]),
    notFound: open(["not_found"]),
    unknownLevel: [...loadCurrentVoterLevels(db).values()].filter((l) => l === "inconnu").length,
  }
}

export interface RowExceptionItem {
  id: string
  kind: "name_mismatch" | "discordant_duplicate"
  bureau: string | null
  orderNumber: number | null
  /** Names and votes as read on the emargement. */
  row: { birthName: string; usageName: string | null; firstNames: string; t1: VoteValue; t2: VoteValue }
  /** Elector of the list the row would be applied to, names as on the electoral list. */
  candidate: { electorId: string; birthName: string; usageName: string | null; firstNames: string } | null
}

/** Open name mismatches and discordant duplicates of the current emargement import. */
export function listRowExceptions(db: Db): { items: RowExceptionItem[]; notFound: number } {
  const current = currentEmargementImport(db)
  if (current === null) return { items: [], notFound: 0 }
  const rows = db
    .select({
      id: importExceptions.id,
      kind: importExceptions.kind,
      bureau: importExceptions.bureau,
      orderNumber: importExceptions.orderNumber,
      payload: importExceptions.payload,
      electorId: electors.id,
      birthName: electors.birthName,
      usageName: electors.usageName,
      firstNames: electors.firstNames,
    })
    .from(importExceptions)
    .leftJoin(electors, eq(electors.id, importExceptions.electorId))
    .where(and(eq(importExceptions.importId, current.id), eq(importExceptions.status, "open")))
    .all()
  const items = rows
    .flatMap((r) => {
      if (r.kind === "not_found") return []
      const p = fromPayload(r.payload)
      const item: RowExceptionItem & { line: number } = {
        id: r.id,
        kind: r.kind,
        bureau: r.bureau,
        orderNumber: r.orderNumber,
        line: p.line,
        row: { birthName: p.birthName, usageName: p.usageName, firstNames: p.firstNames, t1: p.t1, t2: p.t2 },
        candidate:
          r.electorId === null || r.birthName === null || r.firstNames === null
            ? null
            : { electorId: r.electorId, birthName: r.birthName, usageName: r.usageName, firstNames: r.firstNames },
      }
      return [item]
    })
    .sort(
      (a, b) =>
        (a.bureau ?? "").localeCompare(b.bureau ?? "") || (a.orderNumber ?? 0) - (b.orderNumber ?? 0) || a.line - b.line,
    )
    .map(({ line: _line, ...item }) => item)
  return { items, notFound: rows.filter((r) => r.kind === "not_found").length }
}

export interface RowDecisionResult {
  id: string
  status: "accepted" | "rejected"
  electorId: string | null
  level: VoterLevel | null
}

/** Accepts (applies the row's votes to the candidate) or rejects an open exception. */
export function decideRowException(ctx: AppContext, id: string, decision: "accepted" | "rejected"): RowDecisionResult {
  const exception = ctx.db.select().from(importExceptions).where(eq(importExceptions.id, id)).get()
  if (!exception) throw new EmargementImportError("exception_not_found")
  if (exception.status !== "open") throw new EmargementImportError("exception_already_resolved")
  const electorId = exception.electorId
  if (decision === "accepted" && electorId === null) throw new EmargementImportError("exception_without_candidate")
  const now = ctx.now().getTime()
  ctx.db.transaction((tx) => {
    tx.update(importExceptions).set({ status: decision, resolvedAt: now }).where(eq(importExceptions.id, id)).run()
    if (decision !== "accepted" || electorId === null) return
    const p = fromPayload(exception.payload)
    upsertRound(tx, electorId, 1, p.t1, p.proxyT1, exception.importId)
    upsertRound(tx, electorId, 2, p.t2, p.proxyT2, exception.importId)
    if (exception.kind === "discordant_duplicate") {
      // The other rows of the same elector are superseded by the accepted one.
      tx.update(importExceptions)
        .set({ status: "rejected", resolvedAt: now })
        .where(
          and(
            eq(importExceptions.importId, exception.importId),
            eq(importExceptions.kind, "discordant_duplicate"),
            eq(importExceptions.electorId, electorId),
            eq(importExceptions.status, "open"),
          ),
        )
        .run()
    }
  })
  logInfo("emargement_exception_decided", { kind: exception.kind, decision })
  return {
    id,
    status: decision,
    electorId,
    level: electorId === null ? null : (electorVoterLevel(ctx.db, electorId) ?? null),
  }
}

export interface UnknownElectorItem {
  electorId: string
  bureau: string
  orderNumber: number | null
  birthName: string
  usageName: string | null
  firstNames: string
  rounds: { 1: VoteValue | null; 2: VoteValue | null }
}

/** Electors of the current list at the "inconnu" level, by bureau and order number. */
export function listUnknownElectors(db: Db): { items: UnknownElectorItem[] } {
  const currentId = currentRepImportId(db)
  if (currentId === null) return { items: [] }
  const unknown = [...loadCurrentVoterLevels(db)].filter(([, level]) => level === "inconnu").map(([id]) => id)
  if (unknown.length === 0) return { items: [] }
  const rounds = new Map<string, UnknownElectorItem["rounds"]>()
  for (const v of db
    .select({ electorId: voteHistory.electorId, round: voteHistory.round, value: voteHistory.value })
    .from(voteHistory)
    .where(and(eq(voteHistory.election, EMARGEMENT_ELECTION), inArray(voteHistory.electorId, unknown)))
    .all()) {
    const entry = rounds.get(v.electorId) ?? { 1: null, 2: null }
    if (v.round === 1 || v.round === 2) entry[v.round] = v.value
    rounds.set(v.electorId, entry)
  }
  const items: UnknownElectorItem[] = []
  const seen = new Set<string>()
  const listed = db
    .select({
      electorId: registrations.electorId,
      bureau: registrations.bureau,
      orderNumber: registrations.orderNumber,
      listType: registrations.listType,
      birthName: electors.birthName,
      usageName: electors.usageName,
      firstNames: electors.firstNames,
    })
    .from(registrations)
    .innerJoin(electors, eq(electors.id, registrations.electorId))
    .where(and(eq(registrations.importId, currentId), inArray(registrations.electorId, unknown)))
    .orderBy(registrations.bureau, registrations.orderNumber)
    .all()
  for (const { listType, ...r } of listed) {
    // An "inconnu" elector is on the principal list; keep its principal registration.
    if (listType !== "principale" || seen.has(r.electorId)) continue
    seen.add(r.electorId)
    items.push({ ...r, rounds: rounds.get(r.electorId) ?? { 1: null, 2: null } })
  }
  return { items }
}

/** Manual correction of one round from the Exceptions screen; returns the recomputed level. */
export function setRoundValue(
  ctx: AppContext,
  electorId: string,
  round: Round,
  value: VoteValue,
): { electorId: string; level: VoterLevel } {
  const currentId = currentRepImportId(ctx.db)
  const listed =
    currentId === null
      ? undefined
      : ctx.db
          .select({ id: registrations.id })
          .from(registrations)
          .where(and(eq(registrations.importId, currentId), eq(registrations.electorId, electorId)))
          .get()
  if (listed === undefined) throw new EmargementImportError("elector_not_found")
  // Tied to the current emargement import, so a re-import replaces the corrections with the file.
  upsertRound(ctx.db, electorId, round, value, undefined, currentEmargementImport(ctx.db)?.id ?? null)
  logInfo("emargement_round_corrected", { round })
  const level = electorVoterLevel(ctx.db, electorId)
  if (level === undefined) throw new EmargementImportError("elector_not_found")
  return { electorId, level }
}
