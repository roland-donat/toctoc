import type { MiddlewareHandler } from "hono"

// Tiles come from the public OpenStreetMap servers (U7); everything else is same-origin.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const h = c.res.headers
    h.set("Content-Security-Policy", CONTENT_SECURITY_POLICY)
    h.set("Referrer-Policy", "no-referrer")
    h.set("X-Content-Type-Options", "nosniff")
    h.set("X-Frame-Options", "DENY")
    h.set("Cross-Origin-Opener-Policy", "same-origin")
    // The app uses none of these browser features; a compromised script could not either.
    h.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()")
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
      h.set("Cache-Control", "no-store")
    }
  }
}
