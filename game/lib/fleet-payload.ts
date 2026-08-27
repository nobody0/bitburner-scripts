import { workerScript } from "./dispatch-driver.ts";
import { nsResidentScript } from "./ns-proxy.ts";

/** Stable helper scripts copied to every rooted RAM host: the HGW worker and
 * the ns resident that every proxied call runs on. */
export function fleetPayloadScripts(): string[] {
  return [workerScript(), nsResidentScript()];
}
