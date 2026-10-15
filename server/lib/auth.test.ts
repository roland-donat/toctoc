import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { createTestContext, TEST_ORIGIN } from "../../tests/helpers.ts"
import { adminAccount, sessions } from "../db/schema/index.ts"
import {
  accessControl,
  ACCOUNT_FREE_FAILURES,
  ClientThrottle,
  createSession,
  hashPassword,
  loginRetryAfterSeconds,
  SESSION_MAX_AGE_MS,
  SESSION_TTL_MS,
  sessionCookieName,
  setAdminPassword,
  touchSession,
  verifyPassword,
} from "./auth.ts"

const HOUR = 60 * 60 * 1000

describe("password hashing", () => {
  it("hashes with argon2id and verifies only the right password", async () => {
    const hash = await hashPassword("correct horse battery staple")
    expect(hash.startsWith("$argon2id$")).toBe(true)
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true)
    expect(await verifyPassword(hash, "wrong horse battery staple!")).toBe(false)
  })
})

describe("sessions", () => {
  it("stores only the SHA-256 of the token, never the token itself", () => {
    const { ctx } = createTestContext()
    const token = createSession(ctx.db, ctx.now())
    const rows = ctx.db.select().from(sessions).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.idHash).not.toBe(token)
    expect(rows[0]?.idHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("slides the 12 h lifetime on use and rejects an idle session after 12 h", () => {
    const start = new Date("2027-01-15T10:00:00Z")
    const { ctx } = createTestContext({ now: start })
    const token = createSession(ctx.db, start)
    expect(SESSION_TTL_MS).toBe(12 * HOUR)
    // Used after 11 h: still valid, and the lifetime restarts from there.
    expect(touchSession(ctx.db, token, new Date(start.getTime() + 11 * HOUR))).toBe(true)
    // 22 h after creation but only 11 h after last use: still valid.
    expect(touchSession(ctx.db, token, new Date(start.getTime() + 22 * HOUR))).toBe(true)
    // 12 h 1 min of inactivity: rejected.
    expect(touchSession(ctx.db, token, new Date(start.getTime() + 34 * HOUR + 60_000))).toBe(false)
    expect(touchSession(ctx.db, "not-a-token", start)).toBe(false)
  })

  it("setting a new password deletes every existing session and resets the failure counter", async () => {
    const { ctx } = createTestContext()
    setAdminPassword(ctx.db, await hashPassword("first password 1234"), ctx.now())
    ctx.db.update(adminAccount).set({ failedLogins: 7, lastFailedAt: 1 }).run()
    const token = createSession(ctx.db, ctx.now())
    setAdminPassword(ctx.db, await hashPassword("second password 1234"), ctx.now())
    expect(touchSession(ctx.db, token, ctx.now())).toBe(false)
    expect(ctx.db.select().from(sessions).all()).toHaveLength(0)
    const account = ctx.db.select().from(adminAccount).all()
    expect(account).toHaveLength(1)
    expect(account[0]?.failedLogins).toBe(0)
  })
})

describe("login slowdown", () => {
  const t0 = new Date("2027-01-15T10:00:00Z").getTime()
  it("slows a client down after five failures, with a window doubling up to 60 s, never permanent", () => {
    const clients = new ClientThrottle()
    for (let i = 0; i < 4; i++) clients.recordFailure("203.0.113.1", new Date(t0))
    expect(clients.retryAfterSeconds("203.0.113.1", new Date(t0))).toBe(0)
    clients.recordFailure("203.0.113.1", new Date(t0))
    expect(clients.retryAfterSeconds("203.0.113.1", new Date(t0))).toBe(1)
    for (let i = 0; i < 3; i++) clients.recordFailure("203.0.113.1", new Date(t0))
    expect(clients.retryAfterSeconds("203.0.113.1", new Date(t0))).toBe(8)
    expect(clients.retryAfterSeconds("203.0.113.1", new Date(t0 + 3_000))).toBe(5)
    expect(clients.retryAfterSeconds("203.0.113.1", new Date(t0 + 8_000))).toBe(0)
    // Another address is not affected, and a success clears the client.
    expect(clients.retryAfterSeconds("198.51.100.7", new Date(t0))).toBe(0)
    clients.reset("203.0.113.1")
    expect(clients.retryAfterSeconds("203.0.113.1", new Date(t0))).toBe(0)
  })

  it("slows the whole account down only past the global ceiling, never permanently", () => {
    const free = ACCOUNT_FREE_FAILURES
    expect(loginRetryAfterSeconds({ failedLogins: free - 1, lastFailedAt: t0 }, new Date(t0))).toBe(0)
    expect(loginRetryAfterSeconds({ failedLogins: free, lastFailedAt: t0 }, new Date(t0))).toBe(1)
    expect(loginRetryAfterSeconds({ failedLogins: free + 40, lastFailedAt: t0 }, new Date(t0))).toBe(60)
    expect(loginRetryAfterSeconds({ failedLogins: 1000, lastFailedAt: t0 }, new Date(t0 + 60_000))).toBe(0)
  })
})

describe("session lifetime", () => {
  it("ends a session seven days after its creation, however active it stays", () => {
    const { ctx } = createTestContext()
    const t = new Date("2027-01-15T10:00:00Z").getTime()
    const token = createSession(ctx.db, new Date(t))
    for (let h = 6; h < 7 * 24; h += 6) expect(touchSession(ctx.db, token, new Date(t + h * 3_600_000))).toBe(true)
    expect(touchSession(ctx.db, token, new Date(t + SESSION_MAX_AGE_MS))).toBe(false)
  })
})

describe("session cookie name", () => {
  it("uses the __Host- prefix on https and a plain name on http (dev, e2e)", () => {
    expect(sessionCookieName({ publicOrigin: "https://toctoc.test" })).toBe("__Host-toctoc_session")
    expect(sessionCookieName({ publicOrigin: "http://127.0.0.1:3100" })).toBe("toctoc_session")
  })
})

/** Access control mounted on a bare app with a dummy import upload route. */
function uploadApp() {
  const { ctx } = createTestContext()
  const app = new Hono()
  app.use("/api/*", accessControl(ctx))
  app.post("/api/imports/upload", async (c) => {
    const form = await c.req.formData()
    const file = form.get("file")
    return c.json({ received: file instanceof File ? file.size : -1 })
  })
  app.post("/api/things", (c) => c.json({ ok: true }))
  return { app, ctx, cookieName: sessionCookieName(ctx.config) }
}

function uploadBody() {
  const form = new FormData()
  form.append("file", new File(["a;b;c\n1;2;3\n"], "liste.csv", { type: "text/csv" }))
  return form
}

describe("access control on mutating requests", () => {
  it("accepts a multipart upload with the right Origin and a valid session", async () => {
    const { app, ctx, cookieName } = uploadApp()
    const token = createSession(ctx.db, ctx.now())
    const res = await app.request("/api/imports/upload", {
      method: "POST",
      headers: { Origin: TEST_ORIGIN, Cookie: `${cookieName}=${token}` },
      body: uploadBody(),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: 12 })
  })

  it("refuses the same multipart upload without a session", async () => {
    const { app } = uploadApp()
    const res = await app.request("/api/imports/upload", {
      method: "POST",
      headers: { Origin: TEST_ORIGIN },
      body: uploadBody(),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthenticated" })
  })

  it("refuses a multipart upload from another origin even with a session", async () => {
    const { app, ctx, cookieName } = uploadApp()
    const token = createSession(ctx.db, ctx.now())
    const res = await app.request("/api/imports/upload", {
      method: "POST",
      headers: { Origin: "https://evil.example", Cookie: `${cookieName}=${token}` },
      body: uploadBody(),
    })
    expect(res.status).toBe(403)
  })

  it("refuses a body that is neither JSON nor multipart with 415", async () => {
    const { app, ctx, cookieName } = uploadApp()
    const token = createSession(ctx.db, ctx.now())
    const res = await app.request("/api/things", {
      method: "POST",
      headers: {
        Origin: TEST_ORIGIN,
        Cookie: `${cookieName}=${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "a=1",
    })
    expect(res.status).toBe(415)
  })
})
