import type { NS } from "@ns";
import { workerGlobals } from "../lib/worker-shared.ts";

/** Puppet worker: one script file for all three ops, launched with
 * `{ threads, temporary: true, ramOverride: perThreadCost }` so its RAM bill
 * matches exactly the op it performs. It holds no logic — the dispatcher owns
 * the descriptor and the accounting.
 *
 * atExit is registered BEFORE awaiting the op, so a kill, a game reload, or an
 * error still reports the completion and frees the reservation. */
export async function main(ns: NS): Promise<void> {
  const opId = Number(ns.args[0]);
  const g = workerGlobals();
  const info = g.worker_info?.get(opId);
  // No descriptor: the realm was reset (game reload) — exit quietly, the
  // controller will rebuild its ledger.
  if (!info) return;

  let result: number | undefined;
  ns.atExit(() => {
    g.worker_info?.delete(opId);
    g.dispatch_done?.push({
      opId,
      kind: info.kind,
      target: info.target,
      threads: info.threads,
      result,
    });
    g.dispatch_wake?.();
  }, `op${opId}`);

  const options = info.additionalMsec ? { additionalMsec: info.additionalMsec } : undefined;
  if (info.kind === "hack") result = await ns.hack(info.target, options);
  else if (info.kind === "grow") result = await ns.grow(info.target, options);
  else result = await ns.weaken(info.target, options);
}
