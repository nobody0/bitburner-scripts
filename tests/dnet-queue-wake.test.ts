import { describe, expect, test } from "bun:test";
import { signalQueueWork, waitForQueueWork, type DnetHostQueue } from "../game/dnet/realm.ts";

/** The per-queue wake handle: the overseer fires it on enqueue so an idle
 * resident picks up work the instant it is filed instead of on its next poll.
 * These pin the two races the primitive exists to close; the end-to-end pickup
 * through the real agent lives in tests/dnet-hard-cancel.test.ts. */

const mkQueue = (): DnetHostQueue => ({ host: "darkweb", pending: [], lastBeatAt: 0, completed: 0, failed: 0 });

describe("queue wake", () => {
  test("a signal that arrives before the arm is consumed by the next wait", async () => {
    // The enqueue-before-arm race: the overseer files work between the
    // resident's nextJob check and its await. `wakePending` carries it over.
    const q = mkQueue();
    signalQueueWork(q);
    expect(q.wakePending).toBe(true);
    // A generous fallback: if the pending flag were not honoured this would
    // hang far past the test, not resolve.
    await waitForQueueWork(q, 1_000_000);
    expect(q.wakePending).toBe(false);
  });

  test("an armed wait resolves the instant it is signalled, and disarms", async () => {
    const q = mkQueue();
    let resolved = false;
    const waited = waitForQueueWork(q, 1_000_000).then(() => { resolved = true; });
    expect(q.wake).toBeDefined();
    expect(resolved).toBe(false);
    signalQueueWork(q);
    await waited;
    expect(resolved).toBe(true);
    expect(q.wake).toBeUndefined();
  });

  test("with no signal, the wait resolves on the fallback timer", async () => {
    const q = mkQueue();
    const started = Date.now();
    await waitForQueueWork(q, 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(q.wake).toBeUndefined();
  });

  test("a stale handle does not clear a newer arm", async () => {
    // Model a resident killed mid-wait: its fallback fires later, and must not
    // null out the replacement resident's freshly-armed handle.
    const q = mkQueue();
    const firstDone = waitForQueueWork(q, 20); // arms finish#1 with a 20ms timer
    const stale = q.wake!;
    // A replacement arrives and re-arms before #1's timer fires.
    const secondDone = waitForQueueWork(q, 1_000_000); // overwrites q.wake with finish#2
    const fresh = q.wake!;
    expect(fresh).not.toBe(stale);
    // #1's timer fires: it resolves its own promise but leaves finish#2 in place.
    await firstDone;
    expect(q.wake).toBe(fresh);
    // The replacement is still wakeable.
    signalQueueWork(q);
    await secondDone;
    expect(q.wake).toBeUndefined();
  });
});
