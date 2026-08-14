import type { NS } from "@ns";
import { workerGlobals, type WorkerJob } from "../lib/worker-shared.ts";
import { signalWake } from "../lib/wake.ts";
import { MINIMUM_WORKER_PRECISION_MS } from "../../shared/strategy/jit.ts";

/** Puppet worker: one script file for all modes, launched with
 * `{ threads, temporary: true, ramOverride: perThreadCost }` so its RAM bill
 * matches exactly the op it performs. It holds no logic — the dispatcher owns
 * the descriptor and the accounting.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L275-L310 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L434-L474
 *
 * Three modes, selected by the descriptor:
 * - one-shot (default): perform one op, exit. Used for prep waves and shotgun.
 * - "serve": a POOLED worker with fixed kind and threads that loops over jobs
 *   from the realm mailbox, parked between jobs on a `worker_wake` resolver
 *   raced against an idle timeout. One process serves many batch ops, which
 *   collapses exec churn — the browser JavaScript-engine cost of a fresh
 *   WorkerScript + ns object + RAM recalc per op, ~5/sec at depth, forever.
 * - "share": loop over fixed 10-second share slices until the cooperative
 *   stop mailbox wins the race, then report workerExit.
 *
 * atExit is registered BEFORE any await, so normal completion, a kill/reset
 * teardown, or an error reports the in-flight op AND (for serve/share) the worker's
 * own exit, freeing the reservation. A hard browser reload simply discards the
 * whole realm, including both sides of this mailbox. The idle race uses the
 * REALM timer, which is free of Netscript RAM cost and virtualized identically
 * by the simulator.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L143-L159 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/killWorkerScript.ts#L63-L91 */

const IDLE_MS = 5_000;

function wakeDispatcher(kind: "hack" | "grow" | "weaken" | "share"): void {
  const g = workerGlobals();
  if (kind !== "weaken") {
    signalWake(g);
    return;
  }
  if (g.dispatch_weaken_timer !== undefined) clearTimeout(g.dispatch_weaken_timer);
  g.dispatch_weaken_timer = setTimeout(() => {
    g.dispatch_weaken_timer = undefined;
    signalWake(g);
  }, MINIMUM_WORKER_PRECISION_MS);
}

export async function main(ns: NS): Promise<void> {
  // A worker can execute thousands of HGW calls over its life; telemetry, not
  // Netscript's per-call log, is the automation's observable record.
  ns.disableLog("ALL");
  const id = Number(ns.args[0]);
  const g = workerGlobals();
  const info = g.worker_info?.get(id);
  // No descriptor: the realm was reset (game reload) — exit quietly, the
  // controller will rebuild its ledger.
  if (!info) return;

  const options = (job: { additionalMsec?: number; delayUntil?: number; stock?: boolean }) => {
    // additionalMsec is added to the duration from the instant hack/grow/weaken
    // is actually invoked. Exec and module startup are asynchronous, so the
    // driver sends an absolute padding deadline and we remove launch skew here.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L537-L561
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L266-L286
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L342-L362
    const additionalMsec = job.delayUntil === undefined
      ? job.additionalMsec
      : Math.max(0, job.delayUntil - performance.now());
    return additionalMsec || job.stock
      ? {
          ...(additionalMsec ? { additionalMsec } : {}),
          ...(job.stock ? { stock: true } : {}),
        }
      : undefined;
  };
  const run = (target: string, opts?: { additionalMsec?: number; stock?: boolean }): Promise<number> => {
    if (info.kind === "hack") return ns.hack(target, opts);
    if (info.kind === "grow") return ns.grow(target, opts);
    return ns.weaken(target, opts);
  };

  if (info.mode === "share") {
    ns.atExit(() => {
      g.worker_info?.delete(id);
      g.worker_stop?.delete(id);
      g.worker_stop_requested?.delete(id);
      g.dispatch_done?.push({ opId: id, kind: "workerExit", target: "", threads: info.threads });
      wakeDispatcher("share");
    }, `share${id}`);
    for (;;) {
      if (g.worker_stop_requested?.delete(id)) return;
      const stopped = new Promise<boolean>((resolve) => {
        g.worker_stop?.set(id, () => resolve(true));
      });
      const shouldStop = await Promise.race([
        ns.share().then(() => false),
        stopped,
      ]);
      g.worker_stop?.delete(id);
      if (shouldStop || !g.worker_info?.has(id)) return;
    }
  }
  if (info.kind === "share") return;
  const hgwKind = info.kind;

  if (info.mode !== "serve") {
    let result: number | undefined;
    ns.atExit(() => {
      g.worker_info?.delete(id);
      g.dispatch_done?.push({ opId: id, kind: hgwKind, target: info.target, threads: info.threads, result });
      wakeDispatcher(hgwKind);
    }, `op${id}`);
    result = await run(info.target, options(info));
    return;
  }

  // Serve mode. `current` is the job whose op is in flight, so a kill mid-op
  // still reports that op (result undefined) before the workerExit.
  let current: WorkerJob | undefined;
  ns.atExit(() => {
    g.worker_info?.delete(id);
    g.worker_jobs?.delete(id);
    g.worker_wake?.delete(id);
    if (current) {
      g.dispatch_done?.push({ opId: current.opId, kind: hgwKind, target: current.target, threads: info.threads });
    }
    g.dispatch_done?.push({ opId: id, kind: "workerExit", target: "", threads: info.threads });
    wakeDispatcher(hgwKind);
  }, `worker${id}`);

  for (;;) {
    // The realm registry is the liveness authority: a kill (or reset) already
    // ran atExit and deleted the entry — a continuation that observes that
    // must fall through without touching the mailboxes again.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/killWorkerScript.ts#L63-L91
    if (!g.worker_info?.has(id)) return;
    const job = g.worker_jobs?.get(id)?.shift();
    if (!job) {
      const woken = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), IDLE_MS);
        g.worker_wake?.set(id, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      g.worker_wake?.delete(id);
      if (!woken) return; // idle timeout -> exit; atExit reports workerExit
      continue;
    }
    current = job;
    const result = await run(job.target, options(job));
    current = undefined;
    // A kill normally surfaces as the op rejecting (ScriptDeath), but if the
    // continuation somehow outlives the process teardown, atExit has already
    // reported this job — re-check liveness before reporting it again.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/killWorkerScript.ts#L63-L91
    if (!g.worker_info?.has(id)) return;
    g.dispatch_done?.push({ opId: job.opId, kind: hgwKind, target: job.target, threads: info.threads, result });
    wakeDispatcher(hgwKind);
  }
}
