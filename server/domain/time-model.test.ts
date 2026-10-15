import { describe, expect, it } from "vitest"
import { estimateDoorCount, noVoterQuota, timeline, WALK_ALLOWANCE_SECONDS } from "./time-model.ts"

// Fictional walking matrix (seconds): index 0 is the start point, 1 to 3 are doors.
const M = [
  [0, 100, 200, 300],
  [100, 0, 150, 250],
  [200, 150, 0, 120],
  [300, 250, 120, 0],
]

describe("timeline", () => {
  it("adds walking legs and time at doors, back to the start", () => {
    // Service: index 1 = 180 s, 2 = 240 s, 3 = 900 s.
    const service = [0, 180, 240, 900]
    const t = timeline([1, 2, 3], M, service)
    expect(t.walkFromPrevious).toEqual([100, 150, 120])
    // Arrivals: 100; 100 + 180 + 150 = 430; 430 + 240 + 120 = 790.
    expect(t.arrivals).toEqual([100, 430, 790])
    expect(t.returnWalkSeconds).toBe(300)
    expect(t.travelSeconds).toBe(100 + 150 + 120 + 300)
    expect(t.serviceSeconds).toBe(180 + 240 + 900)
    expect(t.totalSeconds).toBe(670 + 1320)
  })

  it("is empty for a loop without doors", () => {
    expect(timeline([], M, [0, 0, 0, 0])).toEqual({
      arrivals: [],
      walkFromPrevious: [],
      returnWalkSeconds: 0,
      travelSeconds: 0,
      serviceSeconds: 0,
      totalSeconds: 0,
    })
  })
})

describe("estimateDoorCount", () => {
  it("divides the session by the mean door time plus two minutes of walking, rounded down", () => {
    expect(WALK_ALLOWANCE_SECONDS).toBe(120)
    // 60 min, 4 min at each door: 3600 / (240 + 120) = 10.
    expect(estimateDoorCount(3600, 240)).toBe(10)
    // 90 min, 3 min: 5400 / 300 = 18.
    expect(estimateDoorCount(5400, 180)).toBe(18)
    // 60 min, 5 min 30: 3600 / 450 = 8.
    expect(estimateDoorCount(3600, 330)).toBe(8)
  })

  it("is at least one door", () => {
    expect(estimateDoorCount(3600, 4000)).toBe(1)
  })
})

describe("noVoterQuota", () => {
  it("allows 30 % of the estimated doors, rounded down", () => {
    expect(noVoterQuota(10, 0.3)).toBe(3)
    expect(noVoterQuota(18, 0.3)).toBe(5)
    expect(noVoterQuota(3, 0.3)).toBe(0)
  })
})
