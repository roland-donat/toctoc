// Administrator authentication and default-deny access control (KTD5, R23).
import { hash, verify, type Algorithm } from "@node-rs/argon2"
import { eq, lt, sql } from "drizzle-orm"
import type { Context, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { getConnInfo } from "@hono/node-server/conninfo"
import type { AppContext } from "../context.ts"
import type { Db } from "../db/index.ts"
import { adminAccount, sessions } from "../db/schema/index.ts"
import type { AppConfig } from "./config.ts"
import { newToken, sha256Hex } from "./tokens.ts"

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const MIN_PASSWORD_LENGTH = 16
const ADMIN_ID = 1

/** Failures allowed from one client before its slowdown starts, and the cap of every slowdown. */
const FREE_FAILURES = 5
const MAX_DELAY_S = 60
/**
 * Failures allowed on the account, all clients together, before the account itself slows down: high enough that
 * one client cannot keep the administrator out, low enough that guesses spread over many addresses stay slow.
 */
export const ACCOUNT_FREE_FAILURES = 50
/** Absolute lifetime of a session, however active it stays. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------- passwords

// `Algorithm` is an ambient const enum, unusable as a value under verbatimModuleSyntax; 2 is Argon2id.
const ARGON2ID = 2 as Algorithm

export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID })
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    // Malformed stored hash: treat as a failed verification.
    return false
  }
}

export interface AdminAccountState {
  passwordHash: string
  failedLogins: number
  lastFailedAt: number | null
}

export function getAdminAccount(db: Db): AdminAccountState | undefined {
  return db
    .select({
      passwordHash: adminAccount.passwordHash,
      failedLogins: adminAccount.failedLogins,
      lastFailedAt: adminAccount.lastFailedAt,
    })
    .from(adminAccount)
    .where(eq(adminAccount.id, ADMIN_ID))
    .get()
}

/** Writes the administrator password, resets the failure counter and deletes every session. */
export function setAdminPassword(db: Db, passwordHash: string, now: Date): void {
  const at = now.getTime()
  db.transaction((tx) => {
    tx.insert(adminAccount)
      .values({ id: ADMIN_ID, passwordHash, updatedAt: at, failedLogins: 0, lastFailedAt: null })
      .onConflictDoUpdate({
        target: adminAccount.id,
        set: { passwordHash, updatedAt: at, failedLogins: 0, lastFailedAt: null },
      })
      .run()
    tx.delete(sessions).run()
  })
}

// ---------------------------------------------------------------- slowdown

/**
 * Seconds to wait before the next login attempt is examined, for a failure count and the time of the last failure.
 * After `free` consecutive failures the window doubles per failure, capped at MAX_DELAY_S; it always ends, so there
 * is no permanent block.
 */
function retryAfterSeconds(failures: number, lastFailedAt: number | null, now: Date, free: number): number {
  if (failures < free || lastFailedAt === null) return 0
  const windowS = Math.min(2 ** (failures - free), MAX_DELAY_S)
  const remainingMs = lastFailedAt + windowS * 1000 - now.getTime()
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0
}

/** Slowdown of the account, all clients together (stored, so it survives a restart). */
export function loginRetryAfterSeconds(
  account: Pick<AdminAccountState, "failedLogins" | "lastFailedAt">,
  now: Date,
): number {
  return retryAfterSeconds(account.failedLogins, account.lastFailedAt, now, ACCOUNT_FREE_FAILURES)
}

const MAX_TRACKED_CLIENTS = 10_000

/**
 * Slowdown per client address (in memory): repeated failures from one address slow down that address only, so a
 * stranger cannot keep the administrator out by failing on purpose.
 */
export class ClientThrottle {
  private readonly entries = new Map<string, { failures: number; lastFailedAt: number }>()

  retryAfterSeconds(client: string, now: Date): number {
    const e = this.entries.get(client)
    return e ? retryAfterSeconds(e.failures, e.lastFailedAt, now, FREE_FAILURES) : 0
  }

  recordFailure(client: string, now: Date): void {
    const at = now.getTime()
    if (this.entries.size >= MAX_TRACKED_CLIENTS) {
      // Forget the clients whose window is long over; if all are recent, forget the oldest.
      for (const [key, e] of this.entries) if (at - e.lastFailedAt > MAX_DELAY_S * 1000) this.entries.delete(key)
      if (this.entries.size >= MAX_TRACKED_CLIENTS) this.entries.delete(this.entries.keys().next().value ?? "")
    }
    const e = this.entries.get(client)
    this.entries.delete(client)
    this.entries.set(client, { failures: (e?.failures ?? 0) + 1, lastFailedAt: at })
  }

  reset(client: string): void {
    this.entries.delete(client)
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/**
 * Address of the client. Behind Caddy every connection comes from loopback and Caddy sets X-Forwarded-For to the
 * address it saw (it replaces any value sent by the client), so the header is read only from a loopback peer; its
 * last entry is the one Caddy wrote. Without a known peer (in-process tests), every request counts as one client.
 */
export function clientAddress(c: Context): string {
  let peer: string | undefined
  try {
    peer = getConnInfo(c).remote.address
  } catch {
    peer = undefined
  }
  if (peer === undefined) return "unknown"
  if (!LOOPBACK.has(peer)) return peer
  const forwarded = c.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim()
  return forwarded && forwarded.length <= 64 ? forwarded : peer
}

/** Atomically counts one more failure and returns the new count. */
export function recordLoginFailure(db: Db, now: Date): number {
  const row = db
    .update(adminAccount)
    .set({ failedLogins: sql`${adminAccount.failedLogins} + 1`, lastFailedAt: now.getTime() })
    .where(eq(adminAccount.id, ADMIN_ID))
    .returning({ failedLogins: adminAccount.failedLogins })
    .get()
  return row?.failedLogins ?? 0
}

export function resetLoginFailures(db: Db): void {
  db.update(adminAccount).set({ failedLogins: 0, lastFailedAt: null }).where(eq(adminAccount.id, ADMIN_ID)).run()
}

// ---------------------------------------------------------------- sessions

/** Creates a session and returns the cookie value; only its SHA-256 is stored. */
export function createSession(db: Db, now: Date): string {
  const token = newToken()
  const at = now.getTime()
  db.delete(sessions).where(lt(sessions.expiresAt, at)).run()
  db.insert(sessions)
    .values({ idHash: sha256Hex(token), createdAt: at, lastSeenAt: at, expiresAt: at + SESSION_TTL_MS })
    .run()
  return token
}

/** Validates a session token and slides its lifetime, never beyond SESSION_MAX_AGE_MS. Expired sessions are deleted. */
export function touchSession(db: Db, token: string, now: Date): boolean {
  const idHash = sha256Hex(token)
  const at = now.getTime()
  const row = db
    .select({ expiresAt: sessions.expiresAt, createdAt: sessions.createdAt })
    .from(sessions)
    .where(eq(sessions.idHash, idHash))
    .get()
  if (!row) return false
  if (row.expiresAt <= at || at - row.createdAt >= SESSION_MAX_AGE_MS) {
    db.delete(sessions).where(eq(sessions.idHash, idHash)).run()
    return false
  }
  const expiresAt = Math.min(at + SESSION_TTL_MS, row.createdAt + SESSION_MAX_AGE_MS)
  db.update(sessions).set({ lastSeenAt: at, expiresAt }).where(eq(sessions.idHash, idHash)).run()
  return true
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.idHash, sha256Hex(token))).run()
}

// ---------------------------------------------------------------- cookie

function isHttps(config: Pick<AppConfig, "publicOrigin">): boolean {
  return config.publicOrigin.startsWith("https://")
}

/** `__Host-` requires Secure, which browsers refuse on plain http (dev and e2e only). */
export function sessionCookieName(config: Pick<AppConfig, "publicOrigin">): string {
  return isHttps(config) ? "__Host-toctoc_session" : "toctoc_session"
}

export function issueSessionCookie(c: Context, config: AppConfig, token: string): void {
  setCookie(c, sessionCookieName(config), token, {
    httpOnly: true,
    secure: isHttps(config),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export function clearSessionCookie(c: Context, config: AppConfig): void {
  deleteCookie(c, sessionCookieName(config), { path: "/", secure: isHttps(config) })
}

export function readSessionToken(c: Context, config: AppConfig): string | undefined {
  return getCookie(c, sessionCookieName(config)) || undefined
}

/** True when the request carries a valid session; slides it and refreshes the cookie lifetime. */
export function hasValidSession(c: Context, ctx: AppContext): boolean {
  const token = readSessionToken(c, ctx.config)
  if (!token || !touchSession(ctx.db, token, ctx.now())) return false
  issueSessionCookie(c, ctx.config, token)
  return true
}

// ---------------------------------------------------------------- middleware

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** Routes reachable without an admin session. `/api/terrain/*` is guarded by its token (U12). */
function isPublicApiPath(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/auth" ||
    path.startsWith("/api/auth/") ||
    path === "/api/terrain" ||
    path.startsWith("/api/terrain/")
  )
}

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

/**
 * Mount on `/api/*`. Mutating requests must come from the configured public origin (CSRF, compared to the
 * public domain rather than the address seen behind the proxy) and carry JSON or multipart; every route is
 * then refused without a session, except the public ones.
 */
export function accessControl(ctx: AppContext): MiddlewareHandler {
  const expectedOrigin = new URL(ctx.config.publicOrigin).origin
  return async (c, next) => {
    if (MUTATING.has(c.req.method)) {
      if (c.req.header("Origin") !== expectedOrigin) return c.json({ error: "forbidden_origin" }, 403)
      const type = mediaType(c.req.header("Content-Type"))
      if (type !== "application/json" && type !== "multipart/form-data") {
        return c.json({ error: "unsupported_media_type" }, 415)
      }
    }
    if (!isPublicApiPath(c.req.path) && !hasValidSession(c, ctx)) {
      return c.json({ error: "unauthenticated" }, 401)
    }
    await next()
  }
}
