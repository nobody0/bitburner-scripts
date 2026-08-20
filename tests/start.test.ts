import { describe, expect, test } from "bun:test";
import { claimControllerEpoch, parseStartMode, shouldReportCrash } from "../game/start.ts";

/** START.JS — the invocation contract and the two decisions boot makes.
 *
 * `main` itself is not unit-tested and deliberately so: it is ns calls and
 * wiring, the simulator already runs the real thing end to end
 * (`sim/tests/scenario-bootstrap.test.ts` boots it cold), and
 * `tests/ram-budget.test.ts` pins the properties that actually bite in game --
 * the 3.6 GB static budget, --perf equivalence, and that the controller can
 * never reach the save. An ns mock here would prove less than any of those.
 *
 * What IS worth pinning is the pure logic inside it, because each piece is a
 * silent single point of failure: bad args run the wrong build, a bad epoch
 * leaves two controllers farming the same fleet, and a bad crash filter either
 * buries real failures or hides them entirely. */

describe("start.js invocation contract", () => {
  test("empty args are the single cold-boot form used by autoexec and reset callbacks", () => {
    expect(parseStartMode([], "build-1")).toBe("cold");
  });

  test("handoff requires the exact build id", () => {
    expect(parseStartMode(["handoff", "build-1"], "build-1")).toBe("handoff");
    expect(() => parseStartMode(["handoff", "stale"], "build-1")).toThrow("invalid start.js args");
  });

  test("rejects the obsolete main arg and every partial or extra form", () => {
    for (const args of [["main"], ["cold"], ["handoff"], ["handoff", "build-1", "extra"]]) {
      expect(() => parseStartMode(args, "build-1")).toThrow("invalid start.js args");
    }
  });
});

describe("the controller epoch is what makes one instance the controller", () => {
  test("a fresh realm claims the first epoch", () => {
    // Cold boot after a page reload: the realm is new and holds no counter.
    const realm: { controllerEpoch?: number } = {};
    expect(claimControllerEpoch(realm)).toBe(1);
    expect(realm.controllerEpoch).toBe(1);
  });

  test("a handoff into a live realm supersedes the incumbent", () => {
    // The outgoing controller is still running here; it exits on its next pass
    // precisely BECAUSE this claim moved the counter past its own epoch.
    const realm = { controllerEpoch: 7 };
    expect(claimControllerEpoch(realm)).toBe(8);
    expect(realm.controllerEpoch).toBe(8);
  });

  test("claims strictly increase, so no two instances can hold the same epoch", () => {
    // The property the whole no-kill handoff rests on. Rapid successive builds
    // overlap in the same realm, and each must supersede every predecessor.
    const realm: { controllerEpoch?: number } = {};
    let previous = 0;
    for (let i = 0; i < 50; i++) {
      const epoch = claimControllerEpoch(realm);
      expect(epoch).toBeGreaterThan(previous);
      previous = epoch;
    }
  });

  test("a zeroed counter still advances rather than sticking", () => {
    // `?? 0` not `|| 0`: were a reset ever to leave the counter at 0, a claim
    // must still move it, or every later instance would tie at 1 and none of
    // them would recognise itself as stale.
    const realm = { controllerEpoch: 0 };
    expect(claimControllerEpoch(realm)).toBe(1);
    expect(claimControllerEpoch(realm)).toBe(2);
  });
});

describe("only real crashes are reported", () => {
  test("ScriptDeath is a clean shutdown, not a failure", () => {
    // Every kill, reset teardown and interrupted delaying ns call arrives this
    // way. Reporting them would bury genuine crashes in routine noise.
    const death = new Error("script killed");
    death.name = "ScriptDeath";
    expect(shouldReportCrash(death)).toBe(false);
  });

  test("everything else is reported, including non-Error throws", () => {
    expect(shouldReportCrash(new Error("boom"))).toBe(true);
    expect(shouldReportCrash(new TypeError("undefined is not a function"))).toBe(true);
    // A bare throw must never be mistaken for a clean shutdown.
    expect(shouldReportCrash("string throw")).toBe(true);
    expect(shouldReportCrash(undefined)).toBe(true);
    // An error merely CLAIMING the message must still report; the marker is
    // the name, and only Bitburner sets it.
    expect(shouldReportCrash(new Error("ScriptDeath"))).toBe(true);
  });
});
