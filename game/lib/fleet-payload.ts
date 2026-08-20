import { workerScript } from "./dispatch-driver.ts";
import { dodgeStubScript } from "./dodge.ts";

/** Helper scripts copied to every rooted RAM host. One stub file covers both
 * dodge lanes; the lane is an exec argument. */
export function fleetPayloadScripts(): string[] {
  return [workerScript(), dodgeStubScript()];
}
