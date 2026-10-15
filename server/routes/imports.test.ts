import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import Papa from "papaparse"
import { describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import { BAN_URL } from "../services/ban-loader.ts"
import type { GeocodeFetch } from "../services/geocode-fallback.ts"
import { importRoutes } from "./imports.ts"

const FIXTURE = readFileSync(join(import.meta.dirname, "../../tests/fixtures/ban-sample.csv"))

function upload(content: Buffer | string, name = "adresses-56.csv"): RequestInit {
  const form = new FormData()
  form.append("file", new File([content], name))
  return { method: "POST", body: form }
}

describe("BAN import routes", () => {
  it("reports an empty reference before any load", async () => {
    const { ctx } = createTestContext()
    const res = await importRoutes(ctx).request("/ban/status")
    expect(await res.json()).toEqual({ total: 0, retired: 0, lastImportedAt: null })
  })

  it("loads an uploaded file and the status reports the Séné count", async () => {
    const { ctx } = createTestContext()
    const router = importRoutes(ctx)

    const res = await router.request("/ban", upload(FIXTURE))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ loaded: 32, created: 32, updated: 0, retired: 0, total: 32 })

    const status = await router.request("/ban/status")
    expect(await status.json()).toEqual({ total: 32, retired: 0, lastImportedAt: ctx.now().getTime() })
  })

  it("rejects a file whose header lacks the id column", async () => {
    const { ctx } = createTestContext()
    const bad = FIXTURE.toString("utf-8").replace(/^id;/, "identifiant;")
    const res = await importRoutes(ctx).request("/ban", upload(bad))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "ban_invalid_header", missingColumns: ["id"] })
  })

  it("rejects a request without file", async () => {
    const { ctx } = createTestContext()
    const res = await importRoutes(ctx).request("/ban", { method: "POST", body: new FormData() })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "file_required" })
  })

  it("downloads the departmental file into sources/ and loads it", async () => {
    const { ctx } = createTestContext()
    const requested: string[] = []
    const fakeFetch = async (url: string): Promise<Response> => {
      requested.push(url)
      return new Response(gzipSync(FIXTURE))
    }

    const res = await importRoutes(ctx, { fetch: fakeFetch }).request("/ban/download", { method: "POST" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ loaded: 32, created: 32, updated: 0, retired: 0, total: 32 })
    expect(requested).toEqual([BAN_URL])
    expect(existsSync(join(ctx.config.dataDir, "sources", "adresses-56.csv.gz"))).toBe(true)
  })

  it("answers 502 when the download fails", async () => {
    const { ctx } = createTestContext()
    const fakeFetch = async (): Promise<Response> => new Response("nope", { status: 503 })
    const res = await importRoutes(ctx, { fetch: fakeFetch }).request("/ban/download", { method: "POST" })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "ban_download_failed" })
  })
})

const REP_FIXTURE = readFileSync(join(import.meta.dirname, "../../tests/fixtures/rep-2026.csv"))

/** Fake Géoplateforme proposing 29 rue de Limur for every address (refused for 99 rue de Limur). */
const proposing29: GeocodeFetch = async (_url, init) => {
  const csv = await ((init.body as FormData).get("data") as File).text()
  const rows = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data
  return new Response(
    Papa.unparse(
      rows.map((row) => ({
        ...row,
        longitude: "-2.729821",
        latitude: "47.648674",
        result_label: "29 Rue de Limur 56860 Séné",
        result_type: "housenumber",
        result_id: "56243_0110_00029",
        result_housenumber: "29",
        result_street: "Rue de Limur",
        result_status: "ok",
      })),
    ),
  )
}

const json = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

describe("REP import routes", () => {
  async function loadedRouter() {
    const { ctx } = createTestContext()
    const router = importRoutes(ctx, { geocodeFetch: proposing29, geocodeSleep: async () => {} })
    await router.request("/ban", upload(FIXTURE))
    return { ctx, router }
  }

  it("simulates, then confirms the import", async () => {
    const { router } = await loadedRouter()
    const sim = await router.request("/rep", upload(REP_FIXTURE, "liste.csv"))
    expect(sim.status).toBe(200)
    const simulation = (await sim.json()) as { pendingId: string; rows: number; toAttach: number }
    expect(simulation).toMatchObject({ rows: 22, electors: 21, matchedBan: 20, matchedStreet: 1, toAttach: 1 })

    const before = await router.request("/rep/status")
    expect(await before.json()).toEqual({ current: null })

    const res = await router.request(`/rep/${simulation.pendingId}/confirm`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { importId: string; matchRate: number; queueSize: number }
    expect(body.importId).toBe(simulation.pendingId)
    expect(body.queueSize).toBe(1)
    expect(body.matchRate).toBeCloseTo(21 / 22, 6)

    const status = (await (await router.request("/rep/status")).json()) as { current: { importId: string; queueSize: number } }
    expect(status.current).toMatchObject({ importId: simulation.pendingId, rows: 22, queueSize: 1 })

    const again = await router.request(`/rep/${simulation.pendingId}/confirm`, { method: "POST" })
    expect(again.status).toBe(404)
  })

  it("rejects a file that is not a REP list", async () => {
    const { router } = await loadedRouter()
    const res = await router.request("/rep", upload("a;b\n1;2\n", "x.csv"))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "rep_invalid_header" })
  })

  it("lists the queue with the refused proposal and attaches a registration by hand", async () => {
    const { router } = await loadedRouter()
    const sim = (await (await router.request("/rep", upload(REP_FIXTURE, "liste.csv"))).json()) as { pendingId: string }
    await router.request(`/rep/${sim.pendingId}/confirm`, { method: "POST" })

    const queue = (await (await router.request("/queue")).json()) as { items: Array<{ id: string }> }
    expect(queue.items).toEqual([
      {
        id: expect.any(String),
        bureau: "0002",
        orderNumber: 4,
        rawNumber: "99",
        rawStreet: "Rue de Limur",
        rawComplement1: null,
        rawComplement2: null,
        rawLieuDit: null,
        rawPostalCode: "56860",
        proposal: { id: "56243_0110_00029", label: "29 Rue de Limur", lat: 47.648674, lon: -2.729821 },
      },
    ])

    const id = queue.items[0]?.id ?? ""
    const unknown = await router.request(`/queue/${id}`, json({ addressId: "56243_0110_00999" }))
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({ error: "unknown_address" })

    const missing = await router.request("/queue/nope", json({ addressId: "56243_0110_00029" }))
    expect(missing.status).toBe(404)

    const res = await router.request(`/queue/${id}`, json({ addressId: "56243_0110_00029" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id, addressId: "56243_0110_00029", matchStatus: "manual" })

    const after = (await (await router.request("/queue")).json()) as { items: unknown[] }
    expect(after.items).toEqual([])
  })
})

const EMARGEMENT_FIXTURE = readFileSync(join(import.meta.dirname, "../../tests/fixtures/emargement-2026.csv"))

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

describe("emargement import and exceptions routes", () => {
  async function listedRouter() {
    const { ctx } = createTestContext()
    const offline: GeocodeFetch = async () => {
      throw new Error("offline")
    }
    const router = importRoutes(ctx, { geocodeFetch: offline, geocodeSleep: async () => {} })
    await router.request("/ban", upload(FIXTURE))
    const sim = (await (await router.request("/rep", upload(REP_FIXTURE, "liste.csv"))).json()) as { pendingId: string }
    await router.request(`/rep/${sim.pendingId}/confirm`, { method: "POST" })
    return { ctx, router }
  }

  async function importedRouter() {
    const loaded = await listedRouter()
    const sim = (await (await loaded.router.request("/emargement", upload(EMARGEMENT_FIXTURE, "emargement.csv"))).json()) as {
      pendingId: string
    }
    await loaded.router.request(`/emargement/${sim.pendingId}/confirm`, { method: "POST" })
    return loaded
  }

  it("refuses an emargement before any electoral list", async () => {
    const { ctx } = createTestContext()
    const res = await importRoutes(ctx).request("/emargement", upload(EMARGEMENT_FIXTURE, "emargement.csv"))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "no_current_list" })
  })

  it("rejects a file that is not an emargement", async () => {
    const { router } = await listedRouter()
    const res = await router.request("/emargement", upload("a;b\r\n1;2\r\n", "x.csv"))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "emargement_invalid_header" })
  })

  it("simulates, then confirms, and the status counts the voters", async () => {
    const { router } = await listedRouter()
    const sim = await router.request("/emargement", upload(EMARGEMENT_FIXTURE, "emargement.csv"))
    expect(sim.status).toBe(200)
    const simulation = (await sim.json()) as { pendingId: string }
    expect(simulation).toMatchObject({ rows: 22, matched: 18, merged: 1, nameMismatches: 1, discordantDuplicates: 1, unknownLevel: 3 })
    expect(await (await router.request("/emargement/status")).json()).toEqual({ current: null })

    const res = await router.request(`/emargement/${simulation.pendingId}/confirm`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ importId: simulation.pendingId, votersT1: 6, votersT2: 6 })

    const status = (await (await router.request("/emargement/status")).json()) as { current: unknown }
    expect(status.current).toMatchObject({ rows: 22, votersT1: 6, votersT2: 6, openRowExceptions: 3, notFound: 0, unknownLevel: 3 })

    const again = await router.request(`/emargement/${simulation.pendingId}/confirm`, { method: "POST" })
    expect(again.status).toBe(404)
  })

  it("accepts a name mismatch and refuses to decide it twice", async () => {
    const { router } = await importedRouter()
    const list = (await (await router.request("/exceptions/rows")).json()) as {
      items: Array<{ id: string; kind: string; candidate: { electorId: string } | null }>
    }
    expect(list.items).toHaveLength(3)
    const romero = list.items.find((i) => i.kind === "name_mismatch")
    const res = await router.request(`/exceptions/rows/${romero?.id}`, send("PATCH", { decision: "accepted" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "accepted", electorId: romero?.candidate?.electorId, level: "votant" })

    const twice = await router.request(`/exceptions/rows/${romero?.id}`, send("PATCH", { decision: "rejected" }))
    expect(twice.status).toBe(409)
    const invalid = await router.request(`/exceptions/rows/${romero?.id}`, send("PATCH", { decision: "maybe" }))
    expect(invalid.status).toBe(400)
    const missing = await router.request("/exceptions/rows/nope", send("PATCH", { decision: "accepted" }))
    expect(missing.status).toBe(404)
  })

  it("corrects both rounds of an inconnu elector and gives the matching level", async () => {
    const { router } = await importedRouter()
    const unknown = (await (await router.request("/exceptions/unknown")).json()) as {
      items: Array<{ electorId: string; bureau: string; orderNumber: number; rounds: Record<string, string | null> }>
    }
    const quebec = unknown.items.find((i) => i.orderNumber === 15)
    expect(quebec).toMatchObject({ bureau: "0001", rounds: { 1: null, 2: null } })
    const id = quebec?.electorId ?? ""

    const t1 = await router.request(`/exceptions/unknown/${id}/rounds/1`, send("PUT", { value: "oui" }))
    expect(await t1.json()).toEqual({ electorId: id, level: "votant" })
    const t2 = await router.request(`/exceptions/unknown/${id}/rounds/2`, send("PUT", { value: "non" }))
    expect(await t2.json()).toEqual({ electorId: id, level: "moyen" })

    const after = (await (await router.request("/exceptions/unknown")).json()) as { items: Array<{ electorId: string }> }
    expect(after.items.map((i) => i.electorId)).not.toContain(id)

    const badRound = await router.request(`/exceptions/unknown/${id}/rounds/3`, send("PUT", { value: "oui" }))
    expect(badRound.status).toBe(400)
    const stranger = await router.request("/exceptions/unknown/nope/rounds/1", send("PUT", { value: "oui" }))
    expect(stranger.status).toBe(404)
  })

  it("searches the addresses of a street for the manual queue", async () => {
    const { router } = await listedRouter()
    const res = await router.request(`/addresses?q=${encodeURIComponent("R. de Limur 29")}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ id: string; label: string }> }
    expect(body.items.map((a) => a.label)).toEqual(["29 Rue de Limur"])
    const street = (await (await router.request("/addresses?q=limur")).json()) as { items: Array<{ label: string }> }
    expect(street.items.length).toBeGreaterThan(5)
    expect(street.items.every((a) => a.label.includes("Limur"))).toBe(true)
  })
})
