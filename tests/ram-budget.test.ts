import { afterAll, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { buildScript, buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";
import { analyzeScriptRam, billableRamNames } from "../tools/ram-analysis.ts";
import { CONTROLLER_CALLS, KIND_CALLS, PROBER_CALLS, threadsFor, type OrderKind } from "../game/dnet/shared.ts";
import { getFunctionRamCost } from "../sim/ns/ram-costs.ts";
import { priceCalls, UNKNOWN_CALL_GB } from "../game/lib/dodge.ts";

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
const START_BUDGET_GB = 3.6;

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
   * `overseer.ts` would pass here and then die on its first call, because that
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
    const overseer = artifacts.find((a) => a.filename === "dnet/controller.js")!;
    const analysis = analyzeScriptRam(overseer.content);
    expect(analysis.overridden).toBe(false);

    // STATIC figure stays base + one getter: the overseer's own reads
    // (`probe`, `getServerDetails`, `getServerMaxRam`, `isRunning`,
    // `kill`) are all BRACKET notation, so the analyser does not charge them and
    // the static number is unchanged. The launch allocation is
    // `priceAgent(CONTROLLER_METHODS)` (~2 GB), which is what actually covers the
    // dynamic cost of those reads.
    const referenced = analysis.entries
      .map((entry) => entry.name)
      .filter((name) => !MANGLE_COLLISIONS.includes(name))
      .sort();
    expect(referenced).toEqual(["getServerMaxRam"]);
    // The overseer now OBSERVES — but only through SYNCHRONOUS, instant reads
    // (`probe` for darkweb's own adjacency, `getServerDetails` + `getServerMaxRam`
    // for any host from anywhere), never a blocking `authenticate`. The map-holder
    // stays responsive; "never block" is preserved, "never observe" relaxed.
    expect(CONTROLLER_METHODS).toEqual([
      "isRunning",
      "kill",
      "dnet.probe",
      "dnet.getServerDetails",
      "dnsLookup",
      "getServerMaxRam",
    ]);
    expect(getFunctionRamCost("getServerMaxRam")).toBe(0.05);

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

    // Same discipline as lib/dodge-stub.js: the file references only what it
    // needs to be a RESIDENT, and every job's cost arrives as a ramOverride at
    // spawn time. If a job's calls appeared here, every resident on every host
    // would pay for the most expensive thing any of them might ever do.
    expect(
      analysis.entries
        .map((entry) => entry.name)
        .filter((name) => !MANGLE_COLLISIONS.includes(name))
        .sort(),
    ).toEqual(["spawn"]);
    // getScriptName is 0 GB, so it never appears in a BILLABLE list — the agent
    // uses it to spawn itself rather than carrying its own filename.
    expect(agent.content).toContain("getScriptName");
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
    // member of PROBER_METHODS but never a billed entry. Critically ABSENT are
    // `spawn` (2.0) and `getServerMaxRam` (0.05): the prober carries no self-
    // revival, so its whole cost is base + probe = exactly 1.8 GB. The overseer
    // re-execs a dead one through its worker instead.
    expect(
      analysis.entries
        .map((entry) => entry.name)
        .filter((name) => !MANGLE_COLLISIONS.includes(name))
        .sort(),
    ).toEqual(["probe"]);
    expect(PROBER_METHODS).toEqual(["dnet.probe", "dnet.nextMutation"]);
    // base 1.6 + probe 0.2, and NOTHING else — the reserve every host holds.
    expect(BASE_GB + getFunctionRamCost("dnet.probe")).toBe(1.8);
    const names = new Set(analysis.entries.map((entry) => entry.name));
    for (const forbidden of ["spawn", "getServerMaxRam", "getServerDetails", "heartbleed", "authenticate", "connectToSession", "scp", "exec"]) {
      expect(names.has(forbidden), `prober must not reference ns.${forbidden} in source`).toBe(false);
    }
  });

  test("the declared method lists cover every call the job bodies make", async () => {
    // THE test that keeps this design honest. A job's allocation is declared by
    // the controller from `JOB_METHODS`, but the calls are made by the bodies in
    // game/dnet/jobs.ts, and the two are connected only by these lists. Get one
    // wrong and the engine kills the process on its first unlisted call.
    //
    // The simulator cannot catch that — it does not model the dynamic-RAM check
    // — so an under-declared job runs perfectly in a sim run and dies in the
    // game. Reading the source is the only place the drift is visible.
    //
    // Every file in the directory, not one named file: the bodies moved out of
    // overseer.ts once and a grep pinned to a filename would have gone quietly
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
      if (slice.includes("listingOn(") || listed) wanted.add("ls");
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
    // The whole 1.65 GB scheme rests on esbuild leaving `x["dnet"]["probe"]()`
    // alone. A `minifySyntax` flag would rewrite it to `x.dnet.probe()`, which
    // the game's analyser bills — silently moving the entire job surface onto
    // the controller. The source-level greps above cannot see that, because it
    // happens after them; only the artifact can.
    const artifacts = await buildScripts(config, { telemetry: true });
    const overseer = artifacts.find((a) => a.filename === "dnet/controller.js")!;
    expect(overseer.content).toContain('["dnet"]');
    // ...and the same for the two ordinary getters a job describes a host with,
    // which have no `dnet` prefix to hide behind.
    expect(overseer.content).toContain('["getServerMaxRam"]');
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
    const residentGb = cost(RESIDENT_METHODS);
    const plantGb = cost(JOB_METHODS["plant"]!);

    expect(controllerGb + residentGb).toBeLessThanOrEqual(16);
    expect(controllerGb + plantGb).toBeLessThanOrEqual(16);

    // And the whole reason for spawning rather than exec'ing: a resident that
    // exec'd its jobs would need BOTH at once. Spawn costs 2.0 against exec's
    // 1.3 but frees the caller first, so a host's peak is a max, not a sum.
    const execPeak = cost([...RESIDENT_METHODS.filter((method) => method !== "spawn"), "exec"])
      + cost(JOB_METHODS["plant"]!.filter((method) => method !== "spawn"));
    expect(plantGb).toBeLessThan(execPeak);

    // Every ROUTINE kind has to fit beside the controller on `darkweb`, because
    // that is the one host home can reach and the only one it can re-seed.
    for (const kind of ROUTINE_JOB_KINDS) {
      const methods = JOB_METHODS[kind];
      if (!methods) continue;
      expect(controllerGb + cost(methods), `${kind} does not fit darkweb beside the controller`)
        .toBeLessThanOrEqual(16);
    }
  });

  test("normal hosts reserve the prober and lab walkers consume the clear host", () => {
    const cost = (methods: readonly string[]): number => {
      let total = BASE_GB;
      for (const method of new Set(methods)) total += getFunctionRamCost(method);
      return total;
    };
    expect(cost(RESIDENT_METHODS)).toBe(3.6);
    expect(BASE_GB + getFunctionRamCost("dnet.probe")).toBe(1.8);
    expect(cost(BOOTSTRAP_RECLAIM_METHODS)).toBe(2.6);
    expect(cost(JOB_METHODS["attempt"]!)).toBeCloseTo(4.7, 10);
    expect(cost(JOB_METHODS["walk"]!)).toBe(2);
    expect(JOB_METHODS["walk"]).not.toContain("dnet.getServerDetails");

    const ordinaryRoom = 16 - 1.8;
    expect(threadsForJob(ordinaryRoom, cost(JOB_METHODS["attempt"]!), true)).toBe(3);
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
    const proberGb = BASE_GB + getFunctionRamCost("dnet.probe");

    expect(getFunctionRamCost("dnet.setStasisLink")).toBe(12);
    expect(pinGb).toBeGreaterThan(16 - controllerGb);

    // THE EXCEPTION, encoded rather than loosened. `pin` is the only kind whose
    // method list omits `spawn`, and that is not an economy: with the 2.0 GB
    // spawn back it would be over 16 GB and could not run on a shallow darknet
    // host AT ALL. Without it the job's process simply ends and leaves the host
    // empty for `planSpread` to re-plant — which is safe only because the pin
    // has just made that host immutable, and which the controller refuses by
    // name when no neighbour could re-plant it.
    expect(JOB_METHODS["pin"]).not.toContain("spawn");
    expect(pinGb + proberGb).toBeLessThanOrEqual(16);
    expect(pinGb + proberGb + getFunctionRamCost("spawn")).toBeGreaterThan(16);
    // The two NO_RESPAWN kinds omit `spawn` and end by handing the host to
    // `planSpread` to re-plant: `pin` because 12 GB + spawn will not fit a shallow
    // host, `walk` because while it IS the lab walker its host runs it alone and
    // every byte the spawn would cost is an `authenticate` thread instead.
    expect(JOB_METHODS["walk"]).not.toContain("spawn");
    // Every other kind hands the host back itself, because nothing outside can put
    // a resident there mid-run.
    for (const [kind, methods] of Object.entries(JOB_METHODS)) {
      // `pin`/`walk` are NO_RESPAWN; `bootstrapReclaim` is the spawn-free local
      // reclaimer (it ends and the controller re-execs); `idle` IS the resident.
      if (kind === "pin" || kind === "walk" || kind === "bootstrapReclaim" || kind === "idle") continue;
      expect(methods, `${kind} must be able to spawn back to resident mode`).toContain("spawn");
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
