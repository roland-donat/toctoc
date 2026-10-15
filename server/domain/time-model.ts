// Time model of a walking loop (KTD8): walking legs from the OSRM matrix plus time at each door. Pure.

/** Walking allowance per door used to estimate how many doors fit in a session (KTD8 no-voter cap). */
export const WALK_ALLOWANCE_SECONDS = 120

export interface Timeline {
  /** Seconds since the start of the session at which each door of the order is reached. */
  arrivals: number[]
  /** Walking seconds from the previous stop (the start point for the first door). */
  walkFromPrevious: number[]
  /** Walking seconds from the last door back to the start point. */
  returnWalkSeconds: number
  travelSeconds: number
  serviceSeconds: number
  /** Back at the start point, walking and time at doors included. */
  totalSeconds: number
}

/**
 * Times of a loop that leaves matrix index 0, visits `order` (matrix indexes) and comes back to index 0.
 * `service[i]` is the time spent at matrix index `i`.
 */
export function timeline(order: readonly number[], durations: readonly (readonly number[])[], service: readonly number[]): Timeline {
  const leg = (from: number, to: number): number => durations[from]?.[to] ?? 0
  const arrivals: number[] = []
  const walkFromPrevious: number[] = []
  let clock = 0
  let travel = 0
  let serviceTotal = 0
  let previous = 0
  for (const index of order) {
    const walk = leg(previous, index)
    clock += walk
    travel += walk
    walkFromPrevious.push(walk)
    arrivals.push(clock)
    const atDoor = service[index] ?? 0
    clock += atDoor
    serviceTotal += atDoor
    previous = index
  }
  const returnWalkSeconds = order.length === 0 ? 0 : leg(previous, 0)
  travel += returnWalkSeconds
  return {
    arrivals,
    walkFromPrevious,
    returnWalkSeconds,
    travelSeconds: travel,
    serviceSeconds: serviceTotal,
    totalSeconds: travel + serviceTotal,
  }
}

/** Doors a session can hold: duration / (mean time at a door + walking allowance), rounded down, at least 1. */
export function estimateDoorCount(durationSeconds: number, meanServiceSeconds: number): number {
  return Math.max(1, Math.floor(durationSeconds / (meanServiceSeconds + WALK_ALLOWANCE_SECONDS)))
}

/** Highest number of "sans inscrit" doors allowed among `doorCount` doors (KTD8), rounded down. */
export function noVoterQuota(doorCount: number, shareCap: number): number {
  return Math.floor(doorCount * shareCap + 1e-9)
}
