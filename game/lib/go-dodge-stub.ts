import type { NS } from "@ns";
import type { GoDodgeGlobalThis } from "./go-dodge-shared.ts";

/** Go worker entrypoint, isolated from the general dodge lane. */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const g = globalThis as GoDodgeGlobalThis;
  const reject = g.go_dodge_reject;
  if (!reject) return;
  const func = g.go_dodge_func;
  const cb = g.go_dodge_cb;
  if (!func || !cb) {
    reject(new Error("Go dodge stub started without a pending call"));
    return;
  }

  try {
    const result = func(ns);
    if (result instanceof Promise) {
      result.then(cb, reject);
      await result.catch(() => {});
      return;
    }
    cb(result);
  } catch (error) {
    reject(error instanceof Error || (typeof error === "object" && error !== null && "pid" in error)
      ? error
      : new Error(String(error)));
  }
}
