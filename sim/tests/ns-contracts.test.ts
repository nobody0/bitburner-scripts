import { describe, expect, test } from "bun:test";
import type { NS, ResetInfo } from "@ns";
import { SimWorld } from "../world.ts";
import { ProcessTable, ScriptDeath } from "../ns/process.ts";
import { makeSimNs, type SimNsHost } from "../ns/api.ts";
import { StockMarketSystem } from "../features/stock.ts";
import {
  resetDarknetContext,
  setDarknetContext,
} from "../vendor/bitburner/src/StockMarket/MarketAdapter.ts";
import { mulberry32 } from "../core/rng.ts";
import { FactionSystem } from "../features/factions.ts";
import { makeSingularity } from "../ns/singularity.ts";
import { GoSystem } from "../features/go-system.ts";
import { ShareSystem } from "../features/share.ts";
import { StanekSystem } from "../features/stanek.ts";
import { Fragments } from "../vendor/bitburner/src/CotMG/Fragment.ts";
import { resetUnmodeled } from "../realm/unmodeled.ts";
import { GoOpponent } from "../vendor/bitburner/src/Go/Enums.ts";
import { darkwebServerSpec } from "../network.ts";
import { DarknetSystem } from "../features/dnet.ts";

function harness(programs: string[] = [], withStock = false, bitnode = 1, withDarkweb = false): { ns: NS; host: SimNsHost; world: SimWorld } {
  const world = new SimWorld({
    seed: 1,
    bitnode,
    network: [{
      hostname: "n00dles",
      hackDifficulty: 1,
      moneyAvailable: 70_000,
      requiredHackingSkill: 1,
      serverGrowth: 3000,
      numOpenPortsRequired: 1,
      maxRam: 4,
    }, ...(withDarkweb ? [darkwebServerSpec()] : [])],
  });
  const processes = new ProcessTable(world.servers, world.clock);
  const files = new Map([
    ["home", new Set(["main.js", "NUKE.exe", ...programs])],
    ["n00dles", new Set(["child.js"])],
    ...(withDarkweb ? [["darkweb", new Set(["scout.js"])] as [string, Set<string>]] : []),
  ]);
  const host: SimNsHost = {
    world,
    clock: world.clock,
    processes,
    files,
    contents: new Map(),
    scripts: new Map(),
    network: new Map(
      withDarkweb
        ? [["home", ["n00dles", "darkweb"]], ["n00dles", ["home"]], ["darkweb", ["home"]]]
        : [["home", ["n00dles"]], ["n00dles", ["home"]]],
    ),
    ramCtx: { bitNode: bitnode },
    reset: {
      lastAugReset: 0,
      lastNodeReset: 0,
      currentNode: bitnode,
      ownedAugs: new Map(),
      ownedSF: new Map(),
      bitNodeOptions: {
        sourceFileOverrides: new Map(),
        intelligenceOverride: undefined,
        restrictHomePCUpgrade: false,
        disableGang: false,
        disableCorporation: false,
        disableBladeburner: false,
        disable4SData: false,
        disableHacknetServer: false,
        disableSleeveExpAndAugmentation: false,
      },
    } as ResetInfo,
    output: [],
    crashes: [],
  };
  const share = new ShareSystem(world);
  const factions = new FactionSystem(world, world.player, {}, share);
  host.share = share;
  host.stanek = new StanekSystem(world, world.player, factions);
  host.go = new GoSystem(world, factions, mulberry32(1));
  const process = processes.start({
    filename: "main.js",
    host: "home",
    args: [],
    threads: 1,
    ramPerThreadGb: 1,
    temporary: false,
  })!;
  if (withStock) {
    world.player.money = 1e15;
    host.stock = new StockMarketSystem(world, world.player, mulberry32(11));
  }
  if (withDarkweb) {
    // A real darknet system, so the session and connection gates are exercised
    // rather than bypassed by `host.dnet` being absent.
    host.dnet = new DarknetSystem({
      servers: world.servers,
      network: host.network,
      processes,
      generate: mulberry32(5),
      random: mulberry32(6),
      logNoise: mulberry32(7),
      bitNode: bitnode,
      fullAccess: () => bitnode === 15,
      hasProgram: () => files.get("home")?.has("DarkscapeNavigator.exe") === true,
      installedAugmentations: () => new Set(world.player.augmentations.keys()),
      allowRedPill: () => true,
      world,
      player: world.player,
      homeFiles: () => files.get("home")!,
      darknetMoneyMultiplier: () => 1,
      forgetFiles: (hostname: string) => {
        files.delete(hostname);
      },
    });
  }
  return { ns: makeSimNs(host, process), host, world };
}

describe("darkweb, the one darknet host reachable without a credential", () => {
  test("scan hides it, but it is rooted, 16 GB, and can be exec'd onto", () => {
    const { ns } = harness([], false, 1, true);

    // Upstream scan skips every DarknetServer, which is the whole reason
    // ns.dnet.probe() exists. If it leaked, darkweb would enter the fleet
    // snapshot and look like a free 16 GB worker host the game never offers.
    expect(ns.scan("home")).toEqual(["n00dles"]);

    // ...yet it IS rooted with 16 GB and nothing blocked, so a script placed
    // there runs. Both halves matter: hiding it without rooting it, or rooting
    // it without hiding it, is a different bug each way.
    expect(ns.hasRootAccess("darkweb")).toBe(true);
    expect(ns.getServerMaxRam("darkweb")).toBe(16);

    // ...but being rooted is not the same as being REACHABLE. Every darknet
    // member runs `expectDarknetAccess` first, and it throws rather than
    // refusing — so in a node with no SF15 and no DarkscapeNavigator.exe, a
    // script that reaches for darkweb dies there. Refusing quietly instead would
    // make a node without access look like one where the host is merely full.
    expect(() => ns.exec("scout.js", "darkweb", 1)).toThrow(/access to the dnet api/);

    // And rooting it did not become a general bypass: an ordinary server we have
    // not nuked still refuses.
    expect(ns.hasRootAccess("n00dles")).toBe(false);
    expect(ns.exec("child.js", "n00dles", 1)).toBe(0);
  });

  test("with access, home can exec onto darkweb — and only home can", () => {
    // The beachhead the whole feature stands on. `scp` and `exec` both
    // short-circuit their admin and session checks for darkweb, so no credential
    // is needed...
    const { ns, host } = harness([], false, 15, true);
    expect(ns.exec("scout.js", "darkweb", 1)).toBeGreaterThan(0);

    // ...but the connection check is NOT short-circuited: upstream evaluates
    // requireDirectConnection BEFORE the darkweb early-out, and only `home`
    // holds the TOR edge. This is the fact that decides where the seeding dodge
    // has to be pinned, and getting it wrong looks exactly like a full host.
    host.network.set("home", ["n00dles"]);
    host.network.set("darkweb", []);
    expect(ns.exec("scout.js", "darkweb", 1)).toBe(0);

    // scp passes no connection requirement at all, so copying still works from
    // anywhere. That asymmetry is why data is nearly free to move out there and
    // a running PROCESS is the hard problem.
    expect(ns.scp("main.js", "darkweb", "home")).toBe(true);
  });
});

describe("Netscript contract fidelity", () => {
  test("share/getSharePower expose the 10 second contribution lifecycle", async () => {
    const { ns, host } = harness();
    let done = false;
    const pending = ns.share().then(() => { done = true; });
    expect(host.share!.currentBonus()).toBeGreaterThan(1);
    expect(await host.clock.runAsync(() => done, 10_000)).toBe("goal");
    await pending;
    expect(ns.getSharePower()).toBe(1);
  });

  test("killing share releases its whole contribution", async () => {
    const { ns, host } = harness();
    const pending = ns.share();
    expect(host.share!.currentBonus()).toBeGreaterThan(1);
    host.processes.kill(ns.pid);
    await expect(pending).rejects.toBeInstanceOf(ScriptDeath);
    expect(host.share!.currentBonus()).toBe(1);
  });

  test("Stanek surface enforces access and exposes vendored placement state", () => {
    const { ns, world } = harness([], false, 13);
    expect(() => ns.stanek.giftWidth()).toThrow("not installed");
    world.player.augmentations.set("Stanek's Gift - Genesis", 1);

    expect(ns.stanek.fragmentDefinitions()).toEqual(Fragments.map((fragment) => fragment.copy()));
    expect(ns.stanek.giftWidth()).toBeGreaterThanOrEqual(2);
    expect(ns.stanek.giftHeight()).toBeGreaterThanOrEqual(3);
    expect(ns.stanek.canPlaceFragment(0, 0, 0, 6)).toBe(true);
    expect(ns.stanek.placeFragment(0, 0, 0, 6)).toBe(true);
    expect(ns.stanek.activeFragments()).toHaveLength(1);
    expect(ns.stanek.getFragment(0, 0)?.id).toBe(6);
    expect(ns.stanek.removeFragment(0, 0)).toBe(true);
    expect(ns.stanek.getFragment(0, 0)).toBeUndefined();
    expect(() => ns.stanek.placeFragment(0, 0, 0, -1)).toThrow("Invalid fragment id");
  });

  test("Stanek charge lands after its delay and a killed charge never lands", async () => {
    const first = harness([], false, 13);
    first.world.player.augmentations.set("Stanek's Gift - Genesis", 1);
    expect(first.ns.stanek.placeFragment(0, 0, 0, 6)).toBe(true);
    let done = false;
    const charged = first.ns.stanek.chargeFragment(0, 0).then(() => { done = true; });
    expect(first.host.stanek!.findFragment(0, 0)?.numCharge).toBe(0);
    expect(await first.host.clock.runAsync(() => done, 1_000)).toBe("goal");
    await charged;
    expect(first.ns.stanek.getFragment(0, 0)?.numCharge).toBe(1);

    const killed = harness([], false, 13);
    killed.world.player.augmentations.set("Stanek's Gift - Genesis", 1);
    expect(killed.ns.stanek.placeFragment(0, 0, 0, 6)).toBe(true);
    const pending = killed.ns.stanek.chargeFragment(0, 0);
    killed.host.processes.kill(killed.ns.pid);
    await expect(pending).rejects.toBeInstanceOf(ScriptDeath);
    expect(killed.host.stanek!.findFragment(0, 0)?.numCharge).toBe(0);
  });

  test("Stanek bonus battery changes charge delay from 1000 ms to 200 ms", async () => {
    const { ns, host, world } = harness([], false, 13);
    world.player.augmentations.set("Stanek's Gift - Genesis", 1);
    host.stanek!.storedCycles = 5;
    expect(ns.stanek.placeFragment(0, 0, 0, 6)).toBe(true);
    let done = false;
    const pending = ns.stanek.chargeFragment(0, 0).then(() => { done = true; });
    expect(host.stanek!.isBonusCharging).toBe(true);
    expect(await host.clock.runAsync(() => done, 199)).toBe("horizon");
    expect(host.stanek!.findFragment(0, 0)?.numCharge).toBe(0);
    expect(await host.clock.runAsync(() => done, 200)).toBe("goal");
    await pending;
    expect(host.stanek!.findFragment(0, 0)?.numCharge).toBe(1);
  });

  test("Stanek refuses to charge booster fragments", () => {
    const { ns, world } = harness([], false, 13);
    world.player.augmentations.set("Stanek's Gift - Genesis", 1);
    expect(ns.stanek.placeFragment(0, 0, 0, 107)).toBe(true);
    expect(() => ns.stanek.chargeFragment(0, 0)).toThrow("Booster Fragment");
  });

  test("Bladeburner join checks access/options before membership and combat only for new members", () => {
    const { ns, host, world } = harness([], false, 6);
    Object.assign(world.person.skills, { strength: 100, defense: 100, dexterity: 100, agility: 100 });
    host.bladeburnerDisabled = true;
    expect(ns.bladeburner.joinBladeburnerDivision()).toBe(false);
    host.bladeburnerDisabled = false;
    expect(ns.bladeburner.joinBladeburnerDivision()).toBe(true);

    Object.assign(world.person.skills, { strength: 1, defense: 1, dexterity: 1, agility: 1 });
    expect(ns.bladeburner.joinBladeburnerDivision()).toBe(true);
    host.bladeburnerDisabled = true;
    expect(ns.bladeburner.joinBladeburnerDivision()).toBe(false);
  });

  test("prestige PID reset is accepted only after all scripts die and restarts at one", () => {
    const { host } = harness();
    expect(() => host.processes.resetPidCounter()).toThrow("while scripts are running");
    host.processes.killAll(false);
    host.processes.resetPidCounter();
    const restarted = host.processes.start({
      filename: "main.js", host: "home", args: [], threads: 1, ramPerThreadGb: 1, temporary: false,
    });
    expect(restarted?.pid).toBe(1);
  });

  test("port openers require their program, count once, and nuke returns a boolean", () => {
    const { ns, world } = harness();
    const target = world.servers.get("n00dles")!;
    expect(ns.brutessh("n00dles")).toBe(false);
    expect(target.openPortCount).toBe(0);
    expect(ns.nuke("n00dles")).toBe(false);

    expect(ns.ls("home")).toContain("NUKE.exe");
  });

  test("a real opener succeeds once and permits nuke", () => {
    const { ns, world } = harness(["BruteSSH.exe"]);
    const target = world.servers.get("n00dles")!;
    expect(ns.brutessh("n00dles")).toBe(true);
    expect(ns.brutessh("n00dles")).toBe(true);
    expect(target.openPortCount).toBe(1);
    expect(ns.nuke("n00dles")).toBe(true);
    expect(target.hasAdminRights).toBe(true);
  });

  test("HGW rejects unrooted and purchased servers", () => {
    const { ns, world } = harness();
    const target = world.servers.get("n00dles")!;
    expect(() => ns.grow("n00dles")).toThrow("no admin rights");
    target.hasAdminRights = true;
    target.purchasedByPlayer = true;
    expect(() => ns.hack("n00dles")).toThrow("purchased server");
    expect(() => ns.weaken("n00dles")).toThrow("purchased server");
  });

  test("HGW validates thread and delay options like validateHGWOptions", () => {
    const { ns, world } = harness();
    world.servers.get("n00dles")!.hasAdminRights = true;
    expect(() => ns.grow("n00dles", { threads: 2 })).toThrow("Too many threads");
    expect(() => ns.grow("n00dles", { threads: -1 })).toThrow("positive number");
    expect(() => ns.grow("n00dles", { additionalMsec: -1 })).toThrow("non-negative");
    expect(() => ns.grow("n00dles", { additionalMsec: 1e9 + 1 })).toThrow("too large");
    expect(() => (ns.grow as (host: string, opts: unknown) => unknown)("n00dles", 1)).toThrow("must be an object");
  });

  test("home money reads player money through both public APIs", () => {
    const { ns, world } = harness();
    world.player.money = 123_456;
    expect(ns.getServerMoneyAvailable("home")).toBe(123_456);
    expect(ns.getServer("home").moneyAvailable).toBe(123_456);
  });

  test("server APIs resolve IPs and never expose simulator-only fields", () => {
    const { ns, world } = harness();
    const target = world.servers.get("n00dles")!;
    expect(ns.getServer(target.ip).hostname).toBe("n00dles");
    expect(Object.hasOwn(ns.getServer("n00dles") as object, "simKind")).toBe(false);
    expect(ns.scan(world.servers.get("home")!.ip, { returnByIP: true })).toEqual([target.ip]);
    expect(ns.hasRootAccess(target.ip)).toBe(false);
    expect(ns.fileExists("child.js", target.ip)).toBe(true);
    expect(ns.ls(target.ip)).toEqual(["child.js"]);
  });

  test("isolated ordinary servers stay inaccessible until the graph exposes them", () => {
    const { ns, host, world } = harness();
    const base = world.servers.get("n00dles")!;
    const daemon = { ...base, hostname: "w0r1d_d43m0n", ip: "203.0.113.9", hasAdminRights: true };
    world.servers.set(daemon.hostname, daemon);
    host.network.set(daemon.hostname, []);

    expect(() => ns.getServer(daemon.hostname)).toThrow("Invalid host");
    expect(() => ns.getServer(daemon.ip)).toThrow("Invalid host");
    expect(() => ns.hasRootAccess(daemon.hostname)).toThrow("Invalid host");

    host.network.get("n00dles")!.push(daemon.hostname);
    host.network.set(daemon.hostname, ["n00dles"]);
    expect(ns.getServer(daemon.ip).hostname).toBe(daemon.hostname);
  });

  test("cloud upgrades return sentinels for invalid hosts", () => {
    const { ns } = harness();
    expect(ns.cloud.getServerUpgradeCost("not-a-server", 16)).toBe(-1);
    expect(ns.cloud.upgradeServer("not-a-server", 16)).toBe(false);
  });

  test("HGW applies to the canonical server when targeted by IP", async () => {
    const { ns, host, world } = harness();
    const target = world.servers.get("n00dles")!;
    target.hasAdminRights = true;
    target.hackDifficulty = target.minDifficulty + 5;
    let settled = false;
    const pending = ns.weaken(target.ip).finally(() => { settled = true; });
    expect(await host.clock.runAsync(
      () => settled,
      world.hgwDurationMs("weaken", target) + 1,
    )).toBe("goal");
    expect(await pending).toBeGreaterThan(0);
  });

  test("getResetInfo returns fresh nested maps on every call", () => {
    const { ns, host } = harness();
    host.reset.ownedSF.set(4, 2);
    host.reset.bitNodeOptions.sourceFileOverrides.set(4, 1);
    const first = ns.getResetInfo();
    first.ownedSF.set(4, 99);
    first.bitNodeOptions.sourceFileOverrides.set(4, 99);
    const second = ns.getResetInfo();
    expect(second.ownedSF.get(4)).toBe(2);
    expect(second.bitNodeOptions.sourceFileOverrides.get(4)).toBe(1);
    expect(second).not.toBe(first);
  });

  test("Singularity methods are inaccessible outside BN4 without Source-File 4", () => {
    const { host, world } = harness();
    const factions = new FactionSystem(world, world.player);
    host.singularity = makeSingularity({
      world, player: world.player, factions, clock: world.clock, bitNode: 1,
      terminal: { host: "home" }, network: host.network,
      crimes: { start: () => 0 } as never,
      satisfyContext: () => ({
        player: world.player, person: world.person, servers: world.servers,
        factionRep: () => 0, companyRep: () => 0, bitNode: 1,
        hacknet: { ram: 0, cores: 0, levels: 0 }, bladeburnerRank: () => 0, files: new Set(),
      }),
      pokeInvitationCounter: () => {}, homeFiles: () => new Set(), hasTor: () => false, setTor: () => {},
    });
    const ns = makeSimNs(host, [...host.processes.values()][0]!);
    expect(() => ns.singularity.getOwnedAugmentations()).toThrow("Singularity API");
    world.player.sourceFiles["4"] = 1;
    expect(ns.singularity.getOwnedAugmentations()).toEqual([]);
    expect(() => ns.singularity.getFactionRep("not-a-faction" as never)).toThrow("Invalid faction");
    expect(() => ns.singularity.workForFaction("CyberSec", "not-work" as never)).toThrow("Invalid faction work type");
    expect(() => ns.singularity.getAugmentationPrice("not-an-augmentation" as never)).toThrow("Invalid augmentation");
  });

  test("destroyW0r1dD43m0n fires only after daemon root and skill preconditions", () => {
    const { host, world } = harness([], false, 4);
    const base = world.servers.get("n00dles")!;
    const daemon = { ...base, hostname: "w0r1d_d43m0n", requiredHackingSkill: 3_000, hasAdminRights: false };
    world.servers.set(daemon.hostname, daemon);
    let completed: [number, string | undefined, Map<number, number>] | undefined;
    const factions = new FactionSystem(world, world.player);
    host.singularity = makeSingularity({
      world, player: world.player, factions, clock: world.clock, bitNode: 4,
      terminal: { host: "home" }, network: host.network,
      crimes: { start: () => 0 } as never,
      satisfyContext: () => ({
        player: world.player, person: world.person, servers: world.servers,
        factionRep: () => 0, companyRep: () => 0, bitNode: 4,
        hacknet: { ram: 0, cores: 0, levels: 0 }, bladeburnerRank: () => 0, files: new Set(),
      }),
      pokeInvitationCounter: () => {}, homeFiles: () => new Set(), hasTor: () => false, setTor: () => {},
      onBitNodeComplete: (next, callback, options) => {
        completed = [next, callback, options.sourceFileOverrides];
      },
    });
    const ns = makeSimNs(host, [...host.processes.values()][0]!);
    expect(ns.singularity.destroyW0r1dD43m0n(2, "/start.js", {} as never)).toBeUndefined();
    ns.singularity.destroyW0r1dD43m0n(2, "/start.js");
    expect(completed).toBeUndefined();
    daemon.hasAdminRights = true;
    world.person.skills.hacking = 3_000;
    world.player.ownedSourceFiles["4"] = 3;
    expect(() => ns.singularity.destroyW0r1dD43m0n(2, "/start.js", {} as never)).toThrow(
      "sourceFileOverrides must be a Map",
    );
    ns.singularity.destroyW0r1dD43m0n(2, "/start.js", {
      sourceFileOverrides: new Map([[4, 2]]),
      disableGang: true,
    } as never);
    expect(completed).toEqual([2, "start.js", new Map([[4, 2]])]);
    expect(daemon.backdoorInstalled).toBe(true);
  });

  test("Bladeburner daemon completion fails loudly until Black Operations are modeled", () => {
    resetUnmodeled();
    const { host, world } = harness([], false, 4);
    const base = world.servers.get("n00dles")!;
    world.servers.set("w0r1d_d43m0n", {
      ...base, hostname: "w0r1d_d43m0n", requiredHackingSkill: 3_000, hasAdminRights: false,
    });
    world.gates.inBladeburner = true;
    const factions = new FactionSystem(world, world.player);
    host.singularity = makeSingularity({
      world, player: world.player, factions, clock: world.clock, bitNode: 4,
      terminal: { host: "home" }, network: host.network,
      crimes: { start: () => 0 } as never,
      satisfyContext: () => ({
        player: world.player, person: world.person, servers: world.servers,
        factionRep: () => 0, companyRep: () => 0, bitNode: 4,
        hacknet: { ram: 0, cores: 0, levels: 0 }, bladeburnerRank: () => 0, files: new Set(),
      }),
      pokeInvitationCounter: () => {}, homeFiles: () => new Set(), hasTor: () => false, setTor: () => {},
    });
    const ns = makeSimNs(host, [...host.processes.values()][0]!);
    expect(() => ns.singularity.destroyW0r1dD43m0n(2)).toThrow("Bladeburner BitNode completion");
    resetUnmodeled();
  });

  test("the universally available Go capability getter returns the real fresh-board state", () => {
    const { ns } = harness();
    expect(ns.go.getGameState()).toEqual({
      currentPlayer: "Black",
      whiteScore: 1.5,
      blackScore: 0,
      previousMove: null,
      komi: 1.5,
      bonusCycles: 0,
    });
  });

  test("the Go Netscript surface advances the vendored opponent in virtual time", async () => {
    const { ns, host } = harness();
    let settled = false;
    const pending = ns.go.makeMove(0, 0).finally(() => { settled = true; });
    expect(await host.clock.runAsync(() => settled, 60_000)).toBe("goal");
    const response = await pending;
    expect(["move", "pass", "gameOver"]).toContain(response.type);
    expect(ns.go.getMoveHistory().length).toBeGreaterThan(0);

    expect(ns.go.resetBoardState("Illuminati", 5)).toHaveLength(5);
    expect(ns.go.getOpponent()).toBe("Illuminati");
    expect(ns.go.analysis.getStats().Netburners?.losses).toBe(1);
    expect(ns.go.analysis.getControlledEmptyNodes()).toHaveLength(5);
  });

  test("the Go cheat surface enforces access and advances one successful cheat turn", async () => {
    const locked = harness();
    expect(() => locked.ns.go.cheat.getCheatCount()).toThrow("Source-File 14.2");

    const { ns, host, world } = harness();
    world.player.sourceFiles["14"] = 2;
    expect(ns.go.cheat.getCheatCount()).toBe(0);
    expect(ns.go.cheat.getCheatSuccessChance(0)).toBe(0.6);
    expect(() => ns.go.cheat.getCheatCount(true)).toThrow("white-side No AI Go is not modeled");
    let settled = false;
    const pending = ns.go.cheat.playTwoMoves(0, 0, 6, 6).finally(() => { settled = true; });
    expect(await host.clock.runAsync(() => settled, 60_000)).toBe("goal");
    await pending;
    expect(ns.go.cheat.getCheatCount()).toBe(1);
    expect(ns.go.getBoardState().join("").split("X")).toHaveLength(3);
  });

  test("a critical cheat failure ends the game without deepening an existing dry streak", async () => {
    const { ns, host, world } = harness();
    world.player.sourceFiles["14"] = 2;
    host.go!.boardState.cheatCount = 1;
    host.go!.stats.set(GoOpponent.Netburners, {
      wins: 0,
      losses: 0,
      nodes: 0,
      nodePower: 0,
      winStreak: -1,
      oldWinStreak: 0,
      highestWinStreak: 0,
      rep: 0,
    });
    // WHRNG(24_200): first draw narrowly fails count-1's 0.408 chance;
    // second draw is below the 10% ejection threshold.
    host.clock.in(24_200, () => {});
    host.clock.run();
    const response = await ns.go.cheat.destroyNode(0, 0);
    expect(response.type).toBe("gameOver");
    expect(ns.go.cheat.getCheatCount()).toBe(1);
    expect(host.go!.stats.get(GoOpponent.Netburners)).toMatchObject({ losses: 1, winStreak: -1 });
  });

  test("script totals report live per-process rates and since-install hacking separately", () => {
    const { ns, host, world } = harness();
    const running = [...host.processes.values()][0]!;
    running.onlineMoneyMade = 20;
    running.onlineExpGained = 7;
    running.onlineRunningTimeSeconds = 1;
    host.reset.lastAugReset = 0;
    world.recordMoney("hacking", 50);
    host.clock.in(1_000, () => {});
    host.clock.run();
    expect(ns.getTotalScriptIncome()).toEqual([20, 50]);
    expect(ns.getTotalScriptExpGain()).toBe(7);
  });

  test("engine-time accounting starts at 0.01s and finished children transfer earnings to their parent", () => {
    const { host } = harness();
    const parent = [...host.processes.values()][0]!;
    expect(parent.onlineRunningTimeSeconds).toBe(0.01);
    host.processes.updateOnlineTimes(5);
    expect(parent.onlineRunningTimeSeconds).toBe(1.01);
    const child = host.processes.start({
      filename: "child.js", host: "home", args: [], threads: 1,
      ramPerThreadGb: 1, temporary: true, parentPid: parent.pid,
    })!;
    child.onlineMoneyMade = 123;
    child.onlineExpGained = 45;
    host.processes.finish(child.pid);
    expect(parent.onlineMoneyMade).toBe(123);
    expect(parent.onlineExpGained).toBe(45);
  });

  test("the public RAM-cost API rejects unknown paths", () => {
    const { ns } = harness();
    expect(ns.getFunctionRamCost("baseCost")).toBe(1.6);
    expect(() => ns.getFunctionRamCost("does.not.exist")).toThrow();
  });

  test("ramOverride reports an unchanged allocation and refuses to invent dynamic RAM headroom", () => {
    const { ns, host } = harness();
    const process = [...host.processes.values()][0]!;
    expect(ns.ramOverride()).toBe(1);
    expect(ns.ramOverride(1)).toBe(1);
    expect(() => ns.ramOverride(3.6)).toThrow("changing an allocation requires per-process dynamic RAM accounting");
    expect(process.ramGb).toBe(1);
  });

  test("exec refuses a server without root even when the script is present", () => {
    const { ns } = harness();
    expect(ns.exec("child.js", "n00dles", 1)).toBe(0);
  });

  test("an un-awaited delaying call kills the script on its next Netscript call", async () => {
    const { ns, host } = harness();
    const pending = ns.sleep(1_000).catch((error) => error);
    expect(() => ns.getPlayer()).toThrow("Concurrent calls to Netscript functions");
    expect(host.processes.size).toBe(0);
    expect(await pending).toBeInstanceOf(ScriptDeath);
  });

  test("terminal harness teardown cancels timers without fabricating an observable script kill", async () => {
    const { ns, host } = harness();
    let settled = false;
    void ns.sleep(1_000).then(
      () => { settled = true; },
      () => { settled = true; },
    );
    expect(host.processes.killAll(false)).toBe(1);
    await Promise.resolve();
    expect(host.processes.size).toBe(0);
    expect(settled).toBe(false);
  });

  test("killing installBackdoor cancels its timer and world mutation", async () => {
    const { ns, host, world } = harness();
    const target = world.servers.get("n00dles")!;
    target.hasAdminRights = true;
    const factions = new FactionSystem(world, world.player);
    host.singularity = makeSingularity({
      world,
      player: world.player,
      factions,
      clock: world.clock,
      bitNode: 4,
      terminal: { host: "n00dles" },
      network: host.network,
      crimes: { start: () => 0 } as never,
      satisfyContext: () => ({
        player: world.player, person: world.person, servers: world.servers,
        factionRep: () => 0, companyRep: () => 0, bitNode: 4,
        hacknet: { ram: 0, cores: 0, levels: 0 }, bladeburnerRank: () => 0, files: new Set(),
      }),
      pokeInvitationCounter: () => {}, homeFiles: () => new Set(), hasTor: () => false, setTor: () => {},
    });
    const processNs = makeSimNs(host, [...host.processes.values()][0]!);
    const pending = processNs.singularity.installBackdoor().catch((error) => error);
    expect(host.processes.kill(processNs.pid)).toBe(true);
    host.clock.run();
    expect(await pending).toBeInstanceOf(ScriptDeath);
    expect(target.backdoorInstalled).toBe(false);
  });

  test("the 4S script API purchase requires TIX access", () => {
    const { ns } = harness([], true);
    expect(() => ns.stock.purchase4SMarketDataTixApi()).toThrow("no TIX API access");
  });

  test("BitNode multipliers are available in BN5 and gated elsewhere", () => {
    const locked = harness().ns;
    expect(() => locked.getBitNodeMultipliers()).toThrow("requires BitNode 5 or Source-File 5");

    const bn5 = harness([], false, 5).ns.getBitNodeMultipliers();
    expect(bn5.ScriptHackMoney).toBe(0.15);
    expect(bn5.FourSigmaMarketDataApiCost).toBe(1);
  });

  /** The harness builds a StockMarketSystem with no access, so no market exists
   *  until something buys one. Purchasing is what rolls the 33 symbols. */
  function openMarket(host: SimNsHost, world: SimWorld, fourSigma = false): void {
    world.player.money = 1e12;
    host.stock!.purchaseWseAccount();
    host.stock!.purchaseTixApi();
    if (fourSigma) host.stock!.purchase4SMarketDataTixApi();
    world.player.money = 1e12;
  }

  test("a fresh stock market has an authoritatively empty order book", () => {
    // Upstream gates the order book on TIX AND (BN8 or SF8.3), and throws
    // otherwise. Only past both rungs is the empty book observed state.
    const { ns, host, world } = harness([], true);
    expect(() => ns.stock.getOrders()).toThrow("no TIX API access");
    openMarket(host, world);
    expect(() => ns.stock.getOrders()).toThrow("BN8 or SF8 level 3");

    host.reset.ownedSF.set(8, 3);
    expect(ns.stock.getOrders()).toEqual({});

    // BN8 grants it without any source file at all.
    const bn8 = harness([], true, 8);
    openMarket(bn8.host, bn8.world);
    expect(bn8.ns.stock.getOrders()).toEqual({});
  });

  test("a BitNodeOptions override replaces the owned source-file level", () => {
    // Player.activeSourceFileLvl: an override present at ANY level, zero
    // included, wins over what the player owns. Reading ownedSF alone would
    // hand a script a rung the run deliberately disabled.
    const { ns, host, world } = harness([], true);
    openMarket(host, world);
    host.reset.ownedSF.set(8, 3);
    expect(ns.stock.getOrders()).toEqual({});

    host.reset.bitNodeOptions.sourceFileOverrides.set(8, 0);
    expect(() => ns.stock.getOrders()).toThrow("BN8 or SF8 level 3");
    expect(() => ns.stock.buyShort("ECP", 1)).toThrow("BN8 or SF8 level 2");
  });

  test("shorts need BN8 or SF8.2", () => {
    const { ns, host, world } = harness([], true);
    openMarket(host, world);
    expect(() => ns.stock.buyShort("ECP", 1)).toThrow("BN8 or SF8 level 2");
    expect(() => ns.stock.sellShort("ECP", 1)).toThrow("BN8 or SF8 level 2");

    host.reset.ownedSF.set(8, 2);
    // Past the gate the trade actually happens, and reports the bid.
    expect(ns.stock.buyShort("ECP", 1)).toBeCloseTo(ns.stock.getBidPrice("ECP"), 6);
  });

  test("getPurchaseCost and getSaleGain are modelled, not merely priced", () => {
    // ram-costs.ts charges for both. Before they existed here the proxy
    // reported them unmodelled, which invalidates the whole run.
    const { ns, host, world } = harness([], true);
    openMarket(host, world);

    const ask = ns.stock.getAskPrice("ECP");
    const bid = ns.stock.getBidPrice("ECP");
    const cost = ns.stock.getPurchaseCost("ECP", 100, "L" as never);
    const gain = ns.stock.getSaleGain("ECP", 100, "L" as never);
    // Commission is charged on BOTH legs, which is what makes a round trip cost
    // $200k before the spread is paid at all.
    expect(cost).toBeCloseTo(100 * ask + 100_000, 6);
    expect(gain).toBeCloseTo(100 * bid - 100_000, 6);

    // The quote is what an actual trade charges.
    const before = world.player.money;
    ns.stock.buyStock("ECP", 100);
    // Relative, not absolute: differencing two ~$1e12 balances loses the last
    // few cents to float64 long before the quote is wrong.
    expect((before - world.player.money) / cost).toBeCloseTo(1, 10);

    // Upstream's fallbacks for a refused transaction.
    expect(ns.stock.getPurchaseCost("ECP", -1, "L" as never)).toBe(Infinity);
    expect(ns.stock.getSaleGain("ECP", -1, "L" as never)).toBe(0);
    expect(() => ns.stock.getPurchaseCost("ECP", 1, "nonsense" as never)).toThrow("invalid position type");
  });

  test("getVolatility reports the darknet-boosted figure the tick will use", () => {
    const { ns, host, world } = harness([], true);
    openMarket(host, world, true);
    const plain = ns.stock.getVolatility("ECP");
    expect(plain).toBeCloseTo(host.stock!.stock("ECP")!.mv / 100, 12);

    setDarknetContext({ volatilityMult: (symbol) => (symbol === "ECP" ? 2.5 : 1) });
    try {
      expect(ns.stock.getVolatility("ECP")).toBeCloseTo(plain * 2.5, 12);
      expect(ns.stock.getVolatility("MGCP")).toBeCloseTo(host.stock!.stock("MGCP")!.mv / 100, 12);
    } finally {
      resetDarknetContext();
    }
  });
});
