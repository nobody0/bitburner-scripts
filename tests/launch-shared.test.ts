import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import {
  captureExecLaunch, launchExec, resetLaunchState, temporaryRunOptions, waitExecReady, type ScriptLaunch,
} from "../game/lib/launch-shared.ts";

interface TestLaunch extends ScriptLaunch { readonly kind: "test"; readonly value: number }

function child(pid: number): { ns: NS; exit(): void } {
  const hooks: (() => void)[] = [];
  return {
    ns: { pid, atExit: (hook: () => void) => { hooks.push(hook); } } as unknown as NS,
    exit: () => { for (const hook of hooks) hook(); },
  };
}

describe("script launch process identity", () => {
  beforeEach(resetLaunchState);
  afterEach(resetLaunchState);

  test("automation launches skip duplicate checks", () => {
    expect(temporaryRunOptions({ threads: 2, preventDuplicates: true })).toEqual({
      threads: 2, temporary: true, preventDuplicates: false,
    });
  });

  test("exec return publishes the descriptor under the real pid", () => {
    const bound: number[] = [];
    for (let value = 1; value <= 3; value++) {
      const entity = launchExec<TestLaunch>(
        { kind: "test", value }, () => 100 + value, (launch) => bound.push(launch.pid),
      )!;
      expect(captureExecLaunch<TestLaunch>(child(entity.pid).ns, "test")?.descriptor)
        .toEqual({ kind: "test", value });
    }
    expect(bound).toEqual([101, 102, 103]);
  });

  test("out-of-order children capture only their own pid entity", () => {
    const entities = [1, 2, 3].map((value) =>
      launchExec<TestLaunch>({ kind: "test", value }, () => 100 + value)!);
    const captured = [entities[2]!, entities[0]!, entities[1]!].map((entity) =>
      captureExecLaunch<TestLaunch>(child(entity.pid).ns, "test")!.descriptor.value);
    expect(captured).toEqual([3, 1, 2]);
  });

  test("readiness is explicit and lifetime resolves from atExit", async () => {
    const entity = launchExec<TestLaunch>({ kind: "test", value: 7 }, () => 107)!;
    const process = child(entity.pid);
    const captured = captureExecLaunch<TestLaunch>(process.ns, "test")!;
    captured.ready.resolve();
    expect(await waitExecReady(entity, () => true)).toEqual({ status: "ready", value: undefined });
    process.exit();
    await expect(entity.exited.promise).resolves.toEqual({ value: undefined });
  });

  /** The ns resident resolves its readiness with its OWN LIVE `ns`. Native
   * promise resolution probes anything it is handed for a `then` member, and
   * on the simulator's modelled `ns` that read is an unmodelled member that
   * takes the whole run down. The value must therefore travel boxed, and
   * nothing may ever hand it to `resolve` bare. */
  test("a readiness value is never probed for a `then` member", async () => {
    let probed = false;
    const thenable = { get then() { probed = true; return undefined; } };
    const entity = launchExec<TestLaunch, typeof thenable>(
      { kind: "test", value: 5 }, () => 105,
    )!;
    const captured = captureExecLaunch<TestLaunch, typeof thenable>(child(entity.pid).ns, "test")!;
    captured.ready.resolve(thenable);
    const ready = await waitExecReady(entity, () => true);
    expect(ready.status).toBe("ready");
    expect(ready.status === "ready" && ready.value).toBe(thenable);
    expect(probed).toBe(false);
  });

  test("a refused exec publishes no entity", () => {
    expect(launchExec<TestLaunch>({ kind: "test", value: 1 }, () => 0)).toBeUndefined();
  });

  test("readiness fails only when the returned pid is observed gone", async () => {
    const entity = launchExec<TestLaunch>({ kind: "test", value: 9 }, () => 109)!;
    expect(await waitExecReady(entity, () => false)).toEqual({ status: "gone" });
    await expect(entity.exited.promise).resolves.toEqual({ value: undefined });
  });
});
