import { describe, expect, test } from "bun:test";
import {
  HGW_PROJECTED_OPS_PRESSURE,
  HGW_PROJECTED_OPS_RELEASE,
  MODE_DWELL_MS,
  SHOTGUN_BOUND_HYSTERESIS,
  SHOTGUN_HACK_MS,
  decideMode,
} from "../shared/strategy/mode.ts";

/** The farm-mode policy: hwgw by default, hgw under process pressure with
 * hysteresis, shotgun below the reliable native hack-time window. */

const base = { hackMs: 30_000, projectedHwgwOps: 100, lastMode: "hwgw" as const, lastModeSince: 0, now: 100_000 };

describe("decideMode", () => {
  test("shotgun only below the native hack-time safety boundary", () => {
    expect(decideMode({ ...base, hackMs: SHOTGUN_HACK_MS - 0.001 })).toBe("shotgun");
    expect(decideMode({ ...base, hackMs: SHOTGUN_HACK_MS })).toBe("hwgw");
    expect(decideMode({ ...base, hackMs: 50, lastModeSince: base.now - 1 })).toBe("shotgun");
  });

  test("economic shotgun when RAM out-holds the landing grid, JIT when RAM binds", () => {
    // The user-specified bound: farmGb/ramPerBatch batches fit in RAM;
    // weakenMs/intervalMs fit on the grid at minimum spacing. Time-bound
    // (RAM holds more) -> shotgun stacks same-deadline batches; RAM-bound ->
    // JIT's worker reuse wins. Purely hysteresis-gated: no flapping as a
    // compounding fleet crosses the boundary.
    const grid = 200;
    expect(decideMode({
      ...base,
      ramBoundedBatches: grid * SHOTGUN_BOUND_HYSTERESIS * 1.01,
      timeBoundedBatches: grid,
    })).toBe("shotgun");
    expect(decideMode({
      ...base,
      ramBoundedBatches: grid * SHOTGUN_BOUND_HYSTERESIS * 0.99,
      timeBoundedBatches: grid,
    })).toBe("hwgw");
    // Unlike the correctness arm, the economic entry waits out the dwell.
    expect(decideMode({
      ...base,
      ramBoundedBatches: grid * 2,
      timeBoundedBatches: grid,
      lastModeSince: base.now - MODE_DWELL_MS + 1,
    })).toBe("hwgw");
    // Leaving is dwelled too: a shotgun fleet dipping back under the bound
    // holds until the dwell expires.
    expect(decideMode({
      ...base,
      lastMode: "shotgun",
      ramBoundedBatches: grid,
      timeBoundedBatches: grid,
      lastModeSince: base.now - MODE_DWELL_MS + 1,
    })).toBe("shotgun");
    // Absent inputs: no economic consideration at all.
    expect(decideMode({ ...base })).toBe("hwgw");
  });

  test("hgw under projected HWGW pressure, with hysteresis on the way back", () => {
    expect(decideMode({ ...base, projectedHwgwOps: HGW_PROJECTED_OPS_PRESSURE + 1 })).toBe("hgw");
    // Between release and pressure: holds hgw if already there, stays hwgw otherwise.
    const between = (HGW_PROJECTED_OPS_RELEASE + HGW_PROJECTED_OPS_PRESSURE) / 2;
    expect(decideMode({ ...base, projectedHwgwOps: between, lastMode: "hgw" })).toBe("hgw");
    expect(decideMode({ ...base, projectedHwgwOps: between, lastMode: "hwgw" })).toBe("hwgw");
    expect(decideMode({ ...base, projectedHwgwOps: HGW_PROJECTED_OPS_RELEASE - 1, lastMode: "hgw" })).toBe("hwgw");
  });

  test("a mode switch waits out the dwell", () => {
    const recent = { ...base, projectedHwgwOps: HGW_PROJECTED_OPS_PRESSURE + 1, lastModeSince: base.now - MODE_DWELL_MS + 1 };
    const held = decideMode(recent);
    expect(held).toBe("hwgw");
    expect(decideMode({ ...recent, lastModeSince: base.now - MODE_DWELL_MS })).toBe("hgw");
  });

  test("oscillating inputs near the threshold produce at most one switch per dwell", () => {
    let mode: "hwgw" | "hgw" | "shotgun" = "hwgw";
    let since = 0;
    let switches = 0;
    for (let t = 0; t <= 60_000; t += 1_000) {
      const projectedOps = t % 2_000 === 0 ? HGW_PROJECTED_OPS_PRESSURE + 50 : HGW_PROJECTED_OPS_RELEASE - 50;
      const next = decideMode({ ...base, projectedHwgwOps: projectedOps, lastMode: mode, lastModeSince: since, now: t });
      if (next !== mode) {
        switches++;
        since = t;
        mode = next;
      }
    }
    expect(switches).toBeLessThanOrEqual(3); // one per dwell window over 60s
  });

  test("follows the late-game HWGW -> HGW -> shotgun sequence", () => {
    const hwgw = decideMode({ ...base, now: MODE_DWELL_MS, lastModeSince: 0 });
    expect(hwgw).toBe("hwgw");

    const hgw = decideMode({
      ...base,
      projectedHwgwOps: HGW_PROJECTED_OPS_PRESSURE + 1,
      lastMode: hwgw,
      lastModeSince: 0,
      now: MODE_DWELL_MS,
    });
    expect(hgw).toBe("hgw");

    // Correctness wins immediately over the performance dwell: once native
    // hack time is below the reliable timer window, same-deadline FIFO is the
    // only supported ordering mechanism.
    const shotgun = decideMode({
      ...base,
      hackMs: SHOTGUN_HACK_MS - 1,
      projectedHwgwOps: HGW_PROJECTED_OPS_PRESSURE + 1,
      lastMode: hgw,
      lastModeSince: MODE_DWELL_MS,
      now: MODE_DWELL_MS + 1,
    });
    expect(shotgun).toBe("shotgun");
  });
});
