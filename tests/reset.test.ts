import { describe, expect, test } from "bun:test";
import { resetHackingState } from "../game/lib/features/hacking.ts";
import { workerGlobals } from "../game/lib/worker-shared.ts";
import { classifyReset, type ResetIdentity } from "../shared/reset.ts";

const OLD: ResetIdentity = { currentNode: 1, lastAugReset: 100, lastNodeReset: 10 };

describe("game reset classification", () => {
  test("a first observation and an unchanged world are not resets", () => {
    expect(classifyReset(undefined, OLD)).toBe("none");
    expect(classifyReset(OLD, { ...OLD })).toBe("none");
  });

  test("an augmentation install advances only the augmentation epoch", () => {
    expect(classifyReset(OLD, { ...OLD, lastAugReset: 200 })).toBe("augmentation");
  });

  test("a BitNode reset wins when both prestige timestamps advance", () => {
    expect(classifyReset(OLD, { currentNode: 2, lastAugReset: 200, lastNodeReset: 200 })).toBe("bitnode");
  });

  test("re-entering the same BitNode is still a BitNode reset", () => {
    expect(classifyReset(OLD, { ...OLD, lastAugReset: 200, lastNodeReset: 200 })).toBe("bitnode");
  });

  test("a backwards epoch is a loaded-world discontinuity, not continuity", () => {
    expect(classifyReset(OLD, { ...OLD, lastAugReset: 50 })).toBe("augmentation");
    expect(classifyReset(OLD, { ...OLD, lastAugReset: 50, lastNodeReset: 5 })).toBe("bitnode");
  });
});

describe("prestige invalidation", () => {
  test("hacking drops the dispatcher wake rendezvous with the dead worker fleet", () => {
    const globals = workerGlobals();
    globals.dispatch_wake = () => undefined;
    globals.dispatch_wake_pending = true;
    globals.dispatch_weaken_timer = setTimeout(() => undefined, 60_000);
    globals.dispatch_jit_timers!.set("n00dles", {
      timer: setTimeout(() => undefined, 60_000),
      at: Date.now() + 60_000,
    });

    resetHackingState();

    expect(globals.dispatch_wake).toBeUndefined();
    expect(globals.dispatch_wake_pending).toBe(false);
    expect(globals.dispatch_weaken_timer).toBeUndefined();
    expect(globals.dispatch_jit_timers?.size).toBe(0);
  });
});
