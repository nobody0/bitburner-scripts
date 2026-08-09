import { describe, expect, test } from "bun:test";
import {
  armSleeveCompletion,
  consumeSleeveCompletion,
  pendingSleeveCompletions,
  resetSleeveCompletions,
} from "../game/lib/sleeve-completion.ts";

describe("sleeve completion bridge", () => {
  test("a replaced crime promise cannot masquerade as a natural completion", async () => {
    resetSleeveCompletions();
    let resolveOld!: () => void;
    let resolveCurrent!: () => void;
    const oldPromise = new Promise<void>((resolve) => { resolveOld = resolve; });
    const currentPromise = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    armSleeveCompletion(0, { type: "CRIME", nextCompletion: oldPromise });
    armSleeveCompletion(0, { type: "CRIME", nextCompletion: currentPromise });

    resolveOld();
    await Promise.resolve();
    expect(pendingSleeveCompletions().has(0)).toBe(false);
    resolveCurrent();
    await Promise.resolve();
    expect(pendingSleeveCompletions().has(0)).toBe(true);
    consumeSleeveCompletion(0);
  });

  test("observing no completion-bearing task disarms the old listener", async () => {
    resetSleeveCompletions();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    armSleeveCompletion(1, { type: "CRIME", nextCompletion: promise });
    armSleeveCompletion(1, null);
    resolve();
    await Promise.resolve();
    expect(pendingSleeveCompletions().has(1)).toBe(false);
  });
});
