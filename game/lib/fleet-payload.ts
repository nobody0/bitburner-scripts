import { workerScript } from "./dispatch-driver.ts";
import { dodgeStubScript } from "./dodge.ts";
import { goDodgeStubScript } from "./go-dodge.ts";

/** Helper scripts copied to every rooted RAM host. */
export function fleetPayloadScripts(): string[] {
  return [workerScript(), dodgeStubScript(), goDodgeStubScript()];
}
