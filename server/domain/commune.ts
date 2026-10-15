/**
 * The commune a TOCTOC server covers: one per server, set by `commune_insee` (TOCTOC_COMMUNE_INSEE). Its INSEE code
 * is not its postal code: Clichy-sous-Bois is 93014, postal code 93390.
 */
export const INSEE_CODE_PATTERN = /^(\d{5}|2[AB]\d{3})$/

/** Department of a commune, as the BAN names its departmental files: 2 characters, 3 overseas (971 to 976). */
export function departmentOf(insee: string): string {
  return insee.startsWith("97") ? insee.slice(0, 3) : insee.slice(0, 2)
}
