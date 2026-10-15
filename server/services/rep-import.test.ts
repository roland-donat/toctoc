import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import Papa from "papaparse"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { addresses, electors, imports, registrations } from "../db/schema/index.ts"
import { loadBanFile } from "./ban-loader.ts"
import type { GeocodeFetch } from "./geocode-fallback.ts"
import { commitRepImport, identityKey, parseRep, prepareRepImport, RepFormatError } from "./rep-import.ts"

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures")
const REP_TEXT = readFileSync(join(FIXTURES, "rep-2026.csv"), "utf-8")
const BAN_FIXTURE = join(FIXTURES, "ban-sample.csv")

/** Every name and first name of the fictional fixture: none may ever leave in a fallback request. */
const FIXTURE_NAMES = [
  "ALPHA", "BRAVO", "CHARLIE", "DURAND", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL", "INDIA", "JULIETT", "KILO",
  "LIMA", "MIKE", "NOVEMBER", "OSCAR", "QUEBEC", "ROMEO", "SIERRA", "TANGO", "UNIFORM", "VICTOR",
  "Anne", "Bruno", "Claire", "Denis", "Emma", "Fanny", "Gaston", "Hugo", "Inès", "Julie", "Karim", "Luis", "Marc",
  "Nora", "Olivier", "Quentin", "Rose", "Sophie", "Thomas", "Ursule", "Vincent",
]

/** Records the whole multipart request (form fields and CSV) of every fallback call. */
function recordingGeocoder(answer: (row: Record<string, string>) => Record<string, string> | null = () => null) {
  const bodies: string[] = []
  const fetchFn: GeocodeFetch = async (_url, init) => {
    const parts: string[] = []
    let csv = ""
    for (const [key, value] of (init.body as FormData).entries()) {
      if (typeof value === "string") parts.push(`${key}=${value}`)
      else csv = await value.text()
    }
    bodies.push([...parts, csv].join("\n"))
    const rows = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data
    return new Response(
      Papa.unparse(rows.map((row) => ({ ...row, result_type: "", result_id: "", result_status: "not-found", ...answer(row) }))),
    )
  }
  return { fetchFn, bodies }
}

const neverCalled: GeocodeFetch = async () => {
  throw new Error("the fallback must not be called")
}
const noSleep = async (): Promise<void> => {}

function withoutLines(text: string, ...names: string[]): string {
  return text
    .split("\n")
    .filter((line) => !names.some((n) => line.includes(`"${n}"`)))
    .join("\n")
}

describe("parseRep", () => {
  it("Covers AE1. imports the EU elector with its list type", () => {
    const rows = parseRep(REP_TEXT)
    expect(rows).toHaveLength(22)
    const lima = rows.filter((r) => r.birthName === "LIMA")
    expect(lima.map((r) => r.listType)).toEqual(["complementaire_ue", "complementaire_municipale"])
    expect(rows.filter((r) => r.listType === "principale")).toHaveLength(20)
  })

  it("keeps the useful attributes of a line", () => {
    const charlie = parseRep(REP_TEXT).find((r) => r.birthName === "CHARLIE")
    expect(charlie).toMatchObject({
      usageName: "DURAND",
      firstNames: "Claire",
      sex: "F",
      birthDate: "1980-11-21",
      birthCommuneCode: "35238",
      birthCommune: "Rennes",
      birthDepartment: "35",
      birthCountry: "France",
      nationality: "Française",
      bureau: "0001",
      orderNumber: 3,
      address: { rawNumber: "6", rawStreet: "Rue de Limur", rawLieuDit: null, rawPostalCode: "56860", rawCommune: "Séné" },
    })
  })

  it("reads a file with BOM, NFD headers and CRLF line endings", () => {
    const [header, ...lines] = REP_TEXT.split("\n")
    const text = `\uFEFF${(header ?? "").normalize("NFD")}\r\n${lines.join("\r\n")}`
    expect(text).not.toBe(REP_TEXT)
    expect(parseRep(text)).toEqual(parseRep(REP_TEXT))
  })

  it("imports an elector with an unreadable birth date without date", () => {
    const uniform = parseRep(REP_TEXT).find((r) => r.birthName === "UNIFORM")
    expect(uniform?.birthDate).toBeNull()
    expect(uniform?.birthDateUnreadable).toBe(true)
  })

  it("keeps an empty order number null, never 0", () => {
    const text = REP_TEXT.replace(/("ALPHA".*;)1(\r?\n)/, "$1$2")
    const alpha = parseRep(text).find((r) => r.birthName === "ALPHA")
    expect(alpha?.orderNumber).toBeNull()
  })

  it("rejects a file without the REP columns", () => {
    expect(() => parseRep("a;b\n1;2\n")).toThrow(RepFormatError)
  })
})

describe("identityKey", () => {
  it("normalizes birth name and first names and keeps the ISO date", () => {
    expect(identityKey("Élan-Dupont", " Inès  Marie", "1985-12-25")).toBe("elan dupont|ines marie|1985-12-25")
    expect(identityKey("UNIFORM", "Ursule", null)).toBe("uniform|ursule|")
  })
})

describe("prepareRepImport and commitRepImport", () => {
  let ctx: AppContext

  beforeEach(async () => {
    ctx = createTestContext().ctx
    await loadBanFile(ctx, BAN_FIXTURE)
  })

  it("simulates the import without writing any elector", async () => {
    const { fetchFn } = recordingGeocoder()
    const pending = await prepareRepImport(ctx, Buffer.from(REP_TEXT), { fetch: fetchFn, sleep: noSleep })

    expect(pending.simulation).toEqual({
      pendingId: pending.id,
      rows: 22,
      electors: 21,
      listTypes: { principale: 20, complementaire_ue: 1, complementaire_municipale: 1 },
      matchedBan: 20,
      matchedFallback: 0,
      matchedStreet: 1,
      toAttach: 1,
      unreadableDates: 1,
      duplicatesAcrossLists: 1,
      fallbackAvailable: true,
    })
    expect(ctx.db.select().from(electors).all()).toHaveLength(0)
    expect(ctx.db.select().from(registrations).all()).toHaveLength(0)
    expect(existsSync(join(ctx.config.dataDir, "imports", `${pending.id}.csv`))).toBe(true)
  })

  it("makes no external call when every address is in the BAN", async () => {
    const text = withoutLines(REP_TEXT, "VICTOR")
    const pending = await prepareRepImport(ctx, Buffer.from(text), { fetch: neverCalled, sleep: noSleep })
    expect(pending.simulation.matchedBan).toBe(20)
    expect(pending.simulation.toAttach).toBe(0)
  })

  it("sends the address absent from the BAN to the fallback with no name nor first name", async () => {
    const { fetchFn, bodies } = recordingGeocoder()
    await prepareRepImport(ctx, Buffer.from(REP_TEXT), { fetch: fetchFn, sleep: noSleep })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("99,,Rue de Limur")
    for (const name of FIXTURE_NAMES) expect(bodies[0]).not.toContain(name)
  })

  it("never sends the complements, even when every line goes to the fallback", async () => {
    const empty = createTestContext().ctx
    const { fetchFn, bodies } = recordingGeocoder()
    const pending = await prepareRepImport(empty, Buffer.from(REP_TEXT), { fetch: fetchFn, sleep: noSleep })
    expect(pending.simulation.toAttach).toBe(22)
    const all = bodies.join("\n")
    expect(all).toContain("14,,Rue de Limur")
    expect(all).not.toContain("PAPA")
    expect(all).not.toContain("chez")
    expect(all).not.toContain("Appartement")
    for (const name of FIXTURE_NAMES) expect(all).not.toContain(name)
  })

  it("still prepares the import when the fallback is unreachable", async () => {
    const offline: GeocodeFetch = async () => {
      throw new TypeError("fetch failed")
    }
    const pending = await prepareRepImport(ctx, Buffer.from(REP_TEXT), { fetch: offline, sleep: noSleep })
    expect(pending.simulation.fallbackAvailable).toBe(false)
    expect(pending.simulation.toAttach).toBe(1)
  })

  it("writes electors, registrations and the street-level address on confirmation", async () => {
    const { fetchFn } = recordingGeocoder()
    const pending = await prepareRepImport(ctx, Buffer.from(REP_TEXT), { fetch: fetchFn, sleep: noSleep })
    const result = commitRepImport(ctx, pending)

    expect(result).toMatchObject({ importId: pending.id, rows: 22, electors: 21, queueSize: 1 })
    expect(result.matchRate).toBeCloseTo(21 / 22, 6)

    const imp = ctx.db.select().from(imports).where(eq(imports.id, pending.id)).get()
    expect(imp).toMatchObject({ kind: "rep", rowCount: 22, isCurrent: true })
    expect(ctx.db.select().from(electors).all()).toHaveLength(21)
    const regs = ctx.db.select().from(registrations).all()
    expect(regs).toHaveLength(22)

    const lima = ctx.db.select().from(electors).where(eq(electors.birthName, "LIMA")).all()
    expect(lima).toHaveLength(1)
    const limaRegs = regs.filter((r) => r.electorId === lima[0]?.id)
    expect(limaRegs.map((r) => r.listType).sort()).toEqual(["complementaire_municipale", "complementaire_ue"])

    const uniform = ctx.db.select().from(electors).where(eq(electors.birthName, "UNIFORM")).get()
    expect(uniform?.birthDate).toBeNull()

    const november = ctx.db.select().from(electors).where(eq(electors.birthName, "NOVEMBER")).get()
    const novReg = regs.find((r) => r.electorId === november?.id)
    expect(novReg).toMatchObject({ addressId: "street:keravelo", matchStatus: "street" })
    const street = ctx.db.select().from(addresses).where(eq(addresses.id, "street:keravelo")).get()
    expect(street).toMatchObject({ kind: "street", number: null, streetKey: "keravelo", inseeCode: "56243" })

    const victor = ctx.db.select().from(electors).where(eq(electors.birthName, "VICTOR")).get()
    const vicReg = regs.find((r) => r.electorId === victor?.id)
    expect(vicReg).toMatchObject({ addressId: null, matchStatus: "pending", rawNumber: "99", rawStreet: "Rue de Limur" })

    const oscar = ctx.db.select().from(electors).where(eq(electors.birthName, "OSCAR")).get()
    const oscarReg = regs.find((r) => r.electorId === oscar?.id)
    expect(oscarReg).toMatchObject({ addressId: "56243_0110_00014", matchStatus: "ban", rawComplement1: "chez PAPA Paul" })
  })

  it("re-importing the same file duplicates no elector and makes the new list current", async () => {
    const { fetchFn } = recordingGeocoder()
    const first = await prepareRepImport(ctx, Buffer.from(REP_TEXT), { fetch: fetchFn, sleep: noSleep })
    commitRepImport(ctx, first)
    const second = await prepareRepImport(ctx, Buffer.from(REP_TEXT), { fetch: fetchFn, sleep: noSleep })
    commitRepImport(ctx, second)

    expect(ctx.db.select().from(electors).all()).toHaveLength(21)
    expect(ctx.db.select().from(registrations).all()).toHaveLength(44)
    const reps = ctx.db.select().from(imports).where(eq(imports.kind, "rep")).all()
    expect(reps.map((r) => [r.id, r.isCurrent])).toEqual([
      [first.id, false],
      [second.id, true],
    ])
    expect(ctx.db.select().from(addresses).where(eq(addresses.kind, "street")).all()).toHaveLength(1)
  })
})
