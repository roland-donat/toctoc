// Potential and door-time model of KTD8, editable without code (Paramètres screen, U7).
// Stored as one JSON value under PARAMETERS_KEY in the settings table.
import { z } from "zod"
import type { Db } from "../db/index.ts"
import { getSetting, setSetting } from "../db/settings.ts"

export const PARAMETERS_KEY = "priority_parameters"

export interface PriorityParameters {
  weights: {
    /** Per elector at "abstention forte". */
    fort: number
    /** Per elector at "abstention moyenne". */
    moyen: number
    /** Address without any registered voter. */
    sansInscrit: number
    /** Address whose latest feedback asks to come back or to accompany someone. */
    aRevoir: number
    /** Per elector absent from the March 2026 list (new 2027 registrant): a target, decided on 13/10/2026. */
    nouvelInscrit: number
  }
  /** Upper bound of the summed weights (VROOM priorities range 0 to 100). */
  cap: number
  /** A visit younger than this many days makes the address "visitée récemment". */
  recentDays: number
  /** Priority of a recently visited address that is not "à revoir". */
  recentPriority: number
  /** Maximum share of "sans inscrit" doors in one itinerary (0 to 1). */
  noVoterShareCap: number
  doorTime: {
    baseMinutes: number
    /** Per dwelling or registered voter beyond the first. */
    perExtraMinutes: number
    capMinutes: number
  }
}

export const DEFAULT_PARAMETERS: PriorityParameters = {
  weights: { fort: 40, moyen: 20, sansInscrit: 70, aRevoir: 30, nouvelInscrit: 40 },
  cap: 100,
  recentDays: 30,
  recentPriority: 10,
  noVoterShareCap: 0.3,
  doorTime: { baseMinutes: 3, perExtraMinutes: 1, capMinutes: 15 },
}

const weight = z.number().int().min(0).max(1000)
const minutes = z.number().min(0).max(120)

export const parametersSchema = z.object({
  weights: z.object({ fort: weight, moyen: weight, sansInscrit: weight, aRevoir: weight, nouvelInscrit: weight }),
  cap: z.number().int().min(1).max(100),
  recentDays: z.number().int().min(0).max(365),
  recentPriority: z.number().int().min(0).max(100),
  noVoterShareCap: z.number().min(0).max(1),
  doorTime: z.object({ baseMinutes: minutes, perExtraMinutes: minutes, capMinutes: minutes }),
})

/** Stored parameters, falling back to the defaults field by field (a value saved before a new field existed stays valid). */
export function loadParameters(db: Db): PriorityParameters {
  const stored = getSetting<unknown>(db, PARAMETERS_KEY, null)
  if (stored === null || typeof stored !== "object") return DEFAULT_PARAMETERS
  const s = stored as Partial<Record<keyof PriorityParameters, unknown>>
  const merged = {
    ...DEFAULT_PARAMETERS,
    ...s,
    weights: { ...DEFAULT_PARAMETERS.weights, ...(typeof s.weights === "object" ? s.weights : {}) },
    doorTime: { ...DEFAULT_PARAMETERS.doorTime, ...(typeof s.doorTime === "object" ? s.doorTime : {}) },
  }
  const parsed = parametersSchema.safeParse(merged)
  return parsed.success ? parsed.data : DEFAULT_PARAMETERS
}

/** Validates then stores the parameters; throws a ZodError on an invalid value. */
export function saveParameters(db: Db, params: PriorityParameters): PriorityParameters {
  const valid = parametersSchema.parse(params)
  setSetting(db, PARAMETERS_KEY, valid)
  return valid
}
