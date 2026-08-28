import { describe, expect, test } from "bun:test";
import { shouldReportCrash } from "../game/main.ts";
import { planKillOrder } from "../game/start.ts";
import { parseSyncControl, syncControl } from "../shared/deployment.ts";

/** START.JS — the two decisions boot makes.
 *
 * `main` itself is not unit-tested and deliberately so: it is ns calls and
 * wiring, the simulator already runs the real thing end to end
 * (`sim/tests/scenario-bootstrap.test.ts` boots it cold), and
 * `tests/ram-budget.test.ts` pins the properties that actually bite in game --
 * the 3.6 GB static budget, --perf equivalence, and that the controller can
 * never reach the save. An ns mock here would prove less than any of those.
 *
 * What IS worth pinning is the pure logic inside it, because each piece is a
 * silent single point of failure: a bad epoch leaves two controllers farming
 * the same fleet, and a bad crash filter either
 * buries real failures or hides them entirely. */

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

describe("clean sync control", () => {
  test("kills every remote host once and home last", () => {
    expect(planKillOrder(["home", "n00dles", "darkweb", "n00dles"], "home")).toEqual([
      "n00dles",
      "darkweb",
      "home",
    ]);
  });

  test("round-trips valid control messages and rejects malformed input", () => {
    const prepare = { id: "sync-1", phase: "prepare" as const, hosts: ["home", "home"] };
    expect(parseSyncControl(syncControl(prepare))).toEqual({ ...prepare, hosts: ["home"] });
    expect(parseSyncControl('{"id":"","phase":"ready"}')).toBeUndefined();
    expect(parseSyncControl("not json")).toBeUndefined();
  });
});
