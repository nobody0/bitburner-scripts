import type { NS } from "@ns";
import { runController } from "./lib/controller.ts";
import { errorDetails, isScriptDeath } from "./lib/errors.ts";
import { gameGlobal } from "./lib/globals.ts";
import { makeSink, type TelemetrySink } from "./lib/telemetry-sink.ts";
import { initTelemetry, type Telemetry } from "./lib/telemetry.ts";

/** Single entry point for both boot situations (autoexec: `start.js main`):
 *  - COLD: the game just loaded. The JS realm is fresh (gameGlobal empty) and
 *    with "Exclude Running Scripts from Save" nothing else survived — full
 *    sweep: scan, root, redeploy the whole fleet.
 *  - HANDOFF: a newer build was pushed; the previous instance exec'd us with
 *    ("handoff", buildId) and exited. The realm and the remote starters
 *    survive — inherit the game-state store and keep farming.
 *  Either way the controller-epoch guard makes the newest instance the only
 *  controller: an older loop sees the bumped epoch and exits — no kills.
 *
 * This file is the startup script and nothing else; the loop lives in
 * lib/controller.ts. Both land in one bundle, so the split costs no RAM.
 *
 * Fresh-game RAM budget (8 GB home): start.js ~3.4 GB static + transient
 * dodge stub <= 4.1 GB = 7.5 GB peak; handoff overlap 2 x 3.4 = 6.8 GB. Fits.
 */
export async function main(ns: NS): Promise<void> {
  const mode = ns.args[0] === "handoff" ? "handoff" : "cold";
  const epoch = (gameGlobal.controllerEpoch ?? 0) + 1;
  gameGlobal.controllerEpoch = epoch;

  // The telemetry sink is the ONLY thing this flag decides. Acquisition, the
  // game-state store and every feature driver are compiled into both builds:
  // a --perf build must play the same game, only quieter.
  let tel: Telemetry | undefined;
  let sink: TelemetrySink | undefined;
  try {
    TELEMETRY: if (__TELEMETRY__) {
      tel = initTelemetry(ns, "start.js");
      sink = makeSink(tel);
    }
    await runController(ns, tel, sink, mode, epoch);
  } catch (error) {
    // ScriptDeath is Bitburner's normal cancellation marker (manual kill,
    // reload, or an interrupted ns call), not a controller crash.
    TELEMETRY: if (!isScriptDeath(error) && __TELEMETRY__) {
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
