import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { buildScript, buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";
import { priceCalls, UNKNOWN_CALL_GB } from "../game/lib/dodge.ts";
import type { NS } from "@ns";

/** Static RAM is the fresh-game constraint: start.js plus a transient dodge
 * stub must fit an 8 GB home. Bitburner charges a script for every ns member
 * its source references with dot notation, so this test pins that surface —
 * an accidental `ns.foo` in the controller shows up here, not in-game. */

const RAM_COSTS: Record<string, number> = {
  // Only the members the controller is allowed to touch directly.
  "ns.getPlayer": 0.5,
  "ns.getResetInfo": 1,
  "ns.exec": 1.3,
  "ns.getServerSecurityLevel": 0.1,
  "ns.getServerMoneyAvailable": 0.1,
  "ns.scp": 0.6,
  "ns.scan": 0.2,
  "ns.getServer": 2.0,
  "ns.ps": 0.2,
  "ns.ls": 0.2,
  "ns.nuke": 0.05,
  "ns.brutessh": 0.05,
  "ns.scriptKill": 0.5,
  "ns.kill": 0.5,
  "ns.killall": 0.5,
  "ns.getServerMaxRam": 0.05,
  "ns.getServerUsedRam": 0.05,
  "ns.hack": 0.1,
  "ns.grow": 0.15,
  "ns.weaken": 0.15,
};
const BASE_GB = 1.6;
/** start.js + dodge stub (1.6 + 2.5) must stay under an 8 GB home. */
const START_BUDGET_GB = 3.6;

const config: BitburnerConfig = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: "build-test-ram",
  entries: [
    { source: "game/start.ts", target: "start.js" },
    { source: "game/worker/worker.ts", target: "worker/worker.js" },
  ],
  restoreEntry: { source: "game/restore.ts", target: "restore.js" },
};

afterAll(async () => {
  await rm(config.buildDir, { recursive: true, force: true });
});

/** Approximate Bitburner's static parser: dotted ns member references. */
function staticRam(source: string): { total: number; members: string[] } {
  const members = new Set<string>();
  for (const [member] of Object.entries(RAM_COSTS)) {
    const name = member.slice(3);
    if (new RegExp(`\\bns\\d*\\.${name}\\b`).test(source)) members.add(member);
  }
  let total = BASE_GB;
  for (const member of members) total += RAM_COSTS[member]!;
  return { total, members: [...members].sort() };
}

describe("in-game static RAM budget", () => {
  test("an unpriceable dodged method cannot be mistaken for a cheap call", () => {
    const ns = { getFunctionRamCost: () => { throw new Error("unknown method"); } } as unknown as NS;
    expect(priceCalls(ns, ["renamed.method"])).toBe(UNKNOWN_CALL_GB + 0.5);
  });

  test("start.js stays within its fresh-game budget", async () => {
    const [start] = await buildScripts(config, { telemetry: true });
    const { total, members } = staticRam(start!.content);
    console.log(`start.js static RAM ~${total.toFixed(2)}GB via ${members.join(", ")}`);
    expect(total).toBeLessThanOrEqual(START_BUDGET_GB + 1e-9);
    // The hot path must never dodge, so these two live reads are expected...
    expect(members).toContain("ns.getServerSecurityLevel");
    expect(members).toContain("ns.getServerMoneyAvailable");
    // ...and these must stay inside dodge closures (bracket notation).
    expect(members).not.toContain("ns.scp");
    expect(members).not.toContain("ns.getServer");
    expect(members).not.toContain("ns.scan");
  });

  test("the --perf build costs exactly the same static RAM", async () => {
    // Compiling acquisition into perf builds is only affordable because
    // Bitburner charges for DOTTED ns references, not bundle size: every probe
    // body calls through bracket notation on its own stub ns, so the whole
    // probe table is free here. If a probe ever reaches for `ns.foo` directly,
    // this is where the fresh-game story breaks — not in-game at 3 a.m.
    const [telemetryBuild] = await buildScripts(config, { telemetry: true });
    const [perfBuild] = await buildScripts(config, { telemetry: false });
    const perf = staticRam(perfBuild!.content);
    expect(perf.total).toBeLessThanOrEqual(START_BUDGET_GB + 1e-9);
    expect(perf.members).toEqual(staticRam(telemetryBuild!.content).members);
  });

  test("the controller can never reach the save", async () => {
    // restore.js overwrites the real save. It is a separate entrypoint so that
    // no code path the controller runs can reach IndexedDB or a page reload —
    // an accidental import here is the difference between a bug and lost
    // progress.
    const [start] = await buildScripts(config, { telemetry: true });
    expect(start!.content).not.toContain("indexedDB");
    expect(start!.content).not.toContain("location.reload");
    expect(start!.content).not.toContain("restore-payload");
  });

  test("restore.js stays cheap and read-only against the game", async () => {
    const restore = await buildScript(config, config.restoreEntry!, { telemetry: true });
    const { total, members } = staticRam(restore.content);
    // It only inspects the live game to describe what it is about to
    // overwrite; everything destructive goes through browser globals, which
    // cost no ns RAM.
    expect(members).toEqual(["ns.getResetInfo"]);
    expect(total).toBe(BASE_GB + 1);
    expect(restore.content).toContain("indexedDB");
  });

  test("the puppet worker references only the three ops it performs", async () => {
    const artifacts = await buildScripts(config, { telemetry: true });
    const worker = artifacts.find((a) => a.filename === "worker/worker.js")!;
    // The worker is billed per launch via ramOverride (1.7 / 1.75), not by its
    // own static cost — but only because it references nothing beyond the
    // three ops. Anything else here would exceed the declared override at
    // runtime and the game would kill the worker mid-batch.
    const { members } = staticRam(worker.content);
    expect(members).toEqual(["ns.grow", "ns.hack", "ns.weaken"]);
  });
});
