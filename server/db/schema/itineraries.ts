import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
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
})

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
  issuedAt: integer("issued_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
})
