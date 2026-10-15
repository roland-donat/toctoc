// Single solver interface of the route generator (KTD2): chooses which doors fit in the session and orders them.
// The route builder (U11) only talks to this interface, so the solver can change without touching the selection
// rules (priorities, no-voter cap) applied around it.
import {
  solveWithVroom,
  type RoutingClientOptions,
  type RoutingConfig,
  type RoutingProblem,
  type RoutingSolution,
} from "./routing-client.ts"

export interface DoorSolver {
  readonly name: string
  /**
   * Keeps the jobs that fit in `maxDurationSeconds` (walking and time at doors, back to index 0), favouring the
   * higher priorities, and orders them. Throws RoutingUnavailableError when the underlying service is down.
   */
  solve(problem: RoutingProblem): Promise<RoutingSolution>
}

/** VROOM on the OSRM foot matrix (KTD1). */
export function vroomSolver(config: RoutingConfig, opts: RoutingClientOptions = {}): DoorSolver {
  return {
    name: "vroom",
    solve: (problem) => solveWithVroom(config, problem, opts),
  }
}
