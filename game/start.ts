import type { NS } from "@ns";
import type { FeatureOverrides } from "../shared/features/profile.ts";
import { runController } from "./lib/controller.ts";
import { errorDetails, isScriptDeath } from "./lib/errors.ts";
import { gameGlobal } from "./lib/globals.ts";
import { makeSink, type TelemetrySink } from "./lib/telemetry-sink.ts";
import { initTelemetry, type Telemetry } from "./lib/telemetry.ts";
import { resolveRunIdentity } from "./lib/run-identity.ts";

export type StartMode = "cold" | "handoff";

/** The only supported invocation forms.
 *
 * Empty args are load/reset callbacks: Bitburner always invokes the exported
 * `main` function, and its singularity reset callbacks cannot supply args.
 * A deployment handoff names the build it expects to have launched so an
 * interleaved/stale push cannot silently run the wrong stable `start.js`. */
export function parseStartMode(args: readonly unknown[], buildId: string): StartMode {
  if (args.length === 0) return "cold";
  if (args.length === 2 && args[0] === "handoff" && args[1] === buildId) return "handoff";
  throw new Error(
    `invalid start.js args ${JSON.stringify(args)}; expected no args or ["handoff", "${buildId}"]`,
  );
}

/** Claim the controller epoch, and report what was claimed.
 *
 * The epoch is the whole of the "only one controller" mechanism. Nothing kills
 * the outgoing loop: the incoming instance bumps this counter in the shared
 * page realm, and the older loop notices its own epoch is stale on its next
 * pass and returns. So the ONLY property that matters is that a later claim is
 * always strictly greater than every earlier one, including across the window
 * where two start.js instances briefly overlap during a build handoff.
 *
 * Split out of `main` so that property is testable without an ns mock: the
 * realm object is the entire input.
 * Source (scripts are imported modules in the page realm, so the counter
 * survives a handoff but not a page reload): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptJSEvaluator.ts#L208-L223 */
export function claimControllerEpoch(realm: { controllerEpoch?: number }): number {
  // A fresh realm (cold boot after a page reload) has no counter and claims 1;
  // `?? 0` rather than `|| 0` so a corrupt 0 still advances rather than sticking.
  const epoch = (realm.controllerEpoch ?? 0) + 1;
  realm.controllerEpoch = epoch;
  return epoch;
}

/** Whether a controller failure is worth reporting.
 *
 * ScriptDeath is Bitburner's normal cancellation marker -- a manual kill, a
 * reset teardown, or an interrupted delaying ns call -- and it arrives on every
 * clean shutdown. Reporting it would bury real crashes in routine noise, and
 * swallowing a real crash would be worse, so this is the one decision the
 * catch block makes and it is worth pinning on its own.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/killWorkerScript.ts#L63-L91 */
export function shouldReportCrash(error: unknown): boolean {
  return !isScriptDeath(error);
}

/** Single entry point for both boot situations (autoexec: `start.js`):
 *  - COLD: the game just loaded. The JS realm is fresh (gameGlobal empty) and
 *    with "Exclude Running Scripts from Save" nothing else survived — full
 *    sweep: scan, root, redeploy the whole fleet.
 *    Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/BaseServer.ts#L296-L311
 *  - HANDOFF: a newer build was pushed; the previous instance exec'd us with
 *    ("handoff", buildId) and exited. The realm and the remote starters
 *    survive — inherit the game-state store and keep farming.
 *    Source (scripts are imported modules in the page realm): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptJSEvaluator.ts#L208-L223
 *  Either way the controller-epoch guard makes the newest instance the only
 *  controller: an older loop sees the bumped epoch and exits — no kills.
 *
 * This file is the startup script and nothing else; the loop lives in
 * lib/controller.ts. Both land in one bundle, so the split costs no RAM.
 *
 * Fresh-game RAM budget (8 GB home): start.js 3.6 GB static + transient
 * dodge stub <= 4.1 GB = 7.7 GB peak; handoff overlap 2 x 3.6 = 7.2 GB. Fits.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L10-L29
 */
export async function main(ns: NS, featureOverrides?: FeatureOverrides): Promise<void> {
  // Must be the first statement and a numeric literal: v3.0.1's static RAM
  // analyser recognises this syntax before launch. Dynamic RAM is independently
  // pinned below by tests against the controller's direct ns call surface.
  ns.ramOverride(3.6);
  // HGW is deliberately high-frequency. Avoid constructing and retaining a
  // Netscript log entry for every scheduler getter and exec call.
  ns.disableLog("ALL");
  const mode = parseStartMode(ns.args, __BUILD_ID__);
  const epoch = claimControllerEpoch(gameGlobal);
  const identity = await resolveRunIdentity(ns, mode === "handoff");

  // The telemetry sink is the ONLY thing this flag decides. Acquisition, the
  // game-state store and every feature driver are compiled into both builds:
  // a --perf build must play the same game, only quieter.
  let tel: Telemetry | undefined;
  let sink: TelemetrySink | undefined;
  try {
    TELEMETRY: if (__TELEMETRY__) {
      tel = initTelemetry(ns, "start.js", identity);
      sink = makeSink(tel);
    }
    await runController(ns, tel, sink, mode, epoch, featureOverrides);
  } catch (error) {
    TELEMETRY: if (shouldReportCrash(error) && __TELEMETRY__) {
      try {
        tel!.event("start.crash", { build: __BUILD_ID__, mode, epoch, error: errorDetails(error) });
        tel!.flush();
      } catch {
        // Reporting must never replace the original controller failure.
      }
    }
    throw error;
  }
}
