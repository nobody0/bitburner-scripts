import type { NS } from "@ns";
import { versionedScript } from "../../shared/deployment.ts";
import { STUB_BASE_GB } from "../../shared/ram/placement.ts";
import { gameBuildId } from "./build-id.ts";
import { DodgeExecError } from "./dodge.ts";
import type { GoDodgeGlobalThis } from "./go-dodge-shared.ts";

const g = globalThis as GoDodgeGlobalThis;
const EXEC_RETRIES = 10;

export function goDodgeStubScript(): string {
  return versionedScript("lib/go-dodge-stub.js", gameBuildId());
}

/** Run one delayed Go call on its own worker lane. Only one Go turn may be in
 * flight, but ordinary dodges remain independent. */
export async function goDodge<T>(
  ns: NS,
  func: (stubNs: NS) => T | Promise<T>,
  budgetGb: number,
  host: string,
): Promise<T> {
  if (g.go_dodge_running) throw new Error("a Go turn is already running");

  let settle!: (result: unknown) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve as (result: unknown) => void;
    fail = reject;
  });
  g.go_dodge_func = func;
  g.go_dodge_cb = settle;
  g.go_dodge_reject = fail;
  g.go_dodge_running = promise;
  void promise.catch(() => {});

  try {
    const script = goDodgeStubScript();
    let pid = 0;
    for (let attempt = 0; attempt < EXEC_RETRIES && pid === 0; attempt++) {
      pid = ns.exec(script, host, { ramOverride: STUB_BASE_GB + budgetGb, temporary: true });
      if (pid === 0) await ns.asleep(0);
    }
    if (pid === 0) {
      const error = new DodgeExecError(
        `failed to exec ${script} on ${host} after ${EXEC_RETRIES} attempts`,
      );
      fail(error);
      throw error;
    }
    return await promise;
  } finally {
    // A prestige can let a successor controller claim the lane before this
    // killed worker's rejection continuation runs. Never erase its newer
    // rendezvous slots.
    if (g.go_dodge_running === promise) {
      g.go_dodge_func = undefined;
      g.go_dodge_cb = undefined;
      g.go_dodge_reject = undefined;
      g.go_dodge_running = undefined;
    }
    await Promise.resolve();
    await Promise.resolve();
  }
}
