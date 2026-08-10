import { describe, expect, test } from "bun:test";
import {
  HGW_LIVE_OPS_PRESSURE,
  HGW_LIVE_OPS_RELEASE,
  MODE_DWELL_MS,
  decideMode,
} from "../shared/strategy/mode.ts";

/** The farm-mode policy: hwgw by default, hgw under process pressure with
 * hysteresis, shotgun when weakenTime can no longer hold the interleave. */

const base = { weakenMs: 120_000, liveOps: 100, lastMode: "hwgw" as const, lastModeSince: 0, now: 100_000 };

describe("decideMode", () => {
  test("shotgun when weakenTime fits fewer than the minimum interleaved batches", () => {
    // 0.8s interval: 1.5s of weakenTime holds one batch — below SHOTGUN_MIN_DEPTH.
    expect(decideMode({ ...base, weakenMs: 1_500 }).mode).toBe("shotgun");
    expect(decideMode({ ...base, weakenMs: 1_700 }).mode).toBe("hwgw");
  });

  test("hgw under live-op pressure, with hysteresis on the way back", () => {
    expect(decideMode({ ...base, liveOps: HGW_LIVE_OPS_PRESSURE + 1 }).mode).toBe("hgw");
    // Between release and pressure: holds hgw if already there, stays hwgw otherwise.
    const between = (HGW_LIVE_OPS_RELEASE + HGW_LIVE_OPS_PRESSURE) / 2;
    expect(decideMode({ ...base, liveOps: between, lastMode: "hgw" }).mode).toBe("hgw");
    expect(decideMode({ ...base, liveOps: between, lastMode: "hwgw" }).mode).toBe("hwgw");
    expect(decideMode({ ...base, liveOps: HGW_LIVE_OPS_RELEASE - 1, lastMode: "hgw" }).mode).toBe("hwgw");
  });

  test("a mode switch waits out the dwell", () => {
    const recent = { ...base, liveOps: HGW_LIVE_OPS_PRESSURE + 1, lastModeSince: base.now - MODE_DWELL_MS + 1 };
    const held = decideMode(recent);
    expect(held.mode).toBe("hwgw");
    expect(held.why).toContain("dwell");
    expect(decideMode({ ...recent, lastModeSince: base.now - MODE_DWELL_MS }).mode).toBe("hgw");
  });

  test("oscillating inputs near the threshold produce at most one switch per dwell", () => {
    let mode: "hwgw" | "hgw" | "shotgun" = "hwgw";
    let since = 0;
    let switches = 0;
    for (let t = 0; t <= 60_000; t += 1_000) {
      const liveOps = t % 2_000 === 0 ? HGW_LIVE_OPS_PRESSURE + 50 : HGW_LIVE_OPS_RELEASE - 50;
      const next = decideMode({ ...base, liveOps, lastMode: mode, lastModeSince: since, now: t });
      if (next.mode !== mode) {
        switches++;
        since = t;
        mode = next.mode;
      }
    }
    expect(switches).toBeLessThanOrEqual(3); // one per dwell window over 60s
  });
});
