import type { Action, CompletionEvent, WorldView } from "../world.ts";
import { dispatch, initDispatch, releaseFailed, type DispatchMemory, type DispatchOptions } from "./dispatch.ts";
import type { TargetDirective } from "./directive.ts";

/** The HWGW farm planner: evaluator + dispatcher behind the driver-facing
 * interface. Pure — the sim and the game driver both call `plan` with the
 * completions they have absorbed since the last call and execute the returned
 * actions, reporting back any that failed to start. */

export interface FarmMemory {
  dispatch: DispatchMemory;
  lastDirective?: TargetDirective;
}

export interface FarmPlanResult {
  actions: Action[];
  memory: FarmMemory;
  directive: TargetDirective;
  switched?: { from?: string; to: string };
}

export function initFarm(): FarmMemory {
  return { dispatch: initDispatch() };
}

export function planFarm(
  view: WorldView,
  memory: FarmMemory,
  completions: CompletionEvent[],
  options?: DispatchOptions,
): FarmPlanResult {
  const result = dispatch(view, memory.dispatch, completions, options);
  memory.lastDirective = result.directive;
  return { actions: result.actions, memory, directive: result.directive, switched: result.switched };
}

/** Roll back reservations for actions the driver could not start. */
export function reportFailed(memory: FarmMemory, opIds: Iterable<number>): void {
  releaseFailed(memory.dispatch, opIds);
}
