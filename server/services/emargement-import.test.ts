import { readFileSync } from "node:fs"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { electors, importExceptions, imports, voteHistory } from "../db/schema/index.ts"
import { EMARGEMENT_ELECTION, type VoterLevel } from "../domain/voter-level.ts"
import { loadBanFile } from "./ban-loader.ts"
import {
  commitEmargementImport,
  decideRowException,
  EmargementImportError,
  listRowExceptions,
  listUnknownElectors,
  parseEmargement,
  prepareEmargementImport,
  setRoundValue,
} from "./emargement-import.ts"
import type { GeocodeFetch } from "./geocode-fallback.ts"
import { commitRepImport, prepareRepImport } from "./rep-import.ts"
import { loadCurrentVoterLevels } from "./voter-levels.ts"

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const REP_TEXT = readFileSync(join(FIXTURES, "rep-2026.csv"), "utf-8")
const EMARGEMENT_TEXT = readFileSync(join(FIXTURES, "emargement-2026.csv"), "utf-8")

const unreachable: GeocodeFetch = async () => {
  throw new Error("offline")
}
const geocode = { fetch: unreachable, sleep: async (): Promise<void> => {} }

async function importRep(ctx: AppContext, text = REP_TEXT): Promise<string> {
  const pending = await prepareRepImport(ctx, Buffer.from(text), geocode)
  return commitRepImport(ctx, pending).importId
}

async function importEmargement(ctx: AppContext, text = EMARGEMENT_TEXT) {
  const pending = await prepareEmargementImport(ctx, Buffer.from(text))
  return { simulation: pending.simulation, result: commitEmargementImport(ctx, pending) }
}

function electorId(ctx: AppContext, birthName: string): string {
  const row = ctx.db.select({ id: electors.id }).from(electors).where(eq(electors.birthName, birthName)).get()
  if (!row) throw new Error(`fixture elector missing: ${birthName}`)
  return row.id
}

function levelOf(ctx: AppContext, birthName: string): VoterLevel | undefined {
  return loadCurrentVoterLevels(ctx.db).get(electorId(ctx, birthName))
}

/** Replaces the vote cells of the fixture line of `birthName` (every line of that name). */
function withVotes(text: string, birthName: string, t1: string, t2: string): string {
  return text
    .split("\r\n")
    .map((line) => {
      const cells = line.split(";")
      if (cells[2] !== birthName) return line
      cells[9] = t1
      cells[10] = t2
      return cells.join(";")
    })
    .join("\r\n")
}

describe("parseEmargement", () => {
  it("pads the bureau, reads the votes and keeps the proxies as text", () => {
    const rows = parseEmargement(EMARGEMENT_TEXT)
    expect(rows).toHaveLength(22)
    expect(rows[0]).toMatchObject({ bureau: "0001", orderNumber: 1, birthName: "ALPHA", t1: "oui", t2: "oui", proxyT1: "non" })
  })

  it("turns a cell other than oui or non into illisible, never into non", () => {
    const mike = parseEmargement(EMARGEMENT_TEXT).find((r) => r.birthName === "MIKE")
    expect(mike).toMatchObject({ t1: "illisible", t2: "non" })
    const empty = parseEmargement(withVotes(EMARGEMENT_TEXT, "KILO", "", "?")).find((r) => r.birthName === "KILO")
    expect(empty).toMatchObject({ t1: "illisible", t2: "illisible" })
  })

  it("rejects a file without the emargement columns", () => {
    expect(() => parseEmargement("a;b\r\n1;2\r\n")).toThrow(EmargementImportError)
  })
})

describe("emargement import on the fictional fixtures", () => {
  let ctx: AppContext
  let repId: string

  beforeEach(async () => {
    ctx = createTestContext().ctx
    await loadBanFile(ctx, join(FIXTURES, "ban-sample.csv"))
    repId = await importRep(ctx)
  })

  it("refuses to simulate before any electoral list", async () => {
    const empty = createTestContext().ctx
    await expect(prepareEmargementImport(empty, Buffer.from(EMARGEMENT_TEXT))).rejects.toMatchObject({ code: "no_current_list" })
  })

  it("simulates without writing, then confirms against the current list", async () => {
    const pending = await prepareEmargementImport(ctx, Buffer.from(EMARGEMENT_TEXT))
    expect(pending.simulation).toEqual({
      pendingId: pending.id,
      rows: 22,
      matched: 18,
      merged: 1,
      nameMismatches: 1,
      notFound: 0,
      discordantDuplicates: 1,
      unreadableCells: 1,
      unknownLevel: 3,
    })
    expect(ctx.db.select().from(voteHistory).all()).toHaveLength(0)

    const result = commitEmargementImport(ctx, pending)
    expect(result).toMatchObject({ importId: pending.id, votersT1: 6, votersT2: 6, exceptions: 3 })
    const imported = ctx.db.select().from(imports).where(eq(imports.id, pending.id)).get()
    expect(imported).toMatchObject({ kind: "emargement", referenceImportId: repId, rowCount: 22 })
    expect(ctx.db.select().from(voteHistory).all()).toHaveLength(36)
  })

  it("Covers AE1. Absent at T1 and present at T2: moyen; absent at both on an EU list: hors_cible", async () => {
    await importEmargement(ctx)
    expect(levelOf(ctx, "CHARLIE")).toBe("moyen")
    expect(levelOf(ctx, "LIMA")).toBe("hors_cible")
  })

  it("absent at both rounds on the principal list: fort", async () => {
    await importEmargement(ctx)
    expect(levelOf(ctx, "ECHO")).toBe("fort")
  })

  it("an unreadable round is neither a vote nor an absence: T1 ?? and T2 non gives moyen", async () => {
    await importEmargement(ctx)
    const mike = electorId(ctx, "MIKE")
    const t1 = ctx.db
      .select({ value: voteHistory.value })
      .from(voteHistory)
      .where(and(eq(voteHistory.electorId, mike), eq(voteHistory.round, 1)))
      .get()
    expect(t1?.value).toBe("illisible")
    expect(levelOf(ctx, "MIKE")).toBe("moyen")
  })

  it("two unreadable rounds: inconnu", async () => {
    const { simulation } = await importEmargement(ctx, withVotes(EMARGEMENT_TEXT, "KILO", "??", ""))
    expect(simulation.unknownLevel).toBe(4)
    expect(levelOf(ctx, "KILO")).toBe("inconnu")
  })

  it("a row whose name differs from the elector of the same key is flagged and not applied", async () => {
    await importEmargement(ctx)
    const romeo = electorId(ctx, "ROMEO")
    expect(ctx.db.select().from(voteHistory).where(eq(voteHistory.electorId, romeo)).all()).toHaveLength(0)
    const exception = ctx.db.select().from(importExceptions).where(eq(importExceptions.kind, "name_mismatch")).get()
    expect(exception).toMatchObject({ bureau: "0001", orderNumber: 16, electorId: romeo, status: "open" })
    expect(levelOf(ctx, "ROMEO")).toBe("inconnu")
  })

  it("an order number shared by the principal and complementary lists is settled by the name", async () => {
    await importEmargement(ctx)
    expect(levelOf(ctx, "ALPHA")).toBe("votant")
    expect(levelOf(ctx, "LIMA")).toBe("hors_cible")
    const lima = ctx.db.select().from(voteHistory).where(eq(voteHistory.electorId, electorId(ctx, "LIMA"))).all()
    expect(lima.map((v) => v.value)).toEqual(["non", "non"])
  })

  it("merges identical duplicates and flags discordant ones without applying any of them", async () => {
    await importEmargement(ctx)
    expect(levelOf(ctx, "TANGO")).toBe("moyen")
    const bravo = electorId(ctx, "BRAVO")
    expect(ctx.db.select().from(voteHistory).where(eq(voteHistory.electorId, bravo)).all()).toHaveLength(0)
    const flagged = ctx.db.select().from(importExceptions).where(eq(importExceptions.kind, "discordant_duplicate")).all()
    expect(flagged.map((e) => e.electorId)).toEqual([bravo, bravo])
    expect(levelOf(ctx, "BRAVO")).toBe("inconnu")
  })

  it("an elector without any emargement row is inconnu", async () => {
    await importEmargement(ctx)
    expect(levelOf(ctx, "QUEBEC")).toBe("inconnu")
  })

  it("a row whose bureau and number match no elector is not_found", async () => {
    const extra = `${EMARGEMENT_TEXT}2;9;YANKEE;;Yves;01/01/1990;Vannes;56;1 Rue de Limur 56860 Séné;oui;oui;non;non;scan.jpg;\r\n`
    const { simulation } = await importEmargement(ctx, extra)
    expect(simulation.notFound).toBe(1)
    const exception = ctx.db.select().from(importExceptions).where(eq(importExceptions.kind, "not_found")).get()
    expect(exception).toMatchObject({ bureau: "0002", orderNumber: 9, electorId: null })
  })

  it("an elector absent from the reference list is nouvel_inscrit once a newer list is current", async () => {
    await importEmargement(ctx)
    const victor = REP_TEXT.split("\n").find((l) => l.includes('"VICTOR"'))
    if (victor === undefined) throw new Error("fixture line missing")
    const zulu = victor.replace('"VICTOR"', '"ZULU"').replace('"Vincent"', '"Zoé"').replace(/;4;("[^"]*")$/, ";5;$1")
    await importRep(ctx, `${REP_TEXT.trimEnd()}\n${zulu}\n`)
    expect(levelOf(ctx, "ZULU")).toBe("nouvel_inscrit")
    expect(levelOf(ctx, "CHARLIE")).toBe("moyen")
  })

  it("re-importing replaces the previous emargement rows and exceptions", async () => {
    await importEmargement(ctx)
    await importEmargement(ctx, withVotes(EMARGEMENT_TEXT, "ECHO", "oui", "oui"))
    expect(ctx.db.select().from(voteHistory).all()).toHaveLength(36)
    expect(levelOf(ctx, "ECHO")).toBe("votant")
    expect(listRowExceptions(ctx.db).items).toHaveLength(3)
  })

  describe("exceptions", () => {
    beforeEach(async () => {
      await importEmargement(ctx)
    })

    it("lists the name mismatch and both discordant rows with their candidate, without birth place", () => {
      const { items } = listRowExceptions(ctx.db)
      expect(items.map((i) => [i.kind, i.row.birthName, i.candidate?.birthName])).toEqual([
        ["discordant_duplicate", "BRAVO", "BRAVO"],
        ["discordant_duplicate", "BRAVO", "BRAVO"],
        ["name_mismatch", "ROMERO", "ROMEO"],
      ])
      expect(JSON.stringify(items)).not.toContain("Vannes")
    })

    it("accepting a name mismatch applies its votes to the candidate", () => {
      const romero = listRowExceptions(ctx.db).items.find((i) => i.kind === "name_mismatch")
      decideRowException(ctx, romero?.id ?? "", "accepted")
      expect(levelOf(ctx, "ROMEO")).toBe("votant")
      expect(listRowExceptions(ctx.db).items).toHaveLength(2)
    })

    it("accepting one discordant row applies it and rejects the other one", () => {
      const second = listRowExceptions(ctx.db).items.filter((i) => i.kind === "discordant_duplicate")[1]
      expect(second?.row).toMatchObject({ t1: "oui", t2: "non" })
      decideRowException(ctx, second?.id ?? "", "accepted")
      expect(levelOf(ctx, "BRAVO")).toBe("moyen")
      const statuses = ctx.db
        .select({ status: importExceptions.status })
        .from(importExceptions)
        .where(eq(importExceptions.kind, "discordant_duplicate"))
        .all()
      expect(statuses.map((s) => s.status).sort()).toEqual(["accepted", "rejected"])
    })

    it("rejecting a row applies nothing", () => {
      const romero = listRowExceptions(ctx.db).items.find((i) => i.kind === "name_mismatch")
      decideRowException(ctx, romero?.id ?? "", "rejected")
      expect(levelOf(ctx, "ROMEO")).toBe("inconnu")
    })

    it("lists the electors at the inconnu level and setting both rounds gives the matching level", () => {
      expect(listUnknownElectors(ctx.db).items.map((i) => i.birthName)).toEqual(["BRAVO", "QUEBEC", "ROMEO"])
      const quebec = electorId(ctx, "QUEBEC")
      expect(setRoundValue(ctx, quebec, 1, "non")).toEqual({ electorId: quebec, level: "moyen" })
      expect(setRoundValue(ctx, quebec, 2, "non")).toEqual({ electorId: quebec, level: "fort" })
      expect(setRoundValue(ctx, quebec, 2, "oui")).toEqual({ electorId: quebec, level: "moyen" })
      const rows = ctx.db
        .select({ round: voteHistory.round, value: voteHistory.value })
        .from(voteHistory)
        .where(and(eq(voteHistory.electorId, quebec), eq(voteHistory.election, EMARGEMENT_ELECTION)))
        .orderBy(voteHistory.round)
        .all()
      expect(rows).toEqual([
        { round: 1, value: "non" },
        { round: 2, value: "oui" },
      ])
    })
  })
})
