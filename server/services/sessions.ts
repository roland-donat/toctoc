// Sessions TocToc (15/10/2026): an itinerary seen as a door-to-door session, with its name, progress, field link,
// feedback and history; archived or deleted by the administrator.
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm"
import type { AppContext } from "../context.ts"
import { addresses, itineraries, itineraryDoors, sessionEvents, visits } from "../db/schema/index.ts"
import { parseZone, zoneLabel } from "./route-builder.ts"
import { fieldLinkState, latestFieldLink, revokeFieldLinks, type FieldLinkState } from "../lib/tokens.ts"
import { addressLabel } from "./current-list.ts"

export type SessionEventKind = (typeof sessionEvents.$inferSelect)["kind"]
export type SessionEventSource = (typeof sessionEvents.$inferSelect)["source"]

export class SessionError extends Error {
  readonly code: "itinerary_not_found" | "session_archived"
  constructor(code: "itinerary_not_found" | "session_archived") {
    super(code)
    this.name = "SessionError"
    this.code = code
  }
}

export interface SessionSummary {
  id: string
  name: string | null
  createdAt: number
  zoneLabel: string
  durationMinutes: number
  totalSeconds: number
  doorCount: number
  /** Doors with at least one feedback of this session (cancellations aside). */
  doorsDone: number
  feedbackCount: number
  link: { state: FieldLinkState; expiresAt: number } | null
  /** Latest change of the session (history), its creation at the least. */
  updatedAt: number
  archivedAt: number | null
}

export interface SessionEvent {
  id: number
  at: number
  kind: SessionEventKind
  source: SessionEventSource
  detail: string | null
}

/** Appends to the history of a session; a session deleted meanwhile is left alone. */
export function recordSessionEvent(
  ctx: AppContext,
  itineraryId: string | null | undefined,
  kind: SessionEventKind,
  source: SessionEventSource,
  detail: string | null = null,
): void {
  if (!itineraryId) return
  const exists = ctx.db.select({ id: itineraries.id }).from(itineraries).where(eq(itineraries.id, itineraryId)).get()
  if (!exists) return
  ctx.db.insert(sessionEvents).values({ itineraryId, at: ctx.now().getTime(), kind, source, detail }).run()
}

/** Address of a door, as the history shows it: the place, never who lives there. */
export function doorLabel(ctx: AppContext, addressId: string): string | null {
  const place = ctx.db
    .select({ number: addresses.number, rep: addresses.rep, streetName: addresses.streetName })
    .from(addresses)
    .where(eq(addresses.id, addressId))
    .get()
  return place ? addressLabel(place) : null
}

/** The session, refused when archived: an archived session is read-only until restored. */
export function assertActiveSession(ctx: AppContext, id: string): void {
  const it = ctx.db.select({ archivedAt: itineraries.archivedAt }).from(itineraries).where(eq(itineraries.id, id)).get()
  if (!it) throw new SessionError("itinerary_not_found")
  if (it.archivedAt !== null) throw new SessionError("session_archived")
}

/** One session, archived or not. */
export function sessionSummary(ctx: AppContext, id: string): SessionSummary {
  const found = listSessions(ctx, { id })[0]
  if (!found) throw new SessionError("itinerary_not_found")
  return found
}

/** Sessions, newest first: the active ones, or the archived ones (or the one asked for, whatever its state). */
export function listSessions(ctx: AppContext, options: { archived?: boolean; id?: string } = {}): SessionSummary[] {
  const rows = ctx.db
    .select()
    .from(itineraries)
    .where(
      options.id !== undefined
        ? eq(itineraries.id, options.id)
        : options.archived
          ? isNotNull(itineraries.archivedAt)
          : isNull(itineraries.archivedAt),
    )
    .orderBy(desc(itineraries.createdAt))
    .all()
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const doors = new Map<string, Set<string>>()
  for (const d of ctx.db
    .select({ itineraryId: itineraryDoors.itineraryId, addressId: itineraryDoors.addressId })
    .from(itineraryDoors)
    .where(inArray(itineraryDoors.itineraryId, ids))
    .all()) {
    const set = doors.get(d.itineraryId) ?? new Set()
    set.add(d.addressId)
    doors.set(d.itineraryId, set)
  }
  const done = new Map<string, Set<string>>()
  const feedbackCount = new Map<string, number>()
  for (const v of ctx.db
    .select({ itineraryId: visits.itineraryId, addressId: visits.addressId })
    .from(visits)
    // In SQL a null qualification is not "different from annulation": both cases are spelled out.
    .where(and(inArray(visits.itineraryId, ids), or(isNull(visits.qualification), ne(visits.qualification, "annulation"))))
    .all()) {
    if (v.itineraryId === null) continue
    feedbackCount.set(v.itineraryId, (feedbackCount.get(v.itineraryId) ?? 0) + 1)
    // A door taken out of the session afterwards does not count in its progress.
    if (!doors.get(v.itineraryId)?.has(v.addressId)) continue
    const set = done.get(v.itineraryId) ?? new Set()
    set.add(v.addressId)
    done.set(v.itineraryId, set)
  }
  const lastEvent = new Map<string, number>()
  for (const e of ctx.db
    .select({ itineraryId: sessionEvents.itineraryId, at: sessionEvents.at })
    .from(sessionEvents)
    .where(inArray(sessionEvents.itineraryId, ids))
    .all()) {
    lastEvent.set(e.itineraryId, Math.max(lastEvent.get(e.itineraryId) ?? 0, e.at))
  }
  const now = ctx.now()
  return rows.map((r) => {
    const link = latestFieldLink(ctx, r.id)
    return {
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      zoneLabel: zoneLabel(parseZone(r.zone)),
      durationMinutes: r.durationMinutes,
      totalSeconds: r.totalSeconds,
      doorCount: doors.get(r.id)?.size ?? 0,
      doorsDone: done.get(r.id)?.size ?? 0,
      feedbackCount: feedbackCount.get(r.id) ?? 0,
      link: link ? { state: fieldLinkState(link, now), expiresAt: link.expiresAt } : null,
      updatedAt: Math.max(r.createdAt, lastEvent.get(r.id) ?? 0),
      archivedAt: r.archivedAt,
    }
  })
}

/** History of a session, newest first. */
export function listSessionEvents(ctx: AppContext, id: string): SessionEvent[] {
  return ctx.db
    .select({ id: sessionEvents.id, at: sessionEvents.at, kind: sessionEvents.kind, source: sessionEvents.source, detail: sessionEvents.detail })
    .from(sessionEvents)
    .where(eq(sessionEvents.itineraryId, id))
    .orderBy(desc(sessionEvents.at), desc(sessionEvents.id))
    .all()
}

export function renameSession(ctx: AppContext, id: string, name: string | null): void {
  assertActiveSession(ctx, id)
  const cleaned = name?.replace(/\s+/g, " ").trim() || null
  ctx.db.update(itineraries).set({ name: cleaned }).where(eq(itineraries.id, id)).run()
  recordSessionEvent(ctx, id, "renamed", "admin", cleaned)
}

/** Archives: read-only, field link revoked (so its doors are no longer reserved for it). */
export function archiveSession(ctx: AppContext, id: string): void {
  assertActiveSession(ctx, id)
  ctx.db.transaction(() => {
    revokeFieldLinks(ctx, id)
    ctx.db.update(itineraries).set({ archivedAt: ctx.now().getTime() }).where(eq(itineraries.id, id)).run()
    recordSessionEvent(ctx, id, "archived", "admin")
  })
}

export function restoreSession(ctx: AppContext, id: string): void {
  const it = ctx.db.select({ archivedAt: itineraries.archivedAt }).from(itineraries).where(eq(itineraries.id, id)).get()
  if (!it) throw new SessionError("itinerary_not_found")
  if (it.archivedAt === null) return
  ctx.db.update(itineraries).set({ archivedAt: null }).where(eq(itineraries.id, id)).run()
  recordSessionEvent(ctx, id, "restored", "admin")
}

/**
 * Deletes a session, its doors, links and history. Its feedback goes with it when asked (the default of the
 * confirmation); otherwise it stays on the addresses, detached from the session.
 */
export function deleteSession(ctx: AppContext, id: string, options: { withFeedback: boolean }): { feedbackDeleted: number; feedbackKept: number } {
  const it = ctx.db.select({ id: itineraries.id }).from(itineraries).where(eq(itineraries.id, id)).get()
  if (!it) throw new SessionError("itinerary_not_found")
  return ctx.db.transaction((tx) => {
    const own = tx.select({ id: visits.id }).from(visits).where(eq(visits.itineraryId, id)).all().length
    if (options.withFeedback) tx.delete(visits).where(eq(visits.itineraryId, id)).run()
    else tx.update(visits).set({ itineraryId: null }).where(eq(visits.itineraryId, id)).run()
    // Doors, links and history go by cascade.
    tx.delete(itineraries).where(eq(itineraries.id, id)).run()
    return options.withFeedback ? { feedbackDeleted: own, feedbackKept: 0 } : { feedbackDeleted: 0, feedbackKept: own }
  })
}
