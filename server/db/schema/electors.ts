import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { addresses } from "./addresses.ts"

/** One row per file imported (electoral list or emargement). */
export const imports = sqliteTable("imports", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["rep", "emargement", "ban", "commerces"] }).notNull(),
  importedAt: integer("imported_at").notNull(),
  rowCount: integer("row_count").notNull(),
  /** For `rep`: the list currently in force (latest import). */
  isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
  /**
   * For `emargement`: the REP import its rows were matched against (the March 2026 list). An elector absent
   * from that list is a new registrant ("nouvel inscrit"), not "inconnu" (KTD13).
   */
  referenceImportId: text("reference_import_id"),
})

/** Stable elector identity across yearly lists (KTD12): normalized birth name, first names, birth date. */
export const electors = sqliteTable("electors", {
  id: text("id").primaryKey(),
  identityKey: text("identity_key").notNull().unique(),
  birthName: text("birth_name").notNull(),
  usageName: text("usage_name"),
  firstNames: text("first_names").notNull(),
  sex: text("sex", { enum: ["F", "M"] }),
  /** ISO date, null when the file carried an unreadable date. */
  birthDate: text("birth_date"),
  birthCommuneCode: text("birth_commune_code"),
  birthCommune: text("birth_commune"),
  birthDepartment: text("birth_department"),
  birthCountry: text("birth_country"),
  nationality: text("nationality"),
  createdAt: integer("created_at").notNull(),
})

/** Presence of an elector on one imported list; the previous lists stay queryable. */
export const registrations = sqliteTable(
  "registrations",
  {
    id: text("id").primaryKey(),
    electorId: text("elector_id")
      .notNull()
      .references(() => electors.id),
    importId: text("import_id")
      .notNull()
      .references(() => imports.id),
    listType: text("list_type", { enum: ["principale", "complementaire_ue", "complementaire_municipale"] }).notNull(),
    bureau: text("bureau").notNull(),
    orderNumber: integer("order_number"),
    /** Null while the address waits in the manual matching queue. */
    addressId: text("address_id").references(() => addresses.id),
    matchStatus: text("match_status", { enum: ["ban", "fallback", "street", "manual", "pending"] }).notNull(),
    /** BAN id proposed by the Géoplateforme fallback and refused by the KTD3 checks, shown in the queue. */
    fallbackProposalId: text("fallback_proposal_id"),
    rawNumber: text("raw_number"),
    rawStreet: text("raw_street"),
    rawComplement1: text("raw_complement1"),
    rawComplement2: text("raw_complement2"),
    rawLieuDit: text("raw_lieu_dit"),
    rawPostalCode: text("raw_postal_code"),
  },
  (t) => [
    uniqueIndex("registrations_import_elector_list_idx").on(t.importId, t.electorId, t.listType),
    index("registrations_address_idx").on(t.addressId),
    index("registrations_bureau_order_idx").on(t.bureau, t.orderNumber),
  ],
)

/** Frozen voting history per elector (KTD12), one row per election round. */
export const voteHistory = sqliteTable(
  "vote_history",
  {
    id: text("id").primaryKey(),
    electorId: text("elector_id")
      .notNull()
      .references(() => electors.id),
    election: text("election").notNull(),
    round: integer("round").notNull(),
    value: text("value", { enum: ["oui", "non", "illisible"] }).notNull(),
    /** Indicative only: proxy annotations vary between registers (R11). */
    proxy: text("proxy"),
    importId: text("import_id").references(() => imports.id),
  },
  (t) => [uniqueIndex("vote_history_elector_round_idx").on(t.electorId, t.election, t.round)],
)

/** Rows an import could not apply on its own (KTD13): resolved from the Exceptions screen (U5). */
export const importExceptions = sqliteTable("import_exceptions", {
  id: text("id").primaryKey(),
  importId: text("import_id")
    .notNull()
    .references(() => imports.id),
  kind: text("kind", { enum: ["name_mismatch", "discordant_duplicate", "not_found"] }).notNull(),
  bureau: text("bureau"),
  orderNumber: integer("order_number"),
  /** Candidate elector, when one exists. */
  electorId: text("elector_id").references(() => electors.id),
  /** JSON of the source row (nominative: removed by the purge). */
  payload: text("payload").notNull(),
  status: text("status", { enum: ["open", "accepted", "rejected"] }).notNull().default("open"),
  resolvedAt: integer("resolved_at"),
})
