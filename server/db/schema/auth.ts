import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Single administrator account (KTD5). Row id is always 1. */
export const adminAccount = sqliteTable("admin_account", {
  id: integer("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** Consecutive failed logins, used for progressive slowdown; reset on success. */
  failedLogins: integer("failed_logins").notNull().default(0),
  lastFailedAt: integer("last_failed_at"),
})

/** Server-side sessions; only the SHA-256 of the cookie value is stored. Times are epoch milliseconds. */
export const sessions = sqliteTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
})
