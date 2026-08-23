import { describe, expect, test } from "bun:test";
import { signalWake, waitForWake, type HostEntry } from "../game/dnet/shared.ts";

/** The per-host wake handle: the controller fires it on staging so an idle
 * resident picks up work the instant it is filed instead of on its next poll.
 * These pin the two races the primitive exists to close; the end-to-end pickup
 * through the real agent lives in tests/dnet-hard-cancel.test.ts. */

const mkEntry = (): HostEntry => ({ hostname: "darkweb", lastSeenAt: 0, seenAt: {}, dirty: {}, staged: [] });

describe("host wake", () => {
  test("a signal that arrives before the arm is consumed by the next wait", async () => {
    // The stage-before-arm race: the controller stages work between the
    // resident's staged check and its await. `wakePending` carries it over.
    const e = mkEntry();
    signalWake(e);
    expect(e.wakePending).toBe(true);
    await waitForWake(e, 1_000_000);
    expect(e.wakePending).toBe(false);
  });

  test("an armed wait resolves the instant it is signalled, and disarms", async () => {
    const e = mkEntry();
    let resolved = false;
    const waited = waitForWake(e, 1_000_000).then(() => { resolved = true; });
    expect(e.wake).toBeDefined();
    expect(resolved).toBe(false);
    signalWake(e);
    await waited;
    expect(resolved).toBe(true);
    expect(e.wake).toBeUndefined();
  });

  test("with no signal, the wait resolves on the fallback timer", async () => {
    const e = mkEntry();
    const started = Date.now();
    await waitForWake(e, 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(e.wake).toBeUndefined();
  });

  test("a stale handle does not clear a newer arm", async () => {
    const e = mkEntry();
    const firstDone = waitForWake(e, 20);
    const stale = e.wake!;
    const secondDone = waitForWake(e, 1_000_000);
    const fresh = e.wake!;
    expect(fresh).not.toBe(stale);
    await firstDone;
    expect(e.wake).toBe(fresh);
    signalWake(e);
    await secondDone;
    expect(e.wake).toBeUndefined();
  });
});
