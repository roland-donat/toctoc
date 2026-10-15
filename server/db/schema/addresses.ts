import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Address reference (KTD3). `kind = "number"` rows come from the BAN and keep the BAN id;
 * `kind = "street"` rows stand for a street or lieu-dit as a whole, for electors listed
 * without a house number (plan Assumptions), with id `street:<street_key>`.
 */
export const addresses = sqliteTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["number", "street"] }).notNull(),
    number: integer("number"),
    rep: text("rep"),
    streetName: text("street_name").notNull(),
    /** Normalized street (or lieu-dit) name, shared by every address of that street. */
    streetKey: text("street_key").notNull(),
    lieuDit: text("lieu_dit"),
    postalCode: text("postal_code"),
    inseeCode: text("insee_code").notNull(),
    /** Normalized number + repetition + street, used for local matching. */
    matchKey: text("match_key").notNull(),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    /** Number of dwellings entered by the administrator (R9), when known. */
    dwellings: integer("dwellings"),
    /**
     * Set when the administrator says a "commerce probable" is lived in: the address is "sans inscrit" again
     * whatever OpenStreetMap lists there.
     */
    commerceDismissedAt: integer("commerce_dismissed_at"),
    /** Set when a reload of the BAN no longer lists this address; never deleted (feedback may point to it). */
    retiredAt: integer("retired_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("addresses_match_key_idx").on(t.matchKey), index("addresses_street_key_idx").on(t.streetKey)],
)
