import { describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import { adminAccount } from "../db/schema/index.ts"
import { createSession, touchSession, verifyPassword } from "../lib/auth.ts"
import { applyNewPassword } from "./set-password.ts"

describe("set-password", () => {
  it("refuses a password shorter than 16 characters and writes nothing", async () => {
    const { ctx } = createTestContext()
    expect(await applyNewPassword(ctx.db, "quinze-caracter", ctx.now())).toBe("too_short")
    expect(ctx.db.select().from(adminAccount).all()).toHaveLength(0)
  })

  it("stores an argon2id hash of a 16-character password and invalidates existing sessions", async () => {
    const { ctx } = createTestContext()
    const token = createSession(ctx.db, ctx.now())
    expect(await applyNewPassword(ctx.db, "seize-caracteres", ctx.now())).toBe("ok")
    const [row] = ctx.db.select().from(adminAccount).all()
    expect(row?.passwordHash.startsWith("$argon2id$")).toBe(true)
    expect(await verifyPassword(row?.passwordHash ?? "", "seize-caracteres")).toBe(true)
    expect(touchSession(ctx.db, token, ctx.now())).toBe(false)
  })
})
