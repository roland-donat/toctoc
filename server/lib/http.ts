/** Request body as JSON, or undefined when it is missing or malformed (the caller's schema then rejects it). */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}
