import { describe, expect, it } from "vitest"
import {
  GEOCODE_URL,
  geocodeFallback,
  fallbackQueryKey,
  type FallbackQuery,
  type GeocodeFetch,
} from "./geocode-fallback.ts"

const HEADER =
  "qid,numero,indice,voie,lieu_dit,code_postal,commune,longitude,latitude,result_score,result_label,result_type,result_id,result_housenumber,result_name,result_street,result_postcode,result_city,result_citycode,result_status"

function query(overrides: Partial<FallbackQuery> = {}): FallbackQuery {
  return { number: "99", rep: "", street: "Rue de Limur", lieuDit: "", postalCode: "56860", commune: "Séné", ...overrides }
}

interface Recorded {
  url: string
  fields: Record<string, string[]>
  csv: string
}

/** Fake Géoplateforme: answers every row with `answer(row)` (a CSV tail) and records each request. */
function fakeGeocoder(answer: (row: Record<string, string>) => string, statuses: number[] = []) {
  const requests: Recorded[] = []
  const fetchFn: GeocodeFetch = async (url, init) => {
    const form = init.body as FormData
    const fields: Record<string, string[]> = {}
    let csv = ""
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") (fields[key] ??= []).push(value)
      else csv = await value.text()
    }
    requests.push({ url, fields, csv })
    const status = statuses.shift()
    if (status !== undefined && status !== 200) return new Response("busy", { status })
    const [head, ...lines] = csv.trim().split("\n")
    const cols = (head ?? "").split(",")
    const body = lines.map((line) => {
      const cells = line.split(",")
      const row = Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]))
      return `${line},${answer(row)}`
    })
    return new Response([HEADER, ...body].join("\n"))
  }
  return { fetchFn, requests }
}

const noSleep = async (): Promise<void> => {}

describe("geocodeFallback", () => {
  it("posts only the address columns to the Géoplateforme CSV endpoint", async () => {
    const { fetchFn, requests } = fakeGeocoder(() => "")
    await geocodeFallback([query({ number: "13", rep: "bis", lieuDit: "Le Bourg" })], { fetch: fetchFn, sleep: noSleep })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(GEOCODE_URL)
    const [head, row] = (requests[0]?.csv ?? "").trim().split("\n")
    expect(head).toBe("qid,numero,indice,voie,lieu_dit,code_postal,commune")
    expect(row).toBe("q0,13,bis,Rue de Limur,Le Bourg,56860,Séné")
    expect(requests[0]?.fields).toEqual({
      columns: ["numero", "indice", "voie", "lieu_dit", "commune"],
      postcode: ["code_postal"],
    })
  })

  it("parses a housenumber result", async () => {
    const { fetchFn } = fakeGeocoder(
      () =>
        "-2.728458,47.647311,0.85,13bis Rue de Limur 56860 Séné,housenumber,56243_0110_00013_bis,13bis,13bis Rue de Limur,Rue de Limur,56860,Séné,56243,ok",
    )
    const q = query({ number: "13", rep: "bis" })
    const { results, available } = await geocodeFallback([q], { fetch: fetchFn, sleep: noSleep })

    expect(available).toBe(true)
    expect(results.get(fallbackQueryKey(q))).toEqual({
      type: "housenumber",
      banId: "56243_0110_00013_bis",
      housenumber: "13bis",
      street: "Rue de Limur",
      label: "13bis Rue de Limur 56860 Séné",
      lat: 47.647311,
      lon: -2.728458,
    })
  })

  it("returns null for a row the service did not find", async () => {
    const { fetchFn } = fakeGeocoder(() => ",,,,,,,,,,,,not-found")
    const q = query()
    const { results } = await geocodeFallback([q], { fetch: fetchFn, sleep: noSleep })
    expect(results.get(fallbackQueryKey(q))).toBeNull()
  })

  it("sends each distinct address once", async () => {
    const { fetchFn, requests } = fakeGeocoder(() => "")
    await geocodeFallback([query(), query(), query({ number: "98" })], { fetch: fetchFn, sleep: noSleep })
    const lines = (requests[0]?.csv ?? "").trim().split("\n")
    expect(lines).toHaveLength(3)
  })

  it("splits the addresses into chunks of 500", async () => {
    const { fetchFn, requests } = fakeGeocoder(() => "")
    const queries = Array.from({ length: 1200 }, (_, i) => query({ number: String(i + 1) }))
    await geocodeFallback(queries, { fetch: fetchFn, sleep: noSleep })
    expect(requests.map((r) => r.csv.trim().split("\n").length - 1)).toEqual([500, 500, 200])
  })

  it("retries with exponential delay on 429", async () => {
    const { fetchFn, requests } = fakeGeocoder(() => "", [429, 429, 200])
    const delays: number[] = []
    const { available } = await geocodeFallback([query()], {
      fetch: fetchFn,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    expect(available).toBe(true)
    expect(requests).toHaveLength(3)
    expect(delays).toEqual([1000, 2000])
  })

  it("reports the fallback unavailable when the service cannot be reached", async () => {
    const failing: GeocodeFetch = async () => {
      throw new TypeError("fetch failed")
    }
    const q = query()
    const { results, available } = await geocodeFallback([q], { fetch: failing, sleep: noSleep })
    expect(available).toBe(false)
    expect(results.get(fallbackQueryKey(q)) ?? null).toBeNull()
  })

  it("makes no call when there is nothing to look up", async () => {
    const { fetchFn, requests } = fakeGeocoder(() => "")
    const { available } = await geocodeFallback([], { fetch: fetchFn, sleep: noSleep })
    expect(requests).toHaveLength(0)
    expect(available).toBe(true)
  })

  it("gives up on a service that accepts the connection but never answers, then degrades", async () => {
    let attempts = 0
    const hanging: GeocodeFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        attempts++
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })
    const outcome = await geocodeFallback([query()], { fetch: hanging, sleep: noSleep, timeoutMs: 20 })
    expect(outcome.available).toBe(false)
    expect(outcome.results.size).toBe(0)
    expect(attempts).toBe(3)
  }, 2000)
})
