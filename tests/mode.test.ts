import { describe, expect, test } from "bun:test";
import {
  HGW_LIVE_OPS_PRESSURE,
  HGW_LIVE_OPS_RELEASE,
  MODE_DWELL_MS,
  SHOTGUN_HACK_MS,
  decideMode,
} from "../shared/strategy/mode.ts";

/** The farm-mode policy: hwgw by default, hgw under process pressure with
 * hysteresis, shotgun below the reliable native hack-time window. */

const base = { hackMs: 30_000, liveOps: 100, lastMode: "hwgw" as const, lastModeSince: 0, now: 100_000 };

describe("decideMode", () => {
  test("shotgun only below the native hack-time safety boundary", () => {
    expect(decideMode({ ...base, hackMs: SHOTGUN_HACK_MS - 0.001 }).mode).toBe("shotgun");
    expect(decideMode({ ...base, hackMs: SHOTGUN_HACK_MS }).mode).toBe("hwgw");
    expect(decideMode({ ...base, hackMs: 50, lastModeSince: base.now - 1 }).mode).toBe("shotgun");
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

  test("follows the late-game HWGW -> HGW -> shotgun sequence", () => {
    const hwgw = decideMode({ ...base, now: MODE_DWELL_MS, lastModeSince: 0 });
    expect(hwgw.mode).toBe("hwgw");

    const hgw = decideMode({
      ...base,
      liveOps: HGW_LIVE_OPS_PRESSURE + 1,
      lastMode: hwgw.mode,
      lastModeSince: 0,
      now: MODE_DWELL_MS,
    });
    expect(hgw.mode).toBe("hgw");

    // Correctness wins immediately over the performance dwell: once native
    // hack time is below the reliable timer window, same-deadline FIFO is the
    // only supported ordering mechanism.
    const shotgun = decideMode({
      ...base,
      hackMs: SHOTGUN_HACK_MS - 1,
      liveOps: HGW_LIVE_OPS_PRESSURE + 1,
      lastMode: hgw.mode,
      lastModeSince: MODE_DWELL_MS,
      now: MODE_DWELL_MS + 1,
    });
    expect(shotgun.mode).toBe("shotgun");
  });
});
