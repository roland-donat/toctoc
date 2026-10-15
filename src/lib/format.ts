import { ApiError } from "./api-client"

// French number and date formatting shared by the screens, and the message of an API error.

export const numberFormat = new Intl.NumberFormat("fr-FR")
export const percentFormat = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 })

/** Long date and time in the browser's time zone (Imports screens). */
export const localDateTimeFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" })
/** Long date in Paris. */
export const parisLongDateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" })
/** Medium date and time in Paris. */
export const parisDateTimeFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" })

const PARIS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" })

/** Calendar date in Paris (YYYY-MM-DD) of an instant. */
export function parisCalendarDate(instant: Date): string {
  return PARIS_DAY.format(instant)
}

/** Today in Paris, ISO. */
export function parisToday(): string {
  return parisCalendarDate(new Date())
}

/** French message of an API error from its code, a generic one for an unlisted code or a non-API failure. */
export function errorLabel(err: unknown, labels: Readonly<Record<string, string>>): string {
  if (err instanceof ApiError) return labels[err.code] ?? `Erreur du serveur (${err.status}).`
  return "Erreur inattendue."
}
