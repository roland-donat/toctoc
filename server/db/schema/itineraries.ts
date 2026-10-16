import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { addresses } from "./addresses.ts"

export const itineraries = sqliteTable("itineraries", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  name: text("name"),
  /** JSON: `{ type: "polygon", points: [lat, lon][] }` or `{ type: "bureau", bureau }`. */
  zone: text("zone").notNull(),
  startLat: real("start_lat").notNull(),
  startLon: real("start_lon").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  totalSeconds: integer("total_seconds").notNull(),
  /** Per-route permission to show names on the field side (R25), effective only when the global switch allows it (KTD7). */
  showNames: integer("show_names", { mode: "boolean" }).notNull().default(false),
  /** Session archived (15/10/2026): read-only, link closed, listed apart; null while active. */
  archivedAt: integer("archived_at"),
  /** Session ended (16/10/2026): link closed, itinerary frozen, feedback still entered and corrected. */
  endedAt: integer("ended_at"),
})

/**
 * History of a session (15/10/2026): what changed, when and from where. `detail` carries the door address or the
 * new name, never a person's name.
 */
export const sessionEvents = sqliteTable(
  "session_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itineraryId: text("itinerary_id")
      .notNull()
      .references(() => itineraries.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    kind: text("kind", {
      enum: [
        "created",
        "renamed",
        "door_added",
        "door_removed",
        "link_issued",
        "link_revoked",
        "names_shown",
        "names_hidden",
        "feedback_recorded",
        "feedback_corrected",
        "feedback_deleted",
        "archived",
        "restored",
        "ended",
        "reopened",
      ],
    }).notNull(),
    source: text("source", { enum: ["admin", "lien", "feuille"] }).notNull(),
    detail: text("detail"),
  },
  (t) => [index("session_events_itinerary_idx").on(t.itineraryId, t.at)],
)

export const itineraryDoors = sqliteTable(
  "itinerary_doors",
  {
    itineraryId: text("itinerary_id")
      .notNull()
      .references(() => itineraries.id, { onDelete: "cascade" }),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id),
    position: integer("position").notNull(),
    serviceSeconds: integer("service_seconds").notNull(),
    walkSecondsFromPrevious: integer("walk_seconds_from_previous").notNull(),
    priority: integer("priority").notNull(),
    /** Added by hand by the administrator, bypassing the selection rules. */
    manual: integer("manual", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.itineraryId, t.addressId] })],
)

/** Private field link (KTD6): only the SHA-256 of the token is stored. Times are epoch milliseconds. */
export const fieldLinks = sqliteTable("field_links", {
  id: text("id").primaryKey(),
  itineraryId: text("itinerary_id")
    .notNull()
    .references(() => itineraries.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  /**
   * The token itself, so the session page shows the link again (16/10/2026, revises KTD6). Null for a link issued
   * before: it is recreated to be shown.
   */
  token: text("token"),
  issuedAt: integer("issued_at").notNull(),
  /**
   * When the link stopped serving reads: set when the session is ended or archived, null while it runs (no time
   * limit since 16/10/2026). Feedback is still taken for 12 h after it, for phones that were offline.
   */
  expiresAt: integer("expires_at"),
  /** Revoked by hand: refused at once, reads and writes. */
  revokedAt: integer("revoked_at"),
})
