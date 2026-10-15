import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import { addresses, imports, visits } from "../db/schema/index.ts"
import { BanDownloadError, BanFormatError, downloadBan, loadBanFile } from "./ban-loader.ts"

const FIXTURE = join(import.meta.dirname, "../../tests/fixtures/ban-sample.csv")
const SAMPLE = readFileSync(FIXTURE, "utf-8")
const HEADER = SAMPLE.split("\n")[0] ?? ""
const SAMPLE_LINES = SAMPLE.split("\n").slice(1).filter((l) => l.trim() !== "")
const SENE_LINES = SAMPLE_LINES.filter((l) => l.split(";")[6] === "56243")
// Fictional third commune (Theix-Noyalo), to make the 3-commune case.
const THEIX_LINE =
  "56251_0001_00004;56251_0001;4;;Rue du Bourg;56450;56251;Theix-Noyalo;;;272000;6741000;-2.70;47.62;entrée;;;THEIX NOYALO;RUE DU BOURG;commune;commune;1;"

function tmpFile(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "toctoc-ban-"))
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

function csv(lines: string[], header = HEADER): string {
  return [header, ...lines].join("\n") + "\n"
}

describe("loadBanFile", () => {
  it("loads only the addresses of Séné (56243) from a 3-commune file", async () => {
    const { ctx } = createTestContext()
    expect(SENE_LINES.length).toBe(32)
    const path = tmpFile("ban.csv", csv([...SAMPLE_LINES, THEIX_LINE]))

    const result = await loadBanFile(ctx, path)

    expect(result).toEqual({ loaded: 32, created: 32, updated: 0, retired: 0, total: 32 })
    const rows = ctx.db.select().from(addresses).all()
    expect(rows).toHaveLength(32)
    expect(rows.every((r) => r.inseeCode === "56243" && r.kind === "number")).toBe(true)

    const bis = rows.find((r) => r.id === "56243_0110_00013_bis")
    expect(bis).toMatchObject({
      number: 13,
      rep: "bis",
      streetName: "Rue de Limur",
      streetKey: "rue de limur",
      matchKey: "13|bis|rue de limur",
      postalCode: "56860",
      lat: 47.647311,
      lon: -2.728458,
      retiredAt: null,
    })
    const keravelo = rows.find((r) => r.id === "56243_73qtny_00002")
    expect(keravelo?.matchKey).toBe("2||keravelo")

    const imp = ctx.db.select().from(imports).all()
    expect(imp).toHaveLength(1)
    expect(imp[0]).toMatchObject({ kind: "ban", rowCount: 32, importedAt: ctx.now().getTime() })
  })

  it("loads the same file gzipped", async () => {
    const { ctx } = createTestContext()
    const path = tmpFile("adresses-56.csv.gz", gzipSync(csv(SAMPLE_LINES)))

    const result = await loadBanFile(ctx, path)

    expect(result.loaded).toBe(32)
    expect(ctx.db.select().from(addresses).all()).toHaveLength(32)
  })

  it("fails with a clear message and writes nothing when the id column is missing", async () => {
    const { ctx } = createTestContext()
    const header = HEADER.replace(/^id;/, "identifiant;")
    const path = tmpFile("ban.csv", csv(SENE_LINES, header))

    const error = await loadBanFile(ctx, path).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BanFormatError)
    expect((error as BanFormatError).missingColumns).toEqual(["id"])
    expect((error as BanFormatError).message).toContain("missing column(s): id")
    expect(ctx.db.select().from(addresses).all()).toHaveLength(0)
    expect(ctx.db.select().from(imports).all()).toHaveLength(0)
  })

  it("keeps a lieu-dit placeholder row (numero 99999) and fills nom_ld", async () => {
    const { ctx } = createTestContext()
    const placeholder =
      "56243_x1y2z3_99999;;99999;;Kerarden;56860;56243;Séné;;;270000;6742000;-2.73;47.64;segment;;Kerarden;SENE;KERARDEN;commune;commune;1;"
    const path = tmpFile("ban.csv", csv([placeholder]))

    await loadBanFile(ctx, path)

    const row = ctx.db.select().from(addresses).where(eq(addresses.id, "56243_x1y2z3_99999")).get()
    expect(row).toMatchObject({ kind: "number", number: 99999, lieuDit: "Kerarden", matchKey: "99999||kerarden" })
  })

  it("retires an address missing from a reload, keeps its visit, and un-retires it when it comes back", async () => {
    const { ctx, setNow } = createTestContext({ now: new Date("2027-01-01T08:00:00Z") })
    await loadBanFile(ctx, tmpFile("ban.csv", csv(SENE_LINES)))
    const goneId = "56243_0110_00029"
    ctx.db
      .insert(visits)
      .values({ id: "v1", addressId: goneId, visitDate: "2027-01-01", recordedAt: 1, source: "admin" })
      .run()

    setNow(new Date("2027-02-01T08:00:00Z"))
    const reduced = SENE_LINES.filter((l) => !l.startsWith(`${goneId};`))
    const second = await loadBanFile(ctx, tmpFile("ban.csv", csv(reduced)))

    expect(second).toEqual({ loaded: 31, created: 0, updated: 31, retired: 1, total: 31 })
    const gone = ctx.db.select().from(addresses).where(eq(addresses.id, goneId)).get()
    expect(gone?.retiredAt).toBe(new Date("2027-02-01T08:00:00Z").getTime())
    expect(ctx.db.select().from(visits).where(eq(visits.id, "v1")).get()?.addressId).toBe(goneId)

    const third = await loadBanFile(ctx, tmpFile("ban.csv", csv(SENE_LINES)))
    expect(third).toEqual({ loaded: 32, created: 0, updated: 32, retired: 0, total: 32 })
    expect(ctx.db.select().from(addresses).where(eq(addresses.id, goneId)).get()?.retiredAt).toBeNull()
  })
})

describe("downloadBan", () => {
  /** A body that sends one chunk then stalls until the request is aborted (or errors right away). */
  function stallingFetch(mode: "stall" | "error") {
    return async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial content"))
          if (mode === "error") controller.error(new Error("connection reset"))
          else init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason))
        },
      })
      return new Response(body, { status: 200 })
    }
  }

  for (const mode of ["stall", "error"] as const) {
    it(`fails with BanDownloadError and leaves no partial file when the body ${mode === "stall" ? "stalls" : "breaks"}`, async () => {
      const { ctx } = createTestContext()
      await expect(downloadBan(ctx, stallingFetch(mode), { timeoutMs: 50 })).rejects.toBeInstanceOf(BanDownloadError)
      const dir = join(ctx.config.dataDir, "sources")
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
    }, 2000)
  }
})
