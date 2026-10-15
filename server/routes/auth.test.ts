import { describe, expect, it } from "vitest"
import { createTestContext, TEST_ORIGIN } from "../../tests/helpers.ts"
import { createApp } from "../app.ts"
import { hashPassword, setAdminPassword } from "../lib/auth.ts"

const PASSWORD = "un mot de passe fictif assez long"
const COOKIE = "__Host-toctoc_session"

async function setup() {
  const harness = createTestContext()
  setAdminPassword(harness.ctx.db, await hashPassword(PASSWORD), harness.ctx.now())
  return { ...harness, app: createApp(harness.ctx) }
}

type App = ReturnType<typeof createApp>

function login(app: App, password: string, headers: Record<string, string> = {}) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: TEST_ORIGIN, ...headers },
    body: JSON.stringify({ password }),
  })
}

/** Returns the `name=value` pair of the session cookie set by a response. */
function sessionPair(res: Response): string {
  const header = res.headers.get("set-cookie") ?? ""
  const pair = header.split(";")[0] ?? ""
  expect(pair.startsWith(`${COOKIE}=`)).toBe(true)
  return pair
}

describe("default deny on the API", () => {
  it("Covers AE6. Without a session, admin reads answer 401 with no data", async () => {
    const { app } = await setup()
    // Every admin router actually mounted by createApp, so a router mounted outside the guard would show here.
    const adminPaths = [
      "/api/carte",
      "/api/adresses/x",
      "/api/stats",
      "/api/itineraires",
      "/api/retours",
      "/api/imports/ban/status",
      "/api/parametres",
      "/api/antiseches",
    ]
    for (const path of adminPaths) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
      expect(await res.json(), path).toEqual({ error: "unauthenticated" })
    }
  })

  it("lets an authenticated request through to routing (unknown route then answers 404)", async () => {
    const { app } = await setup()
    const cookie = sessionPair(await login(app, PASSWORD))
    const res = await app.request("/api/route-inexistante", { headers: { Cookie: cookie } })
    expect(res.status).toBe(404)
  })

  it("keeps /api/health open", async () => {
    const { app } = await setup()
    expect((await app.request("/api/health")).status).toBe(200)
  })

  it("answers a terrain route without token with 404, not 401", async () => {
    const { app } = await setup()
    const res = await app.request("/api/terrain/abcdef")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found" })
  })
})

describe("login", () => {
  it("sets a __Host- cookie, HttpOnly, Secure, SameSite=Strict, Path=/ on https", async () => {
    const { app } = await setup()
    const res = await login(app, PASSWORD)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authenticated: true })
    const header = res.headers.get("set-cookie") ?? ""
    expect(header).toMatch(/^__Host-toctoc_session=[A-Za-z0-9_-]{40,};/)
    expect(header).toContain("HttpOnly")
    expect(header).toContain("Secure")
    expect(header).toContain("SameSite=Strict")
    expect(header).toContain("Path=/")
    expect(header).not.toContain("Domain=")
  })

  it("uses a non-Secure cookie named toctoc_session on a plain http origin", async () => {
    const harness = createTestContext({ config: { publicOrigin: "http://127.0.0.1:3100" } })
    setAdminPassword(harness.ctx.db, await hashPassword(PASSWORD), harness.ctx.now())
    const app = createApp(harness.ctx)
    const res = await login(app, PASSWORD, { Origin: "http://127.0.0.1:3100" })
    expect(res.status).toBe(200)
    const header = res.headers.get("set-cookie") ?? ""
    expect(header.startsWith("toctoc_session=")).toBe(true)
    expect(header).not.toContain("Secure")
    expect(header).toContain("HttpOnly")
  })

  it("answers 401 to a wrong password and slows down the 10th rapid attempt", async () => {
    const { app } = await setup()
    const statuses: number[] = []
    let last: Response | undefined
    for (let i = 0; i < 10; i++) {
      last = await login(app, "mauvais mot de passe fictif")
      statuses.push(last.status)
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses[9]).toBe(429)
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0)
    // Even the right password is refused during the window.
    expect((await login(app, PASSWORD)).status).toBe(429)
  })

  it("still slows down wrong attempts fired in parallel", async () => {
    const { app } = await setup()
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => login(app, "mauvais mot de passe fictif")))).map((r) => r.status)
    expect(statuses.filter((s) => s === 401).length).toBeLessThan(10)
    expect(statuses).toContain(429)
  })

  it("lets the right password in once the window has passed, and resets the counter", async () => {
    const { app, ctx, setNow } = await setup()
    for (let i = 0; i < 6; i++) await login(app, "mauvais mot de passe fictif")
    setNow(new Date(ctx.now().getTime() + 61_000))
    expect((await login(app, PASSWORD)).status).toBe(200)
    // Counter reset: a new wrong attempt is a plain 401, not 429.
    expect((await login(app, "mauvais mot de passe fictif")).status).toBe(401)
  })

  it("refuses an oversized body before reading it, on the public login", async () => {
    const { app } = await setup()
    const res = await login(app, "x".repeat(200 * 1024))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: "body_too_large" })
  })

  it("behind Caddy, a stranger failing on purpose does not keep the administrator out", async () => {
    const { app } = await setup()
    // The Node adapter gives the socket peer; Caddy connects from loopback and writes X-Forwarded-For.
    const fromCaddy = (client: string, password: string) =>
      app.request(
        "/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: TEST_ORIGIN, "X-Forwarded-For": client },
          body: JSON.stringify({ password }),
        },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
      )
    for (let i = 0; i < 12; i++) await fromCaddy("203.0.113.9", "mauvais mot de passe fictif")
    expect((await fromCaddy("203.0.113.9", "mauvais mot de passe fictif")).status).toBe(429)
    expect((await fromCaddy("198.51.100.20", PASSWORD)).status).toBe(200)
  })

  it("never trusts X-Forwarded-For from a peer that is not Caddy", async () => {
    const { app } = await setup()
    const direct = (client: string) =>
      app.request(
        "/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: TEST_ORIGIN, "X-Forwarded-For": client },
          body: JSON.stringify({ password: "mauvais mot de passe fictif" }),
        },
        { incoming: { socket: { remoteAddress: "192.0.2.50" } } },
      )
    for (let i = 0; i < 6; i++) await direct(`203.0.113.${i + 1}`)
    expect((await direct("203.0.113.99")).status).toBe(429)
  })

  it("a forged X-Forwarded-For does not bypass the slowdown", async () => {
    const { app } = await setup()
    for (let i = 0; i < 5; i++) {
      await login(app, "mauvais mot de passe fictif", { "X-Forwarded-For": "127.0.0.1" })
    }
    for (let i = 0; i < 5; i++) {
      const res = await login(app, "mauvais mot de passe fictif", { "X-Forwarded-For": `203.0.113.${i + 1}` })
      expect(res.status).toBe(429)
    }
  })

  it("refuses a JSON mutation whose Origin differs from the public origin", async () => {
    const { app } = await setup()
    expect((await login(app, PASSWORD, { Origin: "https://evil.example" })).status).toBe(403)
    expect((await login(app, PASSWORD, { Origin: "http://127.0.0.1:3000" })).status).toBe(403)
    const noOrigin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(noOrigin.status).toBe(403)
  })
})

describe("me and logout", () => {
  it("me answers authenticated with a session and 401 without", async () => {
    const { app } = await setup()
    expect((await app.request("/api/auth/me")).status).toBe(401)
    const cookie = sessionPair(await login(app, PASSWORD))
    const me = await app.request("/api/auth/me", { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ authenticated: true })
  })

  it("logout invalidates the session server-side: the reused cookie answers 401", async () => {
    const { app } = await setup()
    const cookie = sessionPair(await login(app, PASSWORD))
    const out = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: TEST_ORIGIN, "Content-Type": "application/json" },
    })
    expect(out.status).toBe(204)
    expect((await app.request("/api/auth/me", { headers: { Cookie: cookie } })).status).toBe(401)
    expect((await app.request("/api/carte", { headers: { Cookie: cookie } })).status).toBe(401)
  })
})
