import { workerScript } from "./dispatch-driver.ts";
import { dodgeStubScript, goDodgeStubScript } from "./dodge.ts";

/** Helper scripts copied to every rooted RAM host. */
export function fleetPayloadScripts(): string[] {
  return [workerScript(), dodgeStubScript(), goDodgeStubScript()];
}
