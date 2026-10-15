import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import { createTestContext } from "../../tests/helpers.ts"

function appWithDist() {
  const root = mkdtempSync(join(tmpdir(), "toctoc-dist-"))
  const dist = join(root, "dist")
  mkdirSync(join(dist, "assets"), { recursive: true })
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>")
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)")
  writeFileSync(join(root, "secret.txt"), "outside the build")
  const { ctx } = createTestContext()
  return createApp(ctx, { distDir: dist })
}

describe("HTTP shell", () => {
  it("answers unknown API routes with a JSON 404, not the SPA page", async () => {
    // Under /api/auth/ the session check does not apply, so the 404 handler is reached anonymously.
    const res = await appWithDist().request("/api/auth/inconnu")
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ error: "not_found" })
  })

  it("marks API responses no-store and no-referrer", async () => {
    const res = await appWithDist().request("/api/health")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'")
  })

  it("serves built assets and falls back to index.html for client routes", async () => {
    const app = appWithDist()
    expect(await (await app.request("/assets/app.js")).text()).toBe("console.log(1)")
    const page = await app.request("/carte")
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("id=root")
  })

  it("never serves a file outside the build directory", async () => {
    const app = appWithDist()
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt"]) {
      const res = await app.request(path)
      expect(await res.text()).not.toContain("outside the build")
    }
  })
})
