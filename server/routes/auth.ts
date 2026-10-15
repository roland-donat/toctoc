import { Hono, type Context } from "hono"
import { z } from "zod"
import type { AppContext } from "../context.ts"
import { readJson } from "../lib/http.ts"
import {
  clearSessionCookie,
  clientAddress,
  ClientThrottle,
  createSession,
  deleteSession,
  getAdminAccount,
  hasValidSession,
  issueSessionCookie,
  loginRetryAfterSeconds,
  readSessionToken,
  recordLoginFailure,
  resetLoginFailures,
  verifyPassword,
} from "../lib/auth.ts"
import { logInfo } from "../lib/log.ts"

const loginSchema = z.object({ password: z.string().min(1).max(1024) })

/** Attempts waiting for their turn; beyond, a login is answered 429 at once. */
const MAX_QUEUED_LOGINS = 20

export function authRoutes(ctx: AppContext): Hono {
  const router = new Hono()

  // Login attempts run one at a time (one Node process, one admin account): the throttle check, the argon2
  // verification and the failure count never interleave, so parallel guesses are slowed down like sequential ones.
  let loginChain: Promise<unknown> = Promise.resolve()
  let queued = 0
  const clients = new ClientThrottle()

  router.post("/login", async (c) => {
    const parsed = loginSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400)
    // A flood of attempts waits in a bounded queue, never in an unbounded one.
    if (queued >= MAX_QUEUED_LOGINS) {
      c.header("Retry-After", "5")
      return c.json({ error: "too_many_attempts" }, 429)
    }
    queued += 1
    const run = loginChain.then(() => attemptLogin(c, parsed.data.password)).finally(() => {
      queued -= 1
    })
    loginChain = run.catch(() => undefined)
    return run
  })

  async function attemptLogin(c: Context, password: string): Promise<Response> {
    const client = clientAddress(c)
    const clientWait = clients.retryAfterSeconds(client, ctx.now())
    if (clientWait > 0) {
      logInfo("login_throttled", { scope: "client", retry_after_s: clientWait })
      c.header("Retry-After", String(clientWait))
      return c.json({ error: "too_many_attempts" }, 429)
    }
    const account = getAdminAccount(ctx.db)
    if (!account) {
      logInfo("login_failed", { reason: "no_admin_password" })
      return c.json({ error: "invalid_credentials" }, 401)
    }

    const retryAfter = loginRetryAfterSeconds(account, ctx.now())
    if (retryAfter > 0) {
      logInfo("login_throttled", { scope: "account", failures: account.failedLogins, retry_after_s: retryAfter })
      c.header("Retry-After", String(retryAfter))
      return c.json({ error: "too_many_attempts" }, 429)
    }

    if (!(await verifyPassword(account.passwordHash, password))) {
      clients.recordFailure(client, ctx.now())
      const failures = recordLoginFailure(ctx.db, ctx.now())
      logInfo("login_failed", { reason: "wrong_password", failures })
      return c.json({ error: "invalid_credentials" }, 401)
    }

    clients.reset(client)
    resetLoginFailures(ctx.db)
    issueSessionCookie(c, ctx.config, createSession(ctx.db, ctx.now()))
    logInfo("login_succeeded")
    return c.json({ authenticated: true })
  }

  router.post("/logout", (c) => {
    const token = readSessionToken(c, ctx.config)
    if (token) deleteSession(ctx.db, token)
    clearSessionCookie(c, ctx.config)
    return c.body(null, 204)
  })

  router.get("/me", (c) => {
    if (!hasValidSession(c, ctx)) return c.json({ error: "unauthenticated" }, 401)
    return c.json({ authenticated: true })
  })

  return router
}
