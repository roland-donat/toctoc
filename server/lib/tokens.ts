// Field link tokens (KTD6, R15): 256 random bits in the URL fragment, sent to the API in a header and looked up by
// their SHA-256. Since 16/10/2026 a link has no time limit and its token is kept, so the session page shows it
// again: it serves until the session is ended or archived (feedback still accepted 12 h after that, for phones
// that were offline) or until it is revoked by hand (refused at once).
import { createHash, randomBytes } from "node:crypto"
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm"
import type { AppContext } from "../context.ts"
import { fieldLinks } from "../db/schema/index.ts"

export const FIELD_LINK_GRACE_MS = 12 * 3600 * 1000
/** Header carrying the token on every field request; the token never appears in an API URL. */
export const FIELD_TOKEN_HEADER = "X-Toctoc-Token"

export type FieldLink = typeof fieldLinks.$inferSelect
/** Lifecycle of the High-Level Technical Design: read and write while active, write only during grace. */
export type FieldLinkState = "actif" | "grace" | "expire" | "revoque"

/** 256 random bits, base64url: field link tokens and admin session ids. */
export function newToken(): string {
  return randomBytes(32).toString("base64url")
}

/** SHA-256 in hex: the only form in which a token is stored. */
export function sha256Hex(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function fieldLinkState(link: Pick<FieldLink, "expiresAt" | "revokedAt">, now: Date): FieldLinkState {
  if (link.revokedAt !== null) return "revoque"
  const at = now.getTime()
  if (link.expiresAt === null || at < link.expiresAt) return "actif"
  if (at < link.expiresAt + FIELD_LINK_GRACE_MS) return "grace"
  return "expire"
}

/**
 * Closes the links of a session that ends or is archived: reads stop now, the feedback queued on phones is still
 * taken during the grace period. Links already closed or revoked are left as they are.
 */
export function closeFieldLinks(ctx: AppContext, itineraryId: string): void {
  const at = ctx.now().getTime()
  ctx.db
    .update(fieldLinks)
    .set({ expiresAt: at })
    .where(
      and(
        eq(fieldLinks.itineraryId, itineraryId),
        isNull(fieldLinks.revokedAt),
        or(isNull(fieldLinks.expiresAt), gt(fieldLinks.expiresAt, at)),
      ),
    )
    .run()
}

/** Revokes every link of the itinerary that is not revoked yet. */
export function revokeFieldLinks(ctx: AppContext, itineraryId: string): void {
  ctx.db
    .update(fieldLinks)
    .set({ revokedAt: ctx.now().getTime() })
    .where(and(eq(fieldLinks.itineraryId, itineraryId), isNull(fieldLinks.revokedAt)))
    .run()
}

/**
 * Issues a new link for the itinerary and returns its token, which is never retrievable afterwards.
 * One live link per itinerary: the previous ones are revoked, so the state shown to the administrator is the whole truth.
 */
export function issueFieldLink(ctx: AppContext, itineraryId: string): { token: string; link: FieldLink } {
  const token = newToken()
  const issuedAt = ctx.now().getTime()
  const link: FieldLink = {
    id: crypto.randomUUID(),
    itineraryId,
    tokenHash: sha256Hex(token),
    token,
    issuedAt,
    expiresAt: null,
    revokedAt: null,
  }
  ctx.db.transaction((tx) => {
    tx.update(fieldLinks)
      .set({ revokedAt: issuedAt })
      .where(and(eq(fieldLinks.itineraryId, itineraryId), isNull(fieldLinks.revokedAt)))
      .run()
    tx.insert(fieldLinks).values(link).run()
  })
  return { token, link }
}

/** Latest issued link of the itinerary, whatever its state. */
export function latestFieldLink(ctx: AppContext, itineraryId: string): FieldLink | undefined {
  return ctx.db
    .select()
    .from(fieldLinks)
    .where(eq(fieldLinks.itineraryId, itineraryId))
    .orderBy(desc(fieldLinks.issuedAt), desc(sql`rowid`))
    .limit(1)
    .get()
}

/** Link of a token with its state now, null for an unknown token. */
export function resolveFieldToken(ctx: AppContext, token: string): { link: FieldLink; state: FieldLinkState } | null {
  const link = ctx.db.select().from(fieldLinks).where(eq(fieldLinks.tokenHash, sha256Hex(token))).get()
  if (!link) return null
  return { link, state: fieldLinkState(link, ctx.now()) }
}
