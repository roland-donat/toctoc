import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, isAbsolute, relative, resolve } from "node:path"
import type { Hono } from "hono"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webmanifest": "application/manifest+json",
}

/** Resolves a request path inside `root`, or null when it would escape it. */
function resolveInside(root: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (decoded.includes("\0")) return null
  const target = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`)
  const rel = relative(root, target)
  if (rel.startsWith("..") || isAbsolute(rel)) return null
  return target
}

/** Serves the built SPA from `distDir`, falling back to index.html for client-side routes. */
export function serveSpa<E extends object>(app: Hono<E>, distDir: string): void {
  const root = resolve(distDir)
  app.get("*", (c) => {
    const indexPath = resolve(root, "index.html")
    const urlPath = c.req.path === "/" ? "/index.html" : c.req.path
    const filePath = resolveInside(root, urlPath)
    if (filePath === null) return c.text("Not found", 404)
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath)
      return c.body(readFileSync(filePath), 200, {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        // Only the files Vite names after their content are immutable; the others (icons, manifest) keep their name
        // across versions and are revalidated.
        "Cache-Control": urlPath.startsWith("/assets/") && ext !== ".html" ? "public, max-age=31536000, immutable" : "no-cache",
      })
    }
    if (!existsSync(indexPath)) return c.text("Not found", 404)
    return c.body(readFileSync(indexPath), 200, {
      "Content-Type": MIME_TYPES[".html"],
      "Cache-Control": "no-cache",
    })
  })
}
