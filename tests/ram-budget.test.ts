import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { buildScript, buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";
import { analyzeScriptRam, billableRamNames } from "../tools/ram-analysis.ts";
import { priceCalls, UNKNOWN_CALL_GB } from "../game/lib/dodge.ts";
import { WORKER_RAM } from "../shared/world.ts";
import type { NS } from "@ns";

/** Declared RAM is the fresh-game constraint: start.js plus a transient dodge
 * stub must fit an 8 GB home. Every assertion here runs against the artifacts
 * the sync actually pushes — minified deployment builds — through a faithful
 * port of the game's own static analyzer (tools/ram-analysis.ts), so the
 * numbers below are the numbers `ls -l` shows in game. */

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
  "ns.disableLog": 0,
  "ns.hack": 0.1,
  "ns.grow": 0.15,
  "ns.weaken": 0.15,
  "ns.share": 2.4,
};
const BASE_GB = 1.6;
/** start.js + dodge stub (1.6 + 2.5) must stay under an 8 GB home. */
const START_BUDGET_GB = 3.6;

const config: BitburnerConfig = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: `build-test-ram-${process.pid}`,
  entries: [
    { source: "game/start.ts", target: "start.js" },
    { source: "game/worker/worker.ts", target: "worker/worker.js" },
    { source: "game/dnet/scout.ts", target: "dnet/scout.js" },
  ],
  restoreEntry: { source: "game/restore.ts", target: "restore.js" },
};

afterAll(async () => {
  await rm(config.buildDir, { recursive: true, force: true });
});

/** Approximate the dynamic RAM surface: direct dotted ns member references.
 * The `ns` receiver-name convention only exists in source names, so this scan
 * runs on a names-preserved build; the surface-bridge test below proves that
 * build and the shipped minified one expose an identical billable surface. */
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

/** Occurrence counts of every billable RAM name in the two positions
 * identifier minification is forbidden to touch: property access (`.name`,
 * where the game bills it) and string literals (`"name"`, the dodge
 * bracket-call surface). Local identifiers are deliberately excluded — the
 * minifier renames those, and losing a billable local name only removes
 * accidental static charges. */
function billableSurface(source: string): Map<string, number> {
  const billable = billableRamNames();
  const counts = new Map<string, number>();
  for (const match of source.matchAll(/(?<!\.)\.([A-Za-z_$][\w$]*)|"([A-Za-z_$][\w$]*)"/g)) {
    const name = match[1] ?? match[2]!;
    if (billable.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

describe("in-game static RAM budget", () => {
  test("an unpriceable dodged method cannot be mistaken for a cheap call", () => {
    const ns = { getFunctionRamCost: () => { throw new Error("unknown method"); } } as unknown as NS;
    expect(priceCalls(ns, ["renamed.method"])).toBe(UNKNOWN_CALL_GB + 0.5);
  });

  test("the game bills the shipped start.js at exactly its declared budget", async () => {
    // This is the autostart contract: start.js is launched by the game
    // (autoexec, destroyW0r1dD43m0n) with no way to pass an override, so the
    // static analyzer itself must resolve to the declared 3.6 GB.
    const [start] = await buildScripts(config, { telemetry: true });
    const analysis = analyzeScriptRam(start!.content);
    expect(analysis.overridden).toBe(true);
    expect(analysis.cost).toBe(START_BUDGET_GB);
  });

  test("the override decoy is doing real work, not masking an empty walk", async () => {
    // Strip the appended decoy declaration and the pessimistic walk must
    // reappear; if this ever reads 3.6 without the decoy, the analyzer port
    // is broken and the previous test proves nothing.
    const [start] = await buildScripts(config, { telemetry: true });
    const withoutDecoy = start!.content.replace(/async function main\(ns\)\{ns\.ramOverride\([\d.]+\)\}\s*$/, "");
    expect(withoutDecoy.length).toBeLessThan(start!.content.length);
    const analysis = analyzeScriptRam(withoutDecoy);
    expect(analysis.overridden).toBe(false);
    expect(analysis.cost).toBeGreaterThan(START_BUDGET_GB);
  });

  test("the --perf build costs exactly the same static RAM", async () => {
    const [telemetryBuild] = await buildScripts(config, { telemetry: true });
    const [perfBuild] = await buildScripts(config, { telemetry: false });
    for (const build of [telemetryBuild!, perfBuild!]) {
      const analysis = analyzeScriptRam(build.content);
      expect(analysis.overridden).toBe(true);
      expect(analysis.cost).toBe(START_BUDGET_GB);
    }
  });

  test("identifier minification cannot move the billable surface", async () => {
    // The dynamic-surface scan below needs source receiver names, which only
    // a names-preserved build has. This bridge makes that legitimate: the
    // shipped minified bundle and the names-preserved bundle must contain
    // exactly the same billable-name occurrences, so whatever the scan proves
    // about one holds for the other. Mangled identifiers are frequency-
    // assigned short names; if one ever collides with a billable name (e.g.
    // `rm`, `ps`), the counts diverge and this fails before the game does.
    const [shipped] = await buildScripts(config, { telemetry: true });
    const [readable] = await buildScripts(config, { telemetry: true, minifyNames: false });
    // Only the shipped flavour carries the appended RAM-override decoy — the
    // names-preserved flavour provably must not (see the next test) — so it
    // is removed before comparing what the renaming itself produced.
    const decoy = "async function main(ns){ns.ramOverride(3.6)}";
    expect(shipped!.content).toContain(decoy);
    expect(billableSurface(shipped!.content.replace(decoy, ""))).toEqual(billableSurface(readable!.content));
  });

  test("a names-preserved deployment still runs the real controller", async () => {
    // Appending the RAM-override decoy to a bundle whose source `main`
    // survived minification would re-bind the bare `export { main }` to the
    // decoy: the game would import a controller that sets its override and
    // exits. The build must skip the decoy exactly when the surviving
    // declaration already satisfies the analyzer (`sync --readable` deploys
    // such bundles), and keep it when identifier minification renamed `main`.
    const decoy = "async function main(ns){ns.ramOverride(3.6)}";
    const [readable] = await buildScripts(config, { telemetry: true, minifyNames: false });
    expect(readable!.content).not.toContain(decoy);
    expect(analyzeScriptRam(readable!.content).overridden).toBe(true);
    const [shipped] = await buildScripts(config, { telemetry: true });
    expect(shipped!.content).toContain(decoy);
    expect(analyzeScriptRam(shipped!.content).overridden).toBe(true);
  });

  test("start.js stays within its fresh-game budget", async () => {
    const [start] = await buildScripts(config, { telemetry: true, minifyNames: false });
    const { total, members } = staticRam(start!.content);
    console.log(`start.js dynamic RAM <=${total.toFixed(2)}GB via ${members.join(", ")}`);
    expect(total).toBeLessThanOrEqual(START_BUDGET_GB + 1e-9);
    // The hot path must never dodge, so these two live reads are expected...
    expect(members).toContain("ns.getServerSecurityLevel");
    expect(members).toContain("ns.getServerMoneyAvailable");
    // ...and these must stay inside dodge closures (bracket notation).
    expect(members).not.toContain("ns.scp");
    expect(members).not.toContain("ns.getServer");
    expect(members).not.toContain("ns.scan");
  });

  test("the controller can never reach the save", async () => {
    // restore.js overwrites the real save. It is a separate entrypoint so that
    // no code path the controller runs can reach IndexedDB or a page reload —
    // an accidental import here is the difference between a bug and lost
    // progress. String literals survive minification, so this runs on the
    // shipped artifact.
    const [start] = await buildScripts(config, { telemetry: true });
    expect(start!.content).not.toContain("indexedDB");
    expect(start!.content).not.toContain("location.reload");
    expect(start!.content).not.toContain("restore-payload");
  });

  test("restore.js stays cheap and read-only against the game", async () => {
    const restore = await buildScript(config, config.restoreEntry!, { telemetry: true });
    // It only inspects the live game to describe what it is about to
    // overwrite; everything destructive goes through browser globals, which
    // cost no ns RAM — but window/document references do, and the game's
    // analyzer bills them here.
    const analysis = analyzeScriptRam(restore.content);
    expect(analysis.overridden).toBe(false);
    expect(analysis.entries.map((entry) => entry.name)).toEqual(["getResetInfo"]);
    expect(analysis.cost).toBe(BASE_GB + 1);
    expect(restore.content).toContain("indexedDB");
  });

  test("the puppet worker references only the ops it performs", async () => {
    const artifacts = await buildScripts(config, { telemetry: true });
    const worker = artifacts.find((a) => a.filename === "worker/worker.js")!;
    // The worker is billed per launch via ramOverride, not by its own static
    // cost — but only because it references nothing with a RAM charge beyond
    // the ops it actually invokes. Billed by the game's own analyzer: base
    // plus exactly hack, grow, weaken, share.
    const analysis = analyzeScriptRam(worker.content);
    expect(analysis.overridden).toBe(false);
    expect(analysis.entries.map((entry) => entry.name).sort()).toEqual(["grow", "hack", "share", "weaken"]);
    expect(analysis.cost).toBeCloseTo(BASE_GB + 0.1 + 0.15 + 0.15 + 2.4, 10);
  });

  test("the darknet scout stays small enough to run on a darknet host", async () => {
    const artifacts = await buildScripts(config, { telemetry: true });
    const scout = artifacts.find((a) => a.filename === "dnet/scout.js")!;
    // A darknet host's usable RAM is maxRam minus whatever its owner blocks, and
    // only `darkweb` is guaranteed a clear 16 GB. Every call here is one the
    // scout genuinely makes, and the absences are the point: no authenticate and
    // no connectToSession (it needs no session), no scp and no exec (it reports
    // through a port), and no setStasisLink, which alone would cost 12 GB.
    const analysis = analyzeScriptRam(scout.content);
    expect(analysis.overridden).toBe(false);
    expect(analysis.entries.map((entry) => entry.name).sort())
      .toEqual(["getHostname", "getServerDetails", "heartbleed", "probe"]);
    expect(analysis.cost).toBeCloseTo(BASE_GB + 0.1 + 0.6 + 0.2 + 0.05, 10);
  });

  test("a --perf scout is silent but behaviourally identical", async () => {
    const telemetryBuild = (await buildScripts(config, { telemetry: true }))
      .find((a) => a.filename === "dnet/scout.js")!;
    const perfBuild = (await buildScripts(config, { telemetry: false }))
      .find((a) => a.filename === "dnet/scout.js")!;
    // The socket is gone, so the observed-vs-known gap disappears from the UI...
    expect(telemetryBuild.content).toContain("WebSocket");
    expect(perfBuild.content).not.toContain("WebSocket");
    // ...but the scout still probes the same hosts, still charges the same RAM,
    // and still writes the same report to the same port. That is the proof the
    // agent's own telemetry is never load-bearing.
    //
    // The two builds do NOT have identical name surfaces, and should not:
    // getScriptName and the atExit that initTelemetry registers exist only to
    // label and flush the send, so a perf build is right to drop them. Both are
    // 0 GB, so the charge is unchanged.
    const charged = (source: string) => analyzeScriptRam(source).entries.map((e) => e.name).sort();
    expect(charged(perfBuild.content)).toEqual(charged(telemetryBuild.content));
    expect(analyzeScriptRam(perfBuild.content).cost).toBe(analyzeScriptRam(telemetryBuild.content).cost);
    expect(perfBuild.content).toContain("tryWritePort");
    expect(perfBuild.content).not.toContain("getScriptName");
  });

  test("every worker ramOverride covers the base plus the call it makes", () => {
    // The game charges DYNAMIC RAM against `ramOverride`, starting from the
    // 1.6 GB script base. An override that omits the base kills the worker on
    // its first ns call with "Dynamic RAM usage calculated to be greater than
    // initial RAM usage" — invisible in the simulator, which does not model
    // the dynamic check.
    for (const kind of ["hack", "grow", "weaken", "share"] as const) {
      expect(WORKER_RAM[kind]).toBeGreaterThanOrEqual(BASE_GB + RAM_COSTS[`ns.${kind}`]! - 1e-9);
    }
  });
});
