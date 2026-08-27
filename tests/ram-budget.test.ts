import { afterAll, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { buildScript, buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";
import { analyzeScriptRam, billableRamNames } from "../tools/ram-analysis.ts";
import {
  ATTEMPT_LEAN_GB, CONTROLLER_CALLS, CONTROLLER_GB, KIND_CALLS, ORDER_PRICES,
  PROBER_ARMOURED_CALLS, PROBER_ARMOURED_GB,
  PROBER_CALLS, PROBER_GB, PROBER_STASIS_CALLS, PROBER_STASIS_GB,
  SCRIPT_BASE_GB, orderCalls, priceOf, threadsFor, type OrderKind,
} from "../game/dnet/shared.ts";

/** The engine's own charge for a call set, base included. */
const priceOfCalls = (calls: readonly string[]): number => {
  let total = SCRIPT_BASE_GB;
  for (const call of new Set(calls)) total += getFunctionRamCost(call);
  return Math.round(total * 1e6) / 1e6;
};
import { getFunctionRamCost } from "../sim/ns/ram-costs.ts";
import { priceCall, UNKNOWN_CALL_GB } from "../game/lib/ns-proxy.ts";
import { nsMainGlobal } from "../game/lib/ns-proxy-shared.ts";
import { START_SCRIPT_GB } from "../game/lib/proxies.ts";
import { DEFAULT_SPREAD_LIMITS } from "../shared/strategy/dnet/plan.ts";

/** The order kinds that run as an ORDER (through the agent switch), i.e. every
 * kind except resident `idle` and the spawn-free `bootstrapReclaim`. */
const JOB_KINDS = (Object.keys(KIND_CALLS) as OrderKind[]).filter((k) => k !== "idle" && k !== "bootstrapReclaim");
/** The heaviest thing a host does as a matter of course (excludes one-off pins). */
const ROUTINE_JOB_KINDS: readonly OrderKind[] = ["inventory", "bleed", "attempt", "plant", "cache", "reclaim", "phish"];
/** Back-compat aliases so the assertions below read unchanged. */
const CONTROLLER_METHODS = CONTROLLER_CALLS;
const RESIDENT_METHODS = KIND_CALLS.idle;
const PROBER_METHODS = PROBER_CALLS;
const BOOTSTRAP_RECLAIM_METHODS = KIND_CALLS.bootstrapReclaim;
const JOB_METHODS = KIND_CALLS as Readonly<Record<string, readonly string[]>>;
const threadsForJob = threadsFor;
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
/** Single-sourced with the bootstrap arithmetic, so the two cannot drift:
 * home's 5.1 GB bootstrap window is 8 GB minus exactly this. */
const START_BUDGET_GB = START_SCRIPT_GB;

const config: BitburnerConfig = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: `build-test-ram-${process.pid}`,
  entries: [
    { source: "game/start.ts", target: "start.js" },
    { source: "game/worker/worker.ts", target: "worker/worker.js" },
    { source: "game/dnet/controller.ts", target: "dnet/controller.js" },
    { source: "game/dnet/agent.ts", target: "dnet/agent.js" },
    { source: "game/dnet/prober.ts", target: "dnet/prober.js" },
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
  test("the deployed attempt surface has no formulas timing call", () => {
    expect(KIND_CALLS.attempt).not.toContain("formulas.dnet.getAuthenticateTime");
  });

  test("an unpriceable proxied method cannot be mistaken for a cheap call", () => {
    const held = nsMainGlobal().nsMain;
    nsMainGlobal().nsMain = { getFunctionRamCost: () => { throw new Error("unknown method"); } } as unknown as NS;
    try {
      expect(priceCall("renamed.method")).toBe(UNKNOWN_CALL_GB);
    } finally {
      nsMainGlobal().nsMain = held;
    }
  });

  test("the game bills the shipped start.js at exactly its declared budget", async () => {
    // This is the autostart contract: start.js is launched by the game
    // (autoexec, destroyW0r1dD43m0n) with no way to pass an override, so the
    // static analyzer itself must resolve to the declared 2.9 GB.
    const [start] = await buildScripts(config, { telemetry: true });
    const analysis = analyzeScriptRam(start!.content);
    expect(analysis.overridden).toBe(true);
    expect(analysis.cost).toBe(START_BUDGET_GB);
  });

  test("the override decoy is doing real work, not masking an empty walk", async () => {
    // Strip the appended decoy declaration and the pessimistic walk must
    // reappear; if this ever reads 2.9 without the decoy, the analyzer port
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
    const decoy = "async function main(ns){ns.ramOverride(2.9)}";
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
    const decoy = "async function main(ns){ns.ramOverride(2.9)}";
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
    // start.js's whole billable surface, exhaustively, because the ns proxy's
    // entire value is that this list does not grow. Each entry is deliberate:
    //
    //  - `exec` is the ONE member the bundle owns on purpose. Every resident is
    //    launched through it and every proxied `exec` routes back to it, so the
    //    bundle pays 1.3 GB once and residents never pay it at all.
    //  - `disableLog` is free.
    //
    // Nothing else. The hot-target live reads and the cadenced `getPlayer`
    // were the last holdouts, kept out of the proxy by a rule inherited from
    // the DODGER — "never dodge inside a timing-critical window" — which
    // priced a throwaway stub process per call. A warm resident is a
    // microtask, so they went through the proxy too and took 0.7 GB with
    // them.
    //
    // Anything else appearing here is a leak — see the next test for why that
    // is so easy to do by accident.
    expect(new Set(members)).toEqual(new Set(["ns.disableLog", "ns.exec"]));
  });

  test("no source file compiled into start.js names an ns member as a property", async () => {
    // THE backstop for the proxy's one rule. Bitburner charges by member NAME
    // across the whole bundle whatever the receiver, so a dotted `ns.getServer`
    // — or merely a local helper called `run`, or a `.exec` on a RegExp — bills
    // start.js for a member nobody meant to buy.
    //
    // This is not hypothetical. Before the migration, `career.ts` and
    // `factions.ts` each defined `const run = async (methods, body) => …` as
    // the dodge idiom itself, silently billing `ns.run`'s 1 GB; and
    // `hacking.ts` wrote `stubNs.scan(current)` dotted inside a dodge closure,
    // billing 0.2 GB. Both survived review for months because nothing checked.
    const [start] = await buildScripts(config, { telemetry: true, minifyNames: false });
    const { members } = staticRam(start!.content);
    const allowed = new Set(["ns.disableLog", "ns.exec"]);
    const leaked = members.filter((member) => !allowed.has(member));
    expect(leaked).toEqual([]);
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
    // plus exactly hack, grow, weaken, share, and Stanek charge.
    const analysis = analyzeScriptRam(worker.content);
    expect(analysis.overridden).toBe(false);
    expect(analysis.entries.map((entry) => entry.name).sort()).toEqual([
      "chargeFragment", "grow", "hack", "share", "weaken",
    ]);
    expect(analysis.cost).toBeCloseTo(BASE_GB + 0.4 + 0.1 + 0.15 + 0.15 + 2.4, 10);
  });

  /** Billable names short enough for the minifier to invent by accident.
   *
   * The game's analyser bills any IDENTIFIER matching a billable member, a
   * mangled local included — and esbuild assigns short names by frequency, so a
   * module-level const can land on a two-character billable name. Only these two
   * are reachable that way (every other billable member is three characters or
   * more), both are cheap getters, and neither is a member the darknet artifacts
   * are forbidden to reference by design.
   *
   * This is a false positive rather than a cost. Unlike start.js — which the
   * game autoexecs with no override, so its static number IS its allocation —
   * both darknet artifacts are launched by us with an explicit `ramOverride`
   * (`priceAgent(ns, CONTROLLER_METHODS)` and `RESIDENT_METHODS`), and the engine
   * then charges DYNAMIC RAM against that override, counting calls actually
   * made. A variable that happens to be spelled `ls` is not a call to `ns.ls`,
   * so it costs nothing at runtime. What must hold for these two is that each
   * process's real calls fit its declared override, which the JOB_METHODS tests
   * below check against the source.
   *
   * Filtering them out is a hole, though, and the test below it closes: with `ls`
   * struck from the built artifact's list, a REAL `ns.ls(...)` added to
   * `controller.ts` would pass here and then die on its first call, because that
   * member is absent from the controller's declared dynamic-RAM surface.
   * So the allowance is paired with a source check that only `jobNs` — the ns a
   * job body is HANDED, which carries its own override — may reach them. */
  const MANGLE_COLLISIONS = ["ls", "ps"];

  test("only a job body reaches the members the minifier can forge", async () => {
    // Every file in the directory, for the reason the JOB_METHODS test gives:
    // they all bundle into the same two artifacts, so the rule is a property of
    // the directory rather than of a filename.
    const names = await readdir("game/dnet");
    for (const name of names.filter((file) => file.endsWith(".ts"))) {
      // Comments stripped first: these files explain the members they must not
      // call, at length, and prose naming `ns.ls` is documentation rather than a
      // call.
      const source = (await readFile(`game/dnet/${name}`, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const member of MANGLE_COLLISIONS) {
        const reaches = new RegExp(`(\\w+)(?:\\.${member}\\b|\\[\\s*"${member}"\\s*\\])`, "g");
        for (const match of source.matchAll(reaches)) {
          expect(
            match[1],
            `game/dnet/${name} reaches .${member} on ${match[1]}; only jobNs may, because `
              + `MANGLE_COLLISIONS filters ${member} out of the static check`,
          ).toBe("jobNs");
        }
      }
    }
  });

  test("the darknet controller decides and cannot act", async () => {
    const artifacts = await buildScripts(config, { telemetry: true });
    const controller = artifacts.find((a) => a.filename === "dnet/controller.js")!;
    const analysis = analyzeScriptRam(controller.content);
    expect(analysis.overridden).toBe(false);

    // NOTHING is referenced by name. The controller's own reads
    // (`getServerDetails`, `getServerMaxRam`, `getServerUsedRam`, `isRunning`,
    // `kill`) all go through a borrowed `ns` in BRACKET notation, so they are
    // billed to the lender rather than to this process.
    //
    // This list used to hold `getServerMaxRam`, for a dotted call at the top of
    // the main loop whose result was thrown away. That was fatal, and silently:
    // the launch allocation is `CONTROLLER_GB` (1.6, base plus a free mutation
    // clock), while `WorkerScript.dynamicRamUsage` STARTS at the 1.6 base and
    // adds each distinct member as it is called — so the first `getServerMaxRam`
    // reached 1.65 against a 1.6 allocation and the engine killed the controller
    // on its first iteration. The simulator does not model the dynamic check, so
    // every test passed.
    // Source: bitburner-src/src/Netscript/WorkerScript.ts (dynamicRamUsage =
    // RamCostConstants.Base) and NetscriptHelpers.tsx updateDynamicRam.
    const referenced = analysis.entries
      .map((entry) => entry.name)
      .filter((name) => !MANGLE_COLLISIONS.includes(name))
      .sort();
    expect(referenced).toEqual([]);
    // The allocation must cover the base and nothing more, which is only true
    // while the controller references no billable member of its own.
    expect(CONTROLLER_GB).toBe(SCRIPT_BASE_GB);
    // The controller owns ONE call, and it is the mutation clock.
    //
    // It is the only process in the darknet that blocks, so it may own nothing
    // else: while parked in `dnet.nextMutation` its `env.runningFn` is held and
    // a second call of its own would throw. Every read and every launch it
    // performs goes through a prober's borrowed `ns` — another script's slot,
    // another script's allocation — which is what makes being parked here free.
    expect(CONTROLLER_METHODS).toEqual(["dnet.nextMutation"]);
    expect(getFunctionRamCost("getServerMaxRam")).toBe(0.05);
    expect(getFunctionRamCost("getServerUsedRam")).toBe(0.05);

    // The ABSENCES that remain the design: it can OBSERVE now, but it still cannot
    // CRACK or LAUNCH. It describes the jobs in this very file — authenticate, scp,
    // exec — only through bracket notation on the ns it HANDS to an agent, so the
    // analyser charges the agent's override instead. A controller that could crack
    // or launch would be the process holding the only copy of the map while sitting
    // inside a multi-second authenticate on a host about to be restarted.
    const names = new Set(analysis.entries.map((entry) => entry.name));
    for (const forbidden of ["heartbleed", "authenticate", "scp", "exec", "spawn"]) {
      expect(names.has(forbidden), `controller must not reference ns.${forbidden}`).toBe(false);
    }
  });

  test("the darknet agent buys its RAM at launch, not in its source", async () => {
    const artifacts = await buildScripts(config, { telemetry: true });
    const agent = artifacts.find((a) => a.filename === "dnet/agent.js")!;
    const analysis = analyzeScriptRam(agent.content);

    // Same discipline as lib/ns-resident.js: the file references only what it
    // needs to be a RESIDENT, and every job's cost arrives as a ramOverride at
    // spawn time. If a job's calls appeared here, every resident on every host
    // would pay for the most expensive thing any of them might ever do.
    expect(
      analysis.entries
        .map((entry) => entry.name)
        .filter((name) => !MANGLE_COLLISIONS.includes(name))
        .sort(),
    ).toEqual([]);
    const names = new Set(analysis.entries.map((entry) => entry.name));
    for (const forbidden of ["probe", "getServerDetails", "heartbleed", "authenticate", "connectToSession", "scp"]) {
      expect(names.has(forbidden), `agent must not reference ns.${forbidden} in source`).toBe(false);
    }
  });

  test("the darknet prober carries only its probe surface — 1.8 GB, no safety net", async () => {
    const artifacts = await buildScripts(config, { telemetry: true });
    const prober = artifacts.find((a) => a.filename === "dnet/prober.js")!;
    const analysis = analyzeScriptRam(prober.content);

    // The prober stands on its host for ONE reason — `probe()` is host-local — and
    // its ONLY billed call is that. `nextMutation` (its clock) is 0 GB, so it is a
    // NOTHING. The prober does not make calls — it LENDS them.
    //
    // Its source references no billable member at all, because every one of
    // them is invoked by the controller through the `ns` this process publishes.
    // So the static analysis is empty and the budget is entirely a promise the
    // launcher's `ramOverride` keeps, which is exactly why it is pinned here.
    expect(
      analysis.entries
        .map((entry) => entry.name)
        .filter((name) => !MANGLE_COLLISIONS.includes(name))
        .sort(),
    ).toEqual([]);
    // `dnet.probe` scans from the CALLING host and `exec` reaches only self and
    // connected: those two cannot be made from anywhere else, and are the whole
    // reason a process stands on every host. The rest is global, lent
    // synchronously because the controller reads facts inside synchronous
    // paths that `dodge` would have had to make async.
    // ONLY the host-bound calls. `dnet.probe` scans from the calling host and
    // `exec` reaches only self and connected, so neither can be borrowed from
    // anywhere else — which is the entire reason a process stands on every
    // host. `connectToSession` is what makes an `exec` aimed at a neighbour
    // legal.
    expect(PROBER_METHODS).toEqual(["dnet.probe", "exec", "dnet.connectToSession"]);
    expect(priceOfCalls(PROBER_METHODS)).toBeCloseTo(3.15, 10);
    expect(priceOfCalls(PROBER_METHODS)).toBe(PROBER_GB);
    // Every GLOBAL call goes to the run's shared ns resident instead. A lender
    // is charged the union of everything ever called through it, so leaving
    // these on the prober would have made every host in the net pay, for ever,
    // for calls the controller makes centrally.
    for (const global of ["dnet.getServerDetails", "dnsLookup", "getServerMaxRam", "kill", "isRunning"]) {
      expect(PROBER_METHODS, `${global} is global; it belongs on the ns resident`).not.toContain(global);
    }
    // It must still never SPAWN: a lender that replaced itself would take the
    // borrowed `ns` with it mid-call.
    const names = new Set(analysis.entries.map((entry) => entry.name));
    for (const forbidden of ["spawn", "asleep", "heartbleed", "authenticate", "connectToSession", "scp"]) {
      expect(names.has(forbidden), `prober must not reference ns.${forbidden} in source`).toBe(false);
    }
  });

  test("the declared method lists cover every call the job bodies make", async () => {
    // THE test that keeps this design honest. A job's allocation is declared by
    // the controller from `JOB_METHODS`, but the calls are made by the bodies in
    // game/dnet/orders.ts, and the two are connected only by these lists. Get one
    // wrong and the engine kills the process on its first unlisted call.
    //
    // The simulator cannot catch that — it does not model the dynamic-RAM check
    // — so an under-declared job runs perfectly in a sim run and dies in the
    // game. Reading the source is the only place the drift is visible.
    //
    // Every file in the directory, not one named file: the bodies moved out of
    // controller.ts once and a grep pinned to a filename would have gone quietly
    // to zero matches rather than failing. They all bundle into the same
    // artifact, so the rule is a property of the directory.
    const sources = await Promise.all(
      (await readdir("game/dnet"))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFile(`game/dnet/${name}`, "utf8")),
    );
    const declared = new Set(Object.values(JOB_METHODS).flat());

    // The bodies reach ns only through bracket notation on the ns they are
    // HANDED, which is what keeps them free to the controller and also what
    // makes them greppable.
    const referenced = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/jobNs\["(\w+)"\](?:\["(\w+)"\])?(?:\["(\w+)"\])?/g)) {
        referenced.add([match[1], match[2], match[3]].filter(Boolean).join("."));
      }
    }
    expect(referenced.size).toBeGreaterThan(4);
    for (const method of referenced) {
      expect(declared.has(method), `JOB_METHODS is missing ns.${method}, which a job body calls`).toBe(true);
    }
  });

  test("each order kind declares the calls ITS OWN body makes", async () => {
    // The union check above is necessary and not sufficient: `reclaim` was once
    // written calling `describeHost(..., true)` — a cache listing — while its own
    // method list omitted `ls`. Every referenced member was declared SOMEWHERE,
    // so the union check passed, and the job would have died on its first `ls`.
    //
    // So the attribution is done per KIND. The order bodies live in
    // `game/dnet/orders.ts` (a `<name>Order` function per kind, tied to a kind by
    // the `runOrder` switch), except `attempt`/`walk`, which are their own files
    // (`attempt.ts`/`walk.ts`) dispatched by the switch. `describeHost` and
    // `listingOn` are shared helpers whose reach a caller inherits.
    const ordersSrc = await readFile("game/dnet/orders.ts", "utf8");
    const attemptSrc = await readFile("game/dnet/attempt.ts", "utf8");
    const walkSrc = await readFile("game/dnet/walk.ts", "utf8");

    // kind -> the function the switch dispatches to.
    const dispatched = new Map<string, string>();
    for (const match of ordersSrc.matchAll(/case "(\w+)":\s*return (\w+)\(/g)) dispatched.set(match[1]!, match[2]!);

    // Where each `<name>Order` function starts, to slice one body out.
    const starts = [...ordersSrc.matchAll(/^(?:async )?function (\w+Order)\(/gm)]
      .map((match) => ({ name: match[1]!, at: match.index! }));

    const DESCRIBE = "dnet.getServerDetails";

    const surfaceOf = (slice: string): Set<string> => {
      const wanted = new Set<string>();
      for (const match of slice.matchAll(/jobNs\["(\w+)"\](?:\["(\w+)"\])?(?:\["(\w+)"\])?/g)) {
        wanted.add([match[1], match[2], match[3]].filter(Boolean).join("."));
      }
      if (slice.includes("describeHost(")) wanted.add(DESCRIBE);
      // Shift for the `deps` argument at position 3: withListing is arg 4,
      // withIdentity is arg 5. Line-bounded so a later `true` is not misread.
      const listed = /describeHost\(\s*jobNs\s*,\s*[^,\r\n)]+\s*,\s*[^,\r\n)]+\s*,\s*true(?:\s*,|\s*\))/.test(slice);
      const identified = /describeHost\(\s*jobNs\s*,\s*[^,\r\n)]+\s*,\s*[^,\r\n)]+\s*,\s*(?:true|false)\s*,\s*true\s*\)/.test(slice);
      // `listingOn` does not just list: it READS every darknet data file it
      // walks past and REMOVES it (and every `.lit`), so a caller inherits the
      // whole `ls`/`read`/`rm` surface, not just the `ls`.
      if (slice.includes("listingOn(") || listed) {
        wanted.add("ls");
        wanted.add("read");
        wanted.add("rm");
      }
      if (identified) wanted.add("dnsLookup");
      return wanted;
    };

    for (const kind of JOB_KINDS) {
      let slice: string;
      if (kind === "attempt") slice = attemptSrc;
      else if (kind === "walk") slice = walkSrc;
      else {
        const fn = dispatched.get(kind);
        expect(fn, `orders.ts switch must dispatch "${kind}"`).toBeDefined();
        const index = starts.findIndex((entry) => entry.name === fn);
        expect(index, `${fn} should be a top-level order body`).toBeGreaterThanOrEqual(0);
        const from = starts[index]!.at;
        const to = index + 1 < starts.length ? starts[index + 1]!.at : ordersSrc.length;
        slice = ordersSrc.slice(from, to);
      }
      const declared = new Set(KIND_CALLS[kind]);
      for (const method of surfaceOf(slice)) {
        expect(
          declared.has(method),
          `KIND_CALLS.${kind} is missing ns.${method}, which its body calls — the engine kills the process on it`,
        ).toBe(true);
      }
    }
  });

  test("the shipped controller still reaches ns by BRACKET, not by dot", async () => {
    // The whole scheme rests on esbuild leaving `x["dnet"]["probe"]()` alone.
    // A `minifySyntax` flag would rewrite it to `x.dnet.probe()`, which the
    // game's analyser bills — silently moving the entire job surface onto the
    // controller. The source-level greps above cannot see that, because it
    // happens after them; only the artifact can.
    const artifacts = await buildScripts(config, { telemetry: true });
    const controller = artifacts.find((a) => a.filename === "dnet/controller.js")!;
    expect(controller.content).toContain('["dnet"]');
    // `exec` is the other one, borrowed from the host's own prober because it
    // reaches only self and connected. It has no `dnet` prefix to hide behind,
    // so a rewrite to `x.exec(...)` would bill this bundle 1.3 GB against a
    // 1.6 GB allocation and kill the controller on its first launch.
    expect(controller.content).toContain('["exec"]');
    // Nothing else is borrowed. Every GLOBAL read — `getServerDetails`,
    // `dnsLookup`, `getServerMaxRam`, `kill`, `isRunning` — goes to the run's
    // shared ns resident through `nsp`, so it is billed to that resident and
    // never appears here at all.
    for (const global of ["getServerMaxRam", "getServerUsedRam", "dnsLookup", "isRunning"]) {
      expect(controller.content, `${global} should go through nsp`).not.toContain(`["${global}"]`);
    }
  });

  test("a resident and the heaviest job both fit a darknet host", () => {
    // `darkweb` is the one darknet host guaranteed a clear 16 GB, and it has to
    // hold the controller AND a resident at once. After that a host holds one
    // agent at a time, because a job SPAWNS from the resident rather than
    // running beside it.
    //
    // Priced through `getFunctionRamCost`, which is what `priceAgent` itself
    // calls. The local table above has no `dnet.*` entries and its `?? 0`
    // fallback silently valued every darknet call at nothing — so this test
    // passed by pricing `plant` at a third of its real size, and would have gone
    // on passing for a 12 GB `setStasisLink`.
    const cost = (methods: readonly string[]): number => {
      let total = BASE_GB;
      for (const method of new Set(methods)) total += getFunctionRamCost(method);
      return total;
    };
    const controllerGb = cost(CONTROLLER_METHODS);
    const proberGb = BASE_GB + getFunctionRamCost("dnet.probe");
    const residentGb = cost(RESIDENT_METHODS);
    const plantGb = cost(JOB_METHODS["plant"]!);

    expect(controllerGb + proberGb + residentGb).toBeLessThanOrEqual(16);
    expect(controllerGb + proberGb + plantGb).toBeLessThanOrEqual(16);

    // And the whole reason for spawning rather than exec'ing: a resident that
    // exec'd its jobs would need BOTH at once. Spawn costs 2.0 against exec's
    // 1.3 but frees the caller first, so a host's peak is a max, not a sum.
    const execPeak = cost([...RESIDENT_METHODS.filter((method) => method !== "spawn"), "exec"])
      + cost(JOB_METHODS["plant"]!.filter((method) => method !== "spawn"));
    expect(plantGb).toBeLessThan(execPeak);

    // Every ROUTINE kind has to fit beside the controller and dedicated prober
    // on `darkweb`, because
    // that is the one host home can reach and the only one it can re-seed.
    for (const kind of ROUTINE_JOB_KINDS) {
      const methods = JOB_METHODS[kind];
      if (!methods) continue;
      expect(controllerGb + proberGb + cost(methods), `${kind} does not fit darkweb beside its controller and prober`)
        .toBeLessThanOrEqual(16);
    }
  });

  test("normal hosts reserve the prober and lab walkers consume the clear host", () => {
    const cost = (methods: readonly string[]): number => {
      let total = BASE_GB;
      for (const method of new Set(methods)) total += getFunctionRamCost(method);
      return total;
    };
    // A resident is a bare script now — 1.6 and nothing else — because there is
    // no resident. The kind survives only as a price nothing launches.
    expect(cost(RESIDENT_METHODS)).toBe(1.6);
    expect(BASE_GB + getFunctionRamCost("dnet.probe")).toBe(1.8);
    expect(cost(BOOTSTRAP_RECLAIM_METHODS)).toBe(2.6);
    // 4.75 is the CONVERSATIONAL price: a solve that must read the target's
    // log ring carries `heartbleed` beside its `authenticate`. It also carries
    // `connectToSession` (0.05), so a password can be checked instantly against
    // an already-rooted host instead of spending seconds of `authenticate`.
    expect(cost(JOB_METHODS["attempt"]!)).toBeCloseTo(2.6, 10);
    // Everything else is LEAN. One script runs one Netscript call at a time, so
    // an attempt cannot bleed while it authenticates — and the kind is
    // thread-scaled, so declaring both charged 0.6 GB on every thread for a
    // call most attempts never make.
    const leanCalls = JOB_METHODS["attempt"]!.filter((call) => call !== "dnet.heartbleed");
    expect(cost(leanCalls)).toBeCloseTo(ATTEMPT_LEAN_GB, 10);
    expect(priceOf("attempt", false)).toBe(ATTEMPT_LEAN_GB);
    expect(priceOf("attempt", true)).toBeGreaterThan(ATTEMPT_LEAN_GB);
    expect(cost(JOB_METHODS["walk"]!)).toBe(2);
    expect(JOB_METHODS["walk"]).not.toContain("dnet.getServerDetails");

    // What the launcher move bought, as a number. The worker no longer carries
    // `spawn`, so its 2.0 GB left the PER-THREAD price entirely: it is paid once
    // per host by the prober's `exec` instead of once per thread here. Threads
    // are the only thing that shortens an `authenticate`.
    // SIX, where the spawn-chained worker managed three. `attempt` is now base
    // plus its one call and nothing else: no `spawn` (the controller launches
    // it), no `connectToSession` (instant, and the controller tries it through
    // a prober before dispatching anything), no `getServerDetails` (the
    // controller's map is in the realm, for nothing). Threads are the only
    // thing that shortens an `authenticate`, so every byte taken off the
    // per-thread price is crack speed.
    const ordinaryRoom = 16 - PROBER_GB;
    expect(ATTEMPT_LEAN_GB).toBe(BASE_GB + getFunctionRamCost("dnet.authenticate"));
    expect(threadsForJob(ordinaryRoom, ATTEMPT_LEAN_GB, true)).toBe(6);
    expect(threadsForJob(16 - 1.8, 4.15, true), "the old spawn-chained price").toBe(3);
    expect(threadsForJob(16, cost(JOB_METHODS["walk"]!), true)).toBe(8);
  });

  test("a 12 GB stasis link is why the RAM target is not simply the largest job", () => {
    // A stated deployment fact rather than a surprise. `setStasisLink` alone is
    // 12 GB, so a pin job nearly fills a shallow host once its 1.8 GB prober is
    // included. It also does not fit `darkweb` beside the controller.
    //
    // That is survivable for a deliberate one-off, and fatal as a net-wide
    // target: `planFarm`'s `wantedGb` is "the heaviest thing a host should be
    // able to hold", so taking it over every declared kind would mark the whole
    // net cramped and set the reclaim ladder grinding everywhere. Hence
    // ROUTINE_JOB_KINDS, and hence this test naming the number.
    const cost = (methods: readonly string[]): number => {
      let total = BASE_GB;
      for (const method of new Set(methods)) total += getFunctionRamCost(method);
      return total;
    };
    const pinGb = cost(JOB_METHODS["pin"]!);
    const controllerGb = cost(CONTROLLER_METHODS);
    const proberGb = cost(PROBER_METHODS);

    expect(getFunctionRamCost("dnet.setStasisLink")).toBe(12);
    expect(pinGb).toBeGreaterThan(16 - proberGb);

    // THE EXCEPTION, encoded rather than loosened. `pin` is the only kind whose
    // method list omits `spawn`, and that is not an economy: with the 2.0 GB
    // spawn back it would be over 16 GB and could not run on a shallow darknet
    // host AT ALL. Without it the job's process simply ends and leaves the host
    // empty for `planSpread` to re-plant — which is safe only because the pin
    // has just made that host immutable, and which the controller refuses by
    // name when no neighbour could re-plant it.
    expect(JOB_METHODS["pin"]).not.toContain("spawn");
    // A pin no longer clears a 16 GB host beside the prober, and that is the
    // point rather than a regression: the prober absorbed the resident and got
    // bigger, so `pin` DISPLACES it exactly as `walk` does. Both jobs need
    // every byte and both end by leaving the host empty for `planSpread`, so
    // the prober beside them is killed rather than reserved around. Reserving
    // anyway would simply have stopped stasis-linking shallow hosts — which is
    // how the labyrinth walk gets set up.
    expect(pinGb + proberGb).toBeGreaterThan(16);
    expect(pinGb).toBeLessThanOrEqual(16);
    // NO kind spawns. `pin` and `walk` were the two exceptions — they needed
    // every byte and ended by handing the host to `planSpread` — and the
    // launcher move made every kind look like them: the controller execs each
    // worker through the host's prober `ns`, so none of them ever has to become
    // the next order.
    for (const [kind, methods] of Object.entries(JOB_METHODS)) {
      expect(methods, `${kind} still carries a launcher`).not.toContain("spawn");
    }
    // ...and every routine kind is comfortably under it, which is the gap the
    // routine set exists to preserve.
    for (const kind of ROUTINE_JOB_KINDS) {
      const methods = JOB_METHODS[kind];
      if (methods) expect(cost(methods)).toBeLessThan(pinGb);
    }
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

describe("the written-down price table", () => {
  // `ORDER_PRICES` is literals, so the darknet's whole RAM budget is readable
  // on one screen instead of being a boot-time side effect. That only stays
  // true if the numbers are true — this is what makes a game update or an
  // edited `KIND_CALLS` fail the build rather than silently mis-size a launch.
  test("every entry matches what the engine actually charges", () => {
    for (const kind of Object.keys(KIND_CALLS) as OrderKind[]) {
      expect(ORDER_PRICES[kind], `ORDER_PRICES.${kind} is stale`)
        .toBeCloseTo(priceOfCalls(orderCalls(kind)), 6);
    }
    expect(Object.keys(ORDER_PRICES).sort()).toEqual(Object.keys(KIND_CALLS).sort());
    expect(PROBER_GB).toBe(priceOfCalls(PROBER_CALLS));
    expect(CONTROLLER_GB).toBe(priceOfCalls(CONTROLLER_CALLS));
    // The stasis prober drops `exec`: the engine's mutation guard exempts a
    // linked host, so it can never lose its processes and never needs to
    // relaunch them locally. This pin was missing, which left the one price in
    // the feature free to drift from the surface it is supposed to buy.
    expect(PROBER_STASIS_GB).toBe(priceOfCalls(PROBER_STASIS_CALLS));
    expect(PROBER_STASIS_CALLS).not.toContain("exec");
    // The armoured prober is the plain one plus `spawn`, and the 2.0 GB gap
    // between them IS the policy `planArmour` spends. Pinning both ends means a
    // game update that repriced `spawn` fails here rather than silently making
    // every armour threshold wrong.
    expect(PROBER_ARMOURED_GB).toBe(priceOfCalls(PROBER_ARMOURED_CALLS));
    expect(PROBER_ARMOURED_GB - PROBER_GB).toBeCloseTo(getFunctionRamCost("spawn"), 6);
    expect(PROBER_ARMOURED_CALLS).toContain("spawn");
    // A stasis host is exempt from the restart that armour defends against, so
    // paying for it there would be pure waste.
    expect(PROBER_STASIS_CALLS).not.toContain("spawn");
  });

  test("the planner's default limits mirror the controller's own prices", () => {
    // `shared/strategy` may not import `game/`, so `DEFAULT_SPREAD_LIMITS` is
    // literals — and literals drift. They had: the prober default said 1.8 GB
    // (the price before `exec` joined its surface) and the two resident
    // defaults still carried a 2.0 GB `spawn` no dispatched worker has owned
    // for a long time. Every sim lane and planner test plans against these, so
    // the drift silently modelled a fleet cheaper than the one we run.
    //
    // The controller spreads `DEFAULT_SPREAD_LIMITS` and overrides each field
    // from these same constants (controller.ts `SPREAD_LIMITS`); this pins the
    // defaults to what that override produces.
    expect(DEFAULT_SPREAD_LIMITS.proberRamGb).toBe(PROBER_GB);
    expect(DEFAULT_SPREAD_LIMITS.managedProberRamGb).toBe(PROBER_STASIS_GB);
    expect(DEFAULT_SPREAD_LIMITS.residentRamGb).toBe(priceOf("idle"));
    expect(DEFAULT_SPREAD_LIMITS.managedResidentRamGb).toBe(priceOf("idle"));
    expect(DEFAULT_SPREAD_LIMITS.agentRamGb).toBe(priceOf("idle") + PROBER_GB);
    expect(DEFAULT_SPREAD_LIMITS.bootstrapRamGb).toBe(priceOf("bootstrapReclaim"));
  });

  test("no worker carries a launcher, so there is only one price", () => {
    // There used to be two prices per kind, differing by exactly the 2.0 GB of
    // `spawn`: a worker that had to become the next order carried its own
    // launcher, a controller-dispatched one did not. Every worker is dispatched
    // now — the controller execs it through the host's prober `ns` — so the
    // distinction has nothing left to describe.
    //
    // `spawn` survives in exactly one place, and it is not an order: the
    // ARMOURED prober carries it to dodge `restartServer`, where it is bought
    // once per host rather than once per thread. That is the whole reason it
    // sits on the prober and not here.
    for (const [kind, methods] of Object.entries(KIND_CALLS)) {
      expect(methods, `${kind} still carries a launcher`).not.toContain("spawn");
    }
  });
});
