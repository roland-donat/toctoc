import { beforeEach, describe, expect, it } from "vitest"
import type { Hono } from "hono"
import { createTestContext } from "../../tests/helpers.ts"
import { antisechesRoutes } from "./antiseches.ts"

interface Sheet {
  id: string
  ageBand: string
  title: string
  body: string
  position: number
  updatedAt: number
}

let router: Hono
let setNow: (d: Date) => void

function send(path: string, method: string, body?: unknown) {
  return router.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function create(ageBand: string, title: string, body = "x") {
  const res = await send("/", "POST", { ageBand, title, body })
  return { res, sheet: (await res.json()) as Sheet }
}

beforeEach(() => {
  const t = createTestContext({ now: new Date("2027-01-15T10:00:00Z") })
  router = antisechesRoutes(t.ctx)
  setNow = t.setNow
})

describe("antiseches routes", () => {
  it("creates a sheet and returns it", async () => {
    const { res, sheet } = await create("26-40", "Housing", "Line 1\nLine 2")
    expect(res.status).toBe(201)
    expect(sheet).toMatchObject({ ageBand: "26-40", title: "Housing", body: "Line 1\nLine 2" })
    expect(sheet.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(sheet.updatedAt).toBe(new Date("2027-01-15T10:00:00Z").getTime())
  })

  it("lists sheets ordered by age band then position", async () => {
    await create("generale", "G")
    await create("61+", "S")
    const { sheet: y2 } = await create("18-25", "Y2")
    await create("18-25", "Y1")
    await send(`/${y2.id}`, "PATCH", { position: 5 })
    const list = (await (await send("/", "GET")).json()) as Sheet[]
    expect(list.map((s) => s.title)).toEqual(["Y1", "Y2", "S", "G"])
  })

  it("updates fields and refreshes updatedAt", async () => {
    const { sheet } = await create("41-60", "Old", "old body")
    setNow(new Date("2027-01-16T10:00:00Z"))
    const res = await send(`/${sheet.id}`, "PATCH", { title: "New", ageBand: "61+" })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as Sheet
    expect(updated).toMatchObject({ title: "New", body: "old body", ageBand: "61+" })
    expect(updated.updatedAt).toBe(new Date("2027-01-16T10:00:00Z").getTime())
  })

  it("deletes a sheet", async () => {
    const { sheet } = await create("41-60", "T")
    expect((await send(`/${sheet.id}`, "DELETE")).status).toBe(204)
    expect(((await (await send("/", "GET")).json()) as Sheet[]).length).toBe(0)
    expect((await send(`/${sheet.id}`, "DELETE")).status).toBe(404)
  })

  it("rejects an invalid age band with 400", async () => {
    const { res } = await create("30-50", "T")
    expect(res.status).toBe(400)
  })

  it("returns a body containing HTML verbatim", async () => {
    const html = `<img src=x onerror="window.__xss=1">Bonjour`
    const { sheet } = await create("generale", "XSS", html)
    const list = (await (await send("/", "GET")).json()) as Sheet[]
    expect(list.find((s) => s.id === sheet.id)?.body).toBe(html)
  })
})
