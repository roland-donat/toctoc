import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./server/db/schema/index.ts",
  out: "./server/db/migrations",
  dialect: "sqlite",
})
