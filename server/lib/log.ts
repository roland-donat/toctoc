// Server logs never carry personal data: only event names, routes and counts.

export function logInfo(event: string, details: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...details }))
}

/** Logs an error by class and stack frames only; the message may quote user data, so it is dropped. */
export function logError(event: string, err: unknown, details: Record<string, string | number> = {}): void {
  const name = err instanceof Error ? err.name : typeof err
  const frames =
    err instanceof Error && err.stack ? err.stack.split("\n").slice(1, 6).map((l) => l.trim()) : []
  console.error(JSON.stringify({ level: "error", event, error: name, frames, ...details }))
}
