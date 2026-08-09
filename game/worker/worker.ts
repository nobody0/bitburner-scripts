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

  // `stock: true` makes the op move the target organization's share price:
  // hack pushes the second-order forecast DOWN, grow pushes it UP. The
  // dispatcher sets it on exactly one side of a batch (grow for a long, hack for
  // a short) because flagging both would cancel out. It costs no RAM and no
  // time, so it is passed through rather than gated on anything here.
  const options =
    info.additionalMsec || info.stock
      ? {
          ...(info.additionalMsec ? { additionalMsec: info.additionalMsec } : {}),
          ...(info.stock ? { stock: true } : {}),
        }
      : undefined;
  if (info.kind === "hack") result = await ns.hack(info.target, options);
  else if (info.kind === "grow") result = await ns.grow(info.target, options);
  else result = await ns.weaken(info.target, options);
}
