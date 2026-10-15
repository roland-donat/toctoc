/** Trims, strips control and bidirectional characters (VOTER sanitizeField), null when empty. */
export function sanitizeField(value: string | undefined, maxLen = 200): string | null {
  if (value === undefined) return null
  const cleaned = value
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
    .trim()
    .slice(0, maxLen)
  return cleaned === "" ? null : cleaned
}
