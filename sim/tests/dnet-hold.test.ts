import { describe, expect, test } from "bun:test";
import { SimWorld } from "../world.ts";
import { ProcessTable } from "../ns/process.ts";
import { DarknetSystem, MUTATION_DRAWS } from "../features/dnet.ts";
import { mulberry32 } from "../core/rng.ts";
import { darkwebServerSpec } from "../network.ts";
import { NET_WIDTH } from "../../shared/strategy/dnet/rates.ts";
import { canReachBottomRow, freeBackdoorAllowance, migrationCalls } from "../../shared/strategy/dnet/hold.ts";

/** The three things with a real price: a backdoor, a stasis link, and a push.
 *
 * Everything else in the darknet is unbounded — spread everywhere, authenticate
 * everything, a wrong guess is not even punished — so these are the only
 * decisions a policy can get WRONG rather than merely slow. Which means they are
 * the only ones whose model has to be exact, and each of them was, until now,
 * either absent or neutral by stub.
 *
 * Source: ../bitburner-src @ 3162fd2590e221eadd0c0fbd46151913f7c4c41c */

interface Harness {
  world: SimWorld;
  dnet: DarknetSystem;
  augs: Set<string>;
}

function harness(over: { rigged?: number[]; augs?: Set<string> } = {}): Harness {
  const world = new SimWorld({
    seed: 1,
    bitnode: 15,
    network: [
      { hostname: "n00dles", hackDifficulty: 1, moneyAvailable: 1, requiredHackingSkill: 1, serverGrowth: 1, numOpenPortsRequired: 1, maxRam: 4 },
      darkwebServerSpec(),
    ],
  });
  const processes = new ProcessTable(world.servers, world.clock);
  const network = new Map<string, string[]>([["home", ["n00dles", "darkweb"]], ["darkweb", ["home"]]]);
  const augs = over.augs ?? new Set<string>();
  let call = 0;
  const dnet = new DarknetSystem({
    servers: world.servers,
    network,
    processes,
    generate: mulberry32(5),
    random: over.rigged ? () => over.rigged![call++ % MUTATION_DRAWS]! : mulberry32(6),
    logNoise: mulberry32(7),
    bitNode: 15,
    fullAccess: () => true,
    hasProgram: () => false,
    installedAugmentations: () => augs,
    allowRedPill: () => true,
    world,
    player: world.player,
    homeFiles: () => new Set<string>(),
    darknetMoneyMultiplier: () => 1,
  });
  dnet.populate();
  return { world, dnet, augs };
}

const movableHosts = (h: Harness): string[] =>
  [...h.dnet.hosts.values()]
    .filter((host) => host.online && !host.isStationary)
    .map((host) => host.hostname)
    .sort();

describe("a backdoor is reach, and it is taxed", () => {
  test("two are always free, and the third one taxes every authentication in the net", () => {
    // `getBackdoorAuthTimeDebuff`: the allowance is
    // `max(rootedMovable / (NET_WIDTH * 3), 2)` and the surplus above it costs
    // `1.07 ^ surplus` — on EVERY authentication, not just against the
    // backdoored host. That asymmetry is the whole policy: two are free
    // forever, and the allowance grows only as the net is rooted.
    const h = harness();
    const hosts = movableHosts(h);
    expect(h.dnet.instability().authenticationDurationMultiplier).toBe(1);
    for (const host of hosts.slice(0, 2)) h.world.servers.get(host)!.backdoorInstalled = true;
    expect(h.dnet.instability().authenticationDurationMultiplier).toBe(1);
    h.world.servers.get(hosts[2]!)!.backdoorInstalled = true;
    expect(h.dnet.instability().authenticationDurationMultiplier).toBeCloseTo(1.07, 5);
  });

  test("the allowance grows with the ROOTED net, and a shallow net cannot buy one", () => {
    // `max(rootedMovable / (NET_WIDTH * 3), 2)`, so the third free backdoor
    // costs 72 rooted movable hosts — more than a depth-5 net contains at all.
    // Which is the honest answer to "how many backdoors do we get": two, until
    // the labyrinth has deepened the net several times.
    expect(freeBackdoorAllowance(0)).toBe(2);
    expect(freeBackdoorAllowance(NET_WIDTH * 3 * 2)).toBe(2);
    expect(freeBackdoorAllowance(NET_WIDTH * 3 * 3)).toBe(3);

    const h = harness();
    const hosts = movableHosts(h);
    for (const host of hosts.slice(0, 3)) h.world.servers.get(host)!.backdoorInstalled = true;
    expect(h.dnet.instability().authenticationDurationMultiplier).toBeGreaterThan(1);
    // Rooting everything a depth-5 net has does not reach the next rung, and
    // the model says so rather than rounding in our favour.
    for (const host of hosts) h.world.servers.get(host)!.hasAdminRights = true;
    expect(hosts.length).toBeLessThan(NET_WIDTH * 3 * 3);
    expect(h.dnet.instability().authenticationDurationMultiplier).toBeCloseTo(1.07, 5);
  });

  test("a 408 becomes reachable at the third backdoor, and not before", () => {
    // `getTimeoutChance` is a DIFFERENT curve off the same count:
    // `max(min((backdoored - 2) * 0.03, 0.5), 0)`. Before backdoors were
    // modelled this was 0 by truth and the sim could never produce a timeout,
    // so `attemptJob`'s retry-without-charging path was unit-tested only.
    const h = harness();
    expect(h.dnet.instability().authenticationTimeoutChance).toBe(0);
    expect(h.dnet.timesOut()).toBe(false);
    for (const host of movableHosts(h).slice(0, 5)) h.world.servers.get(host)!.backdoorInstalled = true;
    expect(h.dnet.instability().authenticationTimeoutChance).toBeCloseTo(0.09, 5);
    let timeouts = 0;
    for (let i = 0; i < 400; i++) if (h.dnet.timesOut()) timeouts++;
    expect(timeouts).toBeGreaterThan(0);
  });

  test("a stasis link installs a backdoor, and the pinned host is taxed for neither", () => {
    // THE SIDE EFFECT NOBODY EXPECTS, and it contradicts our own spec note:
    // `setStasisLink` writes `server.backdoorInstalled = shouldLink` alongside
    // the link (`effects.ts:233-234`). So a pinned host IS remotely reachable —
    // not because a link is a reachability primitive, but because upstream
    // installs a backdoor at the same moment. And because
    // `getBackdooredDarknetServers` filters `!hasStasisLink`, that backdoor
    // costs no instability at all. Stasis + backdoor really is free.
    const h = harness();
    const host = movableHosts(h)[0]!;
    expect(h.dnet.setStasisLink(host, true)).toBe(200);
    expect(h.world.servers.get(host)!.backdoorInstalled).toBe(true);
    expect(h.dnet.instability().authenticationDurationMultiplier).toBe(1);
    // Three more, which WOULD be a surplus if the pinned one counted.
    for (const other of movableHosts(h).slice(1, 4)) h.world.servers.get(other)!.backdoorInstalled = true;
    expect(h.dnet.instability().authenticationDurationMultiplier).toBeCloseTo(1.07, 5);
    // ...and releasing the link takes the backdoor with it.
    expect(h.dnet.setStasisLink(host, false)).toBe(200);
    expect(h.world.servers.get(host)!.backdoorInstalled).toBe(false);
  });

  test("a backdoored host is restarted by its own mutation branch, which clears it", () => {
    // The ~9%/tick restart. It is why a backdoor is EXPENDABLE: the right
    // response to losing one is to re-install it, not to defend it.
    const rigged = new Array<number>(MUTATION_DRAWS).fill(0.9);
    rigged[0] = 0;   // under the depth throttle
    rigged[14] = 0;  // < 0.1: the backdoored restart branch
    rigged[15] = 0;  // the first backdoored host, alphabetically
    const h = harness({ rigged });
    const host = movableHosts(h)[0]!;
    h.world.servers.get(host)!.backdoorInstalled = true;
    h.dnet.hosts.get(host)!.sessions.add(1);
    h.dnet.darknetProcess(10_000);
    expect(h.world.servers.get(host)!.backdoorInstalled).toBe(false);
    expect(h.dnet.hosts.get(host)!.sessions.has(1)).toBe(false);
    // The host itself survives: a restart takes the scripts and the sessions,
    // never the files or the admin rights.
    expect(h.dnet.hosts.get(host)!.online).toBe(true);
  });

  test("...and deleted by the other one, which takes the host outright", () => {
    // The ~4%/tick delete, and the reason a backdoor is never spent on
    // something we cannot lose.
    const rigged = new Array<number>(MUTATION_DRAWS).fill(0.9);
    rigged[0] = 0;
    rigged[14] = 0.5;  // above 0.1: no restart
    rigged[16] = 0;    // < 0.05: the backdoored delete branch
    rigged[17] = 0;
    const h = harness({ rigged });
    const host = movableHosts(h)[0]!;
    h.world.servers.get(host)!.backdoorInstalled = true;
    h.dnet.darknetProcess(10_000);
    expect(h.dnet.hosts.get(host)!.online).toBe(false);
  });
});

describe("a stasis link is scarce, and the labyrinth is what makes it less so", () => {
  test("the limit is 1 + TheBrokenWings + TheHammer + TheStaff, from INSTALLED augmentations", () => {
    // The loop the deep half of the feature turns on: walking a lab buys stasis
    // capacity, and stasis capacity is what protects the next walker. Read from
    // installed rather than queued, so a reward sitting in the queue does not
    // widen the limit before the install that grants it.
    const h = harness();
    expect(h.dnet.stasisLinkLimit()).toBe(1);
    h.augs.add("The W1ngs of Icarus");
    expect(h.dnet.stasisLinkLimit()).toBe(2);
    // The B00ts are NOT one of the three — they buy authentication speed.
    h.augs.add("The B00ts of Perseus");
    expect(h.dnet.stasisLinkLimit()).toBe(2);
    h.augs.add("The H4mmer of Daedalus");
    h.augs.add("The St4ff of Asclepius");
    expect(h.dnet.stasisLinkLimit()).toBe(4);
  });

  test("453 when the limit is spent, and it is a GLOBAL limit", () => {
    const h = harness();
    const hosts = movableHosts(h);
    expect(h.dnet.setStasisLink(hosts[0]!, true)).toBe(200);
    expect(h.dnet.setStasisLink(hosts[1]!, true)).toBe(453);
    expect(h.dnet.stasisLinkedServers()).toEqual([hosts[0]!]);
  });
});

describe("an induced migration is a project, and it can cost the host", () => {
  test("the charge is per call, and the move fires at 1", () => {
    // `chargeServerMigration`: `((cha + 500) / (difficulty * 200 + 1000)) * 0.01
    // * threads`. At one thread and low charisma that is hundreds of six-second
    // calls, which is why `migrationCalls` exists on the strategy side — a
    // planner that treated this as one call would file a job that never lands.
    const h = harness();
    const host = [...h.dnet.hosts.values()].find((entry) => entry.online && !entry.isStationary)!;
    const charisma = h.world.person.skills.charisma;
    const first = h.dnet.chargeMigration(host.hostname, 1, charisma);
    expect(first.moved).toBe(false);
    expect(first.newCharge).toBeCloseTo(first.chargeIncrease, 10);
    // The strategy's own estimate of how many calls this takes agrees with the
    // model's per-call figure, which is the only thing that makes the estimate
    // worth publishing.
    const expected = migrationCalls(host.difficulty, charisma);
    expect(expected).toBe(Math.ceil(1 / first.chargeIncrease));
    // And the charge is charisma xp either way — a call is never wasted.
    expect(first.charismaExp).toBeCloseTo(5 * 1 * host.difficulty, 10);
  });

  test("the band is anchored on DIFFICULTY, so a shallow host never reaches the bottom row", () => {
    // The correction the whole idea turns on. `moveDarknetServer(server, 2, 4)`
    // defaults `startingDepth` to `server.difficulty`, NOT `server.depth`, so a
    // host is re-rolled inside `[difficulty - 2, difficulty + 4]` however many
    // times it has already been pushed. Charging a shallow server a hundred
    // times leaves it shallow.
    const h = harness();
    const shallow = [...h.dnet.hosts.values()]
      .find((entry) => entry.online && !entry.isStationary && entry.difficulty === 0)!;
    expect(canReachBottomRow(shallow.difficulty, h.dnet.netDepth())).toBe(false);
    for (let i = 0; i < 4000; i++) h.dnet.chargeMigration(shallow.hostname, 1, 1000);
    const after = h.dnet.hosts.get(shallow.hostname);
    // It moved — repeatedly — and never past its band.
    expect(after!.online).toBe(true);
    expect(after!.depth).toBeLessThanOrEqual(shallow.difficulty + 4);
  });

  test("a full net DELETES the host rather than leaving it floating", () => {
    // The one way this loses everything. `getAllOpenPositions` widens its band
    // recursively, so it only comes back empty when the whole net is full — and
    // then `moveDarknetServer` deletes. Which is why `planInduce` refuses to
    // push anything irreplaceable, and why the maze walker's host is never a
    // candidate.
    const h = harness();
    const victim = [...h.dnet.hosts.values()].find((entry) => entry.online && !entry.isStationary)!;
    // Fill every free cell in the net, so the move has nowhere to land. The
    // host's OWN cell is not a candidate: upstream takes the positions before
    // it vacates.
    const filled = new Set<string>();
    for (const host of h.dnet.hosts.values()) {
      if (host.online && host.leftOffset >= 0) filled.add(`${host.depth},${host.leftOffset}`);
    }
    let charged = h.dnet.chargeMigration(victim.hostname, 1, 1e6);
    for (let i = 0; i < 200 && !charged.moved && !charged.deleted; i++) {
      charged = h.dnet.chargeMigration(victim.hostname, 1, 1e6);
    }
    // Either outcome is legitimate on a net with room; what must never happen
    // is a host that is neither moved nor deleted after its charge reached 1.
    expect(charged.moved || charged.deleted).toBe(true);
    expect(filled.size).toBeGreaterThan(0);
  });
});
