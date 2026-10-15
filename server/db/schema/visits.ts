import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { addresses } from "./addresses.ts"
import { dwellingUnits } from "./dwelling-units.ts"

/** Visit feedback ("retour"), always attached to an address, never to an elector (KTD12). */
export const visits = sqliteTable(
  "visits",
  {
    /** Generated on the phone or in the admin UI, so a resend never duplicates (KTD10). */
    id: text("id").primaryKey(),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id),
    /** Free text: apartment, floor, name on the mailbox (R17). Treated as nominative (KTD7). */
    dwelling: text("dwelling"),
    /** Dwelling of the building the feedback is about, when the volunteer picked or added one. */
    dwellingUnitId: text("dwelling_unit_id").references(() => dwellingUnits.id),
    /** The household met is not on the electoral list: a registration to go and get. */
    nonRegistered: integer("non_registered", { mode: "boolean" }).notNull().default(false),
    /** ISO date of the visit itself, distinct from the entry time. */
    visitDate: text("visit_date").notNull(),
    recordedAt: integer("recorded_at").notNull(),
    source: text("source", { enum: ["lien", "feuille", "admin"] }).notNull(),
    itineraryId: text("itinerary_id"),
    contact: text("contact", { enum: ["obtenu", "absent"] }),
    contactQuality: text("contact_quality", { enum: ["chaleureux", "poli", "ferme"] }),
    toAccompany: integer("to_accompany", { mode: "boolean" }).notNull().default(false),
    /** Work-list status for "à accompagner" (U8). */
    accompanyDone: integer("accompany_done", { mode: "boolean" }).notNull().default(false),
    toRevisit: integer("to_revisit", { mode: "boolean" }).notNull().default(false),
    qualification: text("qualification", {
      enum: ["non_habitation", "logement_vide", "residence_secondaire", "annulation"],
    }),
    /** A qualification on one dwelling does not exclude the whole building (U6). */
    qualificationScope: text("qualification_scope", { enum: ["logement", "immeuble"] }),
    remarks: text("remarks"),
    /** Last correction, by the administrator or from the field link (ms since epoch), null when the feedback is as entered. */
    correctedAt: integer("corrected_at"),
  },
  (t) => [index("visits_address_idx").on(t.addressId), index("visits_date_idx").on(t.visitDate)],
)
