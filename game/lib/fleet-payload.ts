import { workerScript } from "./dispatch-driver.ts";
import { dodgeStubScript } from "./dodge.ts";

/** Stable helper scripts copied to every rooted RAM host. One stub file covers
 * both dodge lanes; the launch descriptor identifies the lane. */
export function fleetPayloadScripts(): string[] {
  return [workerScript(), dodgeStubScript()];
}
