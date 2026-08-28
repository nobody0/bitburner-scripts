import type { NS } from "@ns";
import type { FeatureOverrides } from "../shared/features/profile.ts";
import { runController } from "./lib/controller.ts";
import { errorDetails, isScriptDeath } from "./lib/errors.ts";
import { makeSink, type TelemetrySink } from "./lib/telemetry-sink.ts";
import { initTelemetry, type Telemetry } from "./lib/telemetry.ts";
import { resolveRunIdentity } from "./lib/run-identity.ts";
import { resetLaunchState } from "./lib/launch-shared.ts";
import { nsMainGlobal } from "./lib/ns-proxy-shared.ts";
import { initProxies } from "./lib/proxies.ts";
import { bootstrapResidentHost } from "./lib/bootstrap.ts";

/** ScriptDeath is the normal result of a sync kill or reset teardown. */
export function shouldReportCrash(error: unknown): boolean {
  return !isScriptDeath(error);
}

/** The real game controller. start.js is only the autoexec/sync wrapper and
 * always supplies this process with a 3.2 GB launch override. */
export async function main(ns: NS, featureOverrides?: FeatureOverrides): Promise<void> {
  ns.disableLog("ALL");
  if (ns.args.length !== 0) throw new Error(`main.js accepts no arguments: ${JSON.stringify(ns.args)}`);

  resetLaunchState();
  nsMainGlobal().nsMain = ns;
  initProxies();

  const residentHost = await bootstrapResidentHost();
  if (residentHost === undefined) {
    ns.tprint("WARNING: could not secure foodnstuff or n00dles; ns residents stay on home");
  }
  const identity = await resolveRunIdentity(ns);

  let tel: Telemetry | undefined;
  let sink: TelemetrySink | undefined;
  try {
    TELEMETRY: if (__TELEMETRY__) {
      tel = initTelemetry(ns, "main.js", identity);
      sink = makeSink(tel);
    }
    await runController(ns, tel, sink, featureOverrides);
  } catch (error) {
    TELEMETRY: if (shouldReportCrash(error) && __TELEMETRY__) {
      try {
        tel!.event("start.crash", { build: __BUILD_ID__, error: errorDetails(error) });
        tel!.flush();
      } catch {
        // Reporting must never replace the original controller failure.
      }
    }
    throw error;
  }
}
