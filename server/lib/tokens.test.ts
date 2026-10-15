import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { fieldLinks, itineraries } from "../db/schema/index.ts"
import {
  fieldLinkState,
  issueFieldLink,
  latestFieldLink,
  newToken,
  resolveFieldToken,
  revokeFieldLinks,
  sha256Hex,
} from "./tokens.ts"

const NOW = new Date("2027-03-01T10:00:00Z")
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

let ctx: AppContext
let setNow: (d: Date) => void

function insertItinerary(id: string): void {
  ctx.db
    .insert(itineraries)
    .values({ id, createdAt: NOW.getTime(), name: null, zone: "{}", startLat: 47.6, startLon: -2.75, durationMinutes: 60, totalSeconds: 0 })
    .run()
}

beforeEach(() => {
  const t = createTestContext({ now: NOW })
  ctx = t.ctx
  setNow = t.setNow
  insertItinerary("it-a")
})

describe("newToken", () => {
  it("draws 256 random bits, written in base64url", () => {
    const a = newToken()
    const b = newToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a, "base64url")).toHaveLength(32)
    expect(a).not.toBe(b)
  })

  it("hashes with SHA-256 in hex", () => {
    expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc").digest("hex"))
  })
})

describe("fieldLinkState", () => {
  const issuedAt = NOW.getTime()
  const link = { issuedAt, expiresAt: issuedAt + 7 * DAY, revokedAt: null }
  it("is active for 7 days, then in grace for 12 hours, then expired", () => {
    expect(fieldLinkState(link, new Date(issuedAt + 7 * DAY - 1))).toBe("actif")
    expect(fieldLinkState(link, new Date(issuedAt + 7 * DAY))).toBe("grace")
    expect(fieldLinkState(link, new Date(issuedAt + 7 * DAY + 12 * HOUR - 1))).toBe("grace")
    expect(fieldLinkState(link, new Date(issuedAt + 7 * DAY + 12 * HOUR))).toBe("expire")
  })
  it("is revoked as soon as revokedAt is set, whatever the date", () => {
    expect(fieldLinkState({ ...link, revokedAt: issuedAt + HOUR }, new Date(issuedAt + 2 * HOUR))).toBe("revoque")
  })
})

describe("issueFieldLink", () => {
  it("stores only the hash of the token, valid 7 days", () => {
    const { token, link } = issueFieldLink(ctx, "it-a")
    const rows = ctx.db.select().from(fieldLinks).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokenHash).toBe(createHash("sha256").update(token).digest("hex"))
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(link.expiresAt - link.issuedAt).toBe(7 * DAY)
    expect(resolveFieldToken(ctx, token)).toEqual({ link: rows[0], state: "actif" })
  })

  it("replaces the previous link: issuing again revokes it", () => {
    const first = issueFieldLink(ctx, "it-a")
    setNow(new Date(NOW.getTime() + HOUR))
    const second = issueFieldLink(ctx, "it-a")
    expect(resolveFieldToken(ctx, first.token)?.state).toBe("revoque")
    expect(resolveFieldToken(ctx, second.token)?.state).toBe("actif")
    expect(latestFieldLink(ctx, "it-a")?.id).toBe(second.link.id)
  })

  it("revokes the live link in one call", () => {
    const { token } = issueFieldLink(ctx, "it-a")
    revokeFieldLinks(ctx, "it-a")
    expect(resolveFieldToken(ctx, token)?.state).toBe("revoque")
  })

  it("does not resolve an unknown token", () => {
    issueFieldLink(ctx, "it-a")
    expect(resolveFieldToken(ctx, newToken())).toBeNull()
  })
})
