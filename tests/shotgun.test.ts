import { describe, expect, test } from "bun:test";
import {
  HGW_LIVE_OPS_PRESSURE,
  MODE_DWELL_MS,
  SHOTGUN_HACK_MS,
  decideMode,
  type FarmMode,
} from "../shared/strategy/mode.ts";
import {
  HWGW_MIN_INTERVAL_MS,
  JIT_LAUNCH_GUARD_MS,
  MINIMUM_LANDING_GAP_MS,
} from "../shared/strategy/jit.ts";

/** SHOTGUN — the end of the JIT regime, and the way back.
 *
 * JIT earns its keep by INTERLEAVING: each op is launched so it lands on its
 * own deadline, a few milliseconds after the last, and many batches are in
 * flight at once. That trade stops paying when the target's native hack time
 * collapses, because every op still has to be launched a fixed guard ahead of
 * its landing however short the work is. Past that point we stop trying to
 * order landings with separate deadlines and instead give every op of a wave
 * the SAME deadline, letting the engine's same-tick FIFO turn launch order
 * into arrival order.
 *
 * This file covers the DECISION — where the boundary is, why it is there, and
 * that we can cross it in both directions without flapping. The execution side
 * (same-tick landings, launch order, the additionalMsec arithmetic, and a
 * natural jit -> shotgun -> jit round trip against the real dispatcher) lives
 * in `sim/tests/dispatch.test.ts`, which can run a world. */

const base = {
  hackMs: 30_000,
  liveOps: 100,
  lastMode: "hwgw" as FarmMode,
  lastModeSince: 0,
  now: 1_000_000,
};

/** Weaken always runs 4x the hack, so a target's hack time fixes the whole
 * batch's in-flight window. */
const weakenMsFor = (hackMs: number): number => hackMs * 4;

describe("where the shotgun boundary sits, and why", () => {
  test("at the boundary the launch guard already costs more than the work", () => {
    // This is the real reason the threshold exists, and it is checkable rather
    // than a matter of taste. Every JIT op is launched JIT_LAUNCH_GUARD_MS
    // before its landing and holds its RAM for that whole time -- the guard is
    // paid as additionalMsec, which dispatch itself accounts as "scheduler
    // waste, not work". At the shotgun boundary that waste has already grown
    // past half of an op's entire in-flight window, so interleaving is buying
    // depth with RAM-time it no longer has.
    const weakenAtBoundary = weakenMsFor(SHOTGUN_HACK_MS);
    expect(JIT_LAUNCH_GUARD_MS).toBeGreaterThan(weakenAtBoundary / 2);

    // And the constant is not merely on the right side of that line by luck:
    // the 50% crossover is at 115 ms of hack time, so SHOTGUN_HACK_MS carries
    // about 15% of margin below it. If someone raises the threshold far above
    // the crossover, JIT would be abandoned while it was still paying.
    const crossoverHackMs = (JIT_LAUNCH_GUARD_MS * 2) / 4;
    expect(SHOTGUN_HACK_MS).toBeLessThan(crossoverHackMs);
    expect(SHOTGUN_HACK_MS).toBeGreaterThan(crossoverHackMs * 0.75);
  });

  test("above the boundary JIT still has a pipeline worth having", () => {
    // The other half of the claim: just above the threshold, a weaken window
    // still holds many batch intervals, so interleaving has real depth to sell.
    const justAbove = SHOTGUN_HACK_MS + 1;
    const depth = weakenMsFor(justAbove) / HWGW_MIN_INTERVAL_MS;
    expect(depth).toBeGreaterThan(10);
    // Landings inside a batch stay far enough apart to be ordered by deadline,
    // which is precisely what shotgun gives up.
    expect(weakenMsFor(justAbove)).toBeGreaterThan(4 * MINIMUM_LANDING_GAP_MS);
  });

  test("the boundary is exact and strictly below the threshold", () => {
    expect(decideMode({ ...base, hackMs: SHOTGUN_HACK_MS - 0.001 }).mode).toBe("shotgun");
    expect(decideMode({ ...base, hackMs: SHOTGUN_HACK_MS }).mode).toBe("hwgw");
    // The reason is reported, not just the verdict: a mode nobody can explain
    // is a mode nobody can debug from a telemetry rollup.
    expect(decideMode({ ...base, hackMs: 40 }).why).toContain("hackTime");
    expect(decideMode({ ...base, hackMs: 40 }).why).toContain(String(SHOTGUN_HACK_MS));
  });
});

describe("entering shotgun", () => {
  test("is immediate from any mode, because it is a correctness switch", () => {
    // Once deadlines can no longer order landings, continuing to interleave is
    // wrong, not merely slow -- so the performance dwell must not delay it.
    for (const lastMode of ["hwgw", "hgw"] as const) {
      const decision = decideMode({
        ...base,
        hackMs: SHOTGUN_HACK_MS - 1,
        lastMode,
        lastModeSince: base.now - 1, // dwell has barely started
      });
      expect(decision.mode, `from ${lastMode}`).toBe("shotgun");
      expect(decision.why).not.toContain("dwell");
    }
  });

  test("outranks live-op pressure, which would otherwise ask for hgw", () => {
    // Both conditions true at once: process pressure wants hgw, hack time
    // demands shotgun. Correctness wins.
    expect(decideMode({
      ...base,
      hackMs: SHOTGUN_HACK_MS - 1,
      liveOps: HGW_LIVE_OPS_PRESSURE + 500,
    }).mode).toBe("shotgun");
  });
});

describe("leaving shotgun", () => {
  test("waits out the dwell, unlike entering it", () => {
    // The asymmetry IS the anti-flap mechanism. Entering is free so we are
    // never wrong for long; leaving is rate-limited so a target hovering on
    // the boundary cannot rebuild and tear down the pipeline every pass.
    const justLeft = {
      ...base,
      hackMs: 30_000,
      lastMode: "shotgun" as FarmMode,
      lastModeSince: base.now - MODE_DWELL_MS + 1,
    };
    const held = decideMode(justLeft);
    expect(held.mode).toBe("shotgun");
    expect(held.why).toContain("dwell");
    expect(held.why).toContain("hwgw");

    // One millisecond later the dwell has elapsed and JIT resumes.
    expect(decideMode({ ...justLeft, lastModeSince: base.now - MODE_DWELL_MS }).mode).toBe("hwgw");
  });

  test("returns to hgw rather than hwgw when process pressure is still on", () => {
    // Leaving shotgun is not automatically a return to the default: the other
    // axis is re-evaluated on the way out.
    expect(decideMode({
      ...base,
      hackMs: 30_000,
      liveOps: HGW_LIVE_OPS_PRESSURE + 1,
      lastMode: "shotgun",
      lastModeSince: base.now - MODE_DWELL_MS,
    }).mode).toBe("hgw");
  });
});

describe("the jit -> shotgun -> jit round trip", () => {
  /** Drive decideMode the way the dispatcher does: feed back the mode it chose
   * and the instant it last changed. */
  function driveModes(
    steps: readonly { atMs: number; hackMs: number; liveOps?: number }[],
  ): { atMs: number; mode: FarmMode; why: string }[] {
    let mode: FarmMode = "hwgw";
    let since = 0;
    const timeline: { atMs: number; mode: FarmMode; why: string }[] = [];
    for (const step of steps) {
      const decision = decideMode({
        hackMs: step.hackMs,
        liveOps: step.liveOps ?? 100,
        lastMode: mode,
        lastModeSince: since,
        now: step.atMs,
      });
      if (decision.mode !== mode) {
        mode = decision.mode;
        since = step.atMs;
      }
      timeline.push({ atMs: step.atMs, mode, why: decision.why });
    }
    return timeline;
  }

  test("a target whose hack time collapses and recovers ends back on JIT", () => {
    // The realistic story: skill compounds until the current target's hack
    // time falls through the floor (shotgun), then the farm moves to a richer,
    // harder server whose hack time is long again (back to JIT).
    const steps: { atMs: number; hackMs: number }[] = [];
    for (let t = 0; t <= 60_000; t += 1_000) steps.push({ atMs: t, hackMs: 250 });
    for (let t = 61_000; t <= 120_000; t += 1_000) steps.push({ atMs: t, hackMs: 60 });
    for (let t = 121_000; t <= 240_000; t += 1_000) steps.push({ atMs: t, hackMs: 1_600 });

    const timeline = driveModes(steps);
    const modeAt = (atMs: number): FarmMode => timeline.find((entry) => entry.atMs === atMs)!.mode;

    expect(modeAt(60_000)).toBe("hwgw");
    // Entering is immediate: the very first pass under the threshold switches.
    expect(modeAt(61_000)).toBe("shotgun");
    // Leaving is immediate TOO here, and that is correct rather than a missing
    // guard: the dwell is a minimum time IN a mode, and by now the farm has
    // spent a full minute in shotgun. The dwell exists to stop rapid
    // re-switching, not to make a recovered target wait out a penalty.
    expect(modeAt(121_000)).toBe("hwgw");
    expect(modeAt(240_000)).toBe("hwgw");

    // And the whole trip is exactly two transitions -- out and back.
    const transitions = timeline.filter(
      (entry, index) => index > 0 && entry.mode !== timeline[index - 1]!.mode,
    );
    expect(transitions.map((entry) => entry.mode)).toEqual(["shotgun", "hwgw"]);
  });

  test("a target sitting exactly on the boundary cannot flap every pass", () => {
    // Oscillating hack time across the threshold on every 200 ms pass. Entering
    // is unrestricted, so the guarantee is on the EXITS: at most one per dwell.
    const steps: { atMs: number; hackMs: number }[] = [];
    for (let t = 0; t <= 300_000; t += 200) {
      steps.push({ atMs: t, hackMs: (t / 200) % 2 === 0 ? SHOTGUN_HACK_MS - 5 : SHOTGUN_HACK_MS + 5 });
    }
    const timeline = driveModes(steps);
    const exits = timeline.filter(
      (entry, index) => index > 0 && timeline[index - 1]!.mode === "shotgun" && entry.mode !== "shotgun",
    );
    // 300 s of thrashing input at 5 Hz would be 750 switches if unguarded.
    expect(exits.length).toBeLessThanOrEqual(Math.ceil(300_000 / MODE_DWELL_MS));
    expect(timeline.length).toBeGreaterThan(1_000);
  });

  test("a spike right after entering shotgun is absorbed by the dwell", () => {
    // The dwell's actual protection, stated precisely. A hack-time reading
    // above the threshold WITHIN the dwell window of entering shotgun is
    // ignored and the wave keeps running.
    const steps: { atMs: number; hackMs: number }[] = [];
    for (let t = 0; t <= 20_000; t += 1_000) {
      steps.push({ atMs: t, hackMs: t === 10_000 ? 400 : 60 });
    }
    const timeline = driveModes(steps);
    expect(timeline.every((entry) => entry.mode === "shotgun")).toBe(true);
  });

  test("but once the dwell has elapsed a single pass is enough to leave", () => {
    // The flip side, pinned deliberately rather than discovered later: after a
    // mode has been held past the dwell, ONE reading above the threshold
    // returns the farm to JIT. That is what makes the round trip responsive,
    // and it is also the whole of the protection -- there is no additional
    // confirmation window. The flap bound below is what keeps it safe.
    const steps: { atMs: number; hackMs: number }[] = [];
    for (let t = 0; t <= 60_000; t += 1_000) steps.push({ atMs: t, hackMs: 60 });
    steps.push({ atMs: 61_000, hackMs: 400 });
    const timeline = driveModes(steps);
    expect(timeline.at(-2)!.mode).toBe("shotgun");
    expect(timeline.at(-1)!.mode).toBe("hwgw");
  });
});
