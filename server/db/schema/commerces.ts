import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { addresses } from "./addresses.ts"

/**
 * Shop fronts of the commune read from OpenStreetMap (public data, no personal data): a shop, a commercial amenity,
 * an office or a hotel. An address with no voter where one stands is a "commerce probable", not a door to knock.
 */
export const commerces = sqliteTable(
  "commerces",
  {
    /** OpenStreetMap object, e.g. "n123" (node), "w456" (way). */
    id: text("id").primaryKey(),
    /** Main tag, e.g. "shop=bakery", "amenity=pharmacy". */
    kind: text("kind").notNull(),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    /** BAN number it stands at, null when none was close enough. */
    addressId: text("address_id").references(() => addresses.id),
  },
  (t) => [index("commerces_address_idx").on(t.addressId)],
)
