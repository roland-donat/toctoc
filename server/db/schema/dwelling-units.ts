import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { addresses } from "./addresses.ts"

/**
 * Dwellings ("logements") of an address, kept from one visit to the next (15/10/2026): each feedback of a building
 * can point to one, so the doors left to knock and the households met stay known. The label locates the dwelling
 * (building, floor, door) and is meant to carry no name; it is still cleared by the purge.
 */
export const dwellingUnits = sqliteTable(
  "dwelling_units",
  {
    /** Created on the phone (offline) or on the server; a unit of the electoral list has a derived id. */
    id: text("id").primaryKey(),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id),
    label: text("label").notNull(),
    /** Normalized label, one unit per label and address. */
    labelKey: text("label_key").notNull(),
    source: text("source", { enum: ["liste", "terrain", "admin"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    /** Set when the administrator removes a unit; kept for the feedback that points to it. */
    retiredAt: integer("retired_at"),
  },
  (t) => [
    uniqueIndex("dwelling_units_address_label_idx").on(t.addressId, t.labelKey),
    index("dwelling_units_address_idx").on(t.addressId),
  ],
)
