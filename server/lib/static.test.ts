import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { afterAll, describe, expect, it } from "vitest"
import { serveSpa } from "./static.ts"

const dist = mkdtempSync(join(tmpdir(), "toctoc-static-"))
mkdirSync(join(dist, "assets"))
writeFileSync(join(dist, "index.html"), "<!doctype html>")
writeFileSync(join(dist, "assets", "index-abc123.js"), "")
writeFileSync(join(dist, "terrain.webmanifest"), "{}")
writeFileSync(join(dist, "icon-192.png"), "")
const app = new Hono()
serveSpa(app, dist)
afterAll(() => rmSync(dist, { recursive: true, force: true }))

describe("serveSpa", () => {
  it("caches the content-named assets for good", async () => {
    const res = await app.request("/assets/index-abc123.js")
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  })

  it("revalidates the files that keep their name across versions", async () => {
    for (const path of ["/terrain.webmanifest", "/icon-192.png", "/"]) {
      const res = await app.request(path)
      expect(res.headers.get("cache-control"), path).toBe("no-cache")
    }
  })

  it("serves the manifest with its media type", async () => {
    const res = await app.request("/terrain.webmanifest")
    expect(res.headers.get("content-type")).toBe("application/manifest+json")
  })

  it("falls back to index.html for a client route", async () => {
    const res = await app.request("/terrain")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("<!doctype html>")
  })
})
