// Electoral list import (U4, R1, KTD12). Two steps: prepareRepImport parses the uploaded REP file,
// matches the addresses and returns a simulation without writing any elector; commitRepImport writes
// the import, the electors and their registrations in one transaction.
//
// Pending simulations are kept in memory (PendingImports, only the latest one): a restart drops
// it and the administrator uploads the file again. The uploaded file itself is stored as
// <dataDir>/imports/<importId>.csv (named by import id, never by person) for the purge to remove.
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { eq, isNull } from "drizzle-orm"
import Papa from "papaparse"
import type { AppContext } from "../context.ts"
import { addresses, electors, imports, registrations } from "../db/schema/index.ts"
import { matchKey, normalizeText } from "../domain/address-normalize.ts"
import type { ListType } from "../domain/voter-level.ts"
import { logInfo } from "../lib/log.ts"
import { computeAddressStatuses } from "./address-status.ts"
import { currentRepImportId } from "./current-list.ts"
import { loadAddressIndex, matchAddresses, type AddressMatch, type RepAddress, type StreetAddressPlan } from "./address-matcher.ts"
import type { GeocodeOptions } from "./geocode-fallback.ts"
import { sanitizeField } from "./sanitize.ts"

const LIST_TYPE_LABELS: Readonly<Record<string, ListType>> = {
  "liste principale": "principale",
  "liste complementaire europeenne": "complementaire_ue",
  "liste complementaire municipale": "complementaire_municipale",
}

const COL = {
  listType: "libellé du type de liste",
  birthName: "nom de naissance",
  usageName: "nom d'usage",
  firstNames: "prénoms",
  sex: "sexe",
  birthDate: "date de naissance",
  birthCommuneCode: "code commune de naissance",
  birthCommune: "libellé commune de naissance",
  birthDepartment: "code département de naissance",
  birthCountry: "pays de naissance",
  nationality: "libellé nationalité",
  number: "numéro de voie",
  street: "libellé de voie",
  complement1: "complément 1",
  complement2: "complément 2",
  lieuDit: "lieu-dit",
  postalCode: "code postal",
  commune: "commune",
  bureau: "code du bureau de vote",
  orderNumber: "numéro d'ordre dans le bureau de vote",
} as const

export type RepFormatErrorCode = "rep_invalid_header" | "rep_empty" | "rep_unknown_list_type" | "rep_missing_identity"

export class RepFormatError extends Error {
  override name = "RepFormatError"
  readonly code: RepFormatErrorCode
  readonly missingColumns: string[]
  /** 1-based data line, when the error concerns one line. */
  readonly line: number | null
  constructor(code: RepFormatErrorCode, options: { missingColumns?: string[]; line?: number } = {}) {
    super(`REP file rejected: ${code}`)
    this.code = code
    this.missingColumns = options.missingColumns ?? []
    this.line = options.line ?? null
  }
}

export interface RepRow {
  identityKey: string
  listType: ListType
  birthName: string
  usageName: string | null
  firstNames: string
  sex: "F" | "M" | null
  /** ISO date; null when absent or unreadable. */
  birthDate: string | null
  birthDateUnreadable: boolean
  birthCommuneCode: string | null
  birthCommune: string | null
  birthDepartment: string | null
  birthCountry: string | null
  nationality: string | null
  bureau: string
  orderNumber: number | null
  address: RepAddress
  rawComplement1: string | null
  rawComplement2: string | null
}

/** dd/mm/yyyy to ISO; null when the value is not a real calendar date. */
function parseDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value)
  if (!match) return null
  const [, dd, mm, yyyy] = match
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)))
  if (date.getUTCFullYear() !== Number(yyyy) || date.getUTCMonth() !== Number(mm) - 1 || date.getUTCDate() !== Number(dd)) {
    return null
  }
  return `${yyyy}-${mm}-${dd}`
}

function parseOrderNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  return Number.parseInt(value, 10)
}

/** Stable elector identity (KTD12): normalized birth name, first names and ISO birth date (empty when unknown). */
export function identityKey(birthName: string, firstNames: string, birthDate: string | null): string {
  return `${normalizeText(birthName)}|${normalizeText(firstNames)}|${birthDate ?? ""}`
}

/** Parses a REP file (";" separated, quoted, BOM and CRLF accepted, headers normalized NFC). */
export function parseRep(text: string): RepRow[] {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    delimiter: ";",
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.replace(/^\uFEFF/, "").normalize("NFC").trim().toLowerCase(),
  })
  const fields = parsed.meta.fields ?? []
  const missing = Object.values(COL).filter((c) => !fields.includes(c))
  if (missing.length > 0) throw new RepFormatError("rep_invalid_header", { missingColumns: missing })
  if (parsed.data.length === 0) throw new RepFormatError("rep_empty")

  return parsed.data.map((raw, i) => {
    const get = (column: string): string | null => sanitizeField(raw[column])
    const line = i + 1
    const listType = LIST_TYPE_LABELS[normalizeText(get(COL.listType) ?? "")]
    if (listType === undefined) throw new RepFormatError("rep_unknown_list_type", { line })
    const birthName = get(COL.birthName)
    const firstNames = get(COL.firstNames)
    if (birthName === null || firstNames === null) throw new RepFormatError("rep_missing_identity", { line })
    const rawDate = get(COL.birthDate)
    const birthDate = rawDate === null ? null : parseDate(rawDate)
    const sex = get(COL.sex)?.toUpperCase()
    return {
      identityKey: identityKey(birthName, firstNames, birthDate),
      listType,
      birthName,
      usageName: get(COL.usageName),
      firstNames,
      sex: sex === "F" || sex === "M" ? sex : null,
      birthDate,
      birthDateUnreadable: rawDate !== null && birthDate === null,
      birthCommuneCode: get(COL.birthCommuneCode),
      birthCommune: get(COL.birthCommune),
      birthDepartment: get(COL.birthDepartment),
      birthCountry: get(COL.birthCountry),
      nationality: get(COL.nationality),
      bureau: get(COL.bureau) ?? "",
      orderNumber: parseOrderNumber(get(COL.orderNumber)),
      address: {
        rawNumber: get(COL.number),
        rawStreet: get(COL.street),
        rawLieuDit: get(COL.lieuDit),
        rawPostalCode: get(COL.postalCode),
        rawCommune: get(COL.commune),
      },
      rawComplement1: get(COL.complement1),
      rawComplement2: get(COL.complement2),
    }
  })
}

export interface RepSimulation {
  pendingId: string
  rows: number
  electors: number
  listTypes: Record<ListType, number>
  matchedBan: number
  matchedFallback: number
  matchedStreet: number
  toAttach: number
  unreadableDates: number
  /** Electors listed on more than one list of the file (EU citizens on both complementary lists). */
  duplicatesAcrossLists: number
  /** False when the Géoplateforme could not be reached: every unmatched address went to the queue. */
  fallbackAvailable: boolean
}

export interface PendingRepImport {
  /** Also the id of the import once confirmed, and the name of the stored file. */
  id: string
  rows: RepRow[]
  matches: AddressMatch[]
  streets: Map<string, StreetAddressPlan>
  filePath: string
  simulation: RepSimulation
}

function simulate(id: string, rows: RepRow[], matches: AddressMatch[], fallbackAvailable: boolean): RepSimulation {
  const listsByElector = new Map<string, Set<ListType>>()
  for (const row of rows) {
    const lists = listsByElector.get(row.identityKey) ?? new Set<ListType>()
    lists.add(row.listType)
    listsByElector.set(row.identityKey, lists)
  }
  const countStatus = (status: AddressMatch["status"]): number => matches.filter((m) => m.status === status).length
  return {
    pendingId: id,
    rows: rows.length,
    electors: listsByElector.size,
    listTypes: {
      principale: rows.filter((r) => r.listType === "principale").length,
      complementaire_ue: rows.filter((r) => r.listType === "complementaire_ue").length,
      complementaire_municipale: rows.filter((r) => r.listType === "complementaire_municipale").length,
    },
    matchedBan: countStatus("ban"),
    matchedFallback: countStatus("fallback"),
    matchedStreet: countStatus("street"),
    toAttach: countStatus("pending"),
    unreadableDates: rows.filter((r) => r.birthDateUnreadable).length,
    duplicatesAcrossLists: [...listsByElector.values()].filter((s) => s.size > 1).length,
    fallbackAvailable,
  }
}

/** Parses, stores the file under <dataDir>/imports/ and matches the addresses. Writes no elector. */
export async function prepareRepImport(
  ctx: AppContext,
  content: Buffer,
  options: GeocodeOptions = {},
): Promise<PendingRepImport> {
  const rows = parseRep(content.toString("utf-8"))
  const id = randomUUID()
  const dir = join(ctx.config.dataDir, "imports")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const filePath = join(dir, `${id}.csv`)
  await writeFile(filePath, content, { mode: 0o600 })

  const report = await matchAddresses(
    loadAddressIndex(ctx.db),
    rows.map((r) => r.address),
    options,
  )
  const simulation = simulate(id, rows, report.matches, report.fallbackAvailable)
  logInfo("rep_import_simulated", {
    rows: simulation.rows,
    electors: simulation.electors,
    matchedBan: simulation.matchedBan,
    matchedFallback: simulation.matchedFallback,
    matchedStreet: simulation.matchedStreet,
    toAttach: simulation.toAttach,
    fallbackRequested: report.fallbackRequested,
    fallbackAvailable: report.fallbackAvailable,
  })
  return { id, rows, matches: report.matches, streets: report.streets, filePath, simulation }
}

export interface RepImportResult {
  importId: string
  rows: number
  electors: number
  electorsCreated: number
  registrations: number
  matched: number
  queueSize: number
  /** Share of registrations attached to an address (BAN, fallback or street level). */
  matchRate: number
  /** Comparison with the list previously in force (R6, F4); null on the first import. */
  reimport: ReimportReport | null
}

/** What changed between the previous list and the new one, in electors (one person on two lists counts once). */
export interface ReimportReport {
  /** Identity absent from the previous list. */
  newRegistrants: number
  /** On the previous list, absent from the new one: history kept, no current registration. */
  removed: number
  /** On both lists with a different address. */
  moved: number
  /** Addresses of category "sans_inscrit" before and after the import. */
  sansInscritBefore: number
  sansInscritAfter: number
  /** Registrations attached to the address chosen by hand last year, instead of queued again. */
  manualCarriedOver: number
}

interface RawAddressFields {
  rawNumber: string | null
  rawStreet: string | null
  rawComplement1: string | null
  rawComplement2: string | null
  rawLieuDit: string | null
  rawPostalCode: string | null
}

function rawSignature(r: RawAddressFields): string {
  return JSON.stringify([r.rawNumber, r.rawStreet, r.rawComplement1, r.rawComplement2, r.rawLieuDit, r.rawPostalCode])
}

/** Where an elector lives on one list: the attached address, or the raw fields while it waits in the queue. */
function addressSignatures(regs: ReadonlyArray<RawAddressFields & { electorId: string; addressId: string | null }>) {
  const byElector = new Map<string, Set<string>>()
  for (const r of regs) {
    const set = byElector.get(r.electorId) ?? new Set<string>()
    set.add(r.addressId ?? `raw:${rawSignature(r)}`)
    byElector.set(r.electorId, set)
  }
  return byElector
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x))
}

function countSansInscrit(ctx: AppContext): number {
  return computeAddressStatuses(ctx).filter((s) => s.category === "sans_inscrit").length
}

/** Writes the import in one transaction; the new list becomes the current one. */
export function commitRepImport(ctx: AppContext, pending: PendingRepImport): RepImportResult {
  const now = ctx.now().getTime()
  const previousImportId = currentRepImportId(ctx.db)
  const sansInscritBefore = previousImportId === null ? 0 : countSansInscrit(ctx)
  const committed = ctx.db.transaction((tx) => {
    const previous =
      previousImportId === null
        ? []
        : tx
            .select({
              electorId: registrations.electorId,
              addressId: registrations.addressId,
              matchStatus: registrations.matchStatus,
              rawNumber: registrations.rawNumber,
              rawStreet: registrations.rawStreet,
              rawComplement1: registrations.rawComplement1,
              rawComplement2: registrations.rawComplement2,
              rawLieuDit: registrations.rawLieuDit,
              rawPostalCode: registrations.rawPostalCode,
            })
            .from(registrations)
            .where(eq(registrations.importId, previousImportId))
            .all()
    // Manual attachments of the previous list whose address is still live, by elector and raw address.
    const live = new Set(
      tx.select({ id: addresses.id }).from(addresses).where(isNull(addresses.retiredAt)).all().map((a) => a.id),
    )
    const manual = new Map<string, string>()
    for (const r of previous) {
      if (r.matchStatus === "manual" && r.addressId !== null && live.has(r.addressId)) {
        manual.set(`${r.electorId}|${rawSignature(r)}`, r.addressId)
      }
    }

    tx.update(imports).set({ isCurrent: false }).where(eq(imports.kind, "rep")).run()
    tx.insert(imports)
      .values({ id: pending.id, kind: "rep", importedAt: now, rowCount: pending.rows.length, isCurrent: true })
      .run()

    for (const plan of pending.streets.values()) {
      const values = {
        kind: "street" as const,
        number: null,
        rep: null,
        streetName: plan.streetName,
        streetKey: plan.streetKey,
        lieuDit: null,
        postalCode: plan.postalCode,
        inseeCode: ctx.config.communeInsee,
        matchKey: matchKey(null, null, plan.streetName),
        lat: plan.lat,
        lon: plan.lon,
        retiredAt: null,
        updatedAt: now,
      }
      tx.insert(addresses)
        .values({ id: plan.id, ...values })
        .onConflictDoUpdate({ target: addresses.id, set: values })
        .run()
    }

    const known = new Map(
      tx
        .select({ id: electors.id, identityKey: electors.identityKey })
        .from(electors)
        .all()
        .map((e) => [e.identityKey, e.id]),
    )
    const written = new Map<string, string>()
    let created = 0
    let registrationCount = 0
    let matched = 0
    let carriedOver = 0
    pending.rows.forEach((row, i) => {
      let electorId = written.get(row.identityKey)
      if (electorId === undefined) {
        const attributes = {
          birthName: row.birthName,
          usageName: row.usageName,
          firstNames: row.firstNames,
          sex: row.sex,
          birthDate: row.birthDate,
          birthCommuneCode: row.birthCommuneCode,
          birthCommune: row.birthCommune,
          birthDepartment: row.birthDepartment,
          birthCountry: row.birthCountry,
          nationality: row.nationality,
        }
        const existing = known.get(row.identityKey)
        if (existing === undefined) {
          electorId = randomUUID()
          tx.insert(electors)
            .values({ id: electorId, identityKey: row.identityKey, createdAt: now, ...attributes })
            .run()
          created++
        } else {
          electorId = existing
          tx.update(electors).set(attributes).where(eq(electors.id, electorId)).run()
        }
        written.set(row.identityKey, electorId)
      }

      const raw: RawAddressFields = {
        rawNumber: row.address.rawNumber,
        rawStreet: row.address.rawStreet,
        rawComplement1: row.rawComplement1,
        rawComplement2: row.rawComplement2,
        rawLieuDit: row.address.rawLieuDit,
        rawPostalCode: row.address.rawPostalCode,
      }
      const match = pending.matches[i] ?? { status: "pending" as const, proposalId: null }
      // An address the administrator attached by hand last year is reused when the raw address did not change.
      const manualId = match.status === "pending" ? manual.get(`${electorId}|${rawSignature(raw)}`) : undefined
      const addressId = manualId ?? (match.status === "pending" ? null : match.addressId)
      const inserted = tx
        .insert(registrations)
        .values({
          id: randomUUID(),
          electorId,
          importId: pending.id,
          listType: row.listType,
          bureau: row.bureau,
          orderNumber: row.orderNumber,
          addressId,
          matchStatus: manualId === undefined ? match.status : "manual",
          fallbackProposalId: match.status === "pending" && manualId === undefined ? match.proposalId : null,
          ...raw,
        })
        // The same person twice on the same list of one file would break the unique index: keep the first line.
        .onConflictDoNothing()
        .run()
      if (inserted.changes > 0) {
        registrationCount++
        if (addressId !== null) matched++
        if (manualId !== undefined) carriedOver++
      }
    })

    let changes: Omit<ReimportReport, "sansInscritBefore" | "sansInscritAfter"> | null = null
    if (previousImportId !== null) {
      const before = addressSignatures(previous)
      const after = addressSignatures(
        tx
          .select({
            electorId: registrations.electorId,
            addressId: registrations.addressId,
            rawNumber: registrations.rawNumber,
            rawStreet: registrations.rawStreet,
            rawComplement1: registrations.rawComplement1,
            rawComplement2: registrations.rawComplement2,
            rawLieuDit: registrations.rawLieuDit,
            rawPostalCode: registrations.rawPostalCode,
          })
          .from(registrations)
          .where(eq(registrations.importId, pending.id))
          .all(),
      )
      let moved = 0
      for (const [id, places] of after) {
        const old = before.get(id)
        if (old !== undefined && !sameSet(old, places)) moved++
      }
      changes = {
        newRegistrants: [...after.keys()].filter((id) => !before.has(id)).length,
        removed: [...before.keys()].filter((id) => !after.has(id)).length,
        moved,
        manualCarriedOver: carriedOver,
      }
    }

    return {
      importId: pending.id,
      rows: pending.rows.length,
      electors: written.size,
      electorsCreated: created,
      registrations: registrationCount,
      matched,
      queueSize: registrationCount - matched,
      matchRate: registrationCount === 0 ? 0 : matched / registrationCount,
      changes,
    }
  })
  const { changes, ...counts } = committed
  const reimport: ReimportReport | null =
    changes === null
      ? null
      : {
          newRegistrants: changes.newRegistrants,
          removed: changes.removed,
          moved: changes.moved,
          sansInscritBefore,
          sansInscritAfter: countSansInscrit(ctx),
          manualCarriedOver: changes.manualCarriedOver,
        }
  const result: RepImportResult = { ...counts, reimport }
  logInfo("rep_import_confirmed", {
    rows: result.rows,
    electors: result.electors,
    electorsCreated: result.electorsCreated,
    registrations: result.registrations,
    queueSize: result.queueSize,
    ...(reimport === null ? {} : reimport),
  })
  return result
}
